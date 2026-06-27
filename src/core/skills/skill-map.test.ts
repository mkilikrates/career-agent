import { describe, it, expect } from 'vitest';
import type {
  Accomplishment,
  ExtractedItem,
  ExtractedItemType,
  TalkingPoint,
} from '@core/types';
import {
  asBulletId,
  asDocId,
  asISODate,
  asItemId,
  asSkillId,
  asStarId,
} from '@core/types';
import { sourceLine, trailOf } from '@core/provenance';
import { generate, linkEvidence } from './index';

const DOC = asDocId('cv.pdf');
const AS_OF = asISODate('2024-01-01');

let seq = 0;
const item = (
  type: ExtractedItemType,
  fields: Record<string, unknown>,
  confidence: ExtractedItem['confidence'] = 'High',
  userConfirmed = false,
): ExtractedItem => ({
  id: asItemId(`item-${seq++}`),
  type,
  fields,
  confidence,
  provenance: trailOf(sourceLine(DOC, 1, JSON.stringify(fields))),
  userConfirmed,
  private: false,
  sourceDoc: DOC,
});

const skill = (name: string, c: ExtractedItem['confidence'] = 'High', uc = false) =>
  item('skill', { name }, c, uc);

const byName = (entries: ReturnType<typeof generate>['entries'], name: string) =>
  entries.find((e) => e.name === name);

