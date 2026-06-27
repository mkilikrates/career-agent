// Employer-free role-discovery AI-assist payload (task 26.1; design
// "Role_Matcher"; Requirements 20.6, 47.2, 47.4).
//
// When the user opts in to AI-assisted role discovery, the chosen model is asked
// to suggest roles that fit the user's skills. The request it receives is built
// HERE, deliberately minimised so it leaks nothing sensitive:
//
//   * It is derived from the SKILL MAP ONLY. The skill map carries the user's
//     skill phrasing, a category, and a dated evidence trail — it has no employer
//     name and no company name anywhere — so the payload is inherently
//     employer-free (R20.6, R47.2). We project each entry down to exactly three
//     fields (name, approxDurationMonths, category) so nothing else can leak.
//   * It includes an APPROXIMATE per-skill experience duration in months, derived
//     from the skill's dated evidence trail, so the model can infer a level of
//     experience WITHOUT ever seeing where or for whom the user worked (R20.6).
//   * For a keyed cloud (third-party) destination it EXCLUDES every skill marked
//     private (R47.4, R46.4); for a keyless Local Provider running on the user's
//     own device (no third-party egress) private skills may be included (R46.5).
//
// This module is pure @core domain logic: it builds the data shape and the
// prompt text. It imports NO provider client — transmission flows only through
// the single Egress Gate, reached from `recommendRolesAi` via the injected
// gate-routed transport.

import type { EgressDestination } from '@core/assist';
import type { SkillMap } from '@core/skills';
import type { SkillCategory, SkillMapEntry } from '@core/types';

/**
 * The AI-assist input derived from the skill map (design "Role_Matcher";
 * R20.6, R47.2). Deliberately employer-free and level-inferring: every carried
 * skill has the user's phrasing, an approximate experience duration in months,
 * and a category — and NOTHING else. There is no employer name, no company
 * name, and (for a keyed cloud destination) no skill marked private.
 */
export interface RoleDiscoveryPayload {
  readonly skills: ReadonlyArray<{
    /** The user's own skill phrasing (no employer/company name anywhere). */
    readonly name: string;
    /** Approximate experience duration in months so the model infers a level (R20.6). */
    readonly approxDurationMonths: number;
    /** The skill's category bucket. */
    readonly category: SkillCategory;
  }>;
}

/** Average days per month used to convert a date span to an approximate month count. */
const DAYS_PER_MONTH = 30.4375;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const asString = (v: unknown): string => v as unknown as string;

