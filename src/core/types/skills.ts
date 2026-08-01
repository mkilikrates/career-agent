// Skill-map, accomplishment, and merge data models (R14, R15, R18, R19, R36).

import type { BulletId, DocId, ISODate, SkillId, SkillTerm, StarId } from './brands';
import type { ProvenanceTrail } from './provenance';

/** A reversible record of merging skill terms into a single skill (R15.2). */
export interface MergeRecord {
  from: SkillTerm[];
  into: SkillTerm;
  rationale: string;
  at: ISODate;
  /** Merges are always reversible via a one-step split (R19.3). */
  reversible: true;
}

/** Category bucket for a skill-map entry (R14.1, R73.4). */
export type SkillCategory =
  | 'Technical'
  | 'Leadership'
  | 'Communication'
  | 'Domain'
  | 'Tools'
  | 'Core_Competency';

/** All valid skill categories as a runtime-iterable array (R75.3). */
export const SKILL_CATEGORIES: readonly SkillCategory[] = [
  'Technical',
  'Leadership',
  'Communication',
  'Domain',
  'Tools',
  'Core_Competency',
] as const;

/** A dated, sourced piece of evidence backing a skill (R14.1, R18.2). */
export interface SkillEvidence {
  ref: DocId | StarId | BulletId;
  when: ISODate;
  note: string;
}

/** A skill-map entry with evidence-based proficiency and bi-directional links. */
export interface SkillMapEntry {
  id: SkillId;
  name: string; // user's original phrasing preserved (R17.3)
  category: SkillCategory;
  proficiencySignal: string; // evidence-based, not self-score (R14.3)
  selfAssessment?: string; // separate from evidence signal (R19.4)
  evidence: SkillEvidence[]; // R14.1, R18.2
  since?: ISODate; // R70.1 — earliest date the skill was used
  lastEvidence?: ISODate; // R70.8 — latest evidence[].when date (bounds duration)
  mergeRecord?: MergeRecord; // reversible (R15.2, R19.3)
  brokenReference?: boolean; // R36.2
  /**
   * Marks the skill as private. A private skill is excluded from any payload
   * bound for a keyed cloud (third-party) provider (R46.4, R47.4) — e.g. the
   * employer-free role-discovery payload — but may be included for a keyless
   * Local Provider running on the user's own device (R46.5). Absent/`false`
   * means the skill is not private.
   */
  private?: boolean;
}

/**
 * Compute approximate years of experience from a `since` date (R70.4).
 * Returns `undefined` when `since` is absent or unparseable.
 *
 * @deprecated Use {@link experienceDuration} instead, which bounds duration
 * by the latest evidence date rather than using the current date (R70.8).
 */
export const experienceYears = (since?: ISODate): number | undefined => {
  if (since === undefined) return undefined;
  const ms = Date.parse(since as unknown as string);
  if (Number.isNaN(ms)) return undefined;
  const years = Math.round((Date.now() - ms) / (365.25 * 24 * 60 * 60 * 1000));
  return Math.max(0, years);
};

/**
 * Compute approximate years of experience bounded by actual evidence (R70.1, R70.8).
 * Duration = lastEvidence − since (not now − since), preventing legacy technologies
 * from showing misleading years (e.g. COBOL showing "~31 years" when last used in 1995).
 *
 * When `lastEvidence` is absent, falls back to the current date (skill is still active).
 * Returns `undefined` when `since` is absent or unparseable.
 */
export const experienceDuration = (since?: ISODate, lastEvidence?: ISODate): number | undefined => {
  if (since === undefined) return undefined;
  const startMs = Date.parse(since as unknown as string);
  if (Number.isNaN(startMs)) return undefined;
  let endMs: number;
  if (lastEvidence !== undefined) {
    endMs = Date.parse(lastEvidence as unknown as string);
    if (Number.isNaN(endMs)) endMs = Date.now();
  } else {
    endMs = Date.now();
  }
  const years = Math.round((endMs - startMs) / (365.25 * 24 * 60 * 60 * 1000));
  return Math.max(0, years);
};

/** A CV accomplishment bullet with a stable, never-reused id (R18.1). */
export interface Accomplishment {
  id: BulletId; // BULLET-NN, never reused (R18.4)
  text: string;
  /** >= 1 always (R38.1). */
  provenance: ProvenanceTrail;
  skills: SkillId[]; // bi-directional (R18.3)
  retired?: boolean; // marked not deleted (R23.3)
}
