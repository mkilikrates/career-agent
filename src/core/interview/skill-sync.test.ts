import { describe, it, expect } from 'vitest';
import {
  asDocId,
  asISODate,
  asItemId,
  asSkillId,
  asStarId,
  asBulletId,
  asRoleSlug,
  type StarId,
  type SkillId,
  type TalkingPoint,
} from '@core/types';
import { IdRegistry } from '@core/registry';
import { generate, skillSlug, MissingSkillContextError } from '@core/skills';
import { sourceLine, trailOf } from '@core/provenance';
import type { ExtractedItem } from '@core/types';
import type { InterviewFile } from './interview-document';
import {
  detectNewSkills,
  syncSkillMap,
  detectSessionSkills,
  applySkillDelta,
  type SkillConfirmation,
} from './index';

// --- Fixtures ---------------------------------------------------------------

const DOC = asDocId('cv.pdf');
let seq = 0;

/** Build a verified `skill` extraction so `generate` produces a real entry. */
const skillItem = (name: string): ExtractedItem => ({
  id: asItemId(`item-${seq++}`),
  type: 'skill',
  fields: { name },
  confidence: 'High',
  provenance: trailOf(sourceLine(DOC, 1, name)),
  userConfirmed: true,
  private: false,
  sourceDoc: DOC,
});

/** A skill map containing exactly "Kubernetes" (id `SKILL-kubernetes`). */
const mapWithKubernetes = () =>
  generate([skillItem('Kubernetes')], { asOf: asISODate('2024-01-01') });

/** A confirmed talking point linking the given skill ids. */
const talkingPoint = (
  id: StarId,
  skills: SkillId[],
  polished: string,
  retired = false,
): TalkingPoint => ({
  id,
  flags: [],
  polished,
  skills,
  ...(retired ? { retired: true } : {}),
});

/** A session (interview file) carrying the given confirmed talking points. */
const sessionWith = (talkingPoints: TalkingPoint[]): InterviewFile => ({
  roleSlug: asRoleSlug('platform-engineer'),
  roleTitle: 'Platform Engineer',
  questions: [],
  talkingPoints,
});

// --- Detection (R29.1) ------------------------------------------------------

