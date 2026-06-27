// CV versioning and diffing for the Output_Engine (R33.1, R33.2, R33.3).
//
// Every CV the Output_Engine produces is stored as an immutable file named by
// the target role slug and a monotonically increasing version number — e.g.
// `outputs/cv_[role_slug]_v[n].md` (R33.1, see `@core/storage` `cvPath`). The
// rules this module encodes:
//
//   * R33.1 — a produced version is stored under `cv_[slug]_v[n].{md,pdf,docx}`;
//     the {@link VersionId} ↔ path mapping is the single source of those names.
//   * R33.2 — editing a stored CV never mutates it. {@link nextVersion} always
//     returns a version number strictly greater than every version already
//     stored for the slug, so each edit yields a NEW {@link VersionId}, and
//     {@link recordVersion} refuses to overwrite an existing version file.
//   * R33.3 — {@link diffCv} compares two {@link CvModel}s and enumerates exactly
//     the accomplishments added, removed, or reordered (by their stable
//     `BULLET-NN`/`STAR-NN` ids) and the skills whose emphasis changed (their
//     target-relevance flag or their relative ordering).
//
// Everything here is pure and deterministic: the same inputs always yield the
// same version id, paths, and diff, with every list in a stable order.

import type { BulletId, RoleSlug, SkillId, StarId } from '@core/types';
import { cvPath, type CvFormat } from '@core/storage';
import type { MemoryTree } from '@core/storage';
import type { MemoryPath } from '@core/types';
import type { CvModel, CvBullet, CvSkill } from './cv-model';

const asString = (v: unknown): string => v as unknown as string;

// --- Version identity & paths (R33.1) --------------------------------------

/** The three immutable CV output formats stored per version (R33.1, R32). */
export const VERSION_FORMATS: readonly CvFormat[] = ['md', 'pdf', 'docx'] as const;

/**
 * Identifies one immutable CV version: a target role slug plus a 1-based version
 * number. The pair maps deterministically to the stored file names (R33.1).
 */
export interface VersionId {
  readonly slug: RoleSlug;
  /** 1-based, strictly increasing per slug; never reused (R33.1, R33.2). */
  readonly version: number;
}

/** The shared file stem for a version, without extension (`cv_[slug]_v[n]`). */
export const versionStem = (id: VersionId): string =>
  `cv_${asString(id.slug)}_v${id.version}`;

/** Stable string spelling of a {@link VersionId}, for keys/messages. */
export const versionIdToString = versionStem;

/** The canonical Memory Store path for one format of a version (R33.1). */
export const versionPath = (id: VersionId, format: CvFormat): MemoryPath =>
  cvPath(id.slug, id.version, format);

/** The canonical paths for every format of a version (R33.1). */
export const versionPaths = (id: VersionId): readonly MemoryPath[] =>
  VERSION_FORMATS.map((format) => versionPath(id, format));

/** Matches a stored CV version file: `outputs/cv_<slug>_v<n>.<format>`. */
const CV_VERSION_FILE = /^outputs\/cv_(.+)_v(\d+)\.(?:md|pdf|docx)$/;

/**
 * The version numbers already stored for a role slug, ascending and de-duped.
 * Reads the canonical `outputs/` directory of the {@link MemoryTree}; the
 * presence of any one format counts the version (R33.1).
 */
export const storedVersions = (tree: MemoryTree, slug: RoleSlug): number[] => {
  const target = asString(slug);
  const found = new Set<number>();
  for (const path of tree.list('outputs')) {
    const match = CV_VERSION_FILE.exec(asString(path));
    if (match && match[1] === target) found.add(Number(match[2]));
  }
  return [...found].sort((a, b) => a - b);
};

// --- Allocating the next version (R33.1, R33.2) ----------------------------

/**
 * The next version number for a set of existing ones: one greater than the
 * largest, or 1 when none exist. Pure — never reuses an existing number, so an
 * edit can only ever produce a brand-new version (R33.2).
 */
export const nextVersionNumber = (existing: Iterable<number>): number => {
  let max = 0;
  for (const n of existing) if (n > max) max = n;
  return max + 1;
};

/**
 * Allocate the next {@link VersionId} for a slug from a set of existing version
 * numbers. Deterministic and pure (R33.1, R33.2).
 */
