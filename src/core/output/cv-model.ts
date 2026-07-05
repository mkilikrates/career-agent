// The single `CvModel` builder from confirmed evidence (R30.1, R30.2, R30.3,
// R30.4).
//
// The Output_Engine derives ALL three CV formats (Markdown primary, Typst-Wasm
// PDF, structured DOCX) from one in-memory {@link CvModel} so the formats can
// never drift (R32.5). This module owns the construction of that single model;
// the format renderers (tasks 14.2–14.4) consume it and may only restyle.
//
// The model is the subset of CONFIRMED evidence, selected and prioritised toward
// a target role:
//
//   * R30.1 — the CV contains only information already present in the confirmed
//     skill map and the interview files. Nothing is fabricated and nothing that
//     is retired is surfaced. Concretely, a CV bullet is admitted only when it
//     links (via the bi-directional skill ↔ accomplishment graph, R18.3) to at
//     least one skill that exists in the confirmed skill map, and a skill is
//     surfaced only when it is an entry in that map.
//   * R30.2 — content is prioritised toward the target role's requirements using
//     those same skill ↔ accomplishment links: bullets and skills that evidence
//     a skill the role matches are ordered ahead of the rest.
//   * R30.3 — when a STAR answer carries a quantified result, the quantified
//     result is used. Confirmed talking points are already polished to
//     first-person past-tense text (R28.3) that embeds the result, so the model
//     carries that polished text and flags whether it is quantified.
//   * R30.4 — a talking point flagged `needs_metric` (R25.1) is still includable,
//     but the model attaches a user-facing note that it would be stronger with a
//     quantified metric, so the renderers can surface the `[needs_metric]`
//     annotation.
//
// The builder is pure and deterministic: the same role + confirmed evidence
// always yields the same model, with every list in a stable order.

import type {
  Accomplishment,
  BulletId,
  ExtractedItem,
  ItemId,
  RolePreference,
  RoleSlug,
  SkillCategory,
  SkillId,
  StarId,
  TalkingPoint,
} from '@core/types';
import type { SkillMap } from '@core/skills';
import { computeEligibility } from '@core/ingestion';

const asString = (v: unknown): string => v as unknown as string;

/** Collapse whitespace so a model field can never carry stray newlines. */
const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/** The marker renderers surface for a metric-needing bullet (R30.4). */
export const NEEDS_METRIC_MARKER = '[needs_metric]';

/** The user-facing note attached to a metric-needing bullet (R30.4). */
export const NEEDS_METRIC_NOTE =
  'This point would be stronger with a quantified metric.';

/**
 * Whether a fragment of result text carries a quantified result (R30.3): an
 * explicit number (`30`, `2.5`, `40%`, `$1.2M`), or a written magnitude/scale
 * word. Deliberately conservative — a metric the user actually stated, never a
 * fabricated one.
 */
const QUANTIFIED =
  /\d|\b(?:percent|million|billion|thousand|doubled|tripled|quadrupled|halved)\b/i;

/** Detect a quantified result in any of the supplied text fragments (R30.3). */
const isQuantified = (...fragments: ReadonlyArray<string | undefined>): boolean =>
  fragments.some((f) => f !== undefined && QUANTIFIED.test(f));

// --- Model -----------------------------------------------------------------

/** The contact header of a CV — supplied verbatim, never fabricated (R30.1). */
export interface CvHeader {
  /** The user's name, as they provided it. */
  readonly name?: string;
  /** Contact lines (email, phone, links) exactly as the user supplied them. */
  readonly contact?: readonly string[];
}

/** One skill surfaced on the CV, drawn from the confirmed skill map (R30.1). */
export interface CvSkill {
  readonly id: SkillId;
  /** The user's original phrasing, preserved from the skill map (R17.3). */
  readonly name: string;
  readonly category: SkillCategory;
  /** True when the target role matches this skill — ordered first (R30.2). */
  readonly targetRelevant: boolean;
}

/** Where a CV bullet was sourced from. */
export type CvBulletSource = 'accomplishment' | 'talking-point';

