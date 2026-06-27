// Skill_Mapper AI-assist operation (capability `skill_discovery`) routed through
// the shared opt-in-first contract (task 25.2; design "AI Assist Opt-In-First
// Pattern" + "Skill_Mapper").
//
// This adapts the Skill_Mapper to the shared {@link BaseAssistableOperation} so
// it gets the two trust-critical invariants for free:
//   - `scriptOnly` → the deterministic, evidence-only {@link generate} map (R14)
//     with ZERO provider calls (R14.6, R47.8). The transport is never reached.
//   - `aiAssisted` → the SAME deterministic map PLUS AI-discovered skill names,
//     each wrapped as a confirm-before-entry {@link AssistSuggestion} (R47.3).
//     The corpus is built and chunked by the existing skill-discovery helpers
//     (never truncated, R47.5) and every chunk is sent via the injected
//     gate-routed {@link AssistTransport} — the only path to a provider.
//
// Private-item scope (R46.4/R47.1): for a keyless local on-device destination
// (`dest.kind === 'keyless-local'`) the corpus may include private items and, if
// raw document text is supplied, the WHOLE-document corpus is used; for a keyed
// cloud destination private items are excluded and only the structured items are
// sent. Suggestions are PROPOSALS — the caller turns each user-accepted name into
// a user-confirmed skill (R47.3, R47.6); discovery never writes to the map.

import type { ExtractedItem } from '@core/types';
import {
  BaseAssistableOperation,
  type AssistTransport,
  type EgressDestination,
} from '@core/assist';
import { generate, type SkillMap } from './skill-map';
import {
  buildDiscoveryCorpus,
  buildDiscoveryPrompt,
  buildReviewPrompt,
  buildRawDiscoveryCorpus,
  parseDiscoveredSkills,
} from './skill-discovery';

/** Input to the skill-discovery assist operation. */
export interface SkillDiscoveryInput {
  /** Confirmed extractions the deterministic baseline map is built from (R14). */
  readonly extractions: readonly ExtractedItem[];
  /**
   * An existing skill map whose names should be excluded from suggestions
   * (cumulative de-dupe), in addition to the freshly computed baseline. Optional.
   */
  readonly existingMap?: SkillMap | null;
  /**
   * The raw full text of each ingested document, retained in-session. Used only
   * for a keyless local on-device destination to read whole documents (R47.1).
   */
  readonly rawTexts?: readonly string[];
  /**
   * When `true`, the AI REVIEWS/REFINES the deterministic (script) skill
   * detections instead of discovering from scratch: the prompt carries the
   * parser's skills and asks the model to keep/correct/drop them and add any it
   * missed (the "Both" mode). When `false`/absent the model discovers skills
   * from the evidence alone (the "AI only" mode).
   */
  readonly review?: boolean;
  /** Per-chunk character budget override (defaults to the discovery default). */
  readonly maxCharsPerChunk?: number;
}

/** A single AI-discovered skill name (a proposal requiring confirmation, R47.3). */
export type SkillDiscoverySuggestion = string;

/**
 * The Skill_Mapper's `skill_discovery` operation. `scriptOnly` is the
 * deterministic evidence-only map; `aiAssisted` adds AI-proposed skill names as
 * confirm-before-entry suggestions, routed through the gate.
 */
export class SkillDiscoveryOperation extends BaseAssistableOperation<
  SkillDiscoveryInput,
  SkillMap,
  SkillDiscoverySuggestion
> {
  constructor(private readonly transport: AssistTransport) {
    super();
  }

  /** Deterministic, evidence-only skill map (R14). Issues zero provider calls. */
  protected computeBaseline(input: SkillDiscoveryInput): SkillMap {
    return generate([...input.extractions]);
  }

  /**
   * Build the (never-truncated) corpus chunks and ask the model for skills the
   * structured extractor missed. Private items are included only for a keyless
   * local on-device destination (R46.4); a cloud destination sends structured
   * non-private items only. Each name is de-duped (case-insensitive) against the
   * baseline, the supplied existing map, and prior chunk replies.
   */
  protected async fetchSuggestions(
    input: SkillDiscoveryInput,
    dest: EgressDestination,
    _baseline: SkillMap,
  ): Promise<readonly SkillDiscoverySuggestion[]> {
    const local = dest.kind === 'keyless-local';
    const rawTexts = (input.rawTexts ?? []).filter(
      (t) => typeof t === 'string' && t.trim().length > 0,
    );
    // The AI reads the FULL DECODED DOCUMENT TEXT whenever it is available — for
    // BOTH local and cloud destinations (the chat LLM cannot parse PDF/DOCX
    // binary, so the document is decoded to text on-device first). For a cloud
    // destination the Egress Gate redacts PII/secrets from this text before it
    // leaves the device; for a local destination it is sent in full. Only when
    // no decoded text is available (e.g. a LinkedIn ZIP, or a resumed session
    // where the in-session raw text was not retained) do we fall back to the
    // structured items, privacy-scoped by destination.
    const useRaw = rawTexts.length > 0;
    const chunks = useRaw
      ? buildRawDiscoveryCorpus(rawTexts, { maxCharsPerChunk: input.maxCharsPerChunk })
      : buildDiscoveryCorpus(input.extractions, {
          includePrivate: local,
          maxCharsPerChunk: input.maxCharsPerChunk,
        });

    // "Both" → the model REVIEWS/REFINES the parser's skill detections (kept,
    // corrected, dropped, or augmented); "AI only" → the model discovers from
    // the evidence alone. The returned list is the candidate set the user
    // reviews — it is NOT deduped against the script baseline, because in review
    // mode the refined list is meant to REPLACE the raw parser detections, and
    // in AI-only mode the map is built purely from what the model returns.
    const review = input.review === true;
    // The parser skills shown to the model in review mode must honour the same
    // privacy scope as the corpus: a keyed cloud (third-party) destination
    // excludes private skills (R46.4); a keyless local destination may include
    // them (R7.6). Derived from privacy-scoped extractions, not the full
    // baseline map (which is not privacy-filtered).
    const scriptSkills = review
      ? generate(input.extractions.filter((it) => local || it.private !== true)).entries.map(
          (e) => e.name,
        )
      : [];

    const seen = new Set<string>();
    const found: SkillDiscoverySuggestion[] = [];
    for (const chunk of chunks) {
      const prompt = review ? buildReviewPrompt(scriptSkills, chunk) : buildDiscoveryPrompt(chunk);
      const reply = await this.transport(prompt, dest);
      for (const name of parseDiscoveredSkills(reply, seen)) {
        seen.add(name.toLowerCase());
        found.push(name);
      }
    }
    return found;
  }
}

/** Construct a {@link SkillDiscoveryOperation} bound to a gate-routed transport. */
export function createSkillDiscoveryOperation(
  transport: AssistTransport,
): SkillDiscoveryOperation {
  return new SkillDiscoveryOperation(transport);
}
