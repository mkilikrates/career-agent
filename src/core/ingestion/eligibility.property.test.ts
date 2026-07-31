// Feature: career-agent, Property 7: Output eligibility gating
//
// For any set of ExtractedItems with mixed confidence (High/Medium/Low),
// confirmation, and privacy flags, the eligible set is exactly:
// High-confidence + user-confirmed Medium + explicitly promoted Low, EXCLUDING
// every item marked private.
//
// **Validates: Requirements 11.2, 11.3, 11.4, 12.3, 12.4**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { asDocId, asItemId, type Confidence, type ExtractedItem, type ItemId } from '@core/types';
import { sourceLine, trailOf } from '@core/provenance';
import { computeEligibility } from './eligibility';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const doc = asDocId('test.md');

const arbConfidence: fc.Arbitrary<Confidence> = fc.constantFrom('High', 'Medium', 'Low');

/** Generate an ExtractedItem with random confidence, confirmed, and private flags. */
const arbItem = (index: number): fc.Arbitrary<ExtractedItem> =>
  fc
    .tuple(arbConfidence, fc.boolean(), fc.boolean())
    .map(([confidence, userConfirmed, isPrivate]) => ({
      id: asItemId(`ITEM-${index}`),
      type: 'skill' as const,
      fields: { name: `skill-${index}` },
      confidence,
      provenance: trailOf(sourceLine(doc, index + 1, `item ${index}`)),
      userConfirmed,
      private: isPrivate,
      sourceDoc: doc,
    }));

/** Generate an array of 1-20 items with mixed flags. */
const arbItems = fc
  .integer({ min: 1, max: 20 })
  .chain((count) => fc.tuple(...Array.from({ length: count }, (_, i) => arbItem(i))));

/**
 * Generate a subset of Low-confidence item IDs to be explicitly promoted.
 * Only Low items can be meaningfully promoted.
 */
const arbPromotedSet = (items: ExtractedItem[]): fc.Arbitrary<Set<ItemId>> => {
  const lowIds = items.filter((i) => i.confidence === 'Low').map((i) => i.id);
  if (lowIds.length === 0) return fc.constant(new Set<ItemId>());
  return fc.subarray(lowIds).map((ids) => new Set<ItemId>(ids));
};

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe('@core/ingestion — Property 7: Output eligibility gating', () => {
  it('eligible set matches the expected formula: High + confirmed Medium + promoted Low − private', () => {
    fc.assert(
      fc.property(
        arbItems.chain((items) =>
          arbPromotedSet(items).map((promoted) => ({ items, promoted })),
        ),
        ({ items, promoted }) => {
          const result = computeEligibility({ items, promotedLowIds: promoted });

          // Compute expected eligible set manually
          const expectedEligible = items.filter((item) => {
            // Private items are always excluded
            if (item.private) return false;
            // High confidence → eligible
            if (item.confidence === 'High') return true;
            // User-confirmed → eligible (regardless of confidence level)
            if (item.userConfirmed) return true;
            // Explicitly promoted Low → eligible
            if (item.confidence === 'Low' && promoted.has(item.id)) return true;
            return false;
          });

          // Verify the eligible set matches exactly
          const eligibleIds = new Set(result.eligible.map((i) => i.id));
          const expectedIds = new Set(expectedEligible.map((i) => i.id));

          expect(eligibleIds).toEqual(expectedIds);
        },
      ),
    );
  });

  it('every private item is excluded from the eligible set regardless of confidence or confirmation', () => {
    fc.assert(
      fc.property(
        arbItems.chain((items) =>
          arbPromotedSet(items).map((promoted) => ({ items, promoted })),
        ),
        ({ items, promoted }) => {
          const result = computeEligibility({ items, promotedLowIds: promoted });
          const eligibleIds = new Set(result.eligible.map((i) => i.id));

          // No private item should be in the eligible set
          const privateItems = items.filter((i) => i.private);
          for (const privateItem of privateItems) {
            expect(eligibleIds.has(privateItem.id)).toBe(false);
          }
        },
      ),
    );
  });

  it('needs-review bucket contains exactly unpromoted, unconfirmed Low items', () => {
    fc.assert(
      fc.property(
        arbItems.chain((items) =>
          arbPromotedSet(items).map((promoted) => ({ items, promoted })),
        ),
        ({ items, promoted }) => {
          const result = computeEligibility({ items, promotedLowIds: promoted });

          // Expected needs-review: Low items that are neither confirmed nor promoted
          const expectedNeedsReview = items.filter(
            (item) =>
              item.confidence === 'Low' &&
              !item.userConfirmed &&
              !promoted.has(item.id),
          );

          const reviewIds = new Set(result.needsReview.map((i) => i.id));
          const expectedReviewIds = new Set(expectedNeedsReview.map((i) => i.id));

          expect(reviewIds).toEqual(expectedReviewIds);
        },
      ),
    );
  });
});
