// Role suggestion and skill-match scoring for the Role_Matcher
// (R20.1, R20.2, R20.3).
//
// This module turns a confirmed {@link SkillMap} into a set of suggested target
// roles. Two trust-critical rules from the design govern the implementation:
//
//   * R20.1 — suggested role TYPES must cover employed positions, freelance /
//     consulting opportunities, and portfolio / project-based roles. Every call
//     to {@link suggestRoles} returns suggestions spanning all three types.
//   * R20.2 — for EACH suggested role we produce a title and description, a
//     skill-match score that is explicitly LABELLED AS AN ESTIMATE, a rationale
//     narrative, and the matched skills versus gap skills.
//   * R20.3 — the skill-match score is computed with Ontological Matching as
//     defined in R17: a child skill the user owns satisfies a required parent
//     skill. This module REUSES {@link Taxonomy.satisfies}/`isDescendantOf` from
//     task 11.1 rather than re-implementing ontological matching, and the
//     taxonomy affects SCORING ONLY — it never rewrites the user's phrasing
//     (R17.3).
//
// The scorer is pure and deterministic: the same map + role + taxonomy always
// yields the same {@link MatchScore}. Suggestions are derived from a role
// catalog (a shipped default seed, or a caller-supplied list) so that "matched
// vs gap" is computed honestly against the user's real, verified skills — no
// role requirement, score, or skill is fabricated.

import type {
  LocaleConfig,
  RolePreference,
  SkillId,
  SkillTerm,
} from '@core/types';
import { asRoleSlug, asSkillTerm } from '@core/types';
import { canonicalTerm } from '@core/skills';
import type { SkillMap } from '@core/skills';
import type { Taxonomy } from './taxonomy';
import { DEFAULT_TAXONOMY_YAML, loadTaxonomyFromYaml } from './taxonomy';

/**
 * The kind of engagement a suggested role represents (R20.1). Phase 1 covers
 * exactly the three documented categories.
 */
export type RoleType = 'employed' | 'freelance' | 'portfolio';

/**
 * A target-role specification scored against a skill map. `requiredSkills` are
 * the core skills the role expects; `preferredSkills` are nice-to-haves that
 * lift the score but never create a gap. Skill terms are matched ontologically
 * (R20.3), so a required `SQL Database` is satisfied by an owned `PostgreSQL`.
 */
export interface RoleSpec {
  /** Optional explicit slug; derived deterministically from the title if absent. */
  readonly slug?: string;
  readonly title: string;
  readonly description: string;
  readonly roleType: RoleType;
  /** Core skills expected for the role (unmet ones become gaps, R20.2). */
  readonly requiredSkills: ReadonlyArray<string>;
  /** Nice-to-have skills that raise the score but never create a gap. */
  readonly preferredSkills?: ReadonlyArray<string>;
}

/**
 * The result of scoring a {@link RoleSpec} against a {@link SkillMap} (R20.2).
 *
 * The score is an ESTIMATE, never a guarantee: `estimated` is the literal `true`
 * and `scoreLabel` carries the user-facing "Estimated …" phrasing so the UI can
 * never present the number as a precise fit (R20.2).
 */
export interface MatchScore {
  /** 0–100 skill-match score — an estimate (R20.2). */
  readonly score: number;
  /** Always `true`: the score is explicitly labelled an estimate (R20.2). */
  readonly estimated: true;
  /** User-facing estimate label, e.g. `"Estimated 72% match"` (R20.2). */
  readonly scoreLabel: string;
  /** Ids of the user's own skills that satisfied a required/preferred skill. */
  readonly matchedSkills: SkillId[];
  /** Required skills no owned skill satisfied, in the user's phrasing (R20.2). */
  readonly gapSkills: SkillTerm[];
  /** Narrative explaining the estimate, matches, and gaps (R20.2). */
  readonly rationale: string;
}

/**
 * A suggested target role: a {@link RoleSpec} resolved against the skill map.
 *
 * The shape is field-compatible with {@link RolePreference} minus the
 * user-supplied `rank`/`tag` (assigned later in role-preference capture, task
 * 11.4), plus the `roleType` and the explicit estimate label. A suggestion can
 * therefore be promoted to a `RolePreference` by adding `rank` + `tag`.
 */
