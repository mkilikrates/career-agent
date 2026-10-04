// Output verification against the provenance index (R37, R40.2, R40.3).
//
// This is the executable heart of the No-Fabrication Rule and the backbone of
// Correctness Property 1. Given a generated output and the provenance index that
// keys every confirmed claim to its source trace, the verifier runs the
// two-stage check R40.2 requires:
//
//   STAGE A — provenance resolution (R40.2a):
//   1. extracts every factual claim from the output (see `claims.ts`);
//   2. resolves each claim's stable id against the provenance index — a single
//      `index.resolve(ref)` lookup (R38.1 / R40.2);
//   3. FAILS the output if ANY claim is unresolved (R40.2): an unresolved claim
//      is a fact with no source line, no user confirmation, and no confirmed
//      interview answer behind it — i.e. a fabrication;
//   4. additionally surfaces every unresolved *skill* claim as an invented skill
//      (R37.1, R40.3), and flags any invented skill whose normalised name
//      matches a job-title-implied skill (R37.3) — the adversarial temptation a
//      naive generator would fall for (e.g. inferring Docker/Kubernetes from a
//      bare "DevOps Engineer" title).
//
//   STAGE B — fact fidelity (R37.5 / R40.2b):
//   5. for each resolved claim, reads the confirmed source text behind it from
//      its provenance trail and checks that the emitted text introduces no NEW
//      fact token (metric, date, title, or employer) absent from the source
//      (see `fidelity.ts`). A claim whose id resolves but whose text inflates a
//      metric, shifts a date, or invents an employer is reported as `unfaithful`
//      and fails the output — even though its id resolves. Rephrasing is allowed:
//      only net-new fact-bearing tokens are guarded, never prose wording.
//
// Because resolution is a stable-id lookup rather than string matching, a
// title-implied skill cannot "sneak through": it has no id in the provenance
// index, so it resolves to nothing and fails — exactly the guarantee R37.3 and
// R40.3 require. The verifier is framework-agnostic: it depends only on the
// provenance index abstraction and the pure claim extractor.

import { ProvenanceIndex, buildProvenanceIndex } from '@core/provenance';
import type { ProvenanceSources } from '@core/provenance';
import { skillSlug } from '@core/skills';
import type { StarId } from '@core/types';
import { extractClaims, type Claim, type GeneratedOutput } from './claims';
import { checkFidelity, sourceTextOf, type FactToken } from './fidelity';

/**
 * The provenance backing a verification: either a ready {@link ProvenanceIndex}
 * or the {@link ProvenanceSources} to build one from. Accepting both lets a
 * caller hand the harness whichever it already has (the live index, or the raw
 * confirmed records of a fixture).
 */
export type ProvenanceLike = ProvenanceIndex | ProvenanceSources;

/** Options that tune a single verification. */
export interface VerifyOptions {
  /**
   * Skills a job title would tempt a naive generator to infer without evidence
   * (R37.3, R40.3) — e.g. `['Docker', 'Kubernetes']` for a "DevOps Engineer"
   * title. Any invented (unresolved) skill whose normalised name matches one of
   * these is additionally reported in {@link VerificationReport.titleImpliedSkills}.
   * Names are compared by the same slug scheme the skill map uses, so casing and
   * punctuation variations still match.
   */
  readonly titleImpliedSkills?: readonly string[];
  /**
   * Confirmed STAR answer text keyed by `StarId`, for the fact-fidelity stage
   * (R40.2b, option b). An `interview_answer` provenance record carries only a
   * `StarId`, not its text, so a claim backed solely by an interview answer has
   * no comparable source text unless the caller supplies it here (typically the
   * `polished` field of each confirmed talking point). Claims whose trail
   * exposes no comparable text degrade to resolution-only — fidelity is skipped
   * for them, preserving backward compatibility.
   */
  readonly starText?: ReadonlyMap<StarId, string>;
}

/**
 * The result of verifying one generated output (R40.2). `passed` is true exactly
 * when no claim is unresolved. The breakdown lists are provided so a CI failure
 * (task 18.3) or the UI can explain precisely which claims were unsupported.
 */
