import { describe, expect, it } from 'vitest';
import {
  asBulletId,
  asDocId,
  asISODate,
  asItemId,
  asRoleSlug,
  asSkillId,
  asStarId,
  type Accomplishment,
  type Confidence,
  type ExtractedItem,
  type RolePreference,
  type SkillId,
  type SkillMapEntry,
  type TalkingPoint,
} from '@core/types';
import { sourceLine, trailOf } from '@core/provenance';
import { buildReferenceGraph } from '@core/registry';
import type { SkillMap } from '@core/skills';
import { buildCvModel, NEEDS_METRIC_NOTE } from './cv-model';

const doc = asDocId('cv.md');

/** A minimal confirmed skill-map entry for the given id/name. */
const skill = (id: string, name: string): SkillMapEntry => ({
  id: asSkillId(id),
  name,
  category: 'Technical',
  proficiencySignal: 'Evidence-based.',
  evidence: [],
  recency: asISODate('2024-01-01'),
});

/** Assemble a {@link SkillMap} from entries, building the proof graph from them. */
const skillMapOf = (
  entries: SkillMapEntry[],
  accomplishments: readonly Accomplishment[] = [],
  talkingPoints: readonly TalkingPoint[] = [],
): SkillMap => ({
  entries,
  graph: buildReferenceGraph({ skills: entries, accomplishments, talkingPoints }),
});

/** A confirmed accomplishment bullet linked to the given skills. */
const accomplishment = (
  id: string,
  text: string,
  skills: SkillId[],
  retired = false,
): Accomplishment => ({
  id: asBulletId(id),
  text,
  provenance: trailOf(sourceLine(doc, 1, text)),
  skills,
  ...(retired ? { retired: true } : {}),
});

/** A confirmed talking point linked to the given skills. */
const talkingPoint = (
  id: string,
  polished: string,
  skills: SkillId[],
  opts: { result?: string; flags?: TalkingPoint['flags']; retired?: boolean } = {},
): TalkingPoint => ({
  id: asStarId(id),
  polished,
  skills,
  flags: opts.flags ?? [],
  ...(opts.result !== undefined ? { result: opts.result } : {}),
  ...(opts.retired ? { retired: true } : {}),
});

/** A role preference matching the supplied skills. */
const role = (matched: SkillId[]): RolePreference => ({
  slug: asRoleSlug('staff-engineer'),
  title: 'Staff Engineer',
  description: '',
  matchScore: 0.8,
  matchedSkills: matched,
  gapSkills: [],
  rationale: '',
  rank: 1,
  tag: 'actively_applying',
});

/** A confirmed extracted item of the given type. */
const item = (
  id: string,
  type: ExtractedItem['type'],
  fields: Record<string, unknown>,
  opts: { confidence?: Confidence; private?: boolean; userConfirmed?: boolean } = {},
): ExtractedItem => ({
  id: asItemId(id),
  type,
  fields,
  confidence: opts.confidence ?? 'High',
  provenance: trailOf(sourceLine(doc, 1, id)),
  userConfirmed: opts.userConfirmed ?? false,
  private: opts.private ?? false,
  sourceDoc: doc,
});

describe('@core/output — buildCvModel only includes confirmed, eligible content (R30.1)', () => {
  it('surfaces only skills present in the confirmed skill map', () => {
    const react = skill('SKILL-react', 'React');
    const map = skillMapOf([react]);
    const cv = buildCvModel(role([]), { skillMap: map });
    expect(cv.skills.map((s) => s.name)).toEqual(['React']);
  });

  it('excludes a bullet that links to no confirmed skill', () => {
    const react = skill('SKILL-react', 'React');
    const map = skillMapOf([react]);
    const grounded = accomplishment('BULLET-01', 'Built the React UI.', [react.id]);
    const ungrounded = accomplishment('BULLET-02', 'Did something unconfirmed.', [
      asSkillId('SKILL-ghost'),
    ]);
    const cv = buildCvModel(role([]), {
      skillMap: map,
      accomplishments: [grounded, ungrounded],
    });
    expect(cv.experience.map((b) => b.id)).toEqual([grounded.id]);
  });

  it('excludes retired accomplishments and talking points (R23.3)', () => {
    const react = skill('SKILL-react', 'React');
    const map = skillMapOf([react]);
    const live = accomplishment('BULLET-01', 'Built the React UI.', [react.id]);
    const retiredAcc = accomplishment('BULLET-02', 'Old work.', [react.id], true);
    const retiredTp = talkingPoint('STAR-01', 'Old story.', [react.id], { retired: true });
    const cv = buildCvModel(role([]), {
      skillMap: map,
      accomplishments: [live, retiredAcc],
      talkingPoints: [retiredTp],
    });
    expect(cv.experience.map((b) => b.id)).toEqual([live.id]);
  });

  it('excludes private education / certification items (R12.3)', () => {
    const map = skillMapOf([skill('SKILL-react', 'React')]);
    const edu = item('I-edu', 'education', { degree: 'BSc Computer Science', institution: 'MIT' });
    const privateCert = item(
      'I-cert',
      'certification',
      { name: 'Secret Cert' },
      { private: true },
    );
    const cv = buildCvModel(role([]), { skillMap: map, items: [edu, privateCert] });
    expect(cv.education.map((e) => e.title)).toEqual(['BSc Computer Science']);
    expect(cv.certifications).toEqual([]);
  });
});

