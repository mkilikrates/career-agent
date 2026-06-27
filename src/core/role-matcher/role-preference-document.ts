// Role-preference persistence — serialize / parse / save `profile/role_preferences.md` (R21.3, R34.1, R34.2).
//
// When the user confirms their ranked, tagged target roles, the Role_Matcher
// SHALL store them in the Memory Store (R21.3). This module owns that
// persistence, mirroring the skill-map document (`@core/skills`):
//
// The Memory Store is a Markdown-as-database (R34.1): every entity is plain,
// human-readable Markdown carrying its stable identifier as an HTML anchor
// comment mirrored into the frontmatter `ids:` list (see `@core/markdown`).
// Following that pattern, each {@link RolePreference} is rendered as one
// Markdown section — heading (role title), an `<!-- id: {slug} -->` anchor, and
// the preference's fields (rank, tag, estimate-labelled match score, matched vs
// gap skills, rationale) — and the role slugs are mirrored into the document
// frontmatter via {@link serializeMarkdown}.
//
// Two guarantees, mirroring the rest of the store:
//   1. Lossless round trip (R34.2): {@link parseRolePreferences} ∘
//      {@link serializeRolePreferences} recovers the preferences, and the
//      serialized string is a fixpoint of parse → serialize. Free-text fields
//      are normalised to a single line on render (the line-based store's
//      contract).
//   2. Confirmation-gated persistence (R21.3): {@link saveRolePreferences}
//      writes the canonical `profile/role_preferences.md` path through any
//      Storage_Adapter / MemoryTree writer, and
//      {@link saveConfirmedRolePreferences} only writes once the user has
//      confirmed the preferences.

import type {
  MemoryPath,
  RolePreference,
  RoleTag,
  SkillId,
  SkillTerm,
} from '@core/types';
import { asRoleSlug, asSkillId, asSkillTerm } from '@core/types';
import { anchorComment, parseMarkdown, serializeMarkdown } from '@core/markdown';
import { CANONICAL_FILES } from '@core/storage';
import { DEFAULT_ROLE_TAG, isRoleTag } from './role-preference';

const asString = (v: unknown): string => v as unknown as string;

/** Collapse a value to a single line so it cannot corrupt the line-based document. */
const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/** Title heading written at the top of the role-preferences document. */
export const ROLE_PREFERENCES_HEADING = '# Role Preferences';

/** Rendered for an empty matched/gap skill list so the round trip is faithful. */
const NONE = '_None._';

// --- Serialize --------------------------------------------------------------

/** Render a backticked, comma-separated list of identifiers, or `_None._`. */
const renderList = (values: ReadonlyArray<SkillId | SkillTerm>): string => {
  if (values.length === 0) return NONE;
  return values.map((v) => `\`${asString(v)}\``).join(', ');
};

/** Render a single role preference as a Markdown section (R34.1). */
const renderPreference = (pref: RolePreference): string[] => [
  `## ${oneLine(pref.title)}`,
  '',
  anchorComment(asString(pref.slug)),
  '',
  `- **Rank:** ${pref.rank}`,
  `- **Tag:** ${pref.tag}`,
  // The score is always an ESTIMATE, never a guarantee (R20.2).
  `- **Match score (estimate):** ${pref.matchScore}%`,
  `- **Matched skills:** ${renderList(pref.matchedSkills)}`,
  `- **Gap skills:** ${renderList(pref.gapSkills)}`,
  `- **Description:** ${oneLine(pref.description)}`,
  `- **Rationale:** ${oneLine(pref.rationale)}`,
];

/**
 * Serialize role preferences to the canonical `role_preferences.md` Markdown
 * (R21.3, R34.1). Each preference becomes a human-readable section carrying its
 * stable role slug as an anchor comment; the slugs are mirrored into the
 * document frontmatter (R34.2). Preferences are emitted in ascending rank order
 * so the file reads as the user's preference list. Deterministic: the output
 * depends only on the preferences.
 */
export const serializeRolePreferences = (
  preferences: ReadonlyArray<RolePreference>,
): string => {
  const ordered = [...preferences].sort((a, b) =>
    a.rank !== b.rank
      ? a.rank - b.rank
      : asString(a.slug) < asString(b.slug)
        ? -1
        : asString(a.slug) > asString(b.slug)
          ? 1
          : 0,
  );

  const body: string[] = [ROLE_PREFERENCES_HEADING, ''];
  for (const pref of ordered) {
    body.push(...renderPreference(pref), '');
  }
  const ids = ordered.map((p) => asString(p.slug));
  return serializeMarkdown({ frontmatter: {}, ids, body: `${body.join('\n')}\n` });
};

// --- Parse ------------------------------------------------------------------