/**
 * One experience bullet on the CV. Built from a confirmed accomplishment
 * (`BULLET-NN`) or a confirmed talking point (`STAR-NN`), it carries the text to
 * render, the confirmed skills it evidences, whether it is relevant to the
 * target role (R30.2), whether it states a quantified result (R30.3), and — when
 * the originating talking point was flagged `needs_metric` — a note that it
 * would be stronger with a metric (R30.4).
 */
export interface CvBullet {
  /** The stable proof id this bullet was built from (`BULLET-NN`/`STAR-NN`). */
  readonly id: BulletId | StarId;
  readonly source: CvBulletSource;
  /** The first-person past-tense bullet text to render (R28.3). */
  readonly text: string;
  /** The confirmed skills this bullet evidences (R18.3). */
  readonly skills: readonly SkillId[];
  /** True when it evidences a skill the target role matches (R30.2). */
  readonly targetRelevant: boolean;
  /** True when the bullet states a quantified result (R30.3). */
  readonly quantified: boolean;
  /** True when the originating talking point was flagged `needs_metric` (R30.4). */
  readonly needsMetric: boolean;
  /** A user-facing note to surface when `needsMetric` is set (R30.4). */
  readonly metricNote?: string;
}

/** One education or certification entry, as available from confirmed items. */
export interface CvEntry {
  readonly id: ItemId;
  /** The primary line (degree earned, or certification name). */
  readonly title: string;
  /** The secondary line (institution, or issuer), when present. */
  readonly subtitle?: string;
  /** Supporting detail (field of study, dates), when present. */
  readonly detail?: string;
}

/**
 * One employment position on the CV, with its confirmed talking points and
 * accomplishments placed underneath (R71.7). Positions with no matching bullets
 * still appear with their technologies listed.
 */
export interface CvEmploymentEntry {
  readonly title: string;
  readonly company: string;
  readonly dateRange?: string; // "2019-01 – 2022-06" formatted
  readonly technologies: readonly string[];
  /** Per-position achievements from the extraction (R73.5). */
  readonly achievements: readonly string[];
  /** Talking points / accomplishments that belong to this position. */
  readonly bullets: readonly CvBullet[];
}

/** A language entry on the CV with proficiency level (R73.5). */
export interface CvLanguageEntry {
  readonly language: string;
  readonly proficiency: string;
}

/**
 * The single source of truth every CV format is rendered from (R32.5). It is the
 * confirmed-evidence subset, prioritised toward the target role (R30.1, R30.2).
 * Renderers may restyle but must not add, drop, or alter its content.
 */
export interface CvModel {
  /** The role this CV is tailored to (R30.2). */
  readonly targetRole: {
    readonly slug: RoleSlug;
    readonly title: string;
  };
  /** Contact header, supplied verbatim (R30.1). */
  readonly header: CvHeader;
  /** Optional professional summary, supplied verbatim (never fabricated). */
  readonly summary?: string;
  /** Professional summary from confirmed extraction (R73.5). */
  readonly professionalSummary?: string;
  /** Core competencies from confirmed extraction (R73.5). */
  readonly coreCompetencies?: readonly string[];
  /** Language proficiency entries from confirmed extraction (R73.5). */
  readonly languages?: readonly CvLanguageEntry[];
  /** Hobbies and causes combined from confirmed extraction (R73.5). */
  readonly hobbiesAndCauses?: readonly string[];
  /** Confirmed skills, target-relevant first (R30.1, R30.2). */
  readonly skills: readonly CvSkill[];
  /** Experience bullets, prioritised toward the target role (R30.1–R30.4). */
  readonly experience: readonly CvBullet[];
  /** Employment history grouped chronologically, most recent first (R71.7). */
  readonly employmentEntries?: readonly CvEmploymentEntry[];
  /** Education entries, as available from confirmed items. */
  readonly education: readonly CvEntry[];
  /** Certification entries, as available from confirmed items. */
  readonly certifications: readonly CvEntry[];
}

// --- Input -----------------------------------------------------------------