describe('detectNewSkills — reveal skills absent from the map (R29.1)', () => {
  it('proposes a skill referenced by a confirmed talking point but not in the map', () => {
    const map = mapWithKubernetes();
    const session = sessionWith([
      talkingPoint(asStarId('STAR-01'), [asSkillId('SKILL-terraform')], 'I built the Terraform modules.'),
    ]);

    const delta = detectNewSkills(session, map);

    expect(delta.candidates).toHaveLength(1);
    expect(delta.candidates[0].slug).toBe('terraform');
    expect(delta.candidates[0].skill).toBe('SKILL-terraform');
    expect(delta.candidates[0].evidence).toEqual([
      { talkingPoint: 'STAR-01', content: 'I built the Terraform modules.' },
    ]);
  });

  it('does NOT re-propose a skill already in the map (incl. case variant)', () => {
    const map = mapWithKubernetes(); // entry id SKILL-kubernetes, name "Kubernetes"
    // Reference the same canonical slug — must be recognised as present, R29.1.
    const session = sessionWith([
      talkingPoint(asStarId('STAR-01'), [asSkillId('SKILL-kubernetes')], 'I ran the Kubernetes clusters.'),
    ]);

    expect(detectNewSkills(session, map).candidates).toEqual([]);
  });

  it('recognises a differently-cased map entry name as the same skill (slug match)', () => {
    // A map whose entry NAME is lower-cased "kubernetes" still slugs to kubernetes.
    const map = generate([skillItem('kubernetes')], { asOf: asISODate('2024-01-01') });
    expect(skillSlug('Kubernetes')).toBe(skillSlug('kubernetes'));
    const session = sessionWith([
      talkingPoint(asStarId('STAR-01'), [asSkillId('SKILL-kubernetes')], 'k8s work'),
    ]);
    expect(detectNewSkills(session, map).candidates).toEqual([]);
  });

  it('groups two talking points naming the same new skill into one candidate', () => {
    const map = mapWithKubernetes();
    const session = sessionWith([
      talkingPoint(asStarId('STAR-01'), [asSkillId('SKILL-terraform')], 'first point'),
      talkingPoint(asStarId('STAR-02'), [asSkillId('SKILL-terraform')], 'second point'),
    ]);

    const delta = detectNewSkills(session, map);
    expect(delta.candidates).toHaveLength(1);
    expect(delta.candidates[0].evidence.map((e) => e.talkingPoint)).toEqual([
      'STAR-01',
      'STAR-02',
    ]);
  });

  it('ignores retired talking points (R23.3)', () => {
    const map = mapWithKubernetes();
    const session = sessionWith([
      talkingPoint(asStarId('STAR-01'), [asSkillId('SKILL-terraform')], 'retired', true),
    ]);
    expect(detectNewSkills(session, map).candidates).toEqual([]);
  });

  it('a session with no talking points reveals nothing', () => {
    const map = mapWithKubernetes();
    expect(detectNewSkills(sessionWith([]), map).candidates).toEqual([]);
    expect(detectNewSkills({ ...sessionWith([]), talkingPoints: undefined }, map).candidates).toEqual([]);
  });

  it('is pure — never mutates the map or the session', () => {
    const map = mapWithKubernetes();
    const session = sessionWith([
      talkingPoint(asStarId('STAR-01'), [asSkillId('SKILL-terraform')], 'tp'),
    ]);
    const mapBefore = JSON.stringify(map.entries);
    const sessionBefore = JSON.stringify(session);
    detectNewSkills(session, map);
    expect(JSON.stringify(map.entries)).toBe(mapBefore);
    expect(JSON.stringify(session)).toBe(sessionBefore);
  });

  it('syncSkillMap is the detection entry point (design alias)', () => {
    const map = mapWithKubernetes();
    const session = sessionWith([
      talkingPoint(asStarId('STAR-01'), [asSkillId('SKILL-terraform')], 'tp'),
    ]);
    expect(syncSkillMap(session, map)).toEqual(detectNewSkills(session, map));
  });
});

// --- Surfacing is unapplied (R29.2) ----------------------------------------

describe('detectNewSkills — candidates are surfaced unapplied (R29.2)', () => {
  it('detection does not add anything to the map', () => {
    const map = mapWithKubernetes();
    const before = map.entries.length;
    detectNewSkills(
      sessionWith([
        talkingPoint(asStarId('STAR-01'), [asSkillId('SKILL-terraform')], 'tp'),
      ]),
      map,
    );
    expect(map.entries.length).toBe(before);
  });
});

// --- Apply on confirmation (R29.3) -----------------------------------------