describe('@core/output — buildCvModel prioritises toward the target role (R30.2)', () => {
  it('orders target-relevant skills first', () => {
    const react = skill('SKILL-react', 'React');
    const cobol = skill('SKILL-cobol', 'COBOL');
    const map = skillMapOf([cobol, react]);
    const cv = buildCvModel(role([react.id]), { skillMap: map });
    expect(cv.skills[0].name).toBe('React');
    expect(cv.skills[0].targetRelevant).toBe(true);
    expect(cv.skills[1].targetRelevant).toBe(false);
  });

  it('orders bullets evidencing a matched role skill ahead of the rest', () => {
    const react = skill('SKILL-react', 'React');
    const cobol = skill('SKILL-cobol', 'COBOL');
    const map = skillMapOf([react, cobol]);
    const offTarget = accomplishment('BULLET-01', 'Maintained COBOL batch jobs.', [cobol.id]);
    const onTarget = accomplishment('BULLET-02', 'Led the React migration.', [react.id]);
    const cv = buildCvModel(role([react.id]), {
      skillMap: map,
      accomplishments: [offTarget, onTarget],
    });
    expect(cv.experience.map((b) => b.id)).toEqual([onTarget.id, offTarget.id]);
    expect(cv.experience[0].targetRelevant).toBe(true);
  });
});

describe('@core/output — buildCvModel uses quantified results (R30.3)', () => {
  it('flags a talking point that states a quantified result', () => {
    const react = skill('SKILL-react', 'React');
    const map = skillMapOf([react]);
    const tp = talkingPoint(
      'STAR-01',
      'Cut page load time by 40% by rewriting the React render path.',
      [react.id],
      { result: 'reduced load time by 40%' },
    );
    const cv = buildCvModel(role([]), { skillMap: map, talkingPoints: [tp] });
    expect(cv.experience[0].quantified).toBe(true);
    expect(cv.experience[0].text).toContain('40%');
  });

  it('does not flag a bullet without any quantified result', () => {
    const react = skill('SKILL-react', 'React');
    const map = skillMapOf([react]);
    const tp = talkingPoint('STAR-01', 'Improved the React rendering pipeline.', [react.id]);
    const cv = buildCvModel(role([]), { skillMap: map, talkingPoints: [tp] });
    expect(cv.experience[0].quantified).toBe(false);
  });

  it('orders quantified bullets ahead of non-quantified ones within the same relevance', () => {
    const react = skill('SKILL-react', 'React');
    const map = skillMapOf([react]);
    const plain = talkingPoint('STAR-01', 'Refactored the React components.', [react.id]);
    const quantified = talkingPoint('STAR-02', 'Reduced bundle size by 30%.', [react.id], {
      result: 'cut bundle size by 30%',
    });
    const cv = buildCvModel(role([]), {
      skillMap: map,
      talkingPoints: [plain, quantified],
    });
    expect(cv.experience.map((b) => b.id)).toEqual([quantified.id, plain.id]);
  });
});

describe('@core/output — buildCvModel annotates needs_metric points (R30.4)', () => {
  it('attaches a metric note to a talking point flagged needs_metric', () => {
    const react = skill('SKILL-react', 'React');
    const map = skillMapOf([react]);
    const tp = talkingPoint('STAR-01', 'Led the React migration.', [react.id], {
      flags: ['needs_metric'],
    });
    const cv = buildCvModel(role([]), { skillMap: map, talkingPoints: [tp] });
    expect(cv.experience[0].needsMetric).toBe(true);
    expect(cv.experience[0].metricNote).toBe(NEEDS_METRIC_NOTE);
  });

  it('leaves bullets without the flag unannotated', () => {
    const react = skill('SKILL-react', 'React');
    const map = skillMapOf([react]);
    const tp = talkingPoint('STAR-01', 'Cut errors by 50%.', [react.id], {
      result: 'cut errors by 50%',
    });
    const cv = buildCvModel(role([]), { skillMap: map, talkingPoints: [tp] });
    expect(cv.experience[0].needsMetric).toBe(false);
    expect(cv.experience[0].metricNote).toBeUndefined();
  });
});

describe('@core/output — buildCvModel passes through header/summary and is deterministic', () => {
  it('carries the target role and verbatim header / summary', () => {
    const map = skillMapOf([skill('SKILL-react', 'React')]);
    const cv = buildCvModel(role([]), {
      skillMap: map,
      header: { name: 'Ada Lovelace', contact: ['ada@example.com'] },
      summary: 'Engineer.',
    });
    expect(cv.targetRole.title).toBe('Staff Engineer');
    expect(cv.header.name).toBe('Ada Lovelace');
    expect(cv.summary).toBe('Engineer.');
  });

  it('produces an identical model for identical inputs', () => {
    const react = skill('SKILL-react', 'React');
    const map = skillMapOf([react]);
    const tp = talkingPoint('STAR-01', 'Shipped the React rewrite by 25%.', [react.id], {
      result: 'by 25%',
    });
    const input = { skillMap: map, talkingPoints: [tp] };
    expect(buildCvModel(role([react.id]), input)).toEqual(
      buildCvModel(role([react.id]), input),
    );
  });
});