describe('skill-map generate', () => {
  it('R14.1: each entry has name, category, evidence-based signal, dated evidence, recency', () => {
    const map = generate(
      [
        skill('Python'),
        item('employment', { employer: 'Acme', title: 'Dev', technologies: ['Docker'], start: '2021-01', end: '2023-06' }),
        item('language', { language: 'Spanish', proficiency: 'Fluent' }),
      ],
      { asOf: AS_OF },
    );

    const py = byName(map.entries, 'Python')!;
    expect(py.id).toBe(asSkillId('SKILL-python'));
    expect(py.category).toBe('Technical');
    expect(py.proficiencySignal).toMatch(/evidence-based/i);
    expect(py.evidence).toHaveLength(1);
    expect(py.evidence[0].ref).toBe(DOC);
    expect(py.evidence[0].when).toBe(AS_OF); // undated skill falls back to asOf
    expect(py.recency).toBe(AS_OF);

    // Employment technologies become dated skills (R14.1 dated evidence trail).
    const docker = byName(map.entries, 'Docker')!;
    expect(docker.category).toBe('Tools');
    expect(docker.evidence[0].when).toBe(asISODate('2023-06'));
    expect(docker.recency).toBe(asISODate('2023-06'));

    const spanish = byName(map.entries, 'Spanish')!;
    expect(spanish.category).toBe('Communication');
  });

  it('R14.2: derives skills only from verified source or user confirmation', () => {
    const map = generate(
      [
        skill('Python', 'Medium'),
        skill('Rust', 'Low'), // unverified, not confirmed -> excluded
        skill('COBOL', 'Low', true), // low but user-confirmed -> included (R12.4)
      ],
      { asOf: AS_OF },
    );
    const names = map.entries.map((e) => e.name).sort();
    expect(names).toEqual(['COBOL', 'Python']);
    expect(byName(map.entries, 'Rust')).toBeUndefined();
  });

  it('R14.3: signal is evidence-based and no self-assessment is fabricated', () => {
    const map = generate([skill('Python')], { asOf: AS_OF });
    const py = byName(map.entries, 'Python')!;
    expect(py.selfAssessment).toBeUndefined();
    expect(py.proficiencySignal).not.toMatch(/expert|advanced|self/i);
    expect(py.proficiencySignal).toMatch(/confidence across 1 source/i);
  });

  it('R15: merges casing variants into one entry, preserving user phrasing', () => {
    const map = generate([skill('JavaScript'), skill('javascript'), skill('JAVASCRIPT')], {
      asOf: AS_OF,
    });
    const js = map.entries.filter((e) => e.id === asSkillId('SKILL-javascript'));
    expect(js).toHaveLength(1);
    expect(js[0].name).toBe('JavaScript'); // longest/representative phrasing kept
    expect(js[0].mergeRecord?.reversible).toBe(true);
  });

  it('R16.3: never merges confusable pairs', () => {
    const map = generate([skill('Java'), skill('JavaScript')], { asOf: AS_OF });
    const names = map.entries.map((e) => e.name).sort();
    expect(names).toEqual(['Java', 'JavaScript']);
  });

  it('R15.3: never invents a skill absent from source', () => {
    const inputs = ['React', 'TypeScript'];
    const map = generate(inputs.map((n) => skill(n)), { asOf: AS_OF });
    for (const e of map.entries) expect(inputs).toContain(e.name);
  });

  it('R18.2/R18.3: references BULLET/STAR ids bi-directionally', () => {
    const acc: Accomplishment = {
      id: asBulletId('BULLET-01'),
      text: 'Built a JS data pipeline',
      provenance: trailOf(sourceLine(DOC, 2, 'pipeline')),
      skills: [asSkillId('SKILL-javascript')],
    };
    const tp: TalkingPoint = {
      id: asStarId('STAR-01'),
      flags: [],
      polished: 'I led the Python migration.',
      skills: [asSkillId('SKILL-python')],
    };

    const map = generate([skill('JavaScript'), skill('Python')], {
      asOf: AS_OF,
      accomplishments: [acc],
      talkingPoints: [tp],
    });

    const js = byName(map.entries, 'JavaScript')!;
    expect(js.evidence.some((e) => e.ref === asBulletId('BULLET-01'))).toBe(true);

    // Graph resolves both directions consistently (R18.3).
    expect(map.graph.accomplishmentsFor(asSkillId('SKILL-javascript'))).toEqual([
      asBulletId('BULLET-01'),
    ]);
    expect(map.graph.skillsFor(asBulletId('BULLET-01'))).toEqual([asSkillId('SKILL-javascript')]);
    expect(map.graph.talkingPointsFor(asSkillId('SKILL-python'))).toEqual([asStarId('STAR-01')]);
    expect(map.graph.skillsFor(asStarId('STAR-01'))).toEqual([asSkillId('SKILL-python')]);
  });

  it('R23.3: retired proofs are not surfaced as evidence', () => {
    const acc: Accomplishment = {
      id: asBulletId('BULLET-02'),
      text: 'Retired bullet',
      provenance: trailOf(sourceLine(DOC, 3, 'retired')),
      skills: [asSkillId('SKILL-python')],
      retired: true,
    };
    const map = generate([skill('Python')], { asOf: AS_OF, accomplishments: [acc] });
    const py = byName(map.entries, 'Python')!;
    expect(py.evidence.some((e) => e.ref === asBulletId('BULLET-02'))).toBe(false);
    expect(map.graph.accomplishmentsFor(asSkillId('SKILL-python'))).toEqual([]);
  });

  it('linkEvidence adds proofs bi-directionally and ignores doc refs', () => {
    const map = generate([skill('Python')], { asOf: AS_OF });
    linkEvidence(map, asSkillId('SKILL-python'), [asBulletId('BULLET-09'), DOC], AS_OF, 'proof');
    const py = byName(map.entries, 'Python')!;
    expect(py.evidence.some((e) => e.ref === asBulletId('BULLET-09'))).toBe(true);
    // The plain DocId is not a proof and must not enter the proof graph.
    expect(map.graph.skillsFor(asBulletId('BULLET-09'))).toEqual([asSkillId('SKILL-python')]);
  });

  it('is deterministic and entries are sorted by id', () => {
    const inputs = [skill('Python'), skill('AWS'), skill('Docker')];
    const a = generate(inputs, { asOf: AS_OF });
    const b = generate(inputs, { asOf: AS_OF });
    expect(a.entries.map((e) => e.id)).toEqual(b.entries.map((e) => e.id));
    const ids = a.entries.map((e) => String(e.id));
    expect(ids).toEqual([...ids].sort());
  });
});
