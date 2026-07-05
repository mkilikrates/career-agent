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
  since: asISODate('2024-01-01'),
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

describe('@core/output — buildCvModel employment grouping (R71.7)', () => {
  it('creates employment entries from employment-type items', () => {
    const react = skill('SKILL-react', 'React');
    const map = skillMapOf([react]);
    const emp = item('I-emp1', 'employment', {
      title: 'Senior Engineer',
      employer: 'Acme Corp',
      start: '2020-01',
      end: '2022-06',
      technologies: ['React'],
    });
    const cv = buildCvModel(role([react.id]), { skillMap: map, items: [emp] });
    expect(cv.employmentEntries).toBeDefined();
    expect(cv.employmentEntries!.length).toBeGreaterThanOrEqual(1);
    const entry = cv.employmentEntries!.find((e) => e.title === 'Senior Engineer');
    expect(entry).toBeDefined();
    expect(entry!.company).toBe('Acme Corp');
    expect(entry!.dateRange).toBe('2020-01 – 2022-06');
    expect(entry!.technologies).toEqual(['React']);
  });

  it('includes per-position achievements from extraction (R73.5)', () => {
    const react = skill('SKILL-react', 'React');
    const map = skillMapOf([react]);
    const emp = item('I-emp1', 'employment', {
      title: 'Senior Engineer',
      employer: 'Acme Corp',
      start: '2020-01',
      end: '2022-06',
      technologies: ['React'],
      achievements: ['Reduced bundle size by 40%', 'Migrated codebase to React 18'],
    });
    const cv = buildCvModel(role([react.id]), { skillMap: map, items: [emp] });
    expect(cv.employmentEntries).toBeDefined();
    const entry = cv.employmentEntries!.find((e) => e.title === 'Senior Engineer');
    expect(entry).toBeDefined();
    expect(entry!.achievements).toEqual([
      'Reduced bundle size by 40%',
      'Migrated codebase to React 18',
    ]);
  });

  it('returns empty achievements when not present in employment item', () => {
    const react = skill('SKILL-react', 'React');
    const map = skillMapOf([react]);
    const emp = item('I-emp1', 'employment', {
      title: 'Dev',
      employer: 'Co',
      technologies: ['React'],
    });
    const cv = buildCvModel(role([react.id]), { skillMap: map, items: [emp] });
    expect(cv.employmentEntries).toBeDefined();
    const entry = cv.employmentEntries!.find((e) => e.title === 'Dev');
    expect(entry).toBeDefined();
    expect(entry!.achievements).toEqual([]);
  });

  it('matches bullets to positions by skill overlap', () => {
    const react = skill('SKILL-react', 'React');
    const node = skill('SKILL-node', 'Node.js');
    const map = skillMapOf([react, node]);
    const emp1 = item('I-emp1', 'employment', {
      title: 'Frontend Dev',
      employer: 'Alpha',
      start: '2020-01',
      end: '2022-06',
      technologies: ['React'],
    });
    const emp2 = item('I-emp2', 'employment', {
      title: 'Backend Dev',
      employer: 'Beta',
      start: '2018-01',
      end: '2019-12',
      technologies: ['Node.js'],
    });
    const reactBullet = accomplishment('BULLET-01', 'Built the React UI.', [react.id]);
    const nodeBullet = accomplishment('BULLET-02', 'Built the Node.js API.', [node.id]);
    const cv = buildCvModel(role([react.id, node.id]), {
      skillMap: map,
      accomplishments: [reactBullet, nodeBullet],
      items: [emp1, emp2],
    });
    expect(cv.employmentEntries).toBeDefined();
    const frontend = cv.employmentEntries!.find((e) => e.title === 'Frontend Dev');
    const backend = cv.employmentEntries!.find((e) => e.title === 'Backend Dev');
    expect(frontend).toBeDefined();
    expect(backend).toBeDefined();
    expect(frontend!.bullets.map((b) => b.id)).toContain(reactBullet.id);
    expect(backend!.bullets.map((b) => b.id)).toContain(nodeBullet.id);
  });

  it('positions with no matching bullets still appear with their technologies', () => {
    const react = skill('SKILL-react', 'React');
    const python = skill('SKILL-python', 'Python');
    const map = skillMapOf([react, python]);
    const emp1 = item('I-emp1', 'employment', {
      title: 'Frontend Dev',
      employer: 'Alpha',
      start: '2020-01',
      end: '2022-06',
      technologies: ['React'],
    });
    const emp2 = item('I-emp2', 'employment', {
      title: 'Data Engineer',
      employer: 'Gamma',
      start: '2017-01',
      end: '2019-12',
      technologies: ['Python'],
    });
    // Only a React bullet — Python position has no matching bullets
    const reactBullet = accomplishment('BULLET-01', 'Built the React UI.', [react.id]);
    const cv = buildCvModel(role([react.id]), {
      skillMap: map,
      accomplishments: [reactBullet],
      items: [emp1, emp2],
    });
    expect(cv.employmentEntries).toBeDefined();
    const dataEntry = cv.employmentEntries!.find((e) => e.title === 'Data Engineer');
    expect(dataEntry).toBeDefined();
    expect(dataEntry!.technologies).toEqual(['Python']);
    expect(dataEntry!.bullets).toEqual([]);
  });

  it('orders positions chronologically, most recent first', () => {
    const react = skill('SKILL-react', 'React');
    const map = skillMapOf([react]);
    const emp1 = item('I-emp1', 'employment', {
      title: 'Junior Dev',
      employer: 'Start',
      start: '2015-01',
      end: '2017-12',
      technologies: ['React'],
    });
    const emp2 = item('I-emp2', 'employment', {
      title: 'Senior Dev',
      employer: 'Growth',
      start: '2018-01',
      end: '2020-12',
      technologies: ['React'],
    });
    const emp3 = item('I-emp3', 'employment', {
      title: 'Staff Dev',
      employer: 'Scale',
      start: '2021-01',
      end: '2023-06',
      technologies: ['React'],
    });
    const cv = buildCvModel(role([]), {
      skillMap: map,
      items: [emp1, emp3, emp2], // deliberately unordered
    });
    expect(cv.employmentEntries).toBeDefined();
    const titles = cv.employmentEntries!.map((e) => e.title);
    expect(titles).toEqual(['Staff Dev', 'Senior Dev', 'Junior Dev']);
  });

  it('places unmatched bullets in a General entry', () => {
    const react = skill('SKILL-react', 'React');
    const cobol = skill('SKILL-cobol', 'COBOL');
    const map = skillMapOf([react, cobol]);
    const emp = item('I-emp1', 'employment', {
      title: 'Frontend Dev',
      employer: 'Alpha',
      start: '2020-01',
      end: '2022-06',
      technologies: ['React'],
    });
    // COBOL bullet doesn't match any position's technologies
    const cobolBullet = accomplishment('BULLET-01', 'Maintained legacy COBOL.', [cobol.id]);
    const cv = buildCvModel(role([]), {
      skillMap: map,
      accomplishments: [cobolBullet],
      items: [emp],
    });
    expect(cv.employmentEntries).toBeDefined();
    const general = cv.employmentEntries!.find((e) => e.title === 'General');
    expect(general).toBeDefined();
    expect(general!.bullets.map((b) => b.id)).toContain(cobolBullet.id);
  });

  it('does not produce employmentEntries when there are no employment items', () => {
    const react = skill('SKILL-react', 'React');
    const map = skillMapOf([react]);
    const cv = buildCvModel(role([]), { skillMap: map });
    expect(cv.employmentEntries).toBeUndefined();
  });

  it('preserves the flat experience list for backwards compatibility', () => {
    const react = skill('SKILL-react', 'React');
    const map = skillMapOf([react]);
    const emp = item('I-emp1', 'employment', {
      title: 'Frontend Dev',
      employer: 'Alpha',
      start: '2020-01',
      end: '2022-06',
      technologies: ['React'],
    });
    const bullet = accomplishment('BULLET-01', 'Built the React UI.', [react.id]);
    const cv = buildCvModel(role([react.id]), {
      skillMap: map,
      accomplishments: [bullet],
      items: [emp],
    });
    // The flat list still has the bullet
    expect(cv.experience.map((b) => b.id)).toContain(bullet.id);
    // And it's also placed in the employment entry
    expect(cv.employmentEntries).toBeDefined();
  });
});

