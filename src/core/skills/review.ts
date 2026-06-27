// Skill-map review operations (R15.2, R19.1, R19.2, R19.3, R19.4).
//
// Once the Skill_Mapper has generated a map (task 10.3), the user reviews and
// adjusts it before relying on it (R19.1). This module implements the
// imperative review verbs from the design's `SkillMapper` interface:
//
//   * presentForReview(map)            — R19.1 surface the map for review
//   * applyMerge(map, decision)        — R15.2 user-initiated, logged + reversible
//   * splitMerge(map, skill)           — R19.3 one-step reversal of a merge
//   * removeSkill(map, skill)          — R19.3 remove a skill
//   * addUserSkill(map, input)         — R19.2 requires role/project + when
//   * recordSelfAssessment(map, ...)   — R19.4 stored SEPARATELY from the signal
//
// Two trust rules from the spec drive the shapes here:
//
//   * Every merge is reversible in ONE step (R15.2, R19.3). A merge logs its
//     rationale and keeps enough information to restore the original distinct
//     surface terms as separate entries. Auto-merges from {@link generate} are
//     reversed via their {@link MergeRecord} (the original surface terms live in
//     the evidence notes); user-initiated merges keep an exact pre-merge
//     snapshot so the split is loss-free.
//   * A self-assessment is the user's PERSONAL opinion and is stored in the
//     entry's separate `selfAssessment` field — it NEVER alters the
//     evidence-based `proficiencySignal` (R14.3, R19.4).
//
// Operations mutate the supplied {@link SkillMap} in place (matching
// {@link linkEvidence}) and return a useful value for chaining/inspection. The
// bi-directional proof graph (R18.3) is rebuilt from the entries after any
// structural change so forward/reverse lookups stay consistent.

import type {
  ISODate,
  MergeRecord,
  SkillCategory,
  SkillEvidence,
  SkillId,
  SkillMapEntry,
  SkillTerm,
} from '@core/types';
import { asDocId, asISODate, asSkillId, asSkillTerm } from '@core/types';
import { buildReferenceGraph } from '@core/registry';
import { userConfirmation } from '@core/provenance';
import type { Provenance } from '@core/types';
import type { MergeReason } from './normalise';
import { categoriseSkill, skillSlug, type SkillMap } from './skill-map';

const asString = (v: unknown): string => v as unknown as string;

/** Synthetic evidence ref for a fact the user added/confirmed by hand (R19.2). */
export const USER_CONFIRMATION_REF = asDocId('user-confirmation');

// --- R19.1: present the map for review -------------------------------------

/** One reversible merge currently present in the map, surfaced for review. */
export interface ReviewableMerge {
  readonly skill: SkillId;
  readonly record: MergeRecord;
}

/**
 * A read-only presentation of the generated skill map for user review (R19.1):
 * the entries, the reversible merges the user may split, and a count. Pure — it
 * does not mutate the map.
 */
export interface SkillMapReview {
  readonly entries: readonly SkillMapEntry[];
  readonly merges: readonly ReviewableMerge[];
  readonly count: number;
}

/** Present the generated skill map to the user for review (R19.1). */
export const presentForReview = (map: SkillMap): SkillMapReview => ({
  entries: map.entries,
  merges: map.entries
    .filter((e): e is SkillMapEntry & { mergeRecord: MergeRecord } => e.mergeRecord !== undefined)
    .map((e) => ({ skill: e.id, record: e.mergeRecord })),
  count: map.entries.length,
});

// --- shared helpers --------------------------------------------------------

const findEntry = (map: SkillMap, skill: SkillId): SkillMapEntry | undefined =>
  map.entries.find((e) => asString(e.id) === asString(skill));

/** Most recent evidence date, or the fallback when there is none. */
const recencyOf = (evidence: readonly SkillEvidence[], fallback: string): string => {
  let latest = '';
  for (const e of evidence) {
    const w = asString(e.when);
    if (w > latest) latest = w;
  }
  return latest || fallback;
};

