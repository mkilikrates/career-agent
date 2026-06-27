// Output verification against the provenance index (R37, R40.2, R40.3).
//
// This is the executable heart of the No-Fabrication Rule and the backbone of
// Correctness Property 1: given a generated output and the provenance index that
// keys every confirmed claim to its source trace, the verifier
//
//   1. extracts every factual claim from the output (see `claims.ts`);
//   2. resolves each claim's stable id against the provenance index — a single
//      `index.isResolved(ref)` lookup (R38.1 / R40.2);
//   3. FAILS the output if ANY claim is unresolved (R40.2): an unresolved claim
//      is a fact with no source line, no user confirmation, and no confirmed
//      interview answer behind it — i.e. a fabrication;
//   4. additionally surfaces every unresolved *skill* claim as an invented skill
//      (R37.1, R40.3), and flags any invented skill whose normalised name
//      matches a job-title-implied skill (R37.3) — the adversarial temptation a
//      naive generator would fall for (e.g. inferring Docker/Kubernetes from a
//      bare "DevOps Engineer" title).
//
// Because resolution is a stable-id lookup rather than string matching, a
// title-implied skill cannot "sneak through": it has no id in the provenance
// index, so it resolves to nothing and fails — exactly the guarantee R37.3 and
// R40.3 require. The verifier is framework-agnostic: it depends only on the
// provenance index abstraction and the pure claim extractor.

import { ProvenanceIndex, buildProvenanceIndex } from '@core/provenance';
import type { ProvenanceSources } from '@core/provenance';
import { skillSlug } from '@core/skills';
import { extractClaims, type Claim, type GeneratedOutput } from './claims';

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
  /** Unresolved skill claims — skills not in source/confirmed (R37.1, R40.3). */
  readonly inventedSkills: readonly Claim[];
  /**
   * Invented skills whose name matches a supplied title-implied skill (R37.3):
   * the adversarial inference the No-Fabrication Rule forbids. Always a subset of
   * {@link inventedSkills}.
   */
  readonly titleImpliedSkills: readonly Claim[];
}

/** Normalise a {@link ProvenanceLike} to a concrete {@link ProvenanceIndex}. */
const toIndex = (source: ProvenanceLike): ProvenanceIndex =>
  source instanceof ProvenanceIndex ? source : buildProvenanceIndex(source);

const asString = (v: unknown): string => v as unknown as string;

/**
 * Verify a generated output against the provenance index (R40.2, Property 1).
 * Pure with respect to its inputs and deterministic. The output PASSES only when
 * every extracted claim resolves to a provenance record; any unresolved claim
 * (an unsourced, unconfirmed fact) fails it. Unresolved skill claims are
 * additionally surfaced as invented skills (R37.1, R40.3), and those matching a
 * supplied title-implied skill are flagged as the title-inference violation
 * R37.3 forbids.
 */
export const verifyOutput = (
  output: GeneratedOutput,
  source: ProvenanceLike,
  options: VerifyOptions = {},
): VerificationReport => {
  const index = toIndex(source);
  const claims = extractClaims(output);

  const resolved: Claim[] = [];
  const unresolved: Claim[] = [];
  for (const claim of claims) {
    if (index.isResolved(claim.ref)) resolved.push(claim);
    else unresolved.push(claim);
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
    passed: unresolved.length === 0,
    claims,
    resolved,
    unresolved,
    inventedSkills,
    titleImpliedSkills,
  };
};
