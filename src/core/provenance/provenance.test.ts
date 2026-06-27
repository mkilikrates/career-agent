import { describe, expect, it } from 'vitest';
import {
  asBulletId,
  asDocId,
  asISODate,
  asItemId,
  asSkillId,
  asStarId,
  type Accomplishment,
  type ExtractedItem,
} from '@core/types';
import {
  ProvenanceIndex,
  buildProvenanceIndex,
  interviewAnswer,
  isProvenanceTrail,
  sourceLine,
  trailOf,
  userConfirmation,
  type ProvenanceFact,
} from './index';

describe('@core/provenance — provenance record constructors (R38.1)', () => {
  it('sourceLine produces a source_line record with the given fields', () => {
    const doc = asDocId('cv.pdf');
    const record = sourceLine(doc, 12, 'Led the platform migration');

    expect(record).toEqual({
      kind: 'source_line',
      doc,
      line: 12,
      quote: 'Led the platform migration',
    });
  });

  it('userConfirmation produces a user_confirmation record with the given fields', () => {
    const at = asISODate('2024-05-01');
    const record = userConfirmation(at, 'confirmed in review');

    expect(record).toEqual({
      kind: 'user_confirmation',
      at,
      note: 'confirmed in review',
    });
  });

  it('interviewAnswer produces an interview_answer record with the given star id', () => {
    const star = asStarId('STAR-01');
    const record = interviewAnswer(star);

    expect(record).toEqual({ kind: 'interview_answer', star });
  });
});

describe('@core/provenance — trail helpers (R38.1)', () => {
  it('trailOf builds a non-empty trail from a single record', () => {
    const record = interviewAnswer(asStarId('STAR-02'));
    const trail = trailOf(record);

    expect(trail).toEqual([record]);
    expect(trail.length).toBe(1);
  });

  it('trailOf builds a trail from multiple records preserving order', () => {
    const a = sourceLine(asDocId('cv.pdf'), 3, 'A');
    const b = userConfirmation(asISODate('2024-01-02'), 'B');
    const c = interviewAnswer(asStarId('STAR-03'));
    const trail = trailOf(a, b, c);

    expect(trail).toEqual([a, b, c]);
  });

  it('isProvenanceTrail returns true for non-empty arrays and false for empty arrays', () => {
    expect(isProvenanceTrail([interviewAnswer(asStarId('STAR-04'))])).toBe(true);
    expect(isProvenanceTrail([])).toBe(false);
  });
});

describe('ProvenanceIndex — attach + resolve / trace lookup (R38.1, R38.2)', () => {
  it('resolves a claim to a SourceTrace with the matching ref and non-empty trail', () => {
    const index = new ProvenanceIndex();
    const ref = asItemId('item-1');
    const record = sourceLine(asDocId('cv.pdf'), 5, 'Shipped feature');

    index.attach(ref, record);
    const trace = index.resolve(ref);

    expect(trace).toBeDefined();
    expect(trace?.ref).toBe(ref);
    expect(trace?.provenance).toEqual([record]);
    expect(trace?.provenance.length).toBeGreaterThanOrEqual(1);
  });

  it('lookup is equivalent to resolve', () => {
    const index = new ProvenanceIndex();
    const ref = asBulletId('BULLET-01');
    index.attach(ref, interviewAnswer(asStarId('STAR-05')));

    expect(index.lookup(ref)).toEqual(index.resolve(ref));
  });

  it('returns a defensive copy so mutating the trace does not mutate the index', () => {
    const index = new ProvenanceIndex();
    const ref = asItemId('item-2');
    index.attach(ref, sourceLine(asDocId('cv.pdf'), 1, 'one'));

    const trace = index.resolve(ref)!;
    trace.provenance.push(interviewAnswer(asStarId('STAR-06')));

    // The index's own copy is untouched.
    expect(index.resolve(ref)?.provenance.length).toBe(1);
  });

  it('accepts a ProvenanceTrail (array) when attaching', () => {
    const index = new ProvenanceIndex();
    const ref = asItemId('item-3');
    const trail = trailOf(
      sourceLine(asDocId('cv.pdf'), 2, 'two'),
      userConfirmation(asISODate('2024-03-03'), 'ok'),
    );

    index.attach(ref, trail);

    expect(index.resolve(ref)?.provenance).toEqual([...trail]);
  });
});

