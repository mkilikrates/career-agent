import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  asBulletId,
  asDocId,
  asISODate,
  asItemId,
  asSkillId,
  asStarId,
  type Accomplishment,
  type Confidence,
  type ExtractedItem,
  type ProvenanceTrail,
  type StarId,
  type BulletId,
  type TalkingPoint,
} from './index';

describe('@core/types invariants', () => {
  it('mints branded ids that are not interchangeable with plain strings', () => {
    const star = asStarId('STAR-01');
    const bullet = asBulletId('BULLET-01');

    // Runtime: brands are erased, values behave like strings.
    expect(star).toBe('STAR-01');
    expect(bullet).toBe('BULLET-01');

    // Compile-time: a StarId is not a BulletId and neither is a raw string.
    expectTypeOf(star).not.toEqualTypeOf<BulletId>();
    expectTypeOf(star).not.toEqualTypeOf<string>();
    expectTypeOf<StarId>().toMatchTypeOf<string>(); // still usable as a string
  });

  it('encodes confidence as a closed union', () => {
    expectTypeOf<Confidence>().toEqualTypeOf<'High' | 'Medium' | 'Low'>();
  });

  it('requires at least one provenance record on a fact', () => {
    // A single-element trail is valid.
    const trail: ProvenanceTrail = [
      { kind: 'source_line', doc: asDocId('cv.pdf'), line: 12, quote: 'Led migration' },
    ];
    expect(trail.length).toBeGreaterThanOrEqual(1);

    // An empty array is a type error (the head element is required).
    // @ts-expect-error provenance must be non-empty (R38.1)
    const empty: ProvenanceTrail = [];
    expect(empty).toEqual([]);
  });

  it('exposes retired flags on accomplishments and talking points', () => {
    const acc: Accomplishment = {
      id: asBulletId('BULLET-02'),
      text: 'Cut build time 40%',
      provenance: [{ kind: 'interview_answer', star: asStarId('STAR-02') }],
      skills: [asSkillId('SKILL-ci')],
      retired: true,
    };
    const tp: TalkingPoint = {
      id: asStarId('STAR-03'),
      flags: ['needs_metric'],
      polished: 'I reduced the deployment time.',
      skills: [asSkillId('SKILL-ci')],
      retired: false,
    };

    expect(acc.retired).toBe(true);
    expect(tp.retired).toBe(false);
  });

  it('attaches confidence and >=1 provenance to extracted items', () => {
    const item: ExtractedItem = {
      id: asItemId('item-1'),
      type: 'employment',
      fields: { employer: 'Acme' },
      confidence: 'High',
      provenance: [{ kind: 'user_confirmation', at: asISODate('2024-05-01'), note: 'confirmed' }],
      userConfirmed: true,
      private: false,
      sourceDoc: asDocId('cv.pdf'),
    };
    expect(item.confidence).toBe('High');
    expect(item.provenance.length).toBe(1);
  });
});
