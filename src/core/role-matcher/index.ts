// @core/role-matcher — the Role_Matcher (R17, R20, R21).
//
// Task 11.1 implements the trust-critical front of the Role_Matcher: the skill
// taxonomy and ontological satisfaction (R17, R20.3). The `implements`/`extends`
// relations live in an external, extensible `config/taxonomy.yaml` (R17.1); the
// taxonomy affects scoring ONLY and never rewrites the user's skill phrasing
// (R17.3). Consumers import from one path:
//
//   import { loadTaxonomyFromYaml } from '@core/role-matcher';

// Skill taxonomy and ontological satisfaction (R17.1–R17.3, R20.3).
export {
  loadTaxonomy,
  loadTaxonomyFromYaml,
  parseTaxonomy,
  DEFAULT_TAXONOMY_YAML,
} from './taxonomy';
export type {
  Taxonomy,
  TaxonomyConfig,
  TaxonomyRelation,
  RelationType,
} from './taxonomy';

// Role suggestion and skill-match scoring (R20.1, R20.2, R20.3). Suggests
// employed/freelance/portfolio roles, each with a title+description, an
// estimate-labelled match score, a rationale, and matched-vs-gap skills computed
// via ontological matching (reusing the taxonomy from task 11.1).
export { suggestRoles, scoreMatch, DEFAULT_ROLE_CATALOG } from './role-suggestion';
export type {
  RoleType,
  RoleSpec,
  MatchScore,
  RoleSuggestion,
  SuggestRolesOptions,
} from './role-suggestion';

// Role discovery wired to the shared opt-in-first AssistableOperation (25.2):
// scriptOnly = deterministic scored suggestions (zero provider calls);
// aiAssisted = same suggestions + gate-routed, user-confirmable AI roles.
export {
  RoleDiscoveryOperation,
  createRoleDiscoveryOperation,
  parseAiRoles,
  buildRoleRecommendationPrompt,
} from './role-assist';
export type { RoleDiscoveryInput, AiRoleRecommendation } from './role-assist';

// Employer-free, level-inferring role-discovery AI-assist payload (task 26.1;
// R20.6, R47.2, R47.4): derived from the skill map only, it carries each skill's
// phrasing, an approximate experience duration in months, and a category — never
// an employer or company name — and for a keyed cloud (third-party) destination
// it excludes every skill marked private.
export {
  buildDiscoveryPayload,
  buildDiscoveryPrompt,
  buildRoleReviewPrompt,
  approxDurationMonths,
} from './role-discovery-payload';
export type { RoleDiscoveryPayload } from './role-discovery-payload';

// Role-preference capture (R21.1, R21.2): accept/reject suggested roles, add
// roles the agent did not suggest, then rank and tag the kept roles. A
// RoleSuggestion is promoted to a RolePreference by adding rank + tag.
export {
  capturePreferences,
  isRoleTag,
  ROLE_TAGS,
  DEFAULT_ROLE_TAG,
} from './role-preference';
export type {
  RolePreferenceInput,
  AddedRole,
  CapturePreferencesOptions,
} from './role-preference';

// Role-preference persistence (R21.3): serialize/parse and confirmation-gated
// save of the canonical `profile/role_preferences.md` in the Memory Store.
export {
  serializeRolePreferences,
  parseRolePreferences,
  saveRolePreferences,
  saveConfirmedRolePreferences,
  ROLE_PREFERENCES_HEADING,
  ROLE_PREFERENCES_PATH,
} from './role-preference-document';
export type { RolePreferencesWriter } from './role-preference-document';
