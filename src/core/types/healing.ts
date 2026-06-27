// State-healing model (R36) — emitted by the resume-time verification pass.

import type { BulletId, MemoryPath, SkillId, StarId } from './brands';

/** Result of the resume-time reference-integrity pass; never thrown (R36). */
export interface HealingReport {
  /** Skill evidence refs pointing at an id absent from any registry (R36.2). */
  brokenReferences: { entry: SkillId; missing: StarId | BulletId }[];
  /** Ids declared more than once across the store (R36.3). */
  duplicateIds: { id: StarId | BulletId; locations: MemoryPath[] }[];
  /** True when no broken references or duplicates were found. */
  ok: boolean;
}
