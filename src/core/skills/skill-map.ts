// Skill-map generation with bi-directional evidence links (R14.1, R14.2, R14.3,
// R18.2, R18.3).
//
// `generate(extractions)` turns the verified output of ingestion into a set of
// {@link SkillMapEntry} records. Each entry preserves the user's original skill
// phrasing (R17.3 via the conservative normaliser), carries a category, an
// EVIDENCE-BASED proficiency signal (never a self-reported score unless the user
// supplies one, R14.3), a dated evidence trail, and the `since` date of the
// earliest evidence (R70.1).
//
// Two trust rules govern what becomes a skill:
//   * Skills are derived ONLY from verified source material or explicit user
//     confirmation (R14.2). Low-confidence, not-yet-promoted items are excluded
//     (R11.4) unless the user has confirmed them.
//   * Conservative merging (task 10.1, R15/R16) decides which surface terms fold
//     together; this module never invents a skill that is absent from source.
//
// Bi-directional skill ↔ accomplishment linking (R18.2, R18.3) reuses the ID
// Registry's {@link ReferenceGraph} rather than re-implementing it: when
// accomplishments (`BULLET-NN`) or talking points (`STAR-NN`) are supplied, their
// ids are referenced in the relevant skill entry's evidence trail AND the graph
// resolves each skill to its proofs and each proof back to its skills.

import type {
  Accomplishment,
  ExtractedItem,
  ISODate,
  SkillCategory,
  SkillEvidence,
  SkillId,
  SkillMapEntry,
  SkillTerm,
  TalkingPoint,
} from '@core/types';
import { asISODate, asSkillId, asSkillTerm } from '@core/types';
import {
  buildReferenceGraph,
  kindOf,
  ReferenceGraph,
} from '@core/registry';
import {
  loadConfusablesFromYaml,
  DEFAULT_CONFUSABLES_YAML,
  type Confusables,
} from './confusables';
import { normalise, toMergeRecord, type MergeGroup } from './normalise';

/**
 * The generated skill map: the distinct skill entries plus the bi-directional
 * skill ↔ proof graph that resolves each skill to the accomplishments/talking
 * points that prove it and vice-versa (R18.3).
 */
export interface SkillMap {
  /** One entry per distinct skill, sorted by id for determinism (R14.1). */
  readonly entries: SkillMapEntry[];
  /** Bi-directional skill ↔ accomplishment/talking-point graph (R18.2, R18.3). */
  readonly graph: ReferenceGraph;
}

/** Options for {@link generate}. */
export interface SkillMapOptions {
  /** Confusables resource (defaults to the shipped seed list). */
  readonly confusables?: Confusables;
  /**
   * Confirmed accomplishments to link bi-directionally (R18.2, R18.3). Each
   * accomplishment's `skills` list names the skills it evidences; for every one
   * that exists in the map its `BULLET-NN` id is added to that skill's evidence
   * trail. Retired accomplishments are not surfaced as evidence (R23.3).
   */
  readonly accomplishments?: readonly Accomplishment[];
  /**
   * Confirmed talking points to link bi-directionally (R18.2, R18.3). Each
   * talking point's `skills` list names the skills it evidences; for every one
   * that exists in the map its `STAR-NN` id is added to that skill's evidence
   * trail. Retired talking points are not surfaced as evidence (R23.3).
   */
  readonly talkingPoints?: readonly TalkingPoint[];
  /**
   * The "as of" date used to date evidence drawn from undated source items
   * (e.g. a flat skills list) and to date proof links (R14.1). Defaults to the
   * most recent date found across the extractions, then to {@link nowISO}.
   */
  readonly asOf?: ISODate;
  /** Injectable clock for the last-resort `asOf` fallback (testability). */
  readonly now?: () => Date;
  /**
   * Skip the conservative normalisation/merge pipeline (R60.5). When `true`,
   * each skill term becomes its own entry without synonym/abbreviation/casing
   * merges. Used in AI-only mode where the AI has already consolidated the
   * skill list and the deterministic normaliser would incorrectly drop or merge
   * distinct skills the AI deliberately kept separate.
   */
  readonly skipNormalisation?: boolean;
}

// --- Verification gate (R14.2) ---------------------------------------------

