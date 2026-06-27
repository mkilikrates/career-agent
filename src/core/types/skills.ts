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

/** Category bucket for a skill-map entry (R14.1). */
export type SkillCategory =
  | 'Technical'
  | 'Leadership'
  | 'Communication'
  | 'Domain'
  | 'Tools';

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
  recency: ISODate; // R14.1
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

/** A CV accomplishment bullet with a stable, never-reused id (R18.1). */
export interface Accomplishment {
  id: BulletId; // BULLET-NN, never reused (R18.4)
  text: string;
  /** >= 1 always (R38.1). */
  provenance: ProvenanceTrail;
  skills: SkillId[]; // bi-directional (R18.3)
  retired?: boolean; // marked not deleted (R23.3)
}
