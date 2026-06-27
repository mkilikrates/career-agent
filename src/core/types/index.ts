// @core/types — canonical domain type models for the Career Agent core.
//
// This barrel re-exports every domain type so consumers import from a single
// stable path: `import type { ExtractedItem, StarId } from '@core/types'`.
//
// Invariants encoded at the type level (task 1.2):
//   - provenance is always >= 1 (ProvenanceTrail = NonEmptyArray<Provenance>);
//     an empty provenance list is not representable on facts.
//   - confidence is the closed union 'High' | 'Medium' | 'Low'.
//   - retired flags exist on Accomplishment and TalkingPoint.
//   - StarId / BulletId / SkillId / RoleSlug are nominal brands, not plain
//     strings, so they cannot be accidentally interchanged.

// Branded identifiers and their constructors.
export type {
  Brand,
  StarId,
  BulletId,
  SkillId,
  QuestionId,
  RoleSlug,
  DocId,
  ItemId,
  SkillTerm,
  MemoryPath,
  ISODate,
  DetectionId,
  FileId,
  FileFingerprint,
} from './brands';
export {
  asStarId,
  asBulletId,
  asSkillId,
  asQuestionId,
  asRoleSlug,
  asDocId,
  asItemId,
  asSkillTerm,
  asMemoryPath,
  asISODate,
  asDetectionId,
  asFileId,
  asFileFingerprint,
} from './brands';

// Provenance / confidence.
export type {
  Provenance,
  ProvenanceTrail,
  NonEmptyArray,
  Confidence,
} from './provenance';

// Ingestion.
export type {
  ExtractedItem,
  ExtractedItemType,
  ConflictRecord,
} from './extraction';

// Skills / accomplishments / merges.
export type {
  SkillMapEntry,
  SkillCategory,
  SkillEvidence,
  Accomplishment,
  MergeRecord,
} from './skills';

// Interview coaching.
export type {
  TalkingPoint,
  StarFlag,
  StarElement,
  ResponseStatus,
  StarAnswer,
  Question,
  QuestionCategory,
  ContentAnalysis,
  ContentContribution,
  RevealedSkillEvidence,
  SkillCandidate,
  SkillDelta,
} from './interview';

// Role discovery / preferences.
export type { RolePreference, RoleTag } from './roles';

// State-healing.
export type { HealingReport } from './healing';

// Localisation.
export type { LocaleConfig, OutputLocale } from './locale';