export const nextVersion = (slug: RoleSlug, existing: Iterable<number>): VersionId => ({
  slug,
  version: nextVersionNumber(existing),
});

/**
 * Allocate the next {@link VersionId} for a slug given the current store. The
 * returned version is strictly greater than every version already stored, so it
 * never collides with — and {@link recordVersion} never overwrites — an existing
 * immutable file (R33.1, R33.2).
 */
export const nextVersionFor = (tree: MemoryTree, slug: RoleSlug): VersionId =>
  nextVersion(slug, storedVersions(tree, slug));

/** Rendered bytes/text of a CV version, by format. `md` is the primary (R32.1). */
export interface CvVersionContents {
  readonly md: string;
  readonly pdf?: Uint8Array;
  readonly docx?: Uint8Array;
}

/** Thrown if recording a version would overwrite an existing immutable file. */
export class CvVersionExistsError extends Error {
  constructor(path: string) {
    super(`Refusing to overwrite immutable CV version file: "${path}"`);
    this.name = 'CvVersionExistsError';
  }
}

/**
 * Record a new immutable CV version for a slug on edit (R33.1, R33.2). Allocates
 * the next version, then writes each supplied format to its canonical path —
 * but first refuses, by throwing {@link CvVersionExistsError}, if any target
 * path is already present, so a stored version can never be mutated in place.
 * Returns the new {@link VersionId}.
 */
export const recordVersion = (
  tree: MemoryTree,
  slug: RoleSlug,
  contents: CvVersionContents,
): VersionId => {
  const id = nextVersionFor(tree, slug);
  // Immutability guard (R33.2): never clobber an existing version file.
  for (const path of versionPaths(id)) {
    if (tree.has(path)) throw new CvVersionExistsError(asString(path));
  }
  tree.write(versionPath(id, 'md'), contents.md);
  if (contents.pdf !== undefined) tree.write(versionPath(id, 'pdf'), contents.pdf);
  if (contents.docx !== undefined) tree.write(versionPath(id, 'docx'), contents.docx);
  return id;
};

// --- Diffing two versions (R33.3) ------------------------------------------

/** A CV accomplishment is referenced by its stable bullet/STAR id (R18.4, R23.2). */
export type AccomplishmentId = BulletId | StarId;

/**
 * Which accomplishments differ between two CV versions, by stable id (R33.3).
 * `reordered` is the minimal set of accomplishments present in both whose
 * relative order changed (everything else common kept its order).
 */
export interface AccomplishmentDiff {
  readonly added: readonly AccomplishmentId[];
  readonly removed: readonly AccomplishmentId[];
  readonly reordered: readonly AccomplishmentId[];
}

/** A skill's emphasis on a CV: whether it is target-relevant, and its rank. */
export interface SkillEmphasis {
  /** True when the target role matches the skill — highlighted first (R30.2). */
  readonly targetRelevant: boolean;
  /** 0-based position in the skills list (its relative emphasis/order). */
  readonly rank: number;
}

/** How a skill's emphasis changed between two CV versions (R33.3). */
export type SkillEmphasisKind = 'added' | 'removed' | 're-emphasised';

/** One skill whose emphasis changed between two CV versions (R33.3). */
export interface SkillEmphasisChange {
  readonly id: SkillId;
  /** The skill's display name (from the newer version when present). */
  readonly name: string;
  readonly kind: SkillEmphasisKind;
  /** Emphasis in version `a`; absent when the skill was added. */
  readonly before?: SkillEmphasis;
  /** Emphasis in version `b`; absent when the skill was removed. */
  readonly after?: SkillEmphasis;
}

/**
 * The summary of how two CV versions differ (R33.3): the accomplishments added,
 * removed, or reordered, and the skills whose emphasis changed. `empty` is true
 * exactly when the two models are equivalent in both respects.
 */
export interface CvDiff {
  readonly accomplishments: AccomplishmentDiff;
  readonly skills: { readonly emphasised: readonly SkillEmphasisChange[] };
  /** True when nothing changed in accomplishments or skill emphasis. */
  readonly empty: boolean;
}

/** Stable ascending comparison of two branded-string ids. */
const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * The minimal set of elements (preserving order of `seqA`) that must move to
 * turn `seqA` into `seqB`, where both are permutations of the same id set: the
 * complement of their longest common subsequence. Used to report the smallest
 * accurate "reordered" set (R33.3).
 */