describe('applySkillDelta — add confirmed candidates with links (R29.3)', () => {
  const baseConfirmation = (skill: SkillId, name: string): SkillConfirmation => ({
    skill,
    name,
    roleOrProject: 'Platform Engineer',
    when: '2024-03',
  });

  it('adds only the confirmed candidate, with STAR evidence linked bi-directionally', () => {
    const map = mapWithKubernetes();
    const session = sessionWith([
      talkingPoint(asStarId('STAR-01'), [asSkillId('SKILL-terraform')], 'I built the Terraform modules.'),
    ]);
    const delta = detectNewSkills(session, map);

    const added = applySkillDelta(map, delta, [
      baseConfirmation(asSkillId('SKILL-terraform'), 'Terraform'),
    ]);

    expect(added).toHaveLength(1);
    const entry = added[0];
    expect(entry.name).toBe('Terraform');
    expect(map.entries.some((e) => e.id === entry.id)).toBe(true);

    // STAR proof link wired in BOTH directions (R18.3).
    expect(map.graph.talkingPointsFor(entry.id)).toContain('STAR-01');
    expect(map.graph.skillsFor(asStarId('STAR-01'))).toContain(entry.id);

    // The new evidence carries both the user-confirmation source and the STAR proof.
    expect(entry.evidence.some((ev) => String(ev.ref) === 'STAR-01')).toBe(true);
  });

  it('links a confirmed accomplishment (BULLET) alongside the STAR evidence (R29.3)', () => {
    const map = mapWithKubernetes();
    const session = sessionWith([
      talkingPoint(asStarId('STAR-01'), [asSkillId('SKILL-terraform')], 'tp'),
    ]);
    const delta = detectNewSkills(session, map);

    const added = applySkillDelta(map, delta, [
      {
        ...baseConfirmation(asSkillId('SKILL-terraform'), 'Terraform'),
        accomplishments: [asBulletId('BULLET-07')],
      },
    ]);
    const entry = added[0];

    expect(map.graph.accomplishmentsFor(entry.id)).toContain('BULLET-07');
    expect(map.graph.talkingPointsFor(entry.id)).toContain('STAR-01');
  });

  it('never adds an unconfirmed candidate (R29.2)', () => {
    const map = mapWithKubernetes();
    const session = sessionWith([
      talkingPoint(asStarId('STAR-01'), [asSkillId('SKILL-terraform')], 'tp-a'),
      talkingPoint(asStarId('STAR-02'), [asSkillId('SKILL-ansible')], 'tp-b'),
    ]);
    const delta = detectNewSkills(session, map);
    expect(delta.candidates).toHaveLength(2);

    // Confirm only Terraform; Ansible must NOT be added.
    const added = applySkillDelta(map, delta, [
      baseConfirmation(asSkillId('SKILL-terraform'), 'Terraform'),
    ]);

    expect(added).toHaveLength(1);
    expect(map.entries.some((e) => e.name === 'Terraform')).toBe(true);
    expect(map.entries.some((e) => skillSlug(e.name) === 'ansible')).toBe(false);
  });

  it('ignores a confirmation that does not match any detected candidate (R29.2)', () => {
    const map = mapWithKubernetes();
    const delta = detectNewSkills(
      sessionWith([
        talkingPoint(asStarId('STAR-01'), [asSkillId('SKILL-terraform')], 'tp'),
      ]),
      map,
    );
    // Confirm a skill that was never proposed — must be a no-op.
    const added = applySkillDelta(map, delta, [
      baseConfirmation(asSkillId('SKILL-not-proposed'), 'Something Else'),
    ]);
    expect(added).toEqual([]);
    expect(map.entries.some((e) => e.name === 'Something Else')).toBe(false);
  });

  it('requires role/project AND when for an addition (R19.2)', () => {
    const map = mapWithKubernetes();
    const delta = detectNewSkills(
      sessionWith([
        talkingPoint(asStarId('STAR-01'), [asSkillId('SKILL-terraform')], 'tp'),
      ]),
      map,
    );

    expect(() =>
      applySkillDelta(map, delta, [
        { skill: asSkillId('SKILL-terraform'), name: 'Terraform', roleOrProject: '', when: '2024-03' },
      ]),
    ).toThrow(MissingSkillContextError);

    expect(() =>
      applySkillDelta(map, delta, [
        { skill: asSkillId('SKILL-terraform'), name: 'Terraform', roleOrProject: 'PE', when: '  ' },
      ]),
    ).toThrow(MissingSkillContextError);
  });

  it('keeps linked proof ids allocated in the registry (R18.4, R23.2)', () => {
    const map = mapWithKubernetes();
    const registry = new IdRegistry();
    const delta = detectNewSkills(
      sessionWith([
        talkingPoint(asStarId('STAR-05'), [asSkillId('SKILL-terraform')], 'tp'),
      ]),
      map,
    );

    applySkillDelta(
      map,
      delta,
      [
        {
          ...baseConfirmation(asSkillId('SKILL-terraform'), 'Terraform'),
          accomplishments: [asBulletId('BULLET-03')],
        },
      ],
      { registry },
    );

    expect(registry.isAllocated('STAR-05')).toBe(true);
    expect(registry.isAllocated('BULLET-03')).toBe(true);
    // The next minted ids continue PAST the seeded ones — never reused.
    expect(String(registry.mintStarId())).toBe('STAR-06');
    expect(String(registry.mintBulletId())).toBe('BULLET-04');
  });
});