export interface RoleSuggestion
  extends Omit<RolePreference, 'rank' | 'tag'> {
  /** Which of the three documented role categories this is (R20.1). */
  readonly roleType: RoleType;
  /** Always `true`: `matchScore` is an estimate (R20.2). */
  readonly estimated: true;
  /** User-facing estimate label mirroring {@link MatchScore.scoreLabel}. */
  readonly scoreLabel: string;
}

/** Options for {@link suggestRoles}. */
export interface SuggestRolesOptions {
  /** Role catalog to score (defaults to {@link DEFAULT_ROLE_CATALOG}). */
  readonly catalog?: ReadonlyArray<RoleSpec>;
  /** Taxonomy for ontological matching (defaults to the shipped seed taxonomy). */
  readonly taxonomy?: Taxonomy;
  /**
   * Maximum suggestions returned per role type (default 3). At least one
   * suggestion per available role type is always returned so the three
   * documented categories are covered (R20.1).
   */
  readonly perType?: number;
}

// --- Slug derivation -------------------------------------------------------

/** Deterministic, URL-safe slug from a role's explicit slug or its title. */
const slugify = (spec: RoleSpec): string => {
  const base = (spec.slug ?? spec.title)
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/#/g, 'sharp')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.length > 0 ? base : 'role';
};

// --- Locale-aware title (R41.6 forward-compatibility) ----------------------

/**
 * Resolve the role title for the session locale. Phase 1 keeps role titles —
 * technical terms and job titles — VERBATIM and untranslated (R41.6); the
 * `locale` is accepted so later phases can localise surrounding copy without a
 * signature change, but it never alters the title here.
 */
const localiseTitle = (title: string, _locale: LocaleConfig | undefined): string =>
  title;

// --- Scoring ---------------------------------------------------------------

// A required skill weighs twice a preferred one when computing the estimate.
const REQUIRED_WEIGHT = 2;
const PREFERRED_WEIGHT = 1;

/** Owned skills (by id) that satisfy `required` directly or ontologically (R20.3). */
const matchingEntryIds = (
  required: string,
  map: SkillMap,
  taxonomy: Taxonomy,
): SkillId[] => {
  const canonRequired = canonicalTerm(required);
  if (canonRequired.length === 0) return [];
  const ids: SkillId[] = [];
  for (const entry of map.entries) {
    const direct = canonicalTerm(entry.name) === canonRequired;
    // Ontological: an owned child skill satisfies the required parent (R20.3).
    const ontological = !direct && taxonomy.isDescendantOf(entry.name, required);
    if (direct || ontological) ids.push(entry.id);
  }
  return ids;
};

const asString = (v: unknown): string => v as unknown as string;

const sortedUniqueIds = (ids: Iterable<SkillId>): SkillId[] =>
  [...new Set(ids)].sort((a, b) =>
    asString(a) < asString(b) ? -1 : asString(a) > asString(b) ? 1 : 0,
  );

/** Join skill names for the rationale, capping the list for readability. */
const listNames = (names: string[], max = 3): string => {
  if (names.length === 0) return '';
  if (names.length <= max) return names.join(', ');
  const shown = names.slice(0, max).join(', ');
  return `${shown}, and ${names.length - max} more`;
};

/**
 * Score a {@link RoleSpec} against a {@link SkillMap} using ontological matching
 * (R20.2, R20.3). Pure and deterministic. The returned score is an estimate and
 * is labelled as such; matched skills are the user's own skill ids and gap
 * skills are the unmet required skills in their source phrasing.
 */
