// Conservative skill normalisation (Conservative Merge, R15 + R16).
//
// Given a set of surface skill terms, decide which terms denote the SAME
// underlying skill and may be folded together, and which must stay separate.
// The algorithm is deliberately cautious — misrepresenting a person's expertise
// is worse than leaving two near-duplicate entries:
//
//   * Two terms merge ONLY when they are casing/spelling variants of the same
//     canonical form, or are listed together as synonyms/abbreviations in
//     `config/confusables.yaml` (R15.1).
//   * A pair listed in `confusables.yaml` is NEVER merged, and string
//     similarity ALONE never triggers a merge (R16.1, R16.3) — there is no
//     fuzzy-match auto-merge path at all.
//   * The normaliser never invents a sub-skill that is absent from the source:
//     every term in the output also appears in the input (R15.3).
//   * Umbrella terms present in the source are reported as SEPARATE additional
//     skills, never as a replacement for the named products under them (R16.2).
//   * When two terms look related but are not provably the same skill, they are
//     kept separate and surface at most one optional merge suggestion (R15.4).
//
// Every merge produced is reversible: each {@link MergeGroup} carries the full
// list of source terms, so a one-step split restores the original distinct
// terms (R19.3) — see {@link toMergeRecord}.

import type { ISODate, MergeRecord, SkillTerm } from '@core/types';
import { asSkillTerm } from '@core/types';
import { canonicalTerm, type Confusables } from './confusables';

/** Why two terms were judged to be the same skill (R15.1). */
export type MergeReason =
  | 'casing-or-spelling-variant'
  | 'synonym'
  | 'abbreviation';

/** A set of source terms folded into one skill, with the reason and survivor. */
export interface MergeGroup {
  /** The surviving representative term (full phrasing preferred). */
  readonly into: SkillTerm;
  /** Every distinct source term in the group, including `into` (>= 2). */
  readonly from: SkillTerm[];
  /** Why the merge is licensed (R15.1). */
  readonly reason: MergeReason;
  /** Human-readable rationale, logged on merge (R15.2). */
  readonly rationale: string;
}

/** An optional, user-facing suggestion to merge an uncertain pair (R15.4). */
export interface MergeSuggestion {
  readonly terms: readonly [SkillTerm, SkillTerm];
  readonly rationale: string;
}

/** The outcome of normalising a set of skill terms. */
export interface MergePlan {
  /**
   * The distinct skills after conservative merge: one representative term per
   * resulting skill. Every entry is one of the input terms (R15.3 — nothing is
   * invented).
   */
  readonly skills: SkillTerm[];
  /** The merges actually performed — groups of two or more source terms. */
  readonly merges: MergeGroup[];
  /**
   * Umbrella terms found in the source, kept as separate additional skills
   * rather than absorbing the named products beneath them (R16.2).
   */
  readonly umbrellas: SkillTerm[];
  /** At most one optional merge suggestion per uncertain pair (R15.4). */
  readonly suggestions: MergeSuggestion[];
}

/** Default similarity threshold above which an uncertain pair is suggested. */
export const SUGGESTION_SIMILARITY = 0.84;

/** Options for {@link normalise}. */
export interface NormaliseOptions {
  /**
   * Similarity in `[0, 1]` at or above which two non-mergeable, non-confusable
   * terms raise a single optional merge suggestion (R15.4). Set to `1` to
   * disable suggestions entirely.
   */
  readonly suggestionThreshold?: number;
}

// --- Internal helpers ------------------------------------------------------

/** Levenshtein edit distance between two strings (small, iterative DP). */
const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
};

/** Similarity in `[0, 1]`, derived from normalised edit distance. */
const similarity = (a: string, b: string): number => {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
};