/**
 * The confirmed evidence the CV is built from (R30.1). The skill map and the
 * interview-derived proofs (accomplishments / talking points) are the only
 * source of CV content; `items` supplies the confirmed education / certification
 * records, gated through the same output-eligibility rules as the rest of the
 * pipeline (R11). Header and summary are passed through verbatim — they are user
 * material, never fabricated.
 */
export interface ConfirmedEvidence {
  /** The confirmed skill map (entries + bi-directional proof graph) (R30.1). */
  readonly skillMap: SkillMap;
  /** Confirmed CV accomplishment bullets (R18.1). */
  readonly accomplishments?: readonly Accomplishment[];
  /** Confirmed STAR talking points from the interview files (R28.4). */
  readonly talkingPoints?: readonly TalkingPoint[];
  /** Confirmed extracted items, the source of education / certification entries. */
  readonly items?: readonly ExtractedItem[];
  /** Ids of explicitly promoted Low items, for output-eligibility (R11.4). */
  readonly promotedLowIds?: ReadonlySet<ItemId>;
  /** Contact header, supplied verbatim. */
  readonly header?: CvHeader;
  /** Optional professional summary, supplied verbatim. */
  readonly summary?: string;
}

// --- Employment grouping helpers (R71.7) -----------------------------------

/** Parse a date field (YYYY-MM or YYYY) into a comparable numeric value (YYYYMM). */
const parseYM = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const trimmed = value.trim();
  // Match YYYY-MM or YYYY
  const match = trimmed.match(/^(\d{4})(?:-(\d{1,2}))?/);
  if (!match) return undefined;
  const year = parseInt(match[1], 10);
  const month = match[2] ? parseInt(match[2], 10) : 1;
  return year * 100 + month;
};

/** Derive technologies from an employment item's fields. */
const itemTechnologies = (item: ExtractedItem): string[] => {
  const techs = item.fields.technologies;
  if (Array.isArray(techs)) return techs.filter((t): t is string => typeof t === 'string');
  return [];
};

/** Derive achievements from an employment item's fields (R73.5). */
const itemAchievements = (item: ExtractedItem): string[] => {
  const achievements = item.fields.achievements;
  if (Array.isArray(achievements))
    return achievements.filter((a): a is string => typeof a === 'string');
  return [];
};

/** Format the date range for display from start/end fields. */
const employmentDateRange = (item: ExtractedItem): string | undefined => {
  const start = field(item, 'start', 'startedOn', 'from');
  const end = field(item, 'end', 'finishedOn', 'to');
  return dateRange(start, end);
};

/**
 * Build employment entries from employment-type items and match bullets to them
 * via (a) date overlap or (b) skill overlap with the position's technologies.
 * Returns entries sorted chronologically, most recent first (R71.7).
 */