const dedupeEvidence = (evidence: readonly SkillEvidence[]): SkillEvidence[] => {
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

/**
 * Phrase an evidence-based proficiency signal for an entry built outside
 * {@link generate} (split-restored or user-added). Describes volume, optional
 * user confirmation, and recency — never a self-reported score (R14.3).
 */
const evidenceSignal = (
  evidence: readonly SkillEvidence[],
  recency: string,
  userConfirmed: boolean,
): string => {
  const count = evidence.length;
  const noun = count === 1 ? 'source' : 'sources';
  const confirmed = userConfirmed ? 'user-confirmed, ' : '';
  return `Evidence-based: ${confirmed}low confidence across ${count} ${noun}; most recent ${recency}.`;
};

/** Mint a stable, unique SkillId for a term, avoiding ids already in the map. */
const freshSkillId = (name: SkillTerm | string, used: Set<string>): SkillId => {
  const base = `SKILL-${skillSlug(name) || 'unnamed'}`;
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) candidate = `${base}-${n++}`;
  used.add(candidate);
  return asSkillId(candidate);
};

const usedIds = (map: SkillMap): Set<string> =>
  new Set(map.entries.map((e) => asString(e.id)));

const sortEntries = (entries: SkillMapEntry[]): void => {
  entries.sort((a, b) =>
    asString(a.id) < asString(b.id) ? -1 : asString(a.id) > asString(b.id) ? 1 : 0,
  );
};

/** Rebuild the bi-directional proof graph from the entries after a change. */
const rebuildGraph = (map: SkillMap): void => {
  (map as { graph: SkillMap['graph'] }).graph = buildReferenceGraph({ skills: map.entries });
};

// Exact pre-merge snapshots for user-initiated merges, so a split is loss-free.
const snapshots = new WeakMap<SkillMapEntry, SkillMapEntry[]>();

// --- R19.2: add a user skill -----------------------------------------------

/** A user-supplied skill addition (R19.2). Role/project AND when are required. */
export interface UserSkillInput {
  /** The skill term, in the user's own phrasing (R17.3). */
  readonly name: string;
  /** The role or project in which the skill was used (R19.2, required). */
  readonly roleOrProject: string;
  /** The approximate time the skill was used, ISO-ish (R19.2, required). */
  readonly when: string;
  /** Optional explicit category; inferred from the name when omitted (R14.1). */
  readonly category?: SkillCategory;
}

/** Thrown when an added skill is missing its required role/project or time (R19.2). */
export class MissingSkillContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingSkillContextError';
  }
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * Add a user-stated skill to the map (R19.2). The user MUST state the role or
 * project AND the approximate time the skill was used; an addition missing
 * either is rejected with a {@link MissingSkillContextError}. The new entry
 * carries a user-confirmation provenance (R12.4, R38.1) rather than a source
 * line, and an evidence-based signal that records it as user-confirmed (never a
 * self-reported score, R14.3). Returns the created entry.
 */
export const addUserSkill = (map: SkillMap, input: UserSkillInput): SkillMapEntry => {
  if (!nonEmpty(input.name)) {
    throw new MissingSkillContextError('A skill name is required to add a skill.');
  }
  if (!nonEmpty(input.roleOrProject)) {
    throw new MissingSkillContextError(
      'Adding a skill requires the role or project in which it was used (R19.2).',
    );
  }
  if (!nonEmpty(input.when)) {
    throw new MissingSkillContextError(
      'Adding a skill requires the approximate time it was used (R19.2).',
    );
  }

  const name = input.name.trim();
  const roleOrProject = input.roleOrProject.trim();
  const when = asISODate(input.when.trim());

  // User-confirmation provenance (R38.1) — the source for a hand-added skill.
  const provenance: Provenance = userConfirmation(
    when,
    `User added "${name}" — used in ${roleOrProject} (approx ${asString(when)}).`,
  );
  const note =
    provenance.kind === 'user_confirmation' ? provenance.note : `User added "${name}".`;

  const evidence: SkillEvidence[] = [
    { ref: USER_CONFIRMATION_REF, when, note },
  ];
  const recency = recencyOf(evidence, asString(when));

  const id = freshSkillId(name, usedIds(map));
  const entry: SkillMapEntry = {
    id,
    name, // user's original phrasing preserved (R17.3)
    category: input.category ?? categoriseSkill(name),
    proficiencySignal: evidenceSignal(evidence, recency, true),
    evidence,
    recency: asISODate(recency),
  };

  map.entries.push(entry);
  sortEntries(map.entries);
  return entry;
};