/** A disjoint-set (union-find) over canonical-term indices. */
class UnionFind {
  private readonly parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

interface TermInfo {
  /** A representative surface spelling for this canonical form (first seen). */
  readonly surface: SkillTerm;
  readonly canonical: string;
  /** Every distinct surface spelling that shares this canonical form. */
  readonly surfaces: SkillTerm[];
}

/**
 * Choose the surviving representative among a set of candidate surface
 * spellings. Prefers the term that appears most often, then the longest (a full
 * name such as "JavaScript" over the abbreviation "JS"), then the alphabetically
 * first surface form for determinism. User phrasing is preserved verbatim
 * (R17.3).
 */
const chooseRepresentative = (
  surfaces: ReadonlyArray<SkillTerm>,
  counts: ReadonlyMap<string, number>,
): SkillTerm => {
  return [...surfaces].sort((a, b) => {
    const ca = counts.get(String(a)) ?? 0;
    const cb = counts.get(String(b)) ?? 0;
    if (cb !== ca) return cb - ca;
    if (b.length !== a.length) return b.length - a.length;
    return 0; // tie → preserve first-seen order (stable sort)
  })[0];
};

// --- The algorithm ---------------------------------------------------------

/**
 * Conservatively normalise a set of skill terms (R15, R16). Returns a
 * {@link MergePlan} describing the distinct resulting skills, the reversible
 * merges performed, the umbrella terms kept separate, and any optional merge
 * suggestions for uncertain pairs. Pure and deterministic.
 */
export const normalise = (
  terms: ReadonlyArray<SkillTerm>,
  confusables: Confusables,
  options: NormaliseOptions = {},
): MergePlan => {
  const threshold = options.suggestionThreshold ?? SUGGESTION_SIMILARITY;

  // De-duplicate by canonical form, preserving EVERY distinct surface spelling
  // (so a casing/spelling-variant merge stays reversible to the originals,
  // R19.3) and counting per-surface occurrences (drives representative choice).
  const infos: TermInfo[] = [];
  const indexOfCanonical = new Map<string, number>();
  const surfaceCounts = new Map<string, number>();
  for (const term of terms) {
    const canonical = canonicalTerm(term);
    if (canonical.length === 0) continue;
    surfaceCounts.set(String(term), (surfaceCounts.get(String(term)) ?? 0) + 1);
    const existing = indexOfCanonical.get(canonical);
    if (existing !== undefined) {
      if (!infos[existing].surfaces.some((s) => s === term)) {
        infos[existing].surfaces.push(term);
      }
      continue;
    }
    indexOfCanonical.set(canonical, infos.length);
    infos.push({ surface: term, canonical, surfaces: [term] });
  }

  const uf = new UnionFind(infos.length);

  // Reason per representative root (only the first union reason is kept).
  const reasonOf = new Map<number, MergeReason>();

  // Synonym / abbreviation groups license a merge UNLESS the pair is confusable
  // (the never-merge guard always wins, R16.3).
  const applyGroups = (
    groups: ReadonlyArray<ReadonlySet<string>>,
    reason: MergeReason,
  ): void => {
    for (const group of groups) {
      const indices = infos
        .map((info, i) => ({ i, canonical: info.canonical }))
        .filter((x) => group.has(x.canonical))
        .map((x) => x.i);
      for (let a = 0; a < indices.length; a++) {
        for (let b = a + 1; b < indices.length; b++) {
          const ia = indices[a];
          const ib = indices[b];
          if (confusables.isConfusable(infos[ia].surface, infos[ib].surface)) continue;
          uf.union(ia, ib);
          const root = uf.find(ia);
          if (!reasonOf.has(root)) reasonOf.set(root, reason);
        }
      }
    }
  };
  applyGroups(confusables.synonymGroups, 'synonym');
  applyGroups(confusables.abbreviationGroups, 'abbreviation');

  // Group members by union-find root.
  const membersByRoot = new Map<number, number[]>();
  for (let i = 0; i < infos.length; i++) {
    const root = uf.find(i);
    (membersByRoot.get(root) ?? membersByRoot.set(root, []).get(root)!).push(i);
  }

  const skills: SkillTerm[] = [];
  const merges: MergeGroup[] = [];
  const umbrellas: SkillTerm[] = [];

  for (const [root, indices] of membersByRoot) {
    const members = indices.map((i) => infos[i]);
    // All distinct surface spellings folded into this skill (R19.3 reversal).
    const from = members.flatMap((m) => m.surfaces);
    const representative = chooseRepresentative(from, surfaceCounts);
    skills.push(representative);

    // A merge occurred when more than one distinct surface term was folded in —
    // whether across union-find members or as casing/spelling variants of one
    // canonical form.
    if (from.length > 1) {
      const reason: MergeReason = reasonOf.get(root) ?? 'casing-or-spelling-variant';
      merges.push({
        into: representative,
        from,
        reason,
        rationale: rationaleFor(reason, from, representative),
      });
    }

    // Report umbrella terms (when present in source) as separate skills (R16.2).
    for (const surface of from) {
      if (confusables.isUmbrella(surface)) umbrellas.push(surface);
    }
  }

  const suggestions = buildSuggestions(infos, uf, confusables, threshold);

  return { skills, merges, umbrellas, suggestions };
};

/** Compose a logged rationale for a merge (R15.2). */
const rationaleFor = (
  reason: MergeReason,
  from: ReadonlyArray<SkillTerm>,
  into: SkillTerm,
): string => {
  const sources = from.filter((t) => t !== into);
  const list = sources.length > 0 ? sources.join(', ') : from.join(', ');
  switch (reason) {
    case 'synonym':
      return `Merged synonym(s) ${list} into "${into}" (listed as the same skill in confusables.yaml).`;
    case 'abbreviation':
      return `Merged abbreviation(s) ${list} into "${into}" (listed in confusables.yaml).`;
    case 'casing-or-spelling-variant':
    default:
      return `Merged casing/spelling variant(s) ${list} into "${into}".`;
  }
};

/**
 * Build at most one optional merge suggestion per uncertain pair (R15.4): two
 * terms that are NOT already merged, are NOT a confusable pair, and whose
 * canonical forms are similar above the threshold. Suggestions never merge on
 * their own — they only invite the user to decide (R16.1 is preserved).
 */
const buildSuggestions = (
  infos: TermInfo[],
  uf: UnionFind,
  confusables: Confusables,
  threshold: number,
): MergeSuggestion[] => {
  if (threshold > 1) return [];
  const suggestions: MergeSuggestion[] = [];
  for (let a = 0; a < infos.length; a++) {
    for (let b = a + 1; b < infos.length; b++) {
      if (uf.find(a) === uf.find(b)) continue; // already the same skill
      if (confusables.isConfusable(infos[a].surface, infos[b].surface)) continue; // R16.3
      const score = similarity(infos[a].canonical, infos[b].canonical);
      if (score < threshold) continue;
      suggestions.push({
        terms: [infos[a].surface, infos[b].surface],
        rationale: `"${infos[a].surface}" and "${infos[b].surface}" look similar but were kept separate; merge only if they are the same skill.`,
      });
    }
  }
  return suggestions;
};

/**
 * Convert a performed {@link MergeGroup} into a reversible {@link MergeRecord}
 * (R15.2, R19.3). The record keeps every original surface term, so a one-step
 * split restores the distinct terms.
 */
export const toMergeRecord = (group: MergeGroup, at: ISODate): MergeRecord => ({
  from: group.from.filter((t) => t !== group.into).map((t) => asSkillTerm(String(t))),
  into: group.into,
  rationale: group.rationale,
  at,
  reversible: true,
});

/**
 * Reverse a {@link MergeRecord} in one step (R19.3), returning the original
 * distinct surface terms that had been folded together.
 */
export const splitMergeRecord = (record: MergeRecord): SkillTerm[] => [
  record.into,
  ...record.from,
];