const buildEmploymentEntries = (
  employmentItems: readonly ExtractedItem[],
  bullets: readonly CvBullet[],
  skillMap: SkillMap,
): CvEmploymentEntry[] => {
  // Build a map of skill name (lowercase) → skill id for matching technologies
  // to confirmed skills.
  const skillNameToId = new Map<string, string>();
  for (const entry of skillMap.entries) {
    skillNameToId.set(entry.name.toLowerCase(), asString(entry.id));
  }

  // For each employment item, compute its date range and its technology skill ids.
  interface PositionInfo {
    item: ExtractedItem;
    title: string;
    company: string;
    dateRangeStr: string | undefined;
    startYM: number | undefined;
    endYM: number | undefined;
    technologies: string[];
    techSkillIds: Set<string>;
    matchedBullets: CvBullet[];
  }

  const positions: PositionInfo[] = employmentItems.map((item) => {
    const title = field(item, 'title', 'role', 'position') ?? 'Position';
    const company = field(item, 'employer', 'company', 'org', 'organisation') ?? '';
    const technologies = itemTechnologies(item);
    const techSkillIds = new Set<string>();
    for (const tech of technologies) {
      const id = skillNameToId.get(tech.toLowerCase());
      if (id !== undefined) techSkillIds.add(id);
    }
    return {
      item,
      title,
      company,
      dateRangeStr: employmentDateRange(item),
      startYM: parseYM(item.fields.start ?? item.fields.startedOn ?? item.fields.from),
      endYM: parseYM(item.fields.end ?? item.fields.finishedOn ?? item.fields.to),
      technologies,
      techSkillIds,
      matchedBullets: [],
    };
  });

  // Match each bullet to a position. Strategy:
  // (a) Match by date: if a talking point or accomplishment evidences a skill that
  //     appeared in a position's technology list AND the item has a date range, match
  //     by checking if the position date range overlaps. Since bullets don't carry their
  //     own dates, we match by skill overlap primarily.
  // (b) Match by skill overlap: the bullet's skills intersect with the position's
  //     technology skill ids.
  const assigned = new Set<string>();

  for (const bullet of bullets) {
    let bestMatch: PositionInfo | undefined;
    let bestOverlap = 0;

    for (const pos of positions) {
      if (pos.techSkillIds.size === 0) continue;
      const overlap = bullet.skills.filter((s) => pos.techSkillIds.has(asString(s))).length;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestMatch = pos;
      }
    }

    if (bestMatch !== undefined) {
      bestMatch.matchedBullets.push(bullet);
      assigned.add(asString(bullet.id));
    }
  }

  // Sort positions chronologically, most recent first (by end date, then start).
  // Positions with no dates come last.
  positions.sort((a, b) => {
    const aEnd = a.endYM ?? (a.startYM !== undefined ? 999999 : 0); // ongoing = most recent
    const bEnd = b.endYM ?? (b.startYM !== undefined ? 999999 : 0);
    if (aEnd !== bEnd) return bEnd - aEnd; // descending
    const aStart = a.startYM ?? 0;
    const bStart = b.startYM ?? 0;
    return bStart - aStart; // descending
  });

  // Build the CvEmploymentEntry list. Positions with no matching bullets still
  // appear with their technologies listed (R71.7).
  const entries: CvEmploymentEntry[] = positions.map((pos) => ({
    title: pos.title,
    company: pos.company,
    ...(pos.dateRangeStr !== undefined ? { dateRange: pos.dateRangeStr } : {}),
    technologies: pos.technologies,
    achievements: itemAchievements(pos.item),
    bullets: pos.matchedBullets,
  }));

  // If there are unmatched bullets, add a "General" entry.
  const unmatched = bullets.filter((b) => !assigned.has(asString(b.id)));
  if (unmatched.length > 0) {
    entries.push({
      title: 'General',
      company: '',
      technologies: [],
      achievements: [],
      bullets: unmatched,
    });
  }

  return entries;
};

// --- Build -----------------------------------------------------------------

/** A bullet candidate before ordering, carrying its sort signals. */
interface BulletCandidate {
  readonly bullet: CvBullet;
}