export const scoreMatch = (
  role: RoleSpec,
  map: SkillMap,
  taxonomy: Taxonomy = loadTaxonomyFromYaml(DEFAULT_TAXONOMY_YAML),
): MatchScore => {
  const required = role.requiredSkills ?? [];
  const preferred = role.preferredSkills ?? [];

  const nameById = new Map<string, string>(
    map.entries.map((e) => [asString(e.id), e.name]),
  );

  const matchedIds = new Set<SkillId>();
  const gapSkills: SkillTerm[] = [];
  let satisfiedRequired = 0;

  for (const skill of required) {
    const ids = matchingEntryIds(skill, map, taxonomy);
    if (ids.length > 0) {
      satisfiedRequired += 1;
      for (const id of ids) matchedIds.add(id);
    } else if (canonicalTerm(skill).length > 0) {
      gapSkills.push(asSkillTerm(skill));
    }
  }

  let satisfiedPreferred = 0;
  for (const skill of preferred) {
    const ids = matchingEntryIds(skill, map, taxonomy);
    if (ids.length > 0) {
      satisfiedPreferred += 1;
      for (const id of ids) matchedIds.add(id);
    }
    // Unmet preferred skills are NOT gaps (R20.2 gaps are required skills only).
  }

  const totalWeight =
    required.length * REQUIRED_WEIGHT + preferred.length * PREFERRED_WEIGHT;
  const gotWeight =
    satisfiedRequired * REQUIRED_WEIGHT + satisfiedPreferred * PREFERRED_WEIGHT;
  const score = totalWeight === 0 ? 0 : Math.round((100 * gotWeight) / totalWeight);

  const matchedSkills = sortedUniqueIds(matchedIds);
  const matchedNames = matchedSkills
    .map((id) => nameById.get(asString(id)))
    .filter((n): n is string => n !== undefined);
  const gapNames = gapSkills.map((g) => asString(g));

  const scoreLabel = `Estimated ${score}% match`;

  // Narrative rationale — always frames the number as an estimate (R20.2).
  const parts: string[] = [];
  parts.push(
    `${scoreLabel} (an estimate based on your current evidence, not a guarantee).`,
  );
  if (required.length > 0) {
    parts.push(
      `You match ${satisfiedRequired} of ${required.length} core skills for this ${role.roleType} role` +
        (matchedNames.length > 0 ? ` (${listNames(matchedNames)})` : '') +
        '.',
    );
  } else {
    parts.push(`This ${role.roleType} role lists no fixed core skills.`);
  }
  if (gapNames.length > 0) {
    parts.push(`Gaps to develop: ${listNames(gapNames)}.`);
  } else if (required.length > 0) {
    parts.push('No core-skill gaps identified.');
  }
  parts.push(
    'Related skills count toward the estimate via the skill taxonomy (for example PostgreSQL satisfies a SQL Database requirement).',
  );

  return {
    score,
    estimated: true,
    scoreLabel,
    matchedSkills,
    gapSkills,
    rationale: parts.join(' '),
  };
};

// --- Suggestion ------------------------------------------------------------

/** Resolve a single {@link RoleSpec} into a scored {@link RoleSuggestion}. */
const toSuggestion = (
  spec: RoleSpec,
  map: SkillMap,
  taxonomy: Taxonomy,
  locale: LocaleConfig | undefined,
): RoleSuggestion => {
  const score = scoreMatch(spec, map, taxonomy);
  return {
    slug: asRoleSlug(slugify(spec)),
    title: localiseTitle(spec.title, locale),
    description: spec.description,
    roleType: spec.roleType,
    matchScore: score.score,
    estimated: true,
    scoreLabel: score.scoreLabel,
    matchedSkills: score.matchedSkills,
    gapSkills: score.gapSkills,
    rationale: score.rationale,
  };
};