// --- R19.3: remove a skill -------------------------------------------------

/**
 * Remove a skill from the map in one step (R19.3) and rebuild the proof graph.
 * Returns true if a matching entry was removed.
 */
export const removeSkill = (map: SkillMap, skill: SkillId): boolean => {
  const idx = map.entries.findIndex((e) => asString(e.id) === asString(skill));
  if (idx === -1) return false;
  map.entries.splice(idx, 1);
  rebuildGraph(map);
  return true;
};

// --- R15.2: user-initiated merge -------------------------------------------

/** A user's decision to merge two or more existing skills into one (R15.2). */
export interface MergeDecision {
  /** The entries to fold together (>= 2). */
  readonly skills: readonly SkillId[];
  /** The surviving representative; defaults to the first listed skill. */
  readonly into?: SkillId;
  /** Why the user is merging (drives the logged rationale). */
  readonly reason?: MergeReason;
  /** When the merge happened (logged on the record, R15.2). */
  readonly at: ISODate;
}

const rationaleFor = (
  reason: MergeReason,
  from: readonly SkillTerm[],
  into: SkillTerm,
): string => {
  const sources = from.filter((t) => t !== into);
  const list = (sources.length > 0 ? sources : from).join(', ');
  switch (reason) {
    case 'synonym':
      return `User merged synonym(s) ${list} into "${into}".`;
    case 'abbreviation':
      return `User merged abbreviation(s) ${list} into "${into}".`;
    case 'casing-or-spelling-variant':
    default:
      return `User merged ${list} into "${into}".`;
  }
};

/**
 * Apply a user-initiated merge (R15.2): fold the chosen entries into one,
 * combine and de-duplicate their evidence, log the merge with a rationale, and
 * attach a reversible {@link MergeRecord} to the surviving entry. An exact
 * pre-merge snapshot is kept so {@link splitMerge} restores the originals
 * loss-free in one step (R19.3). Returns the logged record.
 */
export const applyMerge = (map: SkillMap, decision: MergeDecision): MergeRecord => {
  const targets = decision.skills
    .map((id) => findEntry(map, id))
    .filter((e): e is SkillMapEntry => e !== undefined);
  if (targets.length < 2) {
    throw new Error('applyMerge requires at least two existing skills to merge.');
  }

  const intoId = decision.into ?? decision.skills[0];
  const representative =
    targets.find((e) => asString(e.id) === asString(intoId)) ?? targets[0];
  const others = targets.filter((e) => e !== representative);

  // Exact snapshot of every entry folded in, for a loss-free one-step split.
  const snapshot = targets.map((e) => ({
    ...e,
    evidence: e.evidence.map((ev) => ({ ...ev })),
  }));

  const combined = dedupeEvidence([
    ...representative.evidence,
    ...others.flatMap((e) => e.evidence),
  ]);
  representative.evidence.length = 0;
  representative.evidence.push(...combined);

  const recency = recencyOf(combined, asString(representative.recency));
  (representative as { recency: ISODate }).recency = asISODate(recency);

  const intoTerm = asSkillTerm(representative.name);
  const fromTerms = others.map((e) => asSkillTerm(e.name));
  const reason: MergeReason = decision.reason ?? 'synonym';
  const record: MergeRecord = {
    from: fromTerms,
    into: intoTerm,
    rationale: rationaleFor(reason, fromTerms, intoTerm),
    at: decision.at,
    reversible: true,
  };
  representative.mergeRecord = record;
  const userConfirmed = combined.some((e) => asString(e.ref) === asString(USER_CONFIRMATION_REF));
  representative.proficiencySignal = evidenceSignal(combined, recency, userConfirmed);

  // Drop the folded-away entries and remember the snapshot for reversal.
  for (const e of others) {
    const idx = map.entries.indexOf(e);
    if (idx !== -1) map.entries.splice(idx, 1);
  }
  snapshots.set(representative, snapshot);

  sortEntries(map.entries);
  rebuildGraph(map);
  return record;
};

// --- R19.3: one-step split -------------------------------------------------