/**
 * A skill is derived only from VERIFIED source material or explicit user
 * confirmation (R14.2). A user-confirmed item is always trusted (R12.4); an
 * unconfirmed item must carry at least High/Medium confidence — Low-confidence
 * items sit in the needs-review bucket and are excluded until promoted (R11.4).
 */
const isVerified = (item: ExtractedItem): boolean =>
  item.userConfirmed || item.confidence !== 'Low';

// --- Date helpers ----------------------------------------------------------

const asString = (v: unknown): string => v as unknown as string;

/** The first non-empty string among candidate date fields on an item. */
const itemDate = (item: ExtractedItem): string | undefined => {
  const f = item.fields;
  for (const key of ['end', 'finishedOn', 'start', 'startedOn', 'date', 'when']) {
    const value = f[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
};

/** ISO `YYYY-MM-DD` for the injected/real clock. */
const nowISO = (now: () => Date): string => now().toISOString().slice(0, 10);

/**
 * Resolve the effective `asOf` date: the caller's value, else the most recent
 * date present in the extractions, else the current date. ISO date strings sort
 * lexicographically, so a plain max is correct across `YYYY-MM` / `YYYY-MM-DD`.
 */
const resolveAsOf = (
  extractions: readonly ExtractedItem[],
  options: SkillMapOptions,
): string => {
  if (options.asOf !== undefined) return asString(options.asOf);
  const dates = extractions
    .map(itemDate)
    .filter((d): d is string => d !== undefined)
    .sort();
  return dates.length > 0 ? dates[dates.length - 1] : nowISO(options.now ?? (() => new Date()));
};

// --- Skill term extraction (what counts as a skill) ------------------------

/** A surface skill term drawn from one source item, with its dating context. */
interface SourceTerm {
  readonly term: SkillTerm;
  readonly item: ExtractedItem;
  /** Date tied to this specific mention (e.g. an employment range), if any. */
  readonly when?: string;
  /** Extra context for the evidence note (e.g. a stated language proficiency). */
  readonly detail?: string;
}

/**
 * Pull the surface skill terms out of a single verified extracted item:
 *   - `skill` items contribute their named skill (undated);
 *   - `employment` items contribute each listed technology, dated by the role's
 *     end (or start) so the evidence trail carries a real date (R14.1);
 *   - `education` items contribute each listed skill, dated by the education
 *     start date so the `since` derivation reflects when the skill was first
 *     encountered (R71.4, R71.5);
 *   - `language` items contribute the language as a skill, noting the stated
 *     proficiency as source context (not a self-assessment).
 * Other item types carry no claimable skill.
 */
const termsFromItem = (item: ExtractedItem): SourceTerm[] => {
  const f = item.fields;
  switch (item.type) {
    case 'skill': {
      const name = typeof f.name === 'string' ? f.name.trim() : '';
      // AI-discovered skills may carry a `since` field (inferred start year).
      const since = typeof f.since === 'string' ? f.since.trim() : undefined;
      return name ? [{ term: asSkillTerm(name), item, when: since }] : [];
    }
    case 'employment': {
      const techs = Array.isArray(f.technologies) ? (f.technologies as unknown[]) : [];
      const when = itemDate(item);
      return techs
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((t) => ({ term: asSkillTerm(t.trim()), item, when }));
    }
    case 'education': {
      const skills = Array.isArray(f.skills) ? (f.skills as unknown[]) : [];
      // Use education start date as `when` — represents when the skill was first encountered (R71.5).
      const start = typeof f.start === 'string' && f.start.trim().length > 0
        ? f.start.trim()
        : typeof f.startedOn === 'string' && f.startedOn.trim().length > 0
          ? f.startedOn.trim()
          : undefined;
      return skills
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s) => ({ term: asSkillTerm(s.trim()), item, when: start }));
    }
    case 'language': {
      const language = typeof f.language === 'string' ? f.language.trim() : '';
      const proficiency = typeof f.proficiency === 'string' ? f.proficiency.trim() : undefined;
      return language
        ? [{ term: asSkillTerm(language), item, detail: proficiency }]
        : [];
    }
    case 'core_competency': {
      const name = typeof f.name === 'string' ? f.name.trim() : '';
      return name ? [{ term: asSkillTerm(name), item }] : [];
    }
    default:
      return [];
  }
};

