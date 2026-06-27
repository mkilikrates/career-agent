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
  type ExtractedItemType,
  type SkillId,
  type SkillMapEntry,
  type TalkingPoint,
} from '@core/types';
import { sourceLine, trailOf } from '@core/provenance';
import { buildReferenceGraph } from '@core/registry';
import type { SkillMap } from '@core/skills';
import type { ConfirmedEvidence } from './cv-model';
import { NEEDS_METRIC_MARKER } from './cv-model';
import {
  ADVISORY_NOTICE,
  buildLinkedInReport,
  renderLinkedInReportMarkdown,
} from './linkedin-report';

const doc = asDocId('linkedin.md');

const skill = (
  id: string,
  name: string,
  opts: { recency?: string; evidence?: number } = {},
): SkillMapEntry => ({
  id: asSkillId(id),
  name,
  category: 'Technical',
  proficiencySignal: 'Evidence-based.',
  evidence: Array.from({ length: opts.evidence ?? 0 }, () => ({
    ref: doc,
    when: asISODate('2024-01-01'),
    note: 'evidence',
  })),
  recency: asISODate(opts.recency ?? '2024-01-01'),
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
  retired = false,
): Accomplishment => ({
  id: asBulletId(id),
  text,
  provenance: trailOf(sourceLine(doc, 1, text)),
  skills,
  ...(retired ? { retired: true } : {}),
});

const talkingPoint = (
  id: string,
  polished: string,
  skills: SkillId[],
  opts: { flags?: TalkingPoint['flags']; retired?: boolean } = {},
): TalkingPoint => ({
  id: asStarId(id),
  polished,
  skills,
  flags: opts.flags ?? [],
  ...(opts.retired ? { retired: true } : {}),
});

const item = (
  id: string,
  type: ExtractedItemType,
  fields: Record<string, unknown>,
  opts: { private?: boolean; confidence?: ExtractedItem['confidence'] } = {},
): ExtractedItem => ({
  id: asItemId(id),
  type,
  fields,
  confidence: opts.confidence ?? 'High',
  provenance: trailOf(sourceLine(doc, 1, id)),
  userConfirmed: false,
  private: opts.private ?? false,
  sourceDoc: doc,
});

/** A fully-populated confirmed-evidence set exercising every report section. */
const fullEvidence = (): ConfirmedEvidence => {
  const react = skill('SKILL-react', 'React', { recency: '2024-06-01', evidence: 3 });
  const node = skill('SKILL-node', 'Node.js', { recency: '2024-03-01', evidence: 2 });
  const k8s = skill('SKILL-k8s', 'Kubernetes', { recency: '2023-01-01', evidence: 1 });
  const acc = accomplishment('BULLET-01', 'Led the React migration across 12 teams.', [
    react.id,
  ]);
  const tp = talkingPoint('STAR-01', 'Scaled the Node.js platform.', [node.id], {
    flags: ['needs_metric'],
  });
  const job = item('I-job', 'employment', {
    title: 'Staff Engineer',
    employer: 'Acme',
    start: '2020',
    end: '2024',
    description: 'Owned the platform reliability roadmap.',
  });
  return {
    skillMap: skillMapOf([react, node, k8s], [acc], [tp]),
    accomplishments: [acc],
    talkingPoints: [tp],
    items: [job],
    summary: 'Staff engineer focused on platform reliability.',
    header: { name: 'Ada Lovelace' },
  };
};

describe('@core/output — buildLinkedInReport produces every section (R31.1)', () => {
  it('produces a headline, about, positions, experience bullets and skills', () => {
    const report = buildLinkedInReport(fullEvidence());
    expect(report.headline.length).toBeGreaterThan(0);
    expect(report.about.length).toBeGreaterThan(0);
    expect(report.positions.length).toBeGreaterThan(0);
    expect(report.experienceBullets.length).toBeGreaterThan(0);
    expect(report.recommendedSkills.length).toBeGreaterThan(0);
  });

  it('renders every section heading into the advisory Markdown', () => {
    const md = renderLinkedInReportMarkdown(buildLinkedInReport(fullEvidence()));
    expect(md).toContain('# LinkedIn Improvement Report');
    expect(md).toContain('## Suggested Headline');
    expect(md).toContain('## Rewritten About');
    expect(md).toContain('## Position Rewrites');
    expect(md).toContain('## Suggested Experience Bullets');
    expect(md).toContain('## Recommended Skills');
  });

  it('composes the headline from the strongest confirmed skills', () => {
    // React (most recent / most evidence) ahead of Node.js ahead of Kubernetes.
    const report = buildLinkedInReport(fullEvidence());
    expect(report.headline).toBe('React · Node.js · Kubernetes');
  });
});

describe('@core/output — buildLinkedInReport fabricates nothing (R31.1, Property 1)', () => {
  it('recommends only skills that exist in the confirmed skill map', () => {
    const evidence = fullEvidence();
    const report = buildLinkedInReport(evidence);
    const confirmed = new Set(evidence.skillMap.entries.map((e) => e.name));
    for (const s of report.recommendedSkills) expect(confirmed.has(s.name)).toBe(true);
    // It is exactly the confirmed set — a subset that drops nothing, adds nothing.
    expect(report.recommendedSkills.map((s) => s.name).sort()).toEqual(
      [...confirmed].sort(),
    );
  });

  it('surfaces only confirmed accomplishment / talking-point texts as bullets', () => {
    const evidence = fullEvidence();
    const report = buildLinkedInReport(evidence);
    const confirmedTexts = new Set<string>([
      ...(evidence.accomplishments ?? []).map((a) => a.text),
      ...(evidence.talkingPoints ?? []).map((t) => t.polished),
    ]);
    for (const b of report.experienceBullets) expect(confirmedTexts.has(b.text)).toBe(true);
  });

  it('reformats positions only from confirmed employment item fields', () => {
    const report = buildLinkedInReport(fullEvidence());
    const position = report.positions[0]!;
    expect(position.title).toBe('Staff Engineer');
    expect(position.employer).toBe('Acme');
    expect(position.dates).toBe('2020 – 2024');
    expect(position.description).toBe('Owned the platform reliability roadmap.');
  });

  it('excludes a bullet that links to no confirmed skill', () => {
    const react = skill('SKILL-react', 'React');
    const orphan = accomplishment('BULLET-99', 'Unlinked claim.', [asSkillId('SKILL-ghost')]);
    const report = buildLinkedInReport({
      skillMap: skillMapOf([react], [orphan]),
      accomplishments: [orphan],
    });
    expect(report.experienceBullets).toHaveLength(0);
  });

  it('excludes retired accomplishments and talking points', () => {
    const react = skill('SKILL-react', 'React');
    const retiredAcc = accomplishment('BULLET-01', 'Retired bullet.', [react.id], true);
    const retiredTp = talkingPoint('STAR-01', 'Retired point.', [react.id], {
      retired: true,
    });
    const report = buildLinkedInReport({
      skillMap: skillMapOf([react], [retiredAcc], [retiredTp]),
      accomplishments: [retiredAcc],
      talkingPoints: [retiredTp],
    });
    expect(report.experienceBullets).toHaveLength(0);
  });

  it('excludes private employment items from position rewrites (R12.3)', () => {
    const job = item('I-priv', 'employment', { title: 'Secret Role' }, { private: true });
    const report = buildLinkedInReport({ skillMap: skillMapOf([]), items: [job] });
    expect(report.positions).toHaveLength(0);
  });
});

describe('@core/output — LinkedIn report is advisory only (R31.2)', () => {
  it('marks the report advisory and carries the advisory notice', () => {
    const report = buildLinkedInReport(fullEvidence());
    expect(report.advisory).toBe(true);
    expect(report.notice).toBe(ADVISORY_NOTICE);
  });

  it('surfaces the advisory notice prominently in the Markdown', () => {
    const md = renderLinkedInReportMarkdown(buildLinkedInReport(fullEvidence()));
    expect(md).toContain(`> ${ADVISORY_NOTICE}`);
    expect(md.toLowerCase()).toContain('never posts');
  });

  it('exposes no field that would post or apply changes', () => {
    const report = buildLinkedInReport(fullEvidence());
    // The report is data only: its keys describe suggestions, not actions.
    expect(Object.keys(report).sort()).toEqual(
      [
        'about',
        'advisory',
        'experienceBullets',
        'headline',
        'notice',
        'positions',
        'recommendedSkills',
      ].sort(),
    );
  });
});

describe('@core/output — LinkedIn report surfaces the needs_metric marker (R30.4)', () => {
  it('annotates a metric-needing bullet in the Markdown', () => {
    const report = buildLinkedInReport(fullEvidence());
    const needsMetric = report.experienceBullets.find((b) => b.needsMetric);
    expect(needsMetric).toBeDefined();
    const md = renderLinkedInReportMarkdown(report);
    expect(md).toContain(`${needsMetric!.text} ${NEEDS_METRIC_MARKER}`);
  });
});

describe('@core/output — LinkedIn report is deterministic', () => {
  it('produces identical structure and Markdown for identical evidence', () => {
    expect(buildLinkedInReport(fullEvidence())).toEqual(buildLinkedInReport(fullEvidence()));
    expect(renderLinkedInReportMarkdown(buildLinkedInReport(fullEvidence()))).toBe(
      renderLinkedInReportMarkdown(buildLinkedInReport(fullEvidence())),
    );
  });
});

describe('@core/output — LinkedIn report handles sparse evidence gracefully', () => {
  it('omits empty sections for an empty skill map', () => {
    const report = buildLinkedInReport({ skillMap: skillMapOf([]) });
    expect(report.headline).toBe('');
    expect(report.about).toBe('');
    expect(report.experienceBullets).toHaveLength(0);
    expect(report.positions).toHaveLength(0);
    expect(report.recommendedSkills).toHaveLength(0);

    const md = renderLinkedInReportMarkdown(report);
    expect(md).toContain('# LinkedIn Improvement Report');
    expect(md).toContain(`> ${ADVISORY_NOTICE}`);
    expect(md).not.toContain('## Suggested Headline');
    expect(md).not.toContain('## Rewritten About');
    expect(md).not.toContain('## Position Rewrites');
    expect(md).not.toContain('## Recommended Skills');
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('falls back to a confirmed employment title when no skills exist', () => {
    const job = item('I-job', 'employment', { title: 'Staff Engineer' });
    const report = buildLinkedInReport({ skillMap: skillMapOf([]), items: [job] });
    expect(report.headline).toBe('Staff Engineer');
  });

  it('builds an About from only a summary when there are no bullets', () => {
    const report = buildLinkedInReport({
      skillMap: skillMapOf([]),
      summary: 'Reliability-focused engineer.',
    });
    expect(report.about).toBe('Reliability-focused engineer.');
    expect(report.about).not.toContain('Career highlights:');
  });
});
