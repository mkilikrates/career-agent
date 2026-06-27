// The advisory LinkedIn improvement report (R31.1, R31.2).
//
// The Output_Engine can produce a LinkedIn improvement report on request
// (`linkedInReport(src: ConfirmedEvidence): MarkdownDoc`, design §Output_Engine).
// The report suggests a headline, a rewritten "About" section, position
// rewrites, and recommended skills — and it is **advisory only** (R31.2): it is
// generated and presented to the user, who applies any changes themselves. This
// module performs no network or automation work; it never posts to, nor applies
// changes on, the user's LinkedIn profile. It is a pure, deterministic, local
// Markdown generator.
//
// No-Fabrication (R37/R38, design Property 1): every claim in the report is
// drawn ONLY from confirmed information — the confirmed skill map, the confirmed
// accomplishments / talking points, and the confirmed (output-eligible)
// extracted items. The builder never invents a skill, metric, title, or
// employer:
//
//   * the suggested headline is composed from confirmed skill-map skill names
//     (falling back to a confirmed employment title when no skills exist);
//   * the rewritten About reuses the user's verbatim summary and the confirmed,
//     already-polished accomplishment / talking-point texts (R28.3) verbatim;
//   * each position rewrite reformats a confirmed `employment` item's verbatim
//     fields (title, employer, dates, description) — it adds no new prose;
//   * recommended skills are a subset of the confirmed skill map.
//
// Like the rest of the Output_Engine, the report is split into a pure builder
// ({@link buildLinkedInReport}, producing the structured {@link LinkedInReport})
// and a deterministic Markdown renderer ({@link renderLinkedInReportMarkdown}),
// mirroring the `buildCvModel` / `renderMarkdown` pair.

import type {
  BulletId,
  ExtractedItem,
  ItemId,
  SkillCategory,
  SkillId,
  SkillMapEntry,
  StarId,
} from '@core/types';
import { computeEligibility } from '@core/ingestion';
import { NEEDS_METRIC_MARKER } from './cv-model';
import type { ConfirmedEvidence } from './cv-model';

const asString = (v: unknown): string => v as unknown as string;

