// Role discovery / preference data models (R20, R21).

import type { RoleSlug, SkillId, SkillTerm } from './brands';

/** How the user intends to use a target role (R21.2). */
export type RoleTag = 'actively_applying' | 'exploring' | 'practice_only';

/** A ranked, tagged target role with an estimated skill-match score (R20.2, R21). */
export interface RolePreference {
  slug: RoleSlug; // URL-safe, deterministic
  title: string;
  description: string;
  matchScore: number; // labelled estimate (R20.2)
  matchedSkills: SkillId[];
  gapSkills: SkillTerm[];
  rationale: string;
  rank: number;
  tag: RoleTag; // R21.2
}
