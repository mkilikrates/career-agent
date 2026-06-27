import { describe, expect, it } from 'vitest';
import {
  asDocId,
  asISODate,
  asItemId,
  type Confidence,
  type ExtractedItem,
  type ItemId,
} from '@core/types';
import { sourceLine, trailOf } from '@core/provenance';
import { computeEligibility, confirmItem } from './eligibility';

const doc = asDocId('cv.md');

const item = (
  id: string,
  confidence: Confidence,
  opts: { userConfirmed?: boolean; private?: boolean } = {},
): ExtractedItem => ({
  id: asItemId(id),
  type: 'skill',
  fields: { name: id },
  confidence,
  provenance: trailOf(sourceLine(doc, 1, id)),
  userConfirmed: opts.userConfirmed ?? false,
  private: opts.private ?? false,
  sourceDoc: doc,
});

describe('@core/ingestion — computeEligibility (R11.2, R11.3, R11.4, R12.3, R12.4)', () => {
  it('includes High items and excludes private items', () => {
    const high = item('high', 'High');
    const privateHigh = item('priv', 'High', { private: true });
    const { eligible } = computeEligibility({ items: [high, privateHigh] });
    expect(eligible.map((i) => i.id)).toEqual([high.id]);
  });

  it('includes user-confirmed Medium items (R11.3, R12.4)', () => {
    const medium = item('m', 'Medium');
    const confirmedMedium = item('cm', 'Medium', { userConfirmed: true });
    const { eligible } = computeEligibility({ items: [medium, confirmedMedium] });
    expect(eligible.map((i) => i.id)).toEqual([confirmedMedium.id]);
  });

  it('routes unpromoted Low items to needs-review and excludes them from output (R11.4)', () => {
    const low = item('low', 'Low');
    const { eligible, needsReview } = computeEligibility({ items: [low] });
    expect(eligible).toEqual([]);
    expect(needsReview.map((i) => i.id)).toEqual([low.id]);
  });

  it('includes explicitly promoted Low items (R11.4)', () => {
    const low = item('low', 'Low');
    const { eligible, needsReview } = computeEligibility({
      items: [low],
      promotedLowIds: new Set<ItemId>([low.id]),
    });
    expect(eligible.map((i) => i.id)).toEqual([low.id]);
    expect(needsReview).toEqual([]);
  });

  it('excludes a private item even when High or promoted (R12.3)', () => {
    const privateLow = item('pl', 'Low', { private: true });
    const { eligible } = computeEligibility({
      items: [privateLow],
      promotedLowIds: new Set<ItemId>([privateLow.id]),
    });
    expect(eligible).toEqual([]);
  });
});

describe('@core/ingestion — confirmItem raises reliability with provenance (R12.4, R38.1)', () => {
  it('marks the item user-confirmed and appends a user-confirmation record', () => {
    const before = item('x', 'Medium');
    const after = confirmItem(before, asISODate('2024-06-01'), 'looks right');
    expect(after.userConfirmed).toBe(true);
    expect(after.provenance.at(-1)).toMatchObject({
      kind: 'user_confirmation',
      note: 'looks right',
    });
    // input is not mutated
    expect(before.userConfirmed).toBe(false);
    expect(before.provenance).toHaveLength(1);
  });

  it('makes a confirmed Medium item eligible', () => {
    const after = confirmItem(item('x', 'Medium'), asISODate('2024-06-01'));
    expect(computeEligibility({ items: [after] }).eligible).toHaveLength(1);
  });
});