/** Collapse whitespace so a field can never carry stray newlines. */
const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/** Lexicographic compare on brand-string ids, for deterministic ordering. */
const byIdStr = (a: unknown, b: unknown): number => {
  const x = asString(a);
  const y = asString(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** The advisory framing surfaced in every report and in its Markdown (R31.2). */
export const ADVISORY_NOTICE =
  'This LinkedIn report is advisory only. Review the suggestions and apply any ' +
  'changes yourself — this tool never posts to, or modifies, your LinkedIn profile.';

/** How many confirmed skill names compose a suggested headline. */
const HEADLINE_SKILL_COUNT = 3;

// --- Report model ----------------------------------------------------------

/** A suggested skill to surface on the profile, from the confirmed map (R31.1). */
export interface LinkedInSkillSuggestion {
  readonly id: SkillId;
  /** The user's original phrasing, preserved from the skill map (R17.3). */
  readonly name: string;
  readonly category: SkillCategory;
}

/** One suggested experience bullet, drawn verbatim from confirmed evidence. */
export interface LinkedInBullet {
  /** The confirmed proof id this bullet was built from (`BULLET-NN`/`STAR-NN`). */
  readonly id: BulletId | StarId;
  /** The confirmed first-person past-tense text to surface (R28.3). */
  readonly text: string;
  /** True when the originating talking point was flagged `needs_metric` (R30.4). */
  readonly needsMetric: boolean;
}

/**
 * A suggested rewrite of one confirmed `employment` position. Every field is a
 * verbatim reformat of the confirmed item — nothing is fabricated (R31.1).
 */
export interface LinkedInPosition {
  readonly id: ItemId;
  /** The verbatim role title. */
  readonly title: string;
  /** The verbatim employer, when present. */
  readonly employer?: string;
  /** The verbatim date range, when present. */
  readonly dates?: string;
  /** The verbatim position description, when present. */
  readonly description?: string;
}

/**
 * The advisory LinkedIn improvement report (R31). It is presented to the user;
 * the `advisory` flag and {@link ADVISORY_NOTICE} make explicit that the user
 * applies changes manually and that nothing is posted on their behalf (R31.2).
 * Every field is drawn solely from confirmed evidence (R31.1, Property 1).
 */
export interface LinkedInReport {
  /** Always `true`: the report is advisory only, never an action (R31.2). */
  readonly advisory: true;
  /** The user-facing advisory framing (R31.2). */
  readonly notice: string;
  /** A suggested headline composed from confirmed skills (R31.1). */
  readonly headline: string;
  /** A rewritten "About" section, built from confirmed material (R31.1). */
  readonly about: string;
  /** Suggested rewritten achievement bullets, from confirmed proofs (R31.1). */
  readonly experienceBullets: readonly LinkedInBullet[];
  /** Position rewrites, reformatted from confirmed employment items (R31.1). */
  readonly positions: readonly LinkedInPosition[];
  /** Recommended skills — a subset of the confirmed skill map (R31.1). */
  readonly recommendedSkills: readonly LinkedInSkillSuggestion[];
}

// --- Field helpers ---------------------------------------------------------

/** Pick the first non-empty string among an item's candidate fields. */
const field = (item: ExtractedItem, ...keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = item.fields[key];
    if (typeof value === 'string' && value.trim().length > 0) return oneLine(value);
  }
  return undefined;
};

/** Join a start/end range into a single human-readable detail string. */
const dateRange = (start?: string, end?: string): string | undefined => {
  if (start && end) return `${start} – ${end}`;
  return start ?? end ?? undefined;
};

/**
 * Order confirmed skills by evidence strength, deterministically: most-recent
 * evidence first, then most-evidenced, then by original name, then by id. ISO
 * date strings sort lexicographically, so a plain compare is correct.
 */
const byEvidenceStrength = (a: SkillMapEntry, b: SkillMapEntry): number => {
  if (a.recency !== b.recency) return a.recency < b.recency ? 1 : -1; // recent first
  if (a.evidence.length !== b.evidence.length) return b.evidence.length - a.evidence.length;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return byIdStr(a.id, b.id);
};

// --- Build -----------------------------------------------------------------

/**
 * Build the advisory {@link LinkedInReport} from confirmed evidence (R31.1,
 * R31.2). Pure and deterministic: the same confirmed evidence always yields the
 * same report. Every surfaced claim traces to confirmed evidence — confirmed
 * skill-map entries, confirmed (non-retired) accomplishments / talking points,
 * and confirmed (output-eligible, non-private) employment items — so the report
 * fabricates nothing (Property 1). The result is advisory only; it carries no
 * action that posts or applies changes (R31.2).
 */
export const buildLinkedInReport = (evidence: ConfirmedEvidence): LinkedInReport => {
  const confirmedSkillIds = new Set<string>(
    evidence.skillMap.entries.map((e) => asString(e.id)),
  );

  // Confirmed employment / education / certification records, gated through the
  // same output-eligibility rules as the rest of the pipeline (R11), excluding
  // private items (R12.3).
  const { eligible } = computeEligibility({
    items: evidence.items ?? [],
    promotedLowIds: evidence.promotedLowIds,
  });

  // 1. Recommended skills — the confirmed skill map, strongest-evidence first.
  //    A strict subset of the confirmed map: nothing is invented (R31.1).
  const recommendedSkills: LinkedInSkillSuggestion[] = [...evidence.skillMap.entries]
    .sort(byEvidenceStrength)
    .map((entry) => ({ id: entry.id, name: entry.name, category: entry.category }));

  // 2. Suggested headline — composed from the strongest confirmed skill names,
  //    falling back to the most-recent confirmed employment title when no skills
  //    exist. Both sources are confirmed; nothing is fabricated (R31.1).
  const topSkillNames = recommendedSkills.slice(0, HEADLINE_SKILL_COUNT).map((s) => s.name);
  const employmentTitles = eligible
    .filter((i) => i.type === 'employment')
    .map((i) => field(i, 'title', 'role', 'position'))
    .filter((t): t is string => t !== undefined);
  const headline =
    topSkillNames.length > 0
      ? topSkillNames.join(' · ')
      : (employmentTitles[0] ?? '');

  // 3. Suggested experience bullets — confirmed accomplishments then talking
  //    points, admitted only when they link to a confirmed skill (the same
  //    No-Fabrication gate the CV model applies, R30.1), surfaced verbatim.
  const experienceBullets: LinkedInBullet[] = [];
  for (const acc of evidence.accomplishments ?? []) {
    if (acc.retired) continue;
    if (!acc.skills.some((s) => confirmedSkillIds.has(asString(s)))) continue;
    experienceBullets.push({ id: acc.id, text: oneLine(acc.text), needsMetric: false });
  }
  for (const tp of evidence.talkingPoints ?? []) {
    if (tp.retired) continue;
    if (!tp.skills.some((s) => confirmedSkillIds.has(asString(s)))) continue;
    experienceBullets.push({
      id: tp.id,
      text: oneLine(tp.polished),
      needsMetric: tp.flags.includes('needs_metric'),
    });
  }
  experienceBullets.sort((a, b) => byIdStr(a.id, b.id));

  // 4. Rewritten About — the user's verbatim summary (when present) followed by
  //    the strongest confirmed achievement texts. All content is confirmed and
  //    surfaced verbatim; nothing is rephrased into a fabricated claim (R31.1).
  const aboutParts: string[] = [];
  const summary = evidence.summary !== undefined ? oneLine(evidence.summary) : '';
  if (summary.length > 0) aboutParts.push(summary);
  if (experienceBullets.length > 0) {
    aboutParts.push(
      ['Career highlights:', ...experienceBullets.map((b) => `- ${b.text}`)].join('\n'),
    );
  }
  const about = aboutParts.join('\n\n');

  // 5. Position rewrites — each confirmed employment item, reformatted from its
  //    verbatim fields. No prose is added beyond what the item already holds.
  const positions: LinkedInPosition[] = eligible
    .filter((i) => i.type === 'employment')
    .map((item): LinkedInPosition => {
      const title = field(item, 'title', 'role', 'position') ?? 'Position';
      const employer = field(item, 'employer', 'company', 'org', 'organisation');
      const dates = dateRange(
        field(item, 'start', 'startedOn', 'from'),
        field(item, 'end', 'finishedOn', 'to'),
      );
      const description = field(item, 'description', 'summary', 'details');
      const position: LinkedInPosition = { id: item.id, title };
      if (employer !== undefined) (position as { employer?: string }).employer = employer;
      if (dates !== undefined) (position as { dates?: string }).dates = dates;
      if (description !== undefined) {
        (position as { description?: string }).description = description;
      }
      return position;
    })
    .sort((a, b) => byIdStr(a.id, b.id));

  return {
    advisory: true,
    notice: ADVISORY_NOTICE,
    headline,
    about,
    experienceBullets,
    positions,
    recommendedSkills,
  };
};

// --- Render ----------------------------------------------------------------

/** Render one position rewrite header line from its verbatim fields. */
const renderPositionHeader = (position: LinkedInPosition): string => {
  let header = position.title;
  if (position.employer) header += ` — ${position.employer}`;
  if (position.dates) header += ` (${position.dates})`;
  return `### ${header}`;
};

/** Render one position rewrite (header + optional verbatim description). */
const renderPosition = (position: LinkedInPosition): string => {
  const lines = [renderPositionHeader(position)];
  if (position.description) lines.push('', position.description);
  return lines.join('\n');
};

/** Render one suggested experience bullet, surfacing the needs-metric marker. */
const renderBullet = (bullet: LinkedInBullet): string => {
  const text = bullet.needsMetric ? `${bullet.text} ${NEEDS_METRIC_MARKER}` : bullet.text;
  return `- ${text}`;
};

/**
 * Render a {@link LinkedInReport} to a human-readable, advisory Markdown
 * document (R31). Pure and deterministic: the same report always yields the same
 * string. The advisory notice is surfaced prominently at the top (R31.2); every
 * section with no content is omitted so a sparse report still renders cleanly.
 * The renderer only restyles the report — it adds no claim of its own.
 */
export const renderLinkedInReportMarkdown = (report: LinkedInReport): string => {
  const sections: string[] = ['# LinkedIn Improvement Report', `> ${report.notice}`];

  if (report.headline.length > 0) {
    sections.push(`## Suggested Headline\n\n${report.headline}`);
  }
  if (report.about.length > 0) {
    sections.push(`## Rewritten About\n\n${report.about}`);
  }
  if (report.positions.length > 0) {
    sections.push(
      `## Position Rewrites\n\n${report.positions.map(renderPosition).join('\n\n')}`,
    );
  }
  if (report.experienceBullets.length > 0) {
    sections.push(
      `## Suggested Experience Bullets\n\n${report.experienceBullets
        .map(renderBullet)
        .join('\n')}`,
    );
  }
  if (report.recommendedSkills.length > 0) {
    sections.push(
      `## Recommended Skills\n\n${report.recommendedSkills
        .map((s) => `- ${s.name}`)
        .join('\n')}`,
    );
  }

  return `${sections.join('\n\n')}\n`;
};