const movedIds = (seqA: readonly string[], seqB: readonly string[]): Set<string> => {
  const n = seqA.length;
  const m = seqB.length;
  // Standard LCS dynamic-programming table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        seqA[i] === seqB[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  // Recover one LCS; ids in seqA but not in the LCS are the moved ones.
  const kept = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (seqA[i] === seqB[j]) {
      kept.add(seqA[i]!);
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  const moved = new Set<string>();
  for (const id of seqA) if (!kept.has(id)) moved.add(id);
  return moved;
};

/**
 * Diff two CV versions (R33.3). Pure and deterministic: enumerates exactly the
 * accomplishments added, removed, or reordered (by stable bullet/STAR id) and
 * the skills whose emphasis (target-relevance or relative order) changed. Lists
 * are returned in a stable order. A diff of equivalent models is `empty`.
 */
export const diffCv = (a: CvModel, b: CvModel): CvDiff => {
  // --- Accomplishments, keyed by their stable bullet/STAR id ---------------
  const idOf = (x: CvBullet): string => asString(x.id);
  const seqA = a.experience.map(idOf);
  const seqB = b.experience.map(idOf);
  const setA = new Set(seqA);
  const setB = new Set(seqB);

  const idMap = new Map<string, AccomplishmentId>();
  for (const x of a.experience) idMap.set(asString(x.id), x.id);
  for (const x of b.experience) idMap.set(asString(x.id), x.id);

  const added = seqB.filter((id) => !setA.has(id));
  const removed = seqA.filter((id) => !setB.has(id));

  // Reordered: among accomplishments common to both, the minimal moved set.
  const commonA = seqA.filter((id) => setB.has(id));
  const commonB = seqB.filter((id) => setA.has(id));
  const moved = movedIds(commonA, commonB);
  const reordered = [...moved];

  const toAcc = (ids: string[]): AccomplishmentId[] =>
    ids.map((id) => idMap.get(id)!).sort((x, y) => byId({ id: asString(x) }, { id: asString(y) }));

  const accomplishments: AccomplishmentDiff = {
    added: toAcc(added),
    removed: toAcc(removed),
    reordered: toAcc(reordered),
  };

  // --- Skill emphasis -------------------------------------------------------
  const emphasisOf = (skills: readonly CvSkill[]): Map<string, { skill: CvSkill; e: SkillEmphasis }> => {
    const map = new Map<string, { skill: CvSkill; e: SkillEmphasis }>();
    skills.forEach((skill, rank) =>
      map.set(asString(skill.id), { skill, e: { targetRelevant: skill.targetRelevant, rank } }),
    );
    return map;
  };
  const emphA = emphasisOf(a.skills);
  const emphB = emphasisOf(b.skills);

  // The common-skill order, for minimal reorder detection.
  const skillSeqA = a.skills.map((s) => asString(s.id)).filter((id) => emphB.has(id));
  const skillSeqB = b.skills.map((s) => asString(s.id)).filter((id) => emphA.has(id));
  const skillMoved = movedIds(skillSeqA, skillSeqB);

  const changes: SkillEmphasisChange[] = [];
  const allSkillIds = new Set<string>([...emphA.keys(), ...emphB.keys()]);
  for (const idStr of allSkillIds) {
    const inA = emphA.get(idStr);
    const inB = emphB.get(idStr);
    if (inA && !inB) {
      changes.push({ id: inA.skill.id, name: inA.skill.name, kind: 'removed', before: inA.e });
    } else if (!inA && inB) {
      changes.push({ id: inB.skill.id, name: inB.skill.name, kind: 'added', after: inB.e });
    } else if (inA && inB) {
      const relevanceChanged = inA.e.targetRelevant !== inB.e.targetRelevant;
      if (relevanceChanged || skillMoved.has(idStr)) {
        changes.push({
          id: inB.skill.id,
          name: inB.skill.name,
          kind: 're-emphasised',
          before: inA.e,
          after: inB.e,
        });
      }
    }
  }
  changes.sort((x, y) => byId({ id: asString(x.id) }, { id: asString(y.id) }));

  const empty =
    accomplishments.added.length === 0 &&
    accomplishments.removed.length === 0 &&
    accomplishments.reordered.length === 0 &&
    changes.length === 0;

  return { accomplishments, skills: { emphasised: changes }, empty };
};
