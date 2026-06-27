// Output eligibility gating (R11.2, R11.3, R11.4, R12.3, R12.4).
//
// Not every extracted item may appear in generated output. The eligible set is
// exactly:
//   * every **High**-confidence item, plus
//   * every **user-confirmed / user-edited** item (raised to highest
//     reliability, R12.4 — covers confirmed Medium items, R11.3), plus
//   * every **explicitly promoted Low** item (R11.4),
//   * EXCLUDING every item marked **private** (R12.3).
//
// Low items that are neither confirmed nor promoted are routed to a
// needs-review bucket and excluded from output until the user promotes them
// (R11.4). Confirming/editing an item also attaches a user-confirmation
// provenance record so its highest-reliability status is itself sourced (R12.4,
// R38.1).

import type { ExtractedItem, ISODate, ItemId } from '@core/types';
import { userConfirmation } from '@core/provenance';

/** The partition of extracted items by output eligibility (R11.2–R11.4). */
export interface EligibilityResult {
  /** Items eligible to appear in output (R11.2, R11.3, R11.4 — private excluded). */
  readonly eligible: ExtractedItem[];
  /** Low items awaiting promotion; excluded from output until promoted (R11.4). */
  readonly needsReview: ExtractedItem[];
}

/** Inputs to {@link computeEligibility}. */
export interface EligibilityInput {
  readonly items: readonly ExtractedItem[];
  /** Ids of Low items the user has explicitly promoted (R11.4). */
  readonly promotedLowIds?: ReadonlySet<ItemId>;
}

/**
 * Whether an item qualifies for output, ignoring the privacy exclusion (R11.2,
 * R11.3, R11.4, R12.4): High confidence, OR user-confirmed/edited (highest
 * reliability), OR an explicitly promoted Low item.
 */
const qualifies = (item: ExtractedItem, promoted: ReadonlySet<ItemId>): boolean =>
  item.confidence === 'High' || item.userConfirmed || promoted.has(item.id);

/**
 * Compute the output-eligible set and the needs-review bucket (R11.2–R11.4,
 * R12.3). Private items are never eligible (R12.3); Low items that are neither
 * user-confirmed nor promoted go to needs-review (R11.4).
 */
export const computeEligibility = (input: EligibilityInput): EligibilityResult => {
  const promoted = input.promotedLowIds ?? new Set<ItemId>();
  const eligible: ExtractedItem[] = [];
  const needsReview: ExtractedItem[] = [];

  for (const item of input.items) {
    if (!item.private && qualifies(item, promoted)) {
      eligible.push(item);
    }
    // Needs-review bucket: Low items not yet confirmed or promoted (R11.4).
    if (item.confidence === 'Low' && !item.userConfirmed && !promoted.has(item.id)) {
      needsReview.push(item);
    }
  }

  return { eligible, needsReview };
};

/**
 * Mark an item as user-confirmed and raise it to highest reliability with a
 * user-confirmation provenance record (R12.4, R38.1). Returns a new item; the
 * input is not mutated.
 */
export const confirmItem = (
  item: ExtractedItem,
  at: ISODate,
  note = 'User confirmed during ingestion review.',
): ExtractedItem => ({
  ...item,
  userConfirmed: true,
  provenance: [...item.provenance, userConfirmation(at, note)],
});

/**
 * Explicitly promote a Low-confidence item so it becomes output-eligible
 * (R11.4) without marking it user-confirmed. Non-Low items are returned
 * unchanged. Promotion is represented by membership in the promoted-id set
 * passed to {@link computeEligibility}; this helper simply returns that id.
 */
export const promoteLow = (item: ExtractedItem): ItemId => item.id;