/** Does this evidence note describe surface term `term`? (auto-merge notes). */
const noteMatchesTerm = (note: string, term: string): boolean =>
  note.startsWith(`${term} [`) || note.startsWith(`${term} (`);

/**
 * Split a merged skill back into separate entries in ONE step (R19.3),
 * restoring the original distinct surface terms. A user-initiated merge (see
 * {@link applyMerge}) is restored exactly from its snapshot; an automatic merge
 * from {@link generate} is restored from its {@link MergeRecord}, routing each
 * surface term's evidence back by matching the evidence notes (any unmatched or
 * proof-link evidence stays with the representative term). The merge record is
 * cleared. Returns the restored entries, or an empty array if the skill has no
 * reversible merge.
 */
export const splitMerge = (map: SkillMap, skill: SkillId): SkillMapEntry[] => {
  const entry = findEntry(map, skill);
  if (!entry || !entry.mergeRecord) return [];

  const idx = map.entries.indexOf(entry);

  // Exact restoration for a user-initiated merge.
  const snapshot = snapshots.get(entry);
  if (snapshot) {
    map.entries.splice(idx, 1, ...snapshot.map((e) => ({ ...e, evidence: [...e.evidence] })));
    snapshots.delete(entry);
    sortEntries(map.entries);
    rebuildGraph(map);
    return snapshot;
  }

  // Term-based restoration for an automatic merge (R19.3): one entry per
  // original surface term, evidence routed back by matching its note.
  const record = entry.mergeRecord;
  const originalTerms: SkillTerm[] = [record.into, ...record.from];
  // Keep every existing id reserved (incl. the representative's, which it
  // retains) so freshly-minted ids for the `from` terms never collide.
  const used = usedIds(map);

  const restored: SkillMapEntry[] = [];
  const matchedByTerm = new Map<string, SkillEvidence[]>();
  const unmatched: SkillEvidence[] = [];
  for (const ev of entry.evidence) {
    const owner = originalTerms.find((t) => noteMatchesTerm(ev.note, asString(t)));
    if (owner) {
      (matchedByTerm.get(asString(owner)) ?? matchedByTerm.set(asString(owner), []).get(asString(owner))!).push(ev);
    } else {
      unmatched.push(ev);
    }
  }

  for (const term of originalTerms) {
    const isRepresentative = asString(term) === asString(record.into);
    const matched = matchedByTerm.get(asString(term)) ?? [];
    // The representative also keeps any unmatched / proof-link evidence.
    const evidence = dedupeEvidence(isRepresentative ? [...matched, ...unmatched] : matched);
    const recency = recencyOf(evidence, asString(entry.recency));
    const userConfirmed = evidence.some(
      (e) => asString(e.ref) === asString(USER_CONFIRMATION_REF),
    );
    const id = isRepresentative ? entry.id : freshSkillId(term, used);
    restored.push({
      id,
      name: asString(term),
      category: categoriseSkill(term),
      proficiencySignal: evidenceSignal(evidence, recency, userConfirmed),
      evidence,
      recency: asISODate(recency),
      // mergeRecord intentionally cleared — the merge has been reversed.
    });
  }

  map.entries.splice(idx, 1, ...restored);
  sortEntries(map.entries);
  rebuildGraph(map);
  return restored;
};

// --- R19.4: personal self-assessment ---------------------------------------

/** A user's personal proficiency self-assessment, stored separately (R19.4). */
export interface SelfAssessment {
  /** The user's personal rating (e.g. "Expert", "3/5", free text). */
  readonly level: string;
  /** Optional supporting note. */
  readonly note?: string;
}

/**
 * Record a personal proficiency self-assessment (R19.4). It is stored in the
 * entry's SEPARATE `selfAssessment` field and NEVER alters the evidence-based
 * `proficiencySignal` (R14.3). Returns the updated entry, or undefined if no
 * such skill exists.
 */
export const recordSelfAssessment = (
  map: SkillMap,
  skill: SkillId,
  assessment: SelfAssessment,
): SkillMapEntry | undefined => {
  const entry = findEntry(map, skill);
  if (!entry) return undefined;
  const level = assessment.level.trim();
  const note = assessment.note?.trim();
  entry.selfAssessment = `Self-assessed: ${level}${note ? ` — ${note}` : ''}`;
  return entry;
};
