// Clarify-on-ambiguity mechanism (R42.3, R42.2).
//
// Requirement 42.3: "IF a document is incomplete or ambiguous, THEN THE
// Career_Agent SHALL prompt the user for clarification rather than making
// assumptions." Requirement 42.2 reinforces the spirit: accuracy is prioritised
// over latency, so the right move on uncertainty is to ask, not to guess.
//
// This module is the framework-agnostic guard that turns "I am unsure" into an
// explicit clarification request the UI can surface, and it NEVER silently
// resolves an ambiguous or incomplete field. The single decision point is
// {@link clarifyOrResolve}:
//
//   * 0 candidate values  → the field is INCOMPLETE → request clarification.
//   * 1 candidate value   → unambiguous → resolve to that value.
//   * 2+ distinct values  → AMBIGUOUS → request clarification (never auto-pick).
//
// Because the multi-candidate branch returns a request rather than choosing,
// the "rather than making assumptions" guarantee of R42.3 holds structurally:
// there is no code path that selects among competing values without the user.
// User-supplied clarifications are authoritative (consistent with R39.1).

/** Why a field needs clarification before it can be used (R42.3). */
export type ClarificationReason =
  /** No value was found for the field — the document is incomplete. */
  | 'incomplete'
  /** Multiple conflicting values were found — the document is ambiguous. */
  | 'ambiguous';

/**
 * A request for the user to clarify an incomplete or ambiguous field (R42.3),
 * rather than the agent assuming a value. Carries the field, the reason, the
 * competing candidate values (if any), and the i18n key the UI uses to render
 * the prompt — so no user-facing string is hardcoded here (R41.8).
 */
export interface ClarificationRequest {
  /** Stable field/topic identifier the clarification is about. */
  readonly field: string;
  /** Whether the field is incomplete (no value) or ambiguous (many values). */
  readonly reason: ClarificationReason;
  /** Distinct candidate values found, in first-seen order (empty if none). */
  readonly candidates: readonly string[];
  /** i18n key for the prompt message (resolved + interpolated by the UI). */
  readonly messageKey: string;
}

/** i18n message keys for the two clarification reasons (R41.8). */
export const CLARIFICATION_MESSAGE_KEYS: Readonly<Record<ClarificationReason, string>> =
  Object.freeze({
    incomplete: 'privacy.clarification.incomplete',
    ambiguous: 'privacy.clarification.ambiguous',
  });

/**
 * The outcome of {@link clarifyOrResolve}: EITHER a confidently resolved value
 * OR a clarification request — never both, never neither. A discriminated union
 * so callers must handle the clarification branch and cannot accidentally
 * proceed on an unresolved field.
 */
export type ClarificationOutcome<T> =
  | { readonly kind: 'resolved'; readonly value: T }
  | { readonly kind: 'clarify'; readonly request: ClarificationRequest };

/** Build a {@link ClarificationRequest} for `field` with the given reason. */
export const buildClarificationRequest = (
  field: string,
  reason: ClarificationReason,
  candidates: readonly string[] = [],
): ClarificationRequest => ({
  field,
  reason,
  candidates: [...candidates],
  messageKey: CLARIFICATION_MESSAGE_KEYS[reason],
});

/** Distinct values in first-seen order (so candidate lists are deduplicated). */
const distinct = <T>(values: readonly T[]): T[] => {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
};

/**
 * Decide whether a field can be resolved or must be clarified (R42.3, R42.2).
 *
 * Given the candidate values extracted for a field, this resolves ONLY when
 * exactly one distinct candidate exists. With none it reports `incomplete`;
 * with two or more distinct candidates it reports `ambiguous` — and in neither
 * case does it pick a value, so the agent never assumes (R42.3). Duplicate
 * candidates that are truly the same value collapse to one (so repeated
 * agreement is not mistaken for conflict).
 */
export function clarifyOrResolve(
  field: string,
  candidates: readonly string[],
): ClarificationOutcome<string> {
  const distinctCandidates = distinct(candidates);

  if (distinctCandidates.length === 1) {
    return { kind: 'resolved', value: distinctCandidates[0] };
  }

  const reason: ClarificationReason =
    distinctCandidates.length === 0 ? 'incomplete' : 'ambiguous';
  return {
    kind: 'clarify',
    request: buildClarificationRequest(field, reason, distinctCandidates),
  };
}

/**
 * Convenience predicate: does this set of candidate values require user
 * clarification (R42.3)? True unless exactly one distinct value is present.
 */
export const needsClarification = (candidates: readonly string[]): boolean =>
  clarifyOrResolve('', candidates).kind === 'clarify';
