import { describe, expect, it } from 'vitest';
import {
  asDocId,
  asISODate,
  asItemId,
  type DocId,
  type ExtractedItem,
} from '@core/types';
import { sourceLine, trailOf, userConfirmation } from '@core/provenance';
import {
  conflictResolutionLog,
  filterResolvedConflicts,
  reconcile,
  resolveConflict,
  resolvedFieldSet,
  type ExtractedDoc,
} from './reconciliation';

const employment = (
  doc: DocId,
  fields: Record<string, unknown>,
  opts: { userEntered?: boolean } = {},
): ExtractedItem => ({
  id: asItemId(`${doc as unknown as string}#emp`),
  type: 'employment',
  fields,
  confidence: 'High',
  provenance: opts.userEntered
    ? trailOf(userConfirmation(asISODate('2024-01-01'), 'user'))
    : trailOf(sourceLine(doc, 1, 'role')),
  userConfirmed: opts.userEntered ?? false,
  private: false,
  sourceDoc: doc,
});

const docA = asDocId('cv_2024.md');
const docB = asDocId('cv_2019.md');

// A fixed "now" so recency is deterministic.
const now = () => ({ year: 2024, month: 6 });

describe('@core/ingestion — reconcile merges the richest description (R9.1)', () => {
  it('merges the same role across documents into a single item', () => {
    const docs: ExtractedDoc[] = [
      { docId: docA, date: asISODate('2024-01'), items: [employment(docA, { employer: 'Acme', title: 'Engineer', responsibilities: ['Led migration of the core platform'] })] },
      { docId: docB, date: asISODate('2019-01'), items: [employment(docB, { employer: 'Acme', title: 'Engineer', responsibilities: ['Worked on platform'] })] },
    ];
    const { merged } = reconcile(docs, { now });
    const roles = merged.filter((m) => m.type === 'employment');
    expect(roles).toHaveLength(1);
    // Richest (longest) responsibilities wins the field for an older role.
    expect(roles[0].fields.employer).toBe('Acme');
  });
});

describe('@core/ingestion — conflict completeness (R9.2)', () => {
  it('records every differing field with all candidate values and their sources', () => {
    const docs: ExtractedDoc[] = [
      { docId: docA, date: asISODate('2024-01'), items: [employment(docA, { employer: 'Acme', title: 'Senior Engineer', end: '2024-01' })] },
      { docId: docB, date: asISODate('2019-01'), items: [employment(docB, { employer: 'Acme', title: 'Engineer', end: '2024-01' })] },
    ];
    const { conflicts } = reconcile(docs, { now });
    const titleConflict = conflicts.find((c) => c.field.endsWith('::title'));
    expect(titleConflict).toBeDefined();
    expect(titleConflict?.candidates.map((c) => c.value).sort()).toEqual([
      'Engineer',
      'Senior Engineer',
    ]);
    expect(titleConflict?.candidates.map((c) => c.doc)).toEqual(
      expect.arrayContaining([docA, docB]),
    );
  });

  it('does not record a conflict when documents agree', () => {
    const docs: ExtractedDoc[] = [
      { docId: docA, items: [employment(docA, { employer: 'Acme', title: 'Engineer' })] },
      { docId: docB, items: [employment(docB, { employer: 'Acme', title: 'Engineer' })] },
    ];
    expect(reconcile(docs, { now }).conflicts).toEqual([]);
  });
});

describe('@core/ingestion — default recommendation heuristic (R9.3)', () => {
  it('recommends the most recent document value for a recent (ongoing) role', () => {
    const docs: ExtractedDoc[] = [
      { docId: docA, date: asISODate('2024-01'), items: [employment(docA, { employer: 'Acme', title: 'Staff Engineer' })] },
      { docId: docB, date: asISODate('2019-01'), items: [employment(docB, { employer: 'Acme', title: 'Engineer' })] },
    ];
    const conflict = reconcile(docs, { now }).conflicts.find((c) => c.field.endsWith('::title'));
    expect(conflict?.recommended).toBe('Staff Engineer'); // from the newer doc
  });

  it('recommends the most detailed value for an older, ended role', () => {
    const docs: ExtractedDoc[] = [
      { docId: docA, date: asISODate('2024-01'), items: [employment(docA, { employer: 'Globex', title: 'Eng', end: '2010-01' })] },
      { docId: docB, date: asISODate('2011-01'), items: [employment(docB, { employer: 'Globex', title: 'Software Engineer', end: '2010-01' })] },
    ];
    const conflict = reconcile(docs, { now }).conflicts.find((c) => c.field.endsWith('::title'));
    expect(conflict?.recommended).toBe('Software Engineer'); // most detailed wins
  });
});

describe('@core/ingestion — user-entered value is authoritative (R9.5)', () => {
  it('recommends the user-entered value over document-derived values', () => {
    const docs: ExtractedDoc[] = [
      { docId: docA, date: asISODate('2024-01'), items: [employment(docA, { employer: 'Acme', title: 'Engineer' })] },
      { docId: docB, date: asISODate('2024-01'), items: [employment(docB, { employer: 'Acme', title: 'Principal Engineer' }, { userEntered: true })] },
    ];
    const conflict = reconcile(docs, { now }).conflicts.find((c) => c.field.endsWith('::title'));
    expect(conflict?.recommended).toBe('Principal Engineer');
  });
});

describe('@core/ingestion — resolution logging (R9.4)', () => {
  it('marks a conflict resolved and filters it from a subsequent reload', () => {
    const docs: ExtractedDoc[] = [
      { docId: docA, date: asISODate('2024-01'), items: [employment(docA, { employer: 'Acme', title: 'A' })] },
      { docId: docB, date: asISODate('2019-01'), items: [employment(docB, { employer: 'Acme', title: 'B' })] },
    ];
    const { conflicts } = reconcile(docs, { now });
    expect(conflicts).toHaveLength(1);

    const resolved = resolveConflict(conflicts[0], 'A', 'user', asISODate('2024-06-01'));
    const fields = resolvedFieldSet([resolved]);
    expect(filterResolvedConflicts(conflicts, fields)).toEqual([]);

    const log = conflictResolutionLog([resolved]);
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe('conflict-resolution');
    expect(log[0].message).toContain('Resolved conflict');
  });
});

describe('@core/ingestion — non-employment items pass through', () => {
  it('leaves skills untouched (Skill_Mapper owns de-duplication)', () => {
    const skill: ExtractedItem = {
      id: asItemId('s1'),
      type: 'skill',
      fields: { name: 'Go' },
      confidence: 'High',
      provenance: trailOf(sourceLine(docA, 1, 'Go')),
      userConfirmed: false,
      private: false,
      sourceDoc: docA,
    };
    const { merged } = reconcile([{ docId: docA, items: [skill] }], { now });
    expect(merged).toContainEqual(skill);
  });
});