/** Parse a `YYYY-MM-DD` ISODate to a UTC epoch ms, or `null` when unparseable. */
const parseIso = (iso: unknown): number | null => {
  const s = asString(iso);
  if (typeof s !== 'string' || s.length === 0) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Approximate the experience duration for a single skill, in whole months,
 * derived from its dated evidence trail plus its recency (R20.6). The span runs
 * from the EARLIEST dated evidence to the LATEST observed date (the max of the
 * evidence dates and the entry's `recency`), rounded to the nearest month. A
 * skill with a single dated point (or none) yields a minimum of one month so the
 * model still sees it as carrying some experience rather than zero.
 *
 * Pure and deterministic; never negative.
 */
export const approxDurationMonths = (entry: SkillMapEntry): number => {
  const dates: number[] = [];
  for (const ev of entry.evidence ?? []) {
    const ms = parseIso(ev.when);
    if (ms !== null) dates.push(ms);
  }
  const recency = parseIso(entry.recency);
  if (recency !== null) dates.push(recency);

  if (dates.length === 0) return 1; // no usable dates → minimum signal

  const earliest = Math.min(...dates);
  const latest = Math.max(...dates);
  const months = Math.round((latest - earliest) / MS_PER_DAY / DAYS_PER_MONTH);
  return Math.max(1, months);
};

/**
 * Whether a destination is a keyed cloud (third-party) provider. A keyless Local
 * Provider runs on the user's own device with no third-party egress, so private
 * items may be included (R46.5). Any other destination — including one whose
 * `kind` is absent — is treated as third-party, the SAFE default: over-excluding
 * a private item is harmless, whereas the reverse would leak it (R47.4, R46.4).
 */
const isThirdParty = (dest: EgressDestination): boolean =>
  dest.kind !== 'keyless-local';

/**
 * Build the employer-free role-discovery payload from the skill map (R20.6,
 * R47.2, R47.4). Each entry is projected to exactly `{ name, approxDurationMonths,
 * category }`, so no employer/company name (which the skill map does not carry
 * anyway) can leak. For a keyed cloud (third-party) `dest`, every skill marked
 * private is excluded (R47.4, R46.4); for a keyless Local Provider the private
 * skills are retained (R46.5).
 *
 * Pure and deterministic; preserves the skill map's entry order.
 */
export const buildDiscoveryPayload = (
  map: SkillMap,
  dest: EgressDestination,
): RoleDiscoveryPayload => {
  const thirdParty = isThirdParty(dest);
  const skills = map.entries
    .filter((entry) => !(thirdParty && entry.private === true))
    .map((entry) => ({
      name: entry.name,
      approxDurationMonths: approxDurationMonths(entry),
      category: entry.category,
    }));
  return { skills };
};

/** Render an approximate duration in months as a short human/model-readable hint. */
const describeDuration = (months: number): string => {
  if (months < 12) return `~${months} mo`;
  const years = months / 12;
  // One decimal place, trimming a trailing `.0`.
  const text = years.toFixed(1).replace(/\.0$/, '');
  return `~${text} yr`;
};

/**
 * Build the role-recommendation PROMPT from an employer-free
 * {@link RoleDiscoveryPayload} (R20.6). The model sees only skill phrasing, an
 * approximate experience duration per skill (so it can infer a level), and the
 * category — never an employer or company. Each skill is one line:
 * `"<name> (<category>, ~<duration>)"`. The reply format mirrors
 * {@link parseAiRoles}: one role per line as `"Title — short reason"`.
 */
export const buildDiscoveryPrompt = (payload: RoleDiscoveryPayload): string => {
  const lines = payload.skills.map(
    (s) => `- ${s.name} (${s.category}, ${describeDuration(s.approxDurationMonths)})`,
  );
  return (
    'Based ONLY on the following skills and the approximate experience duration ' +
    'for each, suggest up to 5 realistic job roles that fit, inferring a level of ' +
    'experience from the durations. Do not assume any employer or industry beyond ' +
    'what the skills imply. Return one role per line as "Title — short reason". ' +
    'No preamble.\n\nSkills:\n' +
    lines.join('\n')
  );
};

/**
 * Build the role-recommendation REVIEW prompt for the "Both" mode (script + AI
 * review). The model is given the roles a deterministic matcher already
 * suggested and asked to REVIEW them against the skills/durations — keep the
 * good fits, drop poor ones, and add better-fitting roles the matcher missed —
 * inferring level from the durations and assuming no employer/industry beyond
 * what the skills imply. Same employer-free payload; same one-per-line reply
 * format as {@link buildDiscoveryPrompt} so {@link parseAiRoles} is reused.
 */
export const buildRoleReviewPrompt = (
  payload: RoleDiscoveryPayload,
  scriptRoleTitles: readonly string[],
): string => {
  const lines = payload.skills.map(
    (s) => `- ${s.name} (${s.category}, ${describeDuration(s.approxDurationMonths)})`,
  );
  const detected = scriptRoleTitles.length > 0 ? scriptRoleTitles.join(', ') : '(none suggested)';
  return (
    'A deterministic matcher suggested these roles from the candidate\'s skills: ' +
    detected +
    '. Review that list against the skills and approximate durations below: keep ' +
    'the good fits, drop poor fits, and add any better-fitting roles the matcher ' +
    'missed, inferring the level of experience from the durations. Do not assume ' +
    'any employer or industry beyond what the skills imply. Return one role per ' +
    'line as "Title — short reason". No preamble.\n\nSkills:\n' +
    lines.join('\n')
  );
};