// --- AI adaptive-loop session detection (R63.8) ----------------------------

describe('detectSessionSkills — union per-answer skills, exclude in-map (R63.8)', () => {
  /** A minimal per-question summary carrying only the per-answer skills. */
  const summary = (skills: string[]) => ({ skills });

  it('unions the per-answer skills across the session into candidates', () => {
    const map = mapWithKubernetes();
    const delta = detectSessionSkills(
      [summary(['Terraform', 'Ansible']), summary(['Go'])],
      map,
    );
    expect(delta.candidates.map((c) => c.slug)).toEqual(['ansible', 'go', 'terraform']);
    expect(delta.candidates.map((c) => c.skill)).toEqual([
      'SKILL-ansible',
      'SKILL-go',
      'SKILL-terraform',
    ]);
  });

  it('excludes skills already represented in the map (by canonical slug)', () => {
    const map = mapWithKubernetes();
    // "kubernetes"/"Kubernetes " collapse to the in-map slug and are excluded.
    const delta = detectSessionSkills(
      [summary(['kubernetes', 'Kubernetes ']), summary(['Terraform'])],
      map,
    );
    expect(delta.candidates.map((c) => c.slug)).toEqual(['terraform']);
  });

  it('de-duplicates differently-cased/spaced phrasings of one new skill', () => {
    const map = mapWithKubernetes();
    const delta = detectSessionSkills(
      [summary(['Terraform']), summary(['terraform', '  Terraform  '])],
      map,
    );
    expect(delta.candidates).toHaveLength(1);
    expect(delta.candidates[0].slug).toBe('terraform');
  });

  it('drops empty / whitespace-only skill names and an empty session', () => {
    const map = mapWithKubernetes();
    expect(detectSessionSkills([summary(['', '   '])], map).candidates).toEqual([]);
    expect(detectSessionSkills([], map).candidates).toEqual([]);
  });

  it('candidates carry no talking-point evidence (summaries have no STAR id)', () => {
    const map = mapWithKubernetes();
    const delta = detectSessionSkills([summary(['Terraform'])], map);
    expect(delta.candidates[0].evidence).toEqual([]);
  });

  it('is a proposal only — detection never mutates the map (R29.2)', () => {
    const map = mapWithKubernetes();
    const before = map.entries.length;
    detectSessionSkills([summary(['Terraform'])], map);
    expect(map.entries).toHaveLength(before);
  });

  it('routes through the EXISTING confirm-before-add flow: requires confirmation (R63.8, R29.3)', () => {
    const map = mapWithKubernetes();
    const before = map.entries.length;
    const delta = detectSessionSkills(
      [summary(['Terraform', 'Ansible'])],
      map,
    );
    expect(delta.candidates).toHaveLength(2);

    // Confirm only Terraform; Ansible must NOT be added (unconfirmed).
    const added = applySkillDelta(map, delta, [
      {
        skill: asSkillId('SKILL-terraform'),
        name: 'Terraform',
        roleOrProject: 'Platform Engineer',
        when: '2024-03',
      },
    ]);
    expect(added).toHaveLength(1);
    expect(added[0].name).toBe('Terraform');
    expect(map.entries).toHaveLength(before + 1);
    expect(map.entries.some((e) => e.name === 'Ansible')).toBe(false);
  });
});
