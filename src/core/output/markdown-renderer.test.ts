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
  type ExtractedItem,
  type RolePreference,
  type SkillId,
  type SkillMapEntry,
  type TalkingPoint,
} from '@core/types';
import { sourceLine, trailOf } from '@core/provenance';
import { buildReferenceGraph } from '@core/registry';
import type { SkillMap } from '@core/skills';
import { buildCvModel } from './cv-model';
import type { CvModel } from './cv-model';
import { NEEDS_METRIC_MARKER } from './cv-model';
import { renderMarkdown } from './markdown-renderer';

const doc = asDocId('cv.md');

const skill = (id: string, name: string): SkillMapEntry => ({
  id: asSkillId(id),
  name,
  category: 'Technical',
  proficiencySignal: 'Evidence-based.',
  evidence: [],
  recency: asISODate('2024-01-01'),
});

const skillMapOf = (
  entries: SkillMapEntry[],
  accomplishments: readonly Accomplishment[] = [],
  talkingPoints: readonly TalkingPoint[] = [],
): SkillMap => ({
  entries,
  graph: buildReferenceGraph({ skills: entries, accomplishments, talkingPoints }),
});

const accomplishment = (
  id: string,
  text: string,
  skills: SkillId[],
): Accomplishment => ({
  id: asBulletId(id),
  text,
  provenance: trailOf(sourceLine(doc, 1, text)),
  skills,
});

const talkingPoint = (
  id: string,
  polished: string,
  skills: SkillId[],
  opts: { result?: string; flags?: TalkingPoint['flags'] } = {},
): TalkingPoint => ({
  id: asStarId(id),
  polished,
  skills,
  flags: opts.flags ?? [],
  ...(opts.result !== undefined ? { result: opts.result } : {}),
});

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

const item = (
  id: string,
  type: ExtractedItem['type'],
  fields: Record<string, unknown>,
): ExtractedItem => ({
  id: asItemId(id),
  type,
  fields,
  confidence: 'High',
  provenance: trailOf(sourceLine(doc, 1, id)),
  userConfirmed: false,
  private: false,
  sourceDoc: doc,
});

/** A fully-populated model exercising every section. */
const fullModel = (): CvModel => {
  const react = skill('SKILL-react', 'React');
  const node = skill('SKILL-node', 'Node.js');
  const acc = accomplishment('BULLET-01', 'Led the React migration across 12 teams.', [
    react.id,
  ]);
  const tp = talkingPoint('STAR-01', 'Scaled the Node.js platform.', [node.id], {
    flags: ['needs_metric'],
  });
  const map = skillMapOf([react, node], [acc], [tp]);
  const edu = item('I-edu', 'education', {
    degree: 'BSc Computer Science',
    institution: 'MIT',
    field: 'Distributed Systems',
  });
  const cert = item('I-cert', 'certification', {
    name: 'AWS Solutions Architect',
    issuer: 'Amazon',
    date: '2023',
  });
  return buildCvModel(role([react.id]), {
    skillMap: map,
    accomplishments: [acc],
    talkingPoints: [tp],
    items: [edu, cert],
    header: { name: 'Ada Lovelace', contact: ['ada@example.com', '+1 555 0100'] },
    summary: 'Staff engineer with a focus on platform reliability.',
  });
};

describe('@core/output — renderMarkdown renders every section (R32.1)', () => {
  it('renders header, summary, experience, skills, education and certifications', () => {
    const md = renderMarkdown(fullModel());
    expect(md).toContain('# Ada Lovelace');
    expect(md).toContain('ada@example.com · +1 555 0100');
    expect(md).toContain('## Summary');
    expect(md).toContain('Staff engineer with a focus on platform reliability.');
    expect(md).toContain('## Experience');
    expect(md).toContain('## Skills');
    expect(md).toContain('## Education');
    expect(md).toContain('## Certifications');
  });

  it('orders sections in a fixed, linear reading order', () => {
    const md = renderMarkdown(fullModel());
    const order = ['## Summary', '## Experience', '## Skills', '## Education', '## Certifications'];
    const positions = order.map((h) => md.indexOf(h));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((p) => p >= 0)).toBe(true);
  });
});