/** Pick the first non-empty string among an item's candidate fields. */
const field = (item: ExtractedItem, ...keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = item.fields[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
};

/** Join a start/end range into a single human-readable detail string. */
const dateRange = (start?: string, end?: string): string | undefined => {
  if (start && end) return `${start} – ${end}`;
  return start ?? end ?? undefined;
};

/** Build the education entry for an `education` item, as available. */
const educationEntry = (item: ExtractedItem): CvEntry => {
  const title = field(item, 'degree', 'qualification', 'title', 'name') ?? 'Education';
  const subtitle = field(item, 'institution', 'school', 'university', 'org');
  const detail =
    field(item, 'field', 'fieldOfStudy', 'specialisation') ??
    dateRange(field(item, 'start', 'startedOn'), field(item, 'end', 'finishedOn'));
  const entry: CvEntry = { id: item.id, title };
  if (subtitle !== undefined) (entry as { subtitle?: string }).subtitle = subtitle;
  if (detail !== undefined) (entry as { detail?: string }).detail = detail;
  return entry;
};

/** Build the certification entry for a `certification` item, as available. */
const certificationEntry = (item: ExtractedItem): CvEntry => {
  const title = field(item, 'name', 'title', 'certification') ?? 'Certification';
  const subtitle = field(item, 'issuer', 'authority', 'org', 'institution');
  const detail = field(item, 'date', 'issued', 'when', 'year');
  const entry: CvEntry = { id: item.id, title };
  if (subtitle !== undefined) (entry as { subtitle?: string }).subtitle = subtitle;
  if (detail !== undefined) (entry as { detail?: string }).detail = detail;
  return entry;
};

/**
 * Build the single {@link CvModel} for a target role from confirmed evidence
 * (R30.1–R30.4). Pure and deterministic. The result is the confirmed subset:
 * only skill-map skills, only non-retired bullets that link to a confirmed
 * skill, and only output-eligible education / certification items — all ordered
 * with target-role-relevant content first.
 */
export const buildCvModel = (
  role: RolePreference,
  evidence: ConfirmedEvidence,
): CvModel => {
  // The confirmed skills, by id, and the set the target role matches (R30.2).
  const confirmedSkillIds = new Set<string>(
    evidence.skillMap.entries.map((e) => asString(e.id)),
  );
  const roleSkillIds = new Set<string>(role.matchedSkills.map((s) => asString(s)));

  // 1. Skills section — only confirmed skill-map entries (R30.1), target-relevant
  //    first, then by category and name for a stable, deterministic order (R30.2).
  const skills: CvSkill[] = evidence.skillMap.entries
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      category: entry.category,
      targetRelevant: roleSkillIds.has(asString(entry.id)),
    }))
    .sort((a, b) => {
      if (a.targetRelevant !== b.targetRelevant) return a.targetRelevant ? -1 : 1;
      if (a.category !== b.category) return a.category < b.category ? -1 : 1;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return asString(a.id) < asString(b.id) ? -1 : asString(a.id) > asString(b.id) ? 1 : 0;
    });

  // 2. Experience bullets — drawn from confirmed accomplishments and talking
  //    points, admitted only when they link to a confirmed skill (R30.1), each
  //    carrying its target-relevance (R30.2), quantification (R30.3), and
  //    metric note (R30.4).
  const candidates: BulletCandidate[] = [];

  for (const acc of evidence.accomplishments ?? []) {
    if (acc.retired) continue;
    const linked = acc.skills.filter((s) => confirmedSkillIds.has(asString(s)));
    if (linked.length === 0) continue; // not selectable via skill links (R30.1)
    candidates.push({
      bullet: {
        id: acc.id,
        source: 'accomplishment',
        text: oneLine(acc.text),
        skills: linked,
        targetRelevant: linked.some((s) => roleSkillIds.has(asString(s))),
        quantified: isQuantified(acc.text),
        needsMetric: false,
      },
    });
  }

  for (const tp of evidence.talkingPoints ?? []) {
    if (tp.retired) continue;
    const linked = tp.skills.filter((s) => confirmedSkillIds.has(asString(s)));
    if (linked.length === 0) continue; // not selectable via skill links (R30.1)
    const needsMetric = tp.flags.includes('needs_metric');
    const bullet: CvBullet = {
      id: tp.id,
      source: 'talking-point',
      // The polished text is the first-person past-tense CV text and already
      // embeds any quantified result the user gave (R28.3, R30.3).
      text: oneLine(tp.polished),
      skills: linked,
      targetRelevant: linked.some((s) => roleSkillIds.has(asString(s))),
      // A quantified result from the STAR answer (its result element, or the
      // polished text it was woven into) is used and flagged (R30.3).
      quantified: isQuantified(tp.result, tp.polished),
      needsMetric,
    };
    if (needsMetric) (bullet as { metricNote?: string }).metricNote = NEEDS_METRIC_NOTE;
    candidates.push({ bullet });
  }

  // Prioritise toward the target role (R30.2): target-relevant bullets first,
  // then quantified bullets (R30.3), then by stable id for determinism.
  const experience: CvBullet[] = candidates
    .map((c) => c.bullet)
    .sort((a, b) => {
      if (a.targetRelevant !== b.targetRelevant) return a.targetRelevant ? -1 : 1;
      if (a.quantified !== b.quantified) return a.quantified ? -1 : 1;
      return asString(a.id) < asString(b.id) ? -1 : asString(a.id) > asString(b.id) ? 1 : 0;
    });

  // 3. Education / certification entries — only output-eligible items (R11),
  //    excluding private ones (R12.3). Sorted by id for determinism.
  const { eligible } = computeEligibility({
    items: evidence.items ?? [],
    promotedLowIds: evidence.promotedLowIds,
  });
  const byId = (a: CvEntry, b: CvEntry): number =>
    asString(a.id) < asString(b.id) ? -1 : asString(a.id) > asString(b.id) ? 1 : 0;

  const education: CvEntry[] = eligible
    .filter((i) => i.type === 'education')
    .map(educationEntry)
    .sort(byId);
  const certifications: CvEntry[] = eligible
    .filter((i) => i.type === 'certification')
    .map(certificationEntry)
    .sort(byId);

  const model: CvModel = {
    targetRole: { slug: role.slug, title: role.title },
    header: evidence.header ?? {},
    skills,
    experience,
    education,
    certifications,
  };
  if (evidence.summary !== undefined && evidence.summary.trim().length > 0) {
    (model as { summary?: string }).summary = oneLine(evidence.summary);
  }

  // 5. New CV sections from confirmed items (R73.5) — only included when
  //    the user has explicitly confirmed items of each type.
  const confirmedItems = (evidence.items ?? []).filter((i) => i.userConfirmed && !i.private);

  // Professional summary — from confirmed professional_summary items
  const summaryItems = confirmedItems.filter((i) => i.type === 'professional_summary');
  if (summaryItems.length > 0) {
    const text = summaryItems
      .map((i) => (typeof i.fields.text === 'string' ? i.fields.text.trim() : ''))
      .filter((t) => t.length > 0)
      .join(' ');
    if (text.length > 0) {
      (model as { professionalSummary?: string }).professionalSummary = oneLine(text);
    }
  }

  // Core competencies — from confirmed core_competency items
  const competencyItems = confirmedItems.filter((i) => i.type === 'core_competency');
  if (competencyItems.length > 0) {
    const names = competencyItems
      .map((i) => (typeof i.fields.name === 'string' ? i.fields.name.trim() : ''))
      .filter((n) => n.length > 0);
    if (names.length > 0) {
      (model as { coreCompetencies?: readonly string[] }).coreCompetencies = names;
    }
  }

  // Languages — from confirmed language_proficiency items
  const languageItems = confirmedItems.filter((i) => i.type === 'language_proficiency');
  if (languageItems.length > 0) {
    const langs: CvLanguageEntry[] = languageItems
      .map((i) => ({
        language: typeof i.fields.language === 'string' ? i.fields.language.trim() : '',
        proficiency: typeof i.fields.proficiency === 'string' ? i.fields.proficiency.trim() : '',
      }))
      .filter((l) => l.language.length > 0);
    if (langs.length > 0) {
      (model as { languages?: readonly CvLanguageEntry[] }).languages = langs;
    }
  }

  // Hobbies and causes — combine confirmed hobby and cause items
  const hobbyAndCauseItems = confirmedItems.filter(
    (i) => i.type === 'hobby' || i.type === 'cause',
  );
  if (hobbyAndCauseItems.length > 0) {
    const names = hobbyAndCauseItems
      .map((i) => (typeof i.fields.name === 'string' ? i.fields.name.trim() : ''))
      .filter((n) => n.length > 0);
    if (names.length > 0) {
      (model as { hobbiesAndCauses?: readonly string[] }).hobbiesAndCauses = names;
    }
  }

  // 4. Employment entries — group bullets under their originating employment
  //    position, using date overlap or skill overlap (R71.7).
  const employmentItems = (evidence.items ?? []).filter((i) => i.type === 'employment');
  if (employmentItems.length > 0) {
    const entries = buildEmploymentEntries(employmentItems, experience, evidence.skillMap);
    if (entries.length > 0) {
      (model as { employmentEntries?: readonly CvEmploymentEntry[] }).employmentEntries = entries;
    }
  }

  return model;
};
