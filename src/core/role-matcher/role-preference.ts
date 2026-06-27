// Role-preference capture for the Role_Matcher (R21.1, R21.2).
//
// After {@link suggestRoles} produces estimate-scored {@link RoleSuggestion}s,
// the user steers the result. This module owns that capture step, mirroring the
// design's `capturePreferences(p: RolePreferenceInput[])`:
//
//   * R21.1 — the user may ACCEPT or REJECT any suggested role, and ADD roles
//     the agent did not suggest. Rejected suggestions are dropped; added roles
//     are folded in alongside the accepted suggestions.
//   * R21.2 — the user RANKS the kept roles in order of preference and TAGS each
//     as `actively_applying` | `exploring` | `practice_only`.
//
// A {@link RoleSuggestion} is field-compatible with a {@link RolePreference}
// minus `rank`/`tag` (see `role-suggestion.ts`), so capture is largely a
// promotion: keep the accepted suggestions, attach the user's `rank` + `tag`,
// and renumber ranks into a contiguous 1..N preference order. Added roles that
// the agent never suggested are scored honestly against the user's verified
// skill map via {@link scoreMatch} when a map is supplied — nothing is
// fabricated; an added role with no scoring context simply carries a 0 estimate
// and an explicit "user-added" rationale.
//
// The function is pure and deterministic: the same suggestions + inputs always
// yield the same ordered {@link RolePreference} list. Persistence to
// `role_preferences.md` lives in `role-preference-document.ts` (R21.3).

import type { RolePreference, RoleTag } from '@core/types';
import { asRoleSlug } from '@core/types';
import type { SkillMap } from '@core/skills';
import type { RoleSuggestion, RoleSpec, RoleType } from './role-suggestion';
import { scoreMatch } from './role-suggestion';
import type { Taxonomy } from './taxonomy';
import { DEFAULT_TAXONOMY_YAML, loadTaxonomyFromYaml } from './taxonomy';

const asString = (v: unknown): string => v as unknown as string;

/** The default tag when the user accepts a role without choosing one (R21.2). */
export const DEFAULT_ROLE_TAG: RoleTag = 'exploring';

/** The three tags a role may carry (R21.2). */
export const ROLE_TAGS: ReadonlyArray<RoleTag> = [
  'actively_applying',
  'exploring',
  'practice_only',
];

/** Type guard for the closed {@link RoleTag} union. */
export const isRoleTag = (value: unknown): value is RoleTag =>
  typeof value === 'string' && (ROLE_TAGS as ReadonlyArray<string>).includes(value);

/**
 * A role the user adds that the agent did not suggest (R21.1). Only a `title` is
 * required; the rest is optional context. When `requiredSkills` is supplied and
 * a skill map is passed to {@link capturePreferences}, the added role is scored
 * honestly against the user's verified skills via {@link scoreMatch}; otherwise
 * it carries a 0 estimate and a "user-added" rationale (never a fabricated fit).
 */
export interface AddedRole {
  readonly title: string;
  readonly description?: string;
  readonly roleType?: RoleType;
  /** Optional explicit slug; derived deterministically from the title if absent. */
  readonly slug?: string;
  /** Core skills, used to score the added role when a skill map is available. */
  readonly requiredSkills?: ReadonlyArray<string>;
  /** Nice-to-have skills that lift the score but never create a gap. */
  readonly preferredSkills?: ReadonlyArray<string>;
}

/**
 * One user decision in the capture step (R21.1, R21.2).
 *
 * Either references an existing {@link RoleSuggestion} by `slug`, or supplies an
 * `added` role the agent did not suggest. `accepted` defaults to `true`; set it
 * to `false` to REJECT a suggested role (R21.1). `rank` and `tag` carry the
 * user's preference ordering and intent (R21.2).
 */
export interface RolePreferenceInput {
  /** Slug of the suggested role this decision refers to (omit for an added role). */
  readonly slug?: string;
  /** A role the agent did not suggest (R21.1); mutually exclusive with `slug`. */
  readonly added?: AddedRole;
  /** Accept (default) or reject the referenced suggestion (R21.1). */
  readonly accepted?: boolean;
  /** The user's preference rank; lower is preferred. Ties break by input order. */
  readonly rank?: number;
  /** How the user intends to use the role (R21.2); defaults to `exploring`. */
  readonly tag?: RoleTag;
}

/** Options for {@link capturePreferences}. */
export interface CapturePreferencesOptions {
  /**
   * The user's verified skill map, used to score ADDED roles that declare
   * `requiredSkills` (R20.2, R20.3). When omitted, added roles carry a 0
   * estimate rather than a fabricated score.
   */
  readonly map?: SkillMap;
  /** Taxonomy for ontological scoring of added roles (defaults to the seed). */
  readonly taxonomy?: Taxonomy;
}

/** Deterministic, URL-safe slug from a title (mirrors role-suggestion slugify). */
const slugifyTitle = (title: string, explicit?: string): string => {
  const base = (explicit ?? title)
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/#/g, 'sharp')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.length > 0 ? base : 'role';
};