describe('ProvenanceIndex — accumulation and no-op attach', () => {
  it('appends records when attaching multiple times to the same claim', () => {
    const index = new ProvenanceIndex();
    const ref = asItemId('item-4');
    const first = sourceLine(asDocId('cv.pdf'), 7, 'first');
    const second = interviewAnswer(asStarId('STAR-07'));

    index.attach(ref, first);
    index.attach(ref, second);

    expect(index.resolve(ref)?.provenance).toEqual([first, second]);
    expect(index.size).toBe(1);
  });

  it('treats attaching an empty array as a no-op', () => {
    const index = new ProvenanceIndex();
    const ref = asItemId('item-5');

    index.attach(ref, []);

    expect(index.has(ref)).toBe(false);
    expect(index.size).toBe(0);
    expect(index.resolve(ref)).toBeUndefined();
  });
});

describe('ProvenanceIndex — has / refs / size / isResolved', () => {
  it('reports has, refs, size and isResolved correctly', () => {
    const index = new ProvenanceIndex();
    const a = asItemId('item-a');
    const b = asBulletId('BULLET-b');

    index.attach(a, sourceLine(asDocId('cv.pdf'), 1, 'a'));
    index.attach(b, interviewAnswer(asStarId('STAR-b')));

    expect(index.has(a)).toBe(true);
    expect(index.has(b)).toBe(true);
    expect(index.has(asItemId('item-missing'))).toBe(false);

    expect(index.size).toBe(2);
    expect(index.refs()).toEqual(expect.arrayContaining([a, b]));
    expect(index.refs()).toHaveLength(2);

    expect(index.isResolved(a)).toBe(true);
    expect(index.isResolved(asItemId('item-missing'))).toBe(false);
  });
});

describe('ProvenanceIndex — unresolved-claim detection (R38.2)', () => {
  it('resolve and lookup return undefined for an unknown claim', () => {
    const index = new ProvenanceIndex();
    const unknown = asItemId('unknown');

    expect(index.resolve(unknown)).toBeUndefined();
    expect(index.lookup(unknown)).toBeUndefined();
    expect(index.isResolved(unknown)).toBe(false);
  });

  it('unresolved returns exactly the refs with no provenance attached', () => {
    const index = new ProvenanceIndex();
    const known = asItemId('known');
    const missingA = asItemId('missing-a');
    const missingB = asSkillId('SKILL-missing');

    index.attach(known, sourceLine(asDocId('cv.pdf'), 1, 'known'));

    const result = index.unresolved([known, missingA, missingB]);

    expect(result).toEqual([missingA, missingB]);
    expect(result).not.toContain(known);
  });

  it('reports no unresolved claims when all refs resolve', () => {
    const index = new ProvenanceIndex();
    const a = asItemId('r1');
    const b = asItemId('r2');
    index.attach(a, interviewAnswer(asStarId('STAR-r1')));
    index.attach(b, interviewAnswer(asStarId('STAR-r2')));

    expect(index.unresolved([a, b])).toEqual([]);
  });
});

describe('buildProvenanceIndex (R38.1)', () => {
  const makeItem = (id: string): ExtractedItem => ({
    id: asItemId(id),
    type: 'employment',
    fields: { employer: 'Acme' },
    confidence: 'High',
    provenance: [sourceLine(asDocId('cv.pdf'), 10, 'Worked at Acme')],
    userConfirmed: true,
    private: false,
    sourceDoc: asDocId('cv.pdf'),
  });

  const makeAccomplishment = (id: string): Accomplishment => ({
    id: asBulletId(id),
    text: 'Cut build time 40%',
    provenance: [interviewAnswer(asStarId('STAR-acc'))],
    skills: [asSkillId('SKILL-ci')],
    retired: false,
  });

  it('builds a resolvable index from items, accomplishments and pre-attached facts', () => {
    const item = makeItem('item-1');
    const acc = makeAccomplishment('BULLET-1');
    const fact: ProvenanceFact = {
      ref: asSkillId('SKILL-1'),
      provenance: trailOf(userConfirmation(asISODate('2024-06-01'), 'confirmed skill')),
    };

    const index = buildProvenanceIndex({
      items: [item],
      accomplishments: [acc],
      facts: [fact],
    });

    expect(index.size).toBe(3);
    expect(index.isResolved(item.id)).toBe(true);
    expect(index.isResolved(acc.id)).toBe(true);
    expect(index.isResolved(fact.ref)).toBe(true);

    expect(index.resolve(item.id)?.provenance).toEqual([...item.provenance]);
    expect(index.resolve(acc.id)?.provenance).toEqual([...acc.provenance]);
    expect(index.resolve(fact.ref)?.provenance).toEqual([...fact.provenance]);
  });

  it('yields an empty index for omitted or empty sources', () => {
    expect(buildProvenanceIndex().size).toBe(0);
    expect(buildProvenanceIndex({}).size).toBe(0);
    expect(buildProvenanceIndex({ items: [], accomplishments: [], facts: [] }).size).toBe(0);
  });
});