describe('@core/output — buildCvModel new sections from confirmed items (R73.5)', () => {
  it('includes professionalSummary from confirmed professional_summary items', () => {
    const map = skillMapOf([skill('SKILL-react', 'React')]);
    const summary = item(
      'I-summary',
      'professional_summary',
      { text: 'Experienced software engineer with 10 years of expertise.' },
      { userConfirmed: true },
    );
    const cv = buildCvModel(role([]), { skillMap: map, items: [summary] });
    expect(cv.professionalSummary).toBe(
      'Experienced software engineer with 10 years of expertise.',
    );
  });

  it('excludes professionalSummary when item is not confirmed', () => {
    const map = skillMapOf([skill('SKILL-react', 'React')]);
    const summary = item(
      'I-summary',
      'professional_summary',
      { text: 'Experienced engineer.' },
      { userConfirmed: false },
    );
    const cv = buildCvModel(role([]), { skillMap: map, items: [summary] });
    expect(cv.professionalSummary).toBeUndefined();
  });

  it('excludes professionalSummary when item is private', () => {
    const map = skillMapOf([skill('SKILL-react', 'React')]);
    const summary = item(
      'I-summary',
      'professional_summary',
      { text: 'Secret summary.' },
      { userConfirmed: true, private: true },
    );
    const cv = buildCvModel(role([]), { skillMap: map, items: [summary] });
    expect(cv.professionalSummary).toBeUndefined();
  });

  it('includes coreCompetencies from confirmed core_competency items', () => {
    const map = skillMapOf([skill('SKILL-react', 'React')]);
    const comp1 = item('I-comp1', 'core_competency', { name: 'Leadership' }, { userConfirmed: true });
    const comp2 = item('I-comp2', 'core_competency', { name: 'Strategic Planning' }, { userConfirmed: true });
    const cv = buildCvModel(role([]), { skillMap: map, items: [comp1, comp2] });
    expect(cv.coreCompetencies).toEqual(['Leadership', 'Strategic Planning']);
  });

  it('excludes coreCompetencies when none are confirmed', () => {
    const map = skillMapOf([skill('SKILL-react', 'React')]);
    const comp = item('I-comp1', 'core_competency', { name: 'Leadership' }, { userConfirmed: false });
    const cv = buildCvModel(role([]), { skillMap: map, items: [comp] });
    expect(cv.coreCompetencies).toBeUndefined();
  });

  it('includes languages from confirmed language_proficiency items', () => {
    const map = skillMapOf([skill('SKILL-react', 'React')]);
    const lang1 = item(
      'I-lang1',
      'language_proficiency',
      { language: 'English', proficiency: 'Native' },
      { userConfirmed: true },
    );
    const lang2 = item(
      'I-lang2',
      'language_proficiency',
      { language: 'Portuguese', proficiency: 'Fluent' },
      { userConfirmed: true },
    );
    const cv = buildCvModel(role([]), { skillMap: map, items: [lang1, lang2] });
    expect(cv.languages).toEqual([
      { language: 'English', proficiency: 'Native' },
      { language: 'Portuguese', proficiency: 'Fluent' },
    ]);
  });

  it('excludes languages when none are confirmed', () => {
    const map = skillMapOf([skill('SKILL-react', 'React')]);
    const lang = item(
      'I-lang1',
      'language_proficiency',
      { language: 'English', proficiency: 'Native' },
      { userConfirmed: false },
    );
    const cv = buildCvModel(role([]), { skillMap: map, items: [lang] });
    expect(cv.languages).toBeUndefined();
  });

  it('includes hobbiesAndCauses from confirmed hobby and cause items', () => {
    const map = skillMapOf([skill('SKILL-react', 'React')]);
    const hobby = item('I-hobby', 'hobby', { name: 'Open Source' }, { userConfirmed: true });
    const cause = item('I-cause', 'cause', { name: 'Code for Good' }, { userConfirmed: true });
    const cv = buildCvModel(role([]), { skillMap: map, items: [hobby, cause] });
    expect(cv.hobbiesAndCauses).toEqual(['Open Source', 'Code for Good']);
  });

  it('excludes hobbiesAndCauses when none are confirmed', () => {
    const map = skillMapOf([skill('SKILL-react', 'React')]);
    const hobby = item('I-hobby', 'hobby', { name: 'Reading' }, { userConfirmed: false });
    const cause = item('I-cause', 'cause', { name: 'Volunteering' }, { userConfirmed: false });
    const cv = buildCvModel(role([]), { skillMap: map, items: [hobby, cause] });
    expect(cv.hobbiesAndCauses).toBeUndefined();
  });

  it('only includes confirmed items in hobbiesAndCauses', () => {
    const map = skillMapOf([skill('SKILL-react', 'React')]);
    const confirmedHobby = item('I-h1', 'hobby', { name: 'Cycling' }, { userConfirmed: true });
    const unconfirmedHobby = item('I-h2', 'hobby', { name: 'Running' }, { userConfirmed: false });
    const confirmedCause = item('I-c1', 'cause', { name: 'Mentoring' }, { userConfirmed: true });
    const cv = buildCvModel(role([]), {
      skillMap: map,
      items: [confirmedHobby, unconfirmedHobby, confirmedCause],
    });
    expect(cv.hobbiesAndCauses).toEqual(['Cycling', 'Mentoring']);
  });

  it('does not include new sections when there are no items at all', () => {
    const map = skillMapOf([skill('SKILL-react', 'React')]);
    const cv = buildCvModel(role([]), { skillMap: map });
    expect(cv.professionalSummary).toBeUndefined();
    expect(cv.coreCompetencies).toBeUndefined();
    expect(cv.languages).toBeUndefined();
    expect(cv.hobbiesAndCauses).toBeUndefined();
  });
});
