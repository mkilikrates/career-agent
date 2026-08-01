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
  it('R14.1: each entry has name, category, evidence-based signal, dated evidence, since', () => {
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
    expect(py.evidence[0].when).toBe(asISODate('')); // undated standalone skill has no date
    // Standalone skills with no employment context get `since: undefined` —
    // the user fills it in or the cross-reference step derives it from employment.
    expect(py.since).toBeUndefined();

    // Employment technologies become dated skills (R14.1 dated evidence trail).
    const docker = byName(map.entries, 'Docker')!;
    expect(docker.category).toBe('Tools');
    expect(docker.evidence[0].when).toBe(asISODate('2023-06'));
    // since uses the employment START date (earliest evidence, R70.2) not end date.
    expect(docker.since).toBe(asISODate('2021-01'));

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

  it('R71.4/R71.5: education items contribute skills dated by start date', () => {
    const map = generate(
      [
        item('education', {
          institution: 'MIT',
          degree: 'MSc Computer Science',
          start: '2018-09',
          end: '2020-06',
          skills: ['Machine Learning', 'Statistics'],
        }),
      ],
      { asOf: AS_OF },
    );

    const ml = byName(map.entries, 'Machine Learning')!;
    expect(ml).toBeDefined();
    expect(ml.category).toBe('Technical');
    // Education skills are dated by start (when the skill was first encountered).
    expect(ml.evidence[0].when).toBe(asISODate('2018-09'));
    expect(ml.since).toBe(asISODate('2018-09'));

    const stats = byName(map.entries, 'Statistics')!;
    expect(stats).toBeDefined();
    expect(stats.evidence[0].when).toBe(asISODate('2018-09'));
    expect(stats.since).toBe(asISODate('2018-09'));
  });

  it('R71.5: education start date used as since even when end date is present', () => {
    // Education uses start date (when skill was first used), not end date.
    const map = generate(
      [
        item('education', {
          institution: 'Stanford',
          degree: 'BSc',
          start: '2015-09',
          end: '2019-06',
          skills: ['Python'],
        }),
        item('employment', {
          employer: 'Acme',
          title: 'Dev',
          technologies: ['Python'],
          start: '2019-07',
          end: '2021-12',
        }),
      ],
      { asOf: AS_OF },
    );

    const py = byName(map.entries, 'Python')!;
    // since should be the earliest: education start (2015-09) vs employment end (2021-12)
    expect(py.since).toBe(asISODate('2015-09'));
  });

  it('R73.4: core_competency items are categorized as Core_Competency', () => {
    const map = generate(
      [
        item('core_competency', { name: 'Stakeholder Management' }),
        item('core_competency', { name: 'Strategic Planning' }),
        skill('Python'),
      ],
      { asOf: AS_OF },
    );

    const stakeholder = byName(map.entries, 'Stakeholder Management')!;
    expect(stakeholder).toBeDefined();
    expect(stakeholder.category).toBe('Core_Competency');

    const strategic = byName(map.entries, 'Strategic Planning')!;
    expect(strategic).toBeDefined();
    expect(strategic.category).toBe('Core_Competency');

    // Regular technical skill still uses the keyword-based categoriser.
    const py = byName(map.entries, 'Python')!;
    expect(py.category).toBe('Technical');
  });

  it('R70.2/R71.20: since uses earliest employment start even when standalone extraction already set a later since', () => {
    // Bug 9 scenario: "Terraform" has a standalone skill extraction with since=2024-05,
    // but employment items show it was used from 2022-04. The since should be 2022-04.
    const map = generate(
      [
        item('skill', { name: 'Terraform', since: '2024-05' }),
        item('employment', {
          employer: 'Fidelity',
          title: 'Cloud Engineer',
          technologies: ['Terraform'],
          start: '2022-04',
          end: '2024-03',
        }),
        item('employment', {
          employer: 'Tripadvisor',
          title: 'Platform Engineer',
          technologies: ['Terraform'],
          start: '2024-05',
          end: '2024-11',
        }),
      ],
      { asOf: AS_OF },
    );

    const tf = byName(map.entries, 'Terraform')!;
    expect(tf).toBeDefined();
    // since must reflect the earliest evidence: Fidelity start = 2022-04
    expect(tf.since).toBe(asISODate('2022-04'));
  });

  it('R70.2: since from employment start overrides evidence-derived since when earlier', () => {
    // A skill appears in employment starting 2019-03 but evidence only has end date 2021-12.
    const map = generate(
      [
        item('employment', {
          employer: 'Corp',
          title: 'Dev',
          technologies: ['Kubernetes'],
          start: '2019-03',
          end: '2021-12',
        }),
      ],
      { asOf: AS_OF },
    );

    const k8s = byName(map.entries, 'Kubernetes')!;
    expect(k8s).toBeDefined();
    // since should be employment start (2019-03), not end date (2021-12)
    expect(k8s.since).toBe(asISODate('2019-03'));
  });
});