// --- Stable SkillId derivation ---------------------------------------------

/**
 * Derive a stable, deterministic {@link SkillId} from a skill's canonical name,
 * so the same skill keeps the same id across regenerations (R18.4 — never
 * renumbered). Punctuation that distinguishes skills (`C++` vs `C#` vs `C`) is
 * preserved through a readable transliteration before slugifying.
 */
const slugOf = (name: SkillTerm | string): string =>
  String(name)
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/#/g, 'sharp')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Public alias of the stable slug derivation (R18.4). Exposed so the skill-map
 * review operations (task 10.4) mint ids for user-added and split-restored
 * skills with the exact same scheme used during {@link generate}.
 */
export const skillSlug = slugOf;

// --- Category inference (R14.1) --------------------------------------------

const LEADERSHIP = /\b(lead(ership)?|(?<!firewall |package |password |task |window |resource |credential )manage(ment|r)?|mentor(ship|ing)?|coach(ing)?|strateg(y|ic)|stakeholder|delegat|hiring|roadmap|p&l|budget)\b/i;
const COMMUNICATION = /\b(communicat|present(ation)?|writing|public speaking|negotiat|storytelling|facilitat|english|spanish|french|german|portuguese|mandarin|language)\b/i;
const TOOLS = /\b(git|github|gitlab|jira|confluence|figma|docker|kubernetes|k8s|terraform|jenkins|excel|tableau|power\s?bi|photoshop|slack|notion)\b/i;
const TECHNICAL = /\b(java|javascript|typescript|python|c\+\+|c#|go(lang)?|rust|ruby|php|sql|react|angular|vue|node|aws|azure|gcp|api|machine learning|ml|ai|data|algorithm|css|html|linux|devops|cloud)\b/i;

/**
 * Categorise a skill into one bucket (R14.1) using a conservative keyword scan.
 * Order matters: leadership/communication signals win over a tooling/technical
 * match, and an explicit tool name wins over a generic technical match. Defaults
 * to `Domain` when nothing matches rather than guessing `Technical`.
 */
const categorise = (name: SkillTerm | string): SkillCategory => {
  const s = String(name);
  if (LEADERSHIP.test(s)) return 'Leadership';
  if (COMMUNICATION.test(s)) return 'Communication';
  if (TOOLS.test(s)) return 'Tools';
  if (TECHNICAL.test(s)) return 'Technical';
  return 'Domain';
};

/**
 * Public alias of the keyword categoriser (R14.1). Exposed so the skill-map
 * review operations (task 10.4) categorise user-added and split-restored skills
 * with the exact same rules used during {@link generate}.
 */
export const categoriseSkill = categorise;

// --- Proficiency signal (R14.3) --------------------------------------------

/** Per-skill aggregates used to phrase the evidence-based proficiency signal. */
interface SkillAccumulator {
  readonly name: SkillTerm;
  readonly evidence: SkillEvidence[];
  highestConfidence: ExtractedItem['confidence'];
  userConfirmed: boolean;
  sourceCount: number;
  /** Set when at least one source item is of type `core_competency` (R73.4). */
  hasCoreCompetencySource: boolean;
}

const CONFIDENCE_RANK: Record<ExtractedItem['confidence'], number> = {
  High: 3,
  Medium: 2,
  Low: 1,
};

/**
 * Phrase an EVIDENCE-BASED proficiency signal (R14.3): it describes the volume,
 * confidence, and duration of the evidence — never a self-reported score. A
 * self-assessment is recorded separately and only when the user provides one
 * (see {@link generate}).
 */
const proficiencySignalOf = (acc: SkillAccumulator, recency: string): string => {
  const count = acc.evidence.length;
  const noun = count === 1 ? 'source' : 'sources';
  const confirmed = acc.userConfirmed ? 'user-confirmed, ' : '';
  return `Evidence-based: ${confirmed}${acc.highestConfidence.toLowerCase()} confidence across ${count} ${noun}; since ${recency}.`;
};

// --- Generation ------------------------------------------------------------

/** Side-table mapping a built entry back to its accumulator (signal phrasing). */
const accBackref = new WeakMap<SkillMapEntry, SkillAccumulator>();

const dedupeEvidence = (evidence: SkillEvidence[]): SkillEvidence[] => {
  const seen = new Set<string>();
  const out: SkillEvidence[] = [];
  for (const e of evidence) {
    const key = `${asString(e.ref)}\u0000${asString(e.when)}\u0000${e.note}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => {
    if (a.when !== b.when) return asString(a.when) < asString(b.when) ? -1 : 1;
    return asString(a.ref) < asString(b.ref) ? -1 : asString(a.ref) > asString(b.ref) ? 1 : 0;
  });
};

/** The most recent evidence date in an entry, or the fallback when empty. */
const recencyOf = (evidence: readonly SkillEvidence[], fallback: string): string => {
  let latest = '';
  for (const e of evidence) {
    const w = asString(e.when);
    if (w > latest) latest = w;
  }
  return latest || fallback;
};

/** The earliest evidence date in an entry, or '' when empty (R70.2). */
const earliestOf = (evidence: readonly SkillEvidence[]): string => {
  let earliest = '';
  for (const e of evidence) {
    const w = asString(e.when);
    if (w && (earliest === '' || w < earliest)) earliest = w;
  }
  return earliest;
};

/**
 * Generate a skill map from verified extractions (R14.1, R14.2, R14.3, R18.2,
 * R18.3). Pure and deterministic for a fixed `asOf`/clock. The result's entries
 * preserve user phrasing, carry an evidence-based proficiency signal, a dated
 * evidence trail, and a `since` date; when accomplishments/talking points are supplied
 * their stable ids are referenced bi-directionally through the reference graph.
 */
export const generate = (
  extractions: readonly ExtractedItem[],
  options: SkillMapOptions = {},
): SkillMap => {
  const confusables = options.confusables ?? loadConfusablesFromYaml(DEFAULT_CONFUSABLES_YAML);
  const asOf = resolveAsOf(extractions, options);

  // 1. Gather surface skill terms from verified items only (R14.2, R11.4).
  const sourceTerms: SourceTerm[] = [];
  for (const item of extractions) {
    if (!isVerified(item)) continue;
    sourceTerms.push(...termsFromItem(item));
  }

  // 2. Conservative normalisation decides which surface terms fold together
  //    (R15/R16). Nothing absent from source is invented (R15.3).
  //    In AI-only mode (skipNormalisation), the AI has already consolidated the
  //    skill list — applying the deterministic normaliser would incorrectly drop
  //    or merge distinct skills the AI deliberately kept separate (R60.5).
  const repBySurface = new Map<string, SkillTerm>();
  const mergeByRep = new Map<string, MergeGroup>();

  if (options.skipNormalisation) {
    // AI-only path: each unique surface term (case-insensitive) maps to itself.
    // No synonym/abbreviation/casing merges are applied — the AI's consolidation
    // is the authoritative dedup (R60.5).
    const seen = new Map<string, SkillTerm>();
    for (const src of sourceTerms) {
      const key = asString(src.term).toLowerCase().trim();
      if (key.length === 0) continue;
      if (!seen.has(key)) seen.set(key, src.term);
      repBySurface.set(asString(src.term), seen.get(key)!);
    }
  } else {
    const plan = normalise(
      sourceTerms.map((s) => s.term),
      confusables,
    );

    // Map every surface term to its surviving representative.
    for (const merge of plan.merges) {
      mergeByRep.set(asString(merge.into), merge);
      for (const from of merge.from) repBySurface.set(asString(from), merge.into);
    }
    for (const skill of plan.skills) {
      if (!repBySurface.has(asString(skill))) repBySurface.set(asString(skill), skill);
    }
  }

  // 3. Group evidence per representative skill.
  const accumulators = new Map<string, SkillAccumulator>();
  for (const src of sourceTerms) {
    const rep = repBySurface.get(asString(src.term));
    if (rep === undefined) continue; // term dropped by the normaliser (e.g. empty)
    const repKey = asString(rep);

    let acc = accumulators.get(repKey);
    if (!acc) {
      acc = {
        name: rep,
        evidence: [],
        highestConfidence: 'Low',
        userConfirmed: false,
        sourceCount: 0,
        hasCoreCompetencySource: false,
      };
      accumulators.set(repKey, acc);
    }

    const note = src.detail
      ? `${asString(src.term)} (${src.detail}) [${src.item.type}]`
      : `${asString(src.term)} [${src.item.type}]`;
    acc.evidence.push({ ref: src.item.sourceDoc, when: asISODate(src.when || ''), note });
    acc.userConfirmed ||= src.item.userConfirmed;
    acc.sourceCount += 1;
    if (src.item.type === 'core_competency') acc.hasCoreCompetencySource = true;
    if (CONFIDENCE_RANK[src.item.confidence] > CONFIDENCE_RANK[acc.highestConfidence]) {
      acc.highestConfidence = src.item.confidence;
    }
  }

  // Stable SkillId per representative (deterministic, never renumbered, R18.4).
  const idByRep = new Map<string, SkillId>();
  const usedIds = new Set<string>();
  const skillIdFor = (rep: SkillTerm): SkillId => {
    const key = asString(rep);
    const existing = idByRep.get(key);
    if (existing) return existing;
    const base = `SKILL-${slugOf(rep) || 'unnamed'}`;
    let candidate = base;
    let n = 2;
    while (usedIds.has(candidate)) candidate = `${base}-${n++}`;
    usedIds.add(candidate);
    const id = asSkillId(candidate);
    idByRep.set(key, id);
    return id;
  };

  // 4. Build one entry per representative skill.
  const entries: SkillMapEntry[] = [];
  const entryById = new Map<string, SkillMapEntry>();
  for (const [, acc] of accumulators) {
    const id = skillIdFor(acc.name);
    const merge = mergeByRep.get(asString(acc.name));
    const entry: SkillMapEntry = {
      id,
      name: asString(acc.name), // user's original phrasing preserved (R17.3)
      category: acc.hasCoreCompetencySource ? 'Core_Competency' : categorise(acc.name),
      proficiencySignal: '', // filled after evidence is finalised
      evidence: acc.evidence,
      since: asISODate(asOf),
      ...(merge ? { mergeRecord: toMergeRecord(merge, asISODate(asOf)) } : {}),
      // selfAssessment is intentionally omitted: an evidence-based signal never
      // includes a self-reported score unless the user provides one (R14.3).
    };
    entries.push(entry);
    entryById.set(asString(id), entry);
    // Stash the accumulator on the entry for signal phrasing after linking.
    accBackref.set(entry, acc);
  }

  // 5. Bi-directional accomplishment / talking-point links (R18.2, R18.3).
  for (const acc of options.accomplishments ?? []) {
    if (acc.retired) continue;
    for (const sid of acc.skills) {
      const entry = entryById.get(asString(sid));
      if (!entry) continue;
      entry.evidence.push({ ref: acc.id, when: asISODate(asOf), note: acc.text });
    }
  }
  for (const tp of options.talkingPoints ?? []) {
    if (tp.retired) continue;
    for (const sid of tp.skills) {
      const entry = entryById.get(asString(sid));
      if (!entry) continue;
      entry.evidence.push({ ref: tp.id, when: asISODate(asOf), note: tp.polished });
    }
  }

  // 6. Finalise evidence ordering, since date, lastEvidence date, and the evidence-based signal.
  for (const entry of entries) {
    const finalEvidence = dedupeEvidence(entry.evidence);
    entry.evidence.length = 0;
    entry.evidence.push(...finalEvidence);
    const earliest = earliestOf(finalEvidence);
    const latest = recencyOf(finalEvidence, '');
    // Only set `since` when a real date was found. When `earliest` is empty, all
    // evidence is from standalone skill items with no employment context — leave
    // `since` undefined so the UI prompts the user to fill it (R70.3).
    if (earliest) {
      (entry as { since?: ISODate }).since = asISODate(earliest);
    } else {
      delete (entry as { since?: ISODate }).since;
    }
    // Set `lastEvidence` to the latest evidence date (R70.8). Used to bound
    // the experience duration computation so legacy skills don't show misleading years.
    if (latest) {
      (entry as { lastEvidence?: ISODate }).lastEvidence = asISODate(latest);
    } else {
      delete (entry as { lastEvidence?: ISODate }).lastEvidence;
    }
    const acc = accBackref.get(entry)!;
    entry.proficiencySignal = proficiencySignalOf(acc, earliest || asOf);
  }

  // 6b. Cross-reference: compare each entry's `since` against the earliest
  // employment start date for that skill; override with the earlier date (R70.2,
  // R71.20). This also fills `since` for standalone skill-type items (e.g. from
  // LinkedIn skills list) by inferring from the employment timeline. Also
  // populate `lastEvidence` from the latest employment end date (R70.8).
  const employmentDates = new Map<string, string>(); // skill name (lower) → earliest employment start
  const employmentEndDates = new Map<string, string>(); // skill name (lower) → latest employment end
  for (const item of extractions) {
    if (item.type !== 'employment') continue;
    const startDate = (item.fields.start ?? item.fields.startedOn) as string | undefined;
    const endDate = (item.fields.end ?? item.fields.finishedOn) as string | undefined;
    if (!startDate || typeof startDate !== 'string') continue;
    const techs = Array.isArray(item.fields.technologies) ? (item.fields.technologies as unknown[]) : [];
    for (const tech of techs) {
      if (typeof tech !== 'string') continue;
      const key = tech.trim().toLowerCase();
      const existing = employmentDates.get(key);
      if (!existing || startDate < existing) {
        employmentDates.set(key, startDate);
      }
      // Track the latest end date for bounding lastEvidence
      if (endDate && typeof endDate === 'string') {
        const existingEnd = employmentEndDates.get(key);
        if (!existingEnd || endDate > existingEnd) {
          employmentEndDates.set(key, endDate);
        }
      }
    }
  }
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    const empDate = employmentDates.get(key);
    if (empDate) {
      // Use the employment start date when it's earlier than the current `since`,
      // or when `since` is not yet set (R70.2, R71.20).
      const currentSince = entry.since !== undefined ? asString(entry.since) : '';
      if (!currentSince || empDate < currentSince) {
        (entry as { since?: ISODate }).since = asISODate(empDate);
      }
    }
    // If lastEvidence is still unset, use the latest employment end date (R70.8)
    if (entry.lastEvidence === undefined) {
      const empEnd = employmentEndDates.get(key);
      if (empEnd) {
        (entry as { lastEvidence?: ISODate }).lastEvidence = asISODate(empEnd);
      }
    }
  }

  entries.sort((a, b) => (asString(a.id) < asString(b.id) ? -1 : asString(a.id) > asString(b.id) ? 1 : 0));

  // 7. Build the bi-directional graph from the same data that lives in the
  //    Markdown store (entry evidence refs + proof skill lists), reusing the
  //    ID Registry's reference graph rather than re-implementing it (R18.3).
  const graph = buildReferenceGraph({
    skills: entries,
    accomplishments: (options.accomplishments ?? []).filter((a) => !a.retired),
    talkingPoints: (options.talkingPoints ?? []).filter((t) => !t.retired),
  });

  return { entries, graph };
};

/**
 * Add STAR/BULLET proof evidence to an existing skill entry and keep the graph
 * consistent in both directions (R18.2, R18.3) — the imperative counterpart to
 * the design's `linkEvidence(skill, ids)`. Source-document refs are ignored here
 * (they are not proofs). Returns the same map for chaining.
 */
export const linkEvidence = (
  map: SkillMap,
  skill: SkillId,
  refs: readonly (SkillEvidence['ref'])[],
  when: ISODate,
  note = '',
): SkillMap => {
  const entry = map.entries.find((e) => asString(e.id) === asString(skill));
  if (!entry) return map;
  for (const ref of refs) {
    const kind = kindOf(asString(ref));
    if (kind === undefined) continue; // only STAR/BULLET proofs participate
    entry.evidence.push({ ref, when, note });
    map.graph.addLink(skill, ref as never);
  }
  const finalEvidence = dedupeEvidence(entry.evidence);
  entry.evidence.length = 0;
  entry.evidence.push(...finalEvidence);
  (entry as { since?: ISODate }).since = asISODate(recencyOf(finalEvidence, asString(entry.since ?? '')));
  return map;
};
