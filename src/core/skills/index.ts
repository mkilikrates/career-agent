// @core/skills — the Skill_Mapper (R14–R19, R36).
//
// Task 10.1 implements the trust-critical front of the Skill_Mapper: conservative
// skill normalisation and the never-merge confusables guardrails (R15, R16). The
// never-merge list and synonym knowledge live in an external, extensible
// `config/confusables.yaml` (R16.4); the normaliser merges only provably-same
// skills and keeps everything else separate. Consumers import from one path:
//
//   import { normalise, loadConfusablesFromYaml } from '@core/skills';

// Confusables resource (R16.1–R16.4).
export {
  canonicalTerm,
  loadConfusables,
  loadConfusablesFromYaml,
  parseConfusables,
  DEFAULT_CONFUSABLES_YAML,
} from './confusables';
export type { Confusables, ConfusablesConfig } from './confusables';

// Conservative Merge normalisation (R15).
export {
  normalise,
  toMergeRecord,
  splitMergeRecord,
  SUGGESTION_SIMILARITY,
} from './normalise';
export type {
  MergePlan,
  MergeGroup,
  MergeReason,
  MergeSuggestion,
  NormaliseOptions,
} from './normalise';

// Skill-map generation with bi-directional evidence links (R14, R18.2, R18.3).
export { generate, linkEvidence, skillSlug, categoriseSkill } from './skill-map';
export type { SkillMap, SkillMapOptions } from './skill-map';

// AI skill discovery: opt-in, full-corpus, user-confirmed (R42.1, R47).
export {
  buildDiscoveryCorpus,
  buildRawDiscoveryCorpus,
  buildDiscoveryPrompt,
  parseDiscoveredSkills,
  itemToLine,
  DISCOVERY_PROMPT_INSTRUCTION,
  DEFAULT_DISCOVERY_CHUNK_CHARS,
} from './skill-discovery';
export type { DiscoveryCorpusOptions } from './skill-discovery';

// AI skill discovery wired to the shared opt-in-first AssistableOperation (25.2):
// scriptOnly = deterministic evidence-only map (zero provider calls);
// aiAssisted = same map + gate-routed, user-confirmable skill suggestions.
export {
  SkillDiscoveryOperation,
  createSkillDiscoveryOperation,
} from './skill-assist';
export type {
  SkillDiscoveryInput,
  SkillDiscoverySuggestion,
} from './skill-assist';

// Skill-map review: reversible merge/split, add/remove, self-assessment
// (R15.2, R19.1, R19.2, R19.3, R19.4).
export {
  presentForReview,
  applyMerge,
  splitMerge,
  removeSkill,
  addUserSkill,
  recordSelfAssessment,
  MissingSkillContextError,
  USER_CONFIRMATION_REF,
} from './review';
export type {
  SkillMapReview,
  ReviewableMerge,
  UserSkillInput,
  MergeDecision,
  SelfAssessment,
} from './review';

// Skill-map persistence: serialize / parse / save `profile/skill_map.md`
// (R14.4, R34.1, R34.2).
export {
  serializeSkillMap,
  parseSkillMap,
  loadSkillMap,
  saveSkillMap,
  saveConfirmedSkillMap,
  SKILL_MAP_HEADING,
  SKILL_MAP_PATH,
} from './skill-map-document';
export type { PersistableSkillMap, SkillMapWriter } from './skill-map-document';