/** Descending by score, then ascending by slug for a stable deterministic order. */
const byScoreThenSlug = (a: RoleSuggestion, b: RoleSuggestion): number => {
  if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
  const sa = asString(a.slug);
  const sb = asString(b.slug);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

const ROLE_TYPES: ReadonlyArray<RoleType> = ['employed', 'freelance', 'portfolio'];

/**
 * Suggest target roles for a skill map, covering employed / freelance /
 * portfolio role types (R20.1). Each suggestion carries a title, description, an
 * estimated skill-match score, a rationale, and matched-vs-gap skills computed
 * with ontological matching (R20.2, R20.3).
 *
 * Suggestions are drawn from a role catalog (the shipped default, or
 * `options.catalog`) and scored against the user's verified skills, so matched
 * and gap skills are honest — nothing is fabricated. The result always spans
 * every role type present in the catalog: the top `perType` per type are kept,
 * with at least one per type, and the combined list is ordered by estimated
 * score (highest first).
 */
export const suggestRoles = (
  map: SkillMap,
  locale?: LocaleConfig,
  options: SuggestRolesOptions = {},
): RoleSuggestion[] => {
  const catalog = options.catalog ?? DEFAULT_ROLE_CATALOG;
  const taxonomy =
    options.taxonomy ?? loadTaxonomyFromYaml(DEFAULT_TAXONOMY_YAML);
  const perType = Math.max(1, options.perType ?? 3);

  const suggestions = catalog.map((spec) =>
    toSuggestion(spec, map, taxonomy, locale),
  );

  // Keep the top `perType` per role type so all three categories are covered
  // (R20.1) without flooding the list with low-relevance roles.
  const kept: RoleSuggestion[] = [];
  for (const type of ROLE_TYPES) {
    const ofType = suggestions
      .filter((s) => s.roleType === type)
      .sort(byScoreThenSlug);
    kept.push(...ofType.slice(0, perType));
  }

  return kept.sort(byScoreThenSlug);
};

// --- Default role catalog --------------------------------------------------

/**
 * The default seed role catalog spanning the three documented role types
 * (R20.1). It is intentionally broad and grounded in common, widely-recognised
 * skills (including the seed taxonomy's families) so that "matched vs gap" is
 * meaningful for a typical software/technical profile. Callers may supply their
 * own catalog via {@link SuggestRolesOptions.catalog}; nothing here is presented
 * to the user as fact — scores and gaps are computed against the user's own
 * verified skills.
 */
export const DEFAULT_ROLE_CATALOG: ReadonlyArray<RoleSpec> = [
  // Employed positions (R20.1).
  {
    title: 'Backend Engineer',
    description:
      'Build and operate server-side services, APIs, and data stores in an employed role.',
    roleType: 'employed',
    requiredSkills: ['JavaScript', 'SQL Database', 'REST API'],
    preferredSkills: ['TypeScript', 'Docker', 'Kubernetes'],
  },
  {
    title: 'Frontend Engineer',
    description:
      'Develop accessible, performant user interfaces for the web in an employed role.',
    roleType: 'employed',
    requiredSkills: ['JavaScript', 'HTML', 'CSS'],
    preferredSkills: ['React', 'TypeScript'],
  },
  {
    title: 'Engineering Manager',
    description:
      'Lead and grow an engineering team, owning delivery and people development.',
    roleType: 'employed',
    requiredSkills: ['Leadership', 'Communication', 'Project Management'],
    preferredSkills: ['Mentoring', 'Roadmapping'],
  },
  // Freelance / consulting opportunities (R20.1).
  {
    title: 'Freelance Full-Stack Developer',
    description:
      'Deliver end-to-end web features for clients on a freelance basis.',
    roleType: 'freelance',
    requiredSkills: ['JavaScript', 'SQL Database'],
    preferredSkills: ['React', 'Node.js', 'TypeScript'],
  },
  {
    title: 'Independent Technical Consultant',
    description:
      'Advise clients on architecture and delivery as an independent consultant.',
    roleType: 'freelance',
    requiredSkills: ['Communication', 'System Design'],
    preferredSkills: ['Cloud', 'Architecture'],
  },
  // Portfolio / project-based roles (R20.1).
  {
    title: 'Open-Source Contributor',
    description:
      'Contribute to open-source projects to build a public, verifiable portfolio.',
    roleType: 'portfolio',
    requiredSkills: ['Git'],
    preferredSkills: ['JavaScript', 'TypeScript', 'Documentation'],
  },
  {
    title: 'Portfolio Project Builder',
    description:
      'Ship self-directed projects that demonstrate your skills to prospective employers.',
    roleType: 'portfolio',
    requiredSkills: ['JavaScript'],
    preferredSkills: ['React', 'SQL Database'],
  },
];
