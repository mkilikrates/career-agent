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
  /** Confirmed skills, target-relevant first (R30.1, R30.2). */
  readonly skills: readonly CvSkill[];
  /** Experience bullets, prioritised toward the target role (R30.1–R30.4). */
  readonly experience: readonly CvBullet[];
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
  return model;
};