/** Promote a kept {@link RoleSuggestion} to a {@link RolePreference} base (no rank). */
const fromSuggestion = (
  suggestion: RoleSuggestion,
): Omit<RolePreference, 'rank'> & { readonly tag: RoleTag } => ({
  slug: suggestion.slug,
  title: suggestion.title,
  description: suggestion.description,
  matchScore: suggestion.matchScore,
  matchedSkills: suggestion.matchedSkills,
  gapSkills: suggestion.gapSkills,
  rationale: suggestion.rationale,
  tag: DEFAULT_ROLE_TAG,
});

/** Build a {@link RolePreference} base from a user-added role (R21.1). */
const fromAddedRole = (
  added: AddedRole,
  options: CapturePreferencesOptions,
): Omit<RolePreference, 'rank'> & { readonly tag: RoleTag } => {
  const slug = asRoleSlug(slugifyTitle(added.title, added.slug));
  const description = added.description ?? '';

  // Score the added role against the user's verified skills when possible, so
  // matched/gap skills are honest (R20.2, R20.3); never invent a fit.
  if (options.map !== undefined && (added.requiredSkills?.length ?? 0) > 0) {
    const taxonomy =
      options.taxonomy ?? loadTaxonomyFromYaml(DEFAULT_TAXONOMY_YAML);
    const spec: RoleSpec = {
      slug: added.slug,
      title: added.title,
      description,
      roleType: added.roleType ?? 'employed',
      requiredSkills: added.requiredSkills ?? [],
      preferredSkills: added.preferredSkills,
    };
    const score = scoreMatch(spec, options.map, taxonomy);
    return {
      slug,
      title: added.title,
      description,
      matchScore: score.score,
      matchedSkills: score.matchedSkills,
      gapSkills: score.gapSkills,
      rationale: `User-added role (R21.1). ${score.rationale}`,
      tag: DEFAULT_ROLE_TAG,
    };
  }

  return {
    slug,
    title: added.title,
    description,
    matchScore: 0,
    matchedSkills: [],
    gapSkills: [],
    rationale:
      'User-added role (R21.1). No skill-match estimate computed — add core skills or a skill map to score this role.',
    tag: DEFAULT_ROLE_TAG,
  };
};

/**
 * Capture the user's role preferences from the suggestions (R21.1, R21.2).
 *
 * For each {@link RolePreferenceInput}:
 *   - an `added` role is folded in as a new preference (R21.1), scored against
 *     the skill map when one is supplied;
 *   - otherwise the input references a suggestion by `slug`: an ACCEPTED
 *     suggestion is kept, a REJECTED one (`accepted: false`) is dropped (R21.1);
 *   - the kept role carries the user's `tag` (default `exploring`) (R21.2).
 *
 * Kept roles are ordered by the user's `rank` (lower preferred), ties broken by
 * input order, then renumbered into a contiguous `1..N` preference ranking
 * (R21.2). Inputs that reference an unknown slug, or duplicate an already-kept
 * slug, are ignored so the result is a clean, de-duplicated preference list.
 *
 * Pure and deterministic. Returns the ranked, tagged {@link RolePreference}
 * list; persistence is handled by `saveRolePreferences` (R21.3).
 */
export const capturePreferences = (
  suggestions: ReadonlyArray<RoleSuggestion>,
  inputs: ReadonlyArray<RolePreferenceInput>,
  options: CapturePreferencesOptions = {},
): RolePreference[] => {
  const suggestionBySlug = new Map<string, RoleSuggestion>();
  for (const suggestion of suggestions) {
    suggestionBySlug.set(asString(suggestion.slug), suggestion);
  }

  interface Kept {
    readonly base: Omit<RolePreference, 'rank'> & { readonly tag: RoleTag };
    readonly sortRank: number;
    readonly order: number;
  }

  const kept: Kept[] = [];
  const seenSlugs = new Set<string>();
  let order = 0;

  for (const input of inputs) {
    const index = order++;

    let base: (Omit<RolePreference, 'rank'> & { readonly tag: RoleTag }) | undefined;

    if (input.added !== undefined) {
      base = fromAddedRole(input.added, options);
    } else if (input.slug !== undefined) {
      // A reject decision drops the suggestion entirely (R21.1).
      if (input.accepted === false) continue;
      const suggestion = suggestionBySlug.get(input.slug);
      if (suggestion === undefined) continue; // unknown slug — ignore defensively
      base = fromSuggestion(suggestion);
    } else {
      continue; // neither a slug nor an added role — nothing to capture
    }

    const slugKey = asString(base.slug);
    if (seenSlugs.has(slugKey)) continue; // de-duplicate kept roles
    seenSlugs.add(slugKey);

    const tag = input.tag !== undefined && isRoleTag(input.tag) ? input.tag : DEFAULT_ROLE_TAG;
    const sortRank =
      typeof input.rank === 'number' && Number.isFinite(input.rank)
        ? input.rank
        : Number.POSITIVE_INFINITY;

    kept.push({ base: { ...base, tag }, sortRank, order: index });
  }

  // Order by the user's preference rank (lower first), ties by input order
  // (R21.2), then renumber into a contiguous 1..N ranking.
  kept.sort((a, b) => (a.sortRank !== b.sortRank ? a.sortRank - b.sortRank : a.order - b.order));

  return kept.map((k, i) => ({ ...k.base, rank: i + 1 }));
};