const HEADING = /^## (.*)$/;
const ANCHOR = /^<!--\s*id:\s*(\S+)\s*-->$/;
const RANK = /^- \*\*Rank:\*\* (.*)$/;
const TAG = /^- \*\*Tag:\*\* (.*)$/;
const SCORE = /^- \*\*Match score \(estimate\):\*\* (.*)$/;
const MATCHED = /^- \*\*Matched skills:\*\* (.*)$/;
const GAPS = /^- \*\*Gap skills:\*\* (.*)$/;
const DESCRIPTION = /^- \*\*Description:\*\* (.*)$/;
const RATIONALE = /^- \*\*Rationale:\*\* (.*)$/;
const BACKTICKED = /`([^`]*)`/g;

/** Mutable accumulator for a preference being parsed. */
interface PartialPreference {
  slug?: string;
  title: string;
  description: string;
  matchScore: number;
  matchedSkills: SkillId[];
  gapSkills: SkillTerm[];
  rationale: string;
  rank: number;
  tag: RoleTag;
}

const newPartial = (title: string): PartialPreference => ({
  title,
  description: '',
  matchScore: 0,
  matchedSkills: [],
  gapSkills: [],
  rationale: '',
  rank: 0,
  tag: DEFAULT_ROLE_TAG,
});

/** Parse the integer percentage out of a rendered match-score value. */
const parseScore = (raw: string): number => {
  const match = /-?\d+/.exec(raw);
  return match ? Number.parseInt(match[0], 10) : 0;
};

/** Parse a backticked list, treating the `_None._` sentinel as empty. */
const parseBackticked = (raw: string): string[] => {
  if (raw.trim() === NONE) return [];
  return [...raw.matchAll(BACKTICKED)].map((m) => m[1]);
};

/** Finalise a partial into a {@link RolePreference} (slug defaulted defensively). */
const finalise = (p: PartialPreference): RolePreference => ({
  slug: asRoleSlug(p.slug ?? slugFromTitle(p.title)),
  title: p.title,
  description: p.description,
  matchScore: p.matchScore,
  matchedSkills: p.matchedSkills,
  gapSkills: p.gapSkills,
  rationale: p.rationale,
  rank: p.rank,
  tag: p.tag,
});

/** Minimal fallback slug when an anchor is missing (kept inverse-faithful). */
const slugFromTitle = (title: string): string =>
  title
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/#/g, 'sharp')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'role';

/**
 * Parse a `role_preferences.md` document back into its preferences (R34.2). The
 * exact inverse of {@link serializeRolePreferences} for the single-line-field
 * contract the store carries; lines that match no rule are ignored, so the
 * printable heading and section spacing never confuse the parse. Preferences
 * are returned in ascending rank order.
 */
export const parseRolePreferences = (markdown: string): RolePreference[] => {
  const { body } = parseMarkdown(markdown);
  const preferences: RolePreference[] = [];
  let current: PartialPreference | undefined;

  const flush = (): void => {
    if (current) preferences.push(finalise(current));
  };

  for (const raw of body.split('\n')) {
    const line = raw.trim();

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      current = newPartial(heading[1]);
      continue;
    }
    if (!current) continue;

    const anchor = ANCHOR.exec(line);
    if (anchor) {
      current.slug = anchor[1];
      continue;
    }
    const rank = RANK.exec(line);
    if (rank) {
      const n = Number.parseInt(rank[1], 10);
      current.rank = Number.isFinite(n) ? n : 0;
      continue;
    }
    const tag = TAG.exec(line);
    if (tag) {
      current.tag = isRoleTag(tag[1].trim()) ? (tag[1].trim() as RoleTag) : DEFAULT_ROLE_TAG;
      continue;
    }
    const score = SCORE.exec(line);
    if (score) {
      current.matchScore = parseScore(score[1]);
      continue;
    }
    const matched = MATCHED.exec(line);
    if (matched) {
      current.matchedSkills = parseBackticked(matched[1]).map((s) => asSkillId(s));
      continue;
    }
    const gaps = GAPS.exec(line);
    if (gaps) {
      current.gapSkills = parseBackticked(gaps[1]).map((s) => asSkillTerm(s));
      continue;
    }
    const description = DESCRIPTION.exec(line);
    if (description) {
      current.description = description[1];
      continue;
    }
    const rationale = RATIONALE.exec(line);
    if (rationale) {
      current.rationale = rationale[1];
      continue;
    }
  }
  flush();

  return preferences.sort((a, b) =>
    a.rank !== b.rank
      ? a.rank - b.rank
      : asString(a.slug) < asString(b.slug)
        ? -1
        : asString(a.slug) > asString(b.slug)
          ? 1
          : 0,
  );
};

// --- Persist (R21.3) --------------------------------------------------------

/** Canonical Memory Store location for role preferences (R34.1). */
export const ROLE_PREFERENCES_PATH: MemoryPath = CANONICAL_FILES.rolePreferences;

/** Minimal writer satisfied by both the Storage_Adapter and the MemoryTree. */
export interface RolePreferencesWriter {
  write(path: MemoryPath, data: string): unknown;
}

/**
 * Persist role preferences to `profile/role_preferences.md` via the supplied
 * writer (Storage_Adapter or MemoryTree). Serialization is shared with
 * {@link serializeRolePreferences}, so the written file round-trips losslessly
 * (R34.2). Awaits the write so a Promise-returning adapter completes before the
 * caller advances.
 */
export const saveRolePreferences = async (
  writer: RolePreferencesWriter,
  preferences: ReadonlyArray<RolePreference>,
): Promise<MemoryPath> => {
  await writer.write(ROLE_PREFERENCES_PATH, serializeRolePreferences(preferences));
  return ROLE_PREFERENCES_PATH;
};

/**
 * Confirmation-gated persistence (R21.3): store the preferences ONLY when the
 * user has confirmed them. Returns the written path when the preferences were
 * saved, or `undefined` when `confirmed` is false (nothing is written).
 */
export const saveConfirmedRolePreferences = async (
  writer: RolePreferencesWriter,
  preferences: ReadonlyArray<RolePreference>,
  confirmed: boolean,
): Promise<MemoryPath | undefined> => {
  if (!confirmed) return undefined;
  return saveRolePreferences(writer, preferences);
};
