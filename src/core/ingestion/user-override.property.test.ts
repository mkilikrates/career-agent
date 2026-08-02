// Feature: career-agent, Property 18: User override supremacy
//
// For any field on which the user issues an override, the persisted value equals
// the user-supplied value, and any agent concern about that override is recorded
// at most once with no refusal to proceed.
//
// **Validates: Requirements 39.1, 39.2**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { asDocId, asISODate, asItemId, type ExtractedItem, type ItemId, type ISODate } from '@core/types';
import { sourceLine, trailOf } from '@core/provenance';
import { applyUserOverride, ConcernLog } from './review';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const doc = asDocId('test-doc.pdf');

/** Generate an arbitrary item ID. */
const arbItemId: fc.Arbitrary<ItemId> = fc
  .integer({ min: 1, max: 50 })
  .map((n) => asItemId(`item-${n}`));

/** Generate a field name. */
const arbFieldName = fc.stringMatching(/^[a-z][a-zA-Z]{2,15}$/);

/** Generate a field value (the user's override). */
const arbFieldValue = fc.oneof(
  fc.string({ minLength: 1, maxLength: 100 }),
  fc.integer({ min: 0, max: 9999 }),
  fc.boolean(),
);

/** Generate an ISO date. */
const arbDate: fc.Arbitrary<ISODate> = fc
  .tuple(fc.integer({ min: 2020, max: 2025 }), fc.integer({ min: 1, max: 12 }))
  .map(([y, m]) => asISODate(`${y}-${String(m).padStart(2, '0')}-15`));

/** Generate a concern message. */
const arbConcern = fc.string({ minLength: 5, maxLength: 100 });

/** Generate an extracted item with a specific ID. */
const arbItem = (id: ItemId): fc.Arbitrary<ExtractedItem> =>
  fc
    .record({
      title: fc.string({ minLength: 1, maxLength: 30 }),
      employer: fc.string({ minLength: 1, maxLength: 30 }),
      description: fc.string({ minLength: 1, maxLength: 50 }),
    })
    .map((fields) => ({
      id,
      type: 'employment' as const,
      fields,
      confidence: 'Medium' as const,
      provenance: trailOf(sourceLine(doc, 1, 'test')),
      userConfirmed: false,
      private: false,
      sourceDoc: doc,
    }));

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('@core/ingestion — Property 18: User override supremacy', () => {
  it('the persisted value equals exactly the user-supplied value (R39.1)', () => {
    fc.assert(
      fc.property(
        arbItemId.chain((id) =>
          fc.tuple(
            arbItem(id),
            arbFieldName,
            arbFieldValue,
            arbDate,
          ).map(([item, field, value, at]) => ({ id, item, field, value, at })),
        ),
        ({ id, item, field, value, at }) => {
          const items = [item];
          const result = applyUserOverride(items, id, { [field]: value }, at);

          // Find the updated item
          const updated = result.items.find((i) => i.id === id);
          expect(updated).toBeDefined();

          // The persisted field value equals the user-supplied value exactly
          expect(updated!.fields[field]).toEqual(value);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('the override always proceeds (never refused, R39.2)', () => {
    fc.assert(
      fc.property(
        arbItemId.chain((id) =>
          fc.tuple(
            arbItem(id),
            arbFieldName,
            arbFieldValue,
            arbDate,
            arbConcern,
          ).map(([item, field, value, at, concern]) => ({
            id, item, field, value, at, concern,
          })),
        ),
        ({ id, item, field, value, at, concern }) => {
          const items = [item];
          const log = new ConcernLog();

          // Even with a concern, the override proceeds
          const result = applyUserOverride(items, id, { [field]: value }, at, {
            concern: { field, message: concern },
            concernLog: log,
          });

          // Result items always contain the override (not refused)
          const updated = result.items.find((i) => i.id === id);
          expect(updated).toBeDefined();
          expect(updated!.fields[field]).toEqual(value);

          // Item is now user-confirmed (authoritative)
          expect(updated!.userConfirmed).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a concern is recorded at most once per (item, field) pair (R39.2)', () => {
    fc.assert(
      fc.property(
        arbItemId.chain((id) =>
          fc.tuple(
            arbItem(id),
            arbFieldName,
            fc.array(arbFieldValue, { minLength: 2, maxLength: 5 }),
            arbDate,
            arbConcern,
          ).map(([item, field, values, at, concern]) => ({
            id, item, field, values, at, concern,
          })),
        ),
        ({ id, item, field, values, at, concern }) => {
          const log = new ConcernLog();
          let items: ExtractedItem[] = [item];

          let firstRecorded = false;
          let subsequentRecords = 0;

          for (const value of values) {
            const result = applyUserOverride(items, id, { [field]: value }, at, {
              concern: { field, message: concern },
              concernLog: log,
            });
            items = result.items;

            if (!firstRecorded && result.concernRecorded) {
              firstRecorded = true;
            } else if (firstRecorded && result.concernRecorded) {
              subsequentRecords++;
            }
          }

          // The concern was recorded at most once
          expect(subsequentRecords).toBe(0);

          // The log has at most one entry for this (item, field)
          const allConcerns = log.all().filter(
            (c) => c.itemId === id && c.field === field,
          );
          expect(allConcerns.length).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('the override attaches user-confirmation provenance (R12.4)', () => {
    fc.assert(
      fc.property(
        arbItemId.chain((id) =>
          fc.tuple(arbItem(id), arbFieldName, arbFieldValue, arbDate).map(
            ([item, field, value, at]) => ({ id, item, field, value, at }),
          ),
        ),
        ({ id, item, field, value, at }) => {
          const result = applyUserOverride([item], id, { [field]: value }, at);
          const updated = result.items.find((i) => i.id === id)!;

          // Has at least one user_confirmation provenance
          const hasUserProv = updated.provenance.some(
            (p) => p.kind === 'user_confirmation',
          );
          expect(hasUserProv).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