describe('@core/output — renderMarkdown preserves model content exactly (R32.5)', () => {
  it('renders every bullet, skill and entry from the model and nothing more', () => {
    const cv = fullModel();
    const md = renderMarkdown(cv);
    for (const bullet of cv.experience) expect(md).toContain(bullet.text);
    for (const s of cv.skills) expect(md).toContain(`- ${s.name}`);
    for (const e of cv.education) expect(md).toContain(e.title);
    for (const c of cv.certifications) expect(md).toContain(c.title);

    // No fabricated content: two experience bullets and two skills exactly.
    const bulletLines = md.split('\n').filter((l) => l.startsWith('- '));
    // 2 experience bullets + 2 skills + 1 education + 1 certification = 6 bullets.
    expect(bulletLines).toHaveLength(6);
  });

  it('preserves verbatim contact lines and summary text', () => {
    const md = renderMarkdown(fullModel());
    expect(md).toContain('ada@example.com');
    expect(md).toContain('+1 555 0100');
    expect(md).toContain('Staff engineer with a focus on platform reliability.');
  });

  it('is ATS-safe: no tables, images or raw HTML', () => {
    const md = renderMarkdown(fullModel());
    expect(md).not.toContain('|'); // no layout tables
    expect(md).not.toContain('!['); // no images
    expect(md).not.toMatch(/<[^>]+>/); // no raw HTML / icons
  });
});

describe('@core/output — renderMarkdown surfaces the needs_metric annotation (R30.4)', () => {
  it('appends the needs-metric marker to a metric-needing bullet', () => {
    const cv = fullModel();
    const needsMetric = cv.experience.find((b) => b.needsMetric);
    expect(needsMetric).toBeDefined();
    const md = renderMarkdown(cv);
    expect(md).toContain(`${needsMetric!.text} ${NEEDS_METRIC_MARKER}`);
  });

  it('does not annotate bullets that do not need a metric', () => {
    const react = skill('SKILL-react', 'React');
    const acc = accomplishment('BULLET-01', 'Shipped the redesign.', [react.id]);
    const cv = buildCvModel(role([]), {
      skillMap: skillMapOf([react], [acc]),
      accomplishments: [acc],
    });
    const md = renderMarkdown(cv);
    expect(md).not.toContain(NEEDS_METRIC_MARKER);
    expect(md).toContain('- Shipped the redesign.');
  });
});

describe('@core/output — renderMarkdown is deterministic', () => {
  it('produces an identical string for an identical model', () => {
    expect(renderMarkdown(fullModel())).toBe(renderMarkdown(fullModel()));
  });
});

describe('@core/output — renderMarkdown handles empty / optional sections gracefully', () => {
  it('omits sections that have no content', () => {
    const cv = buildCvModel(role([]), { skillMap: skillMapOf([]) });
    const md = renderMarkdown(cv);
    expect(md).not.toContain('## Summary');
    expect(md).not.toContain('## Experience');
    expect(md).not.toContain('## Skills');
    expect(md).not.toContain('## Education');
    expect(md).not.toContain('## Certifications');
    // An empty model still renders to a clean, single-newline-terminated string.
    expect(md).toBe('\n');
  });

  it('omits the header when no name or contact is supplied', () => {
    const cv = buildCvModel(role([]), { skillMap: skillMapOf([skill('SKILL-react', 'React')]) });
    const md = renderMarkdown(cv);
    // No h1 header line (single '#') is emitted when there is no name.
    expect(md.split('\n').some((l) => /^# /.test(l))).toBe(false);
    expect(md.startsWith('## Skills')).toBe(true);
  });

  it('renders an education entry with only a title', () => {
    const edu = item('I-edu', 'education', { degree: 'BSc Computer Science' });
    const cv = buildCvModel(role([]), { skillMap: skillMapOf([]), items: [edu] });
    const md = renderMarkdown(cv);
    expect(md).toContain('- **BSc Computer Science**');
    expect(md).not.toContain('— —'); // no dangling separators
  });

  it('always terminates with exactly one trailing newline', () => {
    const md = renderMarkdown(fullModel());
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });
});
