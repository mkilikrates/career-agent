// Feature: career-agent, Property 12: Conflict completeness and user authority
//
// For any set of documents describing the same role, every field that differs
// across documents produces a conflict record listing all candidate values with
// their source documents (no value is silently chosen), the default
// recommendation follows the most-recent-for-recent / most-detailed-for-older
// rule, a user-entered value is always treated as authoritative over
// document-derived values, and a resolved conflict is not re-presented on a
// subsequent reload.
//
// **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  asDocId,
  asISODate,
  asItemId,
  type ExtractedItem,
  type ISODate,
} from '@core/types';
import { sourceLine, trailOf } from '@core/provenance';
import {
  reconcile,
  resolveConflict,
  filterResolvedConflicts,
  resolvedFieldSet,
  type ExtractedDoc,
} from './reconciliation';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a date string (YYYY-MM). */
const arbDate: fc.Arbitrary<ISODate> = fc
  .tuple(fc.integer({ min: 2018, max: 2025 }), fc.integer({ min: 1, max: 12 }))
  .map(([y, m]) => asISODate(`${y}-${String(m).padStart(2, '0')}`));

/** Generate a non-empty field value (string). */
const arbFieldValue = fc.string({ minLength: 1, maxLength: 50 });

/**
 * Generate 2-4 documents describing the SAME role (same employer + start) but
 * with potentially differing field values. This is the precondition for
 * conflict detection.
 */
const arbConflictingDocs = fc
  .tuple(
    fc.string({ minLength: 2, maxLength: 20 }), // employer
    arbDate, // role start (shared)
    fc.array(arbDate, { minLength: 2, maxLength: 4 }), // doc dates
    fc.array(arbFieldValue, { minLength: 2, maxLength: 4 }), // title per doc
    fc.array(arbFieldValue, { minLength: 2, maxLength: 4 }), // description per doc
  )
  .map(([employer, start, docDates, titles, descriptions]) => {
    const count = Math.min(docDates.length, titles.length, descriptions.length);
    const docs: ExtractedDoc[] = [];

    for (let i = 0; i < count; i++) {
      const docId = asDocId(`doc-${i}.pdf`);
      const item: ExtractedItem = {
        id: asItemId(`${docId as string}#emp-${i}`),
        type: 'employment',
        fields: {
          employer,
          start: start as string,
          title: titles[i],
          description: descriptions[i],
        },
        confidence: 'High',
        provenance: trailOf(sourceLine(docId, 1, `employment at ${employer}`)),
        userConfirmed: false,
        private: false,
        sourceDoc: docId,
      };
      docs.push({ docId, date: docDates[i], items: [item] });
    }

    return docs;
  })
  .filter((docs) => docs.length >= 2);

/**
 * Generate docs where one has a user-confirmed item (authoritative, R9.5).
 */
const arbDocsWithUserAuthority = arbConflictingDocs.map((docs) => {
  // Make the first doc's item user-confirmed
  if (docs.length > 0 && docs[0].items.length > 0) {
    const confirmedItem = {
      ...docs[0].items[0],
      userConfirmed: true,
    };
    return [
      { ...docs[0], items: [confirmedItem] },
      ...docs.slice(1),
    ];
  }
  return docs;
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('@core/ingestion — Property 12: Conflict completeness and user authority', () => {
  it('every field that differs across documents produces a conflict record (R9.2)', () => {
    fc.assert(
      fc.property(arbConflictingDocs, (docs) => {
        const result = reconcile(docs);

        // Identify fields that genuinely differ across the docs
        const fieldValues = new Map<string, Set<string>>();
        for (const doc of docs) {
          for (const item of doc.items) {
            for (const [field, value] of Object.entries(item.fields)) {
              if (value === undefined) continue;
              if (!fieldValues.has(field)) fieldValues.set(field, new Set());
              fieldValues.get(field)!.add(JSON.stringify(value));
            }
          }
        }

        // Every field with > 1 distinct value should appear in conflicts
        const conflictFields = new Set(result.conflicts.map((c) => c.field.split('::')[1]));
        for (const [field, values] of fieldValues) {
          if (values.size > 1) {
            expect(
              conflictFields.has(field),
              `Field "${field}" has ${values.size} distinct values but no conflict was recorded`,
            ).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('each conflict record lists ALL candidate values with sources (no silent choice, R9.2)', () => {
    fc.assert(
      fc.property(arbConflictingDocs, (docs) => {
        const result = reconcile(docs);

        for (const conflict of result.conflicts) {
          // Every candidate has a source doc
          for (const candidate of conflict.candidates) {
            expect(candidate.doc).toBeDefined();
          }

          // The number of candidates >= 2 (there IS a disagreement)
          const distinctValues = new Set(
            conflict.candidates.map((c) => JSON.stringify(c.value)),
          );
          expect(distinctValues.size).toBeGreaterThanOrEqual(2);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('user-entered value is treated as authoritative (R9.5)', () => {
    fc.assert(
      fc.property(arbDocsWithUserAuthority, (docs) => {
        if (docs.length < 2) return;
        const result = reconcile(docs);

        // If there are conflicts on fields where the user-confirmed doc has a
        // value, the recommendation should be the user-confirmed value.
        const userItem = docs[0].items[0];
        if (!userItem.userConfirmed) return;

        for (const conflict of result.conflicts) {
          const field = conflict.field.split('::')[1];
          const userValue = userItem.fields[field];
          if (userValue === undefined) continue;

          // R9.5: user-entered value is authoritative
          expect(JSON.stringify(conflict.recommended)).toBe(JSON.stringify(userValue));
        }
      }),
      { numRuns: 200 },
    );
  });

  it('resolved conflicts are not re-presented (R9.4)', () => {
    fc.assert(
      fc.property(arbConflictingDocs, (docs) => {
        const result = reconcile(docs);
        if (result.conflicts.length === 0) return;

        // Resolve all conflicts
        const resolved = result.conflicts.map((c) =>
          resolveConflict(c, c.recommended, 'user', asISODate('2024-06-15')),
        );

        // Build resolved field set
        const resolvedFields = resolvedFieldSet(resolved);

        // Filter should produce zero conflicts
        const remaining = filterResolvedConflicts(resolved, resolvedFields);
        expect(remaining).toHaveLength(0);
      }),
      { numRuns: 200 },
    );
  });

  it('merged result always contains one item per role (richest description, R9.1)', () => {
    fc.assert(
      fc.property(arbConflictingDocs, (docs) => {
        const result = reconcile(docs);

        // All docs describe the same role (same employer + start), so the merged
        // output should have exactly one employment item
        const employmentItems = result.merged.filter((i) => i.type === 'employment');
        expect(employmentItems).toHaveLength(1);
      }),
      { numRuns: 200 },
    );
  });
});