export interface VerificationReport {
  /** True when every claim resolves to provenance (R40.2). */
  readonly passed: boolean;
  /** Every claim extracted from the output. */
  readonly claims: readonly Claim[];
  /** Claims that resolved to at least one provenance record (R38.1). */
  readonly resolved: readonly Claim[];
  /** Claims with no provenance — the fabrications that fail the output (R40.2). */
  readonly unresolved: readonly Claim[];
  /**
   * Resolved claims whose emitted text introduced a NEW fact token (metric,
   * date, title, or employer) absent from the confirmed source behind them
   * (R37.5, R40.2b). These fail the output despite resolving. Each carries the
   * specific divergent tokens so a CI failure or the UI can explain precisely
   * what was fabricated.
   */
  readonly unfaithful: readonly UnfaithfulClaim[];
  /** Unresolved skill claims — skills not in source/confirmed (R37.1, R40.3). */
  readonly inventedSkills: readonly Claim[];
  /**
   * Invented skills whose name matches a supplied title-implied skill (R37.3):
   * the adversarial inference the No-Fabrication Rule forbids. Always a subset of
   * {@link inventedSkills}.
   */
  readonly titleImpliedSkills: readonly Claim[];
}

/**
 * A claim that resolved but whose emitted text was not faithful to its source
 * (R37.5): the claim plus the net-new fact tokens that have no grounding.
 */
export interface UnfaithfulClaim {
  /** The resolved claim whose text diverged from its source. */
  readonly claim: Claim;
  /** The emitted fact tokens absent from the confirmed source (R37.5). */
  readonly newFacts: readonly FactToken[];
}

/** Normalise a {@link ProvenanceLike} to a concrete {@link ProvenanceIndex}. */
const toIndex = (source: ProvenanceLike): ProvenanceIndex =>
  source instanceof ProvenanceIndex ? source : buildProvenanceIndex(source);

const asString = (v: unknown): string => v as unknown as string;

/**
 * Verify a generated output against the provenance index (R40.2, Property 1).
 * Pure with respect to its inputs and deterministic. The output PASSES only when
 * every extracted claim both (a) resolves to a provenance record and (b) is
 * faithful to the source behind it. Any unresolved claim (an unsourced,
 * unconfirmed fact) fails it (R40.2a). Any resolved claim whose emitted text
 * introduces a new fact token the source does not contain fails it as well
 * (R37.5 / R40.2b) — rephrasing is allowed, inventing facts is not. Unresolved
 * skill claims are additionally surfaced as invented skills (R37.1, R40.3), and
 * those matching a supplied title-implied skill are flagged as the title-
 * inference violation R37.3 forbids.
 */
export const verifyOutput = (
  output: GeneratedOutput,
  source: ProvenanceLike,
  options: VerifyOptions = {},
): VerificationReport => {
  const index = toIndex(source);
  const claims = extractClaims(output);

  // Stage A — provenance resolution (R40.2a).
  const resolved: Claim[] = [];
  const unresolved: Claim[] = [];
  for (const claim of claims) {
    if (index.isResolved(claim.ref)) resolved.push(claim);
    else unresolved.push(claim);
  }

  // Stage B — fact fidelity (R37.5 / R40.2b). For each resolved claim, read the
  // confirmed source text from its trail and ensure the emitted text introduces
  // no new fact token. Claims whose trail exposes no comparable text degrade to
  // resolution-only (fidelity skipped), preserving backward compatibility.
  const unfaithful: UnfaithfulClaim[] = [];
  for (const claim of resolved) {
    const trace = index.resolve(claim.ref);
    if (!trace) continue; // resolved implies a trace, but stay defensive.
    const sourceText = sourceTextOf(trace.provenance, options.starText);
    if (sourceText === undefined) continue; // no comparable text → skip.
    const result = checkFidelity(claim.text, sourceText);
    if (!result.faithful) {
      unfaithful.push({ claim, newFacts: result.unfaithfulTokens });
    }
  }

  // Every unresolved skill claim is an invented skill (R37.1, R40.3).
  const inventedSkills = unresolved.filter((c) => c.kind === 'skill');

  // Of those, the ones a job title tempts a naive generator to infer (R37.3).
  const impliedSlugs = new Set(
    (options.titleImpliedSkills ?? []).map((name) => skillSlug(name)),
  );
  const titleImpliedSkills = inventedSkills.filter((c) =>
    impliedSlugs.has(skillSlug(c.text || asString(c.ref))),
  );

  return {
    passed: unresolved.length === 0 && unfaithful.length === 0,
    claims,
    resolved,
    unresolved,
    unfaithful,
    inventedSkills,
    titleImpliedSkills,
  };
};
