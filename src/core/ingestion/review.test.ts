import { describe, expect, it } from 'vitest';
import {
  asDocId,
  asISODate,
  asItemId,
  type DocId,
  type ExtractedItem,
} from '@core/types';
import { sourceLine, trailOf } from '@core/provenance';
import type { EmploymentRecord } from './extraction';
import {
  add,
  annotateGap,
  applyUserOverride,
  ConcernLog,
  confirm,
  detectGaps,
  edit,
  groupByDocument,
  markPrivate,
  NEUTRAL_GAP_FRAMING,
  remove,
} from './review';

const mkItem = (id: string, doc: DocId): ExtractedItem => ({
  id: asItemId(id),
  type: 'employment',
  fields: { employer: 'Acme', title: 'Engineer' },
  confidence: 'Medium',
  provenance: trailOf(sourceLine(doc, 1, 'role')),
  userConfirmed: false,
  private: false,
  sourceDoc: doc,
});

const docA = asDocId('cv_a.md');
const docB = asDocId('cv_b.md');

describe('@core/ingestion — groupByDocument (R12.1)', () => {
  it('groups items by source document preserving first-seen order', () => {
    const groups = groupByDocument([
      mkItem('a1', docA),
      mkItem('b1', docB),
      mkItem('a2', docA),
    ]);
    expect(groups.map((g) => g.doc)).toEqual([docA, docB]);
    expect(groups[0].items.map((i) => i.id)).toEqual([asItemId('a1'), asItemId('a2')]);
  });
});

describe('@core/ingestion — review/correction operations (R12.2, R12.3, R12.4)', () => {
  const items = [mkItem('a1', docA)];
  const at = asISODate('2024-06-01');

  it('confirm raises reliability and adds user-confirmation provenance', () => {
    const [confirmed] = confirm(items, asItemId('a1'), at);
    expect(confirmed.userConfirmed).toBe(true);
    expect(confirmed.provenance.at(-1)?.kind).toBe('user_confirmation');
  });

  it('edit updates fields and records the edit as user-confirmed', () => {
    const [edited] = edit(items, asItemId('a1'), { title: 'Staff Engineer' }, at);
    expect(edited.fields.title).toBe('Staff Engineer');
    expect(edited.userConfirmed).toBe(true);
  });

  it('remove deletes the item', () => {
    expect(remove(items, asItemId('a1'))).toEqual([]);
  });

  it('markPrivate flags an item private (stored but never output)', () => {
    const [priv] = markPrivate(items, asItemId('a1'));
    expect(priv.private).toBe(true);
  });

  it('add inserts user-entered information with user-confirmation provenance', () => {
    const result = add(
      items,
      { id: asItemId('new'), type: 'skill', fields: { name: 'Rust' }, sourceDoc: docA },
      at,
    );
    const added = result.at(-1)!;
    expect(added.userConfirmed).toBe(true);
    expect(added.provenance[0].kind).toBe('user_confirmation');
    expect(added.confidence).toBe('High');
  });
});

describe('@core/ingestion — detectGaps (R10.4, R13.1, R13.4)', () => {
  const role = (employer: string, start: string, end?: string): EmploymentRecord => ({
    employer,
    title: 'Engineer',
    start,
    end,
  });

  it('detects a gap longer than three months with neutral framing and honest labels', () => {
    const gaps = detectGaps([role('Acme', '2015-01', '2018-06'), role('Globex', '2019-01')]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      afterEmployer: 'Acme',
      beforeEmployer: 'Globex',
      months: 7,
      startLabel: 'June 2018',
      endLabel: 'January 2019',
      framing: NEUTRAL_GAP_FRAMING,
    });
  });

  it('does not report an interval of exactly three months (R10.4 boundary)', () => {
    expect(detectGaps([role('A', '2019-01', '2019-01'), role('B', '2019-04')])).toEqual([]);
  });

  it('reports an interval of four months', () => {
    expect(detectGaps([role('A', '2019-01', '2019-01'), role('B', '2019-05')])).toHaveLength(1);
  });

  it('reports no gap for overlapping roles', () => {
    expect(
      detectGaps([role('A', '2015-01', '2020-01'), role('B', '2018-01', '2021-01')]),
    ).toEqual([]);
  });

  it('reports no gap after an ongoing (no end) role', () => {
    expect(detectGaps([role('A', '2015-01'), role('B', '2019-01')])).toEqual([]);
  });

  it('sorts roles chronologically before measuring gaps', () => {
    const gaps = detectGaps([role('Globex', '2019-01'), role('Acme', '2015-01', '2018-06')]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].afterEmployer).toBe('Acme');
  });

  it('annotateGap attaches the user note and privacy choice (R13.2)', () => {
    const [gap] = detectGaps([role('Acme', '2015-01', '2018-06'), role('Globex', '2019-01')]);
    const annotated = annotateGap(gap, 'Caregiving sabbatical', true);
    expect(annotated.note).toBe('Caregiving sabbatical');
    expect(annotated.private).toBe(true);
  });
});

describe('@core/ingestion — user-override supremacy (R39.1, R39.2)', () => {
  const items = [mkItem('a1', docA)];
  const at = asISODate('2024-06-01');

  it('persists the user value verbatim and marks it authoritative (R39.1)', () => {
    const { items: updated } = applyUserOverride(items, asItemId('a1'), { title: 'CTO' }, at);
    expect(updated[0].fields.title).toBe('CTO');
    expect(updated[0].userConfirmed).toBe(true);
  });

  it('records an agent concern at most once and never refuses to proceed (R39.2)', () => {
    const log = new ConcernLog();
    const first = applyUserOverride(items, asItemId('a1'), { title: 'CTO' }, at, {
      concern: { field: 'title', message: 'Title not found in any source document.' },
      concernLog: log,
    });
    const second = applyUserOverride(first.items, asItemId('a1'), { title: 'CTO' }, at, {
      concern: { field: 'title', message: 'Title not found in any source document.' },
      concernLog: log,
    });

    expect(first.concernRecorded).toBe(true);
    expect(second.concernRecorded).toBe(false); // recorded at most once
    expect(log.all()).toHaveLength(1);
    // The override still proceeded both times (never refused).
    expect(second.items[0].fields.title).toBe('CTO');
  });
});
