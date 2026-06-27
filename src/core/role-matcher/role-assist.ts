// Role_Matcher AI-assist operation (capability `role_discovery`) routed through
// the shared opt-in-first contract (task 25.2; design "AI Assist Opt-In-First
// Pattern" + "Role_Matcher").
//
// Adapts the Role_Matcher to the shared {@link BaseAssistableOperation}:
//   - `scriptOnly` → the deterministic {@link suggestRoles} suggestions scored
//     against the user's verified skills (R20.1–R20.3) with ZERO provider calls
//     (R20.5). The transport is never reached.
//   - `aiAssisted` → the SAME deterministic suggestions PLUS AI-recommended roles
//     wrapped as confirm-before-entry {@link AssistSuggestion}s (R47.3): the user
//     must explicitly accept a recommendation before it enters preferences.
//
// The AI request here is the employer-free, level-inferring
// {@link RoleDiscoveryPayload} (task 26.1): derived from the skill map only, it
// carries each skill's phrasing, an approximate experience duration, and a
// category — never an employer or company name (R20.6, R47.2) — and for a keyed
// cloud (third-party) destination it excludes every skill marked private (R47.4,
// R46.4). It is routed through the injected gate-routed {@link AssistTransport},
// the only path to a provider. Returned roles are suggestions the user must
// explicitly accept before they enter preferences (R47.3).

import type { LocaleConfig } from '@core/types';
import { asRoleSlug } from '@core/types';
import {
  BaseAssistableOperation,
  type AssistTransport,
  type EgressDestination,
} from '@core/assist';
import type { SkillMap } from '@core/skills';
import {
  suggestRoles,
  type RoleSuggestion,
  type SuggestRolesOptions,
} from './role-suggestion';
import {
  buildDiscoveryPayload,
  buildDiscoveryPrompt as buildPayloadPrompt,
  buildRoleReviewPrompt,
} from './role-discovery-payload';

/** Input to the role-discovery assist operation. */
export interface RoleDiscoveryInput {
  /** The confirmed skill map the suggestions are scored against (R20). */
  readonly map: SkillMap;
  /** Session locale (role titles stay verbatim, R41.6). Optional. */
  readonly locale?: LocaleConfig;
  /** Options forwarded to {@link suggestRoles} (catalog/taxonomy/perType). */
  readonly options?: SuggestRolesOptions;
  /**
   * When `true`, the AI REVIEWS/REFINES the deterministic (script) role
   * suggestions instead of recommending from scratch: the prompt carries the
   * matcher's role titles and asks the model to keep/drop/augment them (the
   * "Both" mode). When `false`/absent the model recommends from the skills
   * alone (the "AI only" mode).
   */
  readonly review?: boolean;
}

/** A single AI-recommended role (a proposal the user must accept, R47.3). */
export interface AiRoleRecommendation {
  /** The recommended role title. */
  readonly title: string;
  /** A short rationale, when the model supplied one. */
  readonly rationale: string;
}

/**
 * Parse a model reply into role recommendations — one per line as
 * `"Title — short reason"` (also accepting `:` or an en/em dash separator).
 * De-duplicates by title (case-insensitive) and drops empty / over-long titles
 * (likely prose, not a role). Shared with the UI so parsing is identical
 * wherever the recommendations are rendered.
 */
export function parseAiRoles(reply: string): AiRoleRecommendation[] {
  const out: AiRoleRecommendation[] = [];
  const seen = new Set<string>();
  for (const raw of reply.split('\n')) {
    const line = raw.replace(/^\s*(?:[-*]|\d+\.)\s*/, '').trim();
    if (line.length === 0) continue;
    const sep = line.match(/\s[—–-]\s|:\s/);
    const title = (sep ? line.slice(0, sep.index) : line)
      .trim()
      .replace(/\*+/g, '');
    const rationale = sep ? line.slice((sep.index ?? 0) + sep[0].length).trim() : '';
    if (title.length === 0 || title.length > 80) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, rationale });
  }
  return out;
}

/**
 * Build the employer-free, level-inferring role-recommendation prompt from the
 * skill map (R20.6, R47.2, R47.4). Delegates to {@link buildDiscoveryPayload} so
 * the prompt carries only skill phrasing, an approximate experience duration,
 * and a category — never an employer or company name — and, for a keyed cloud
 * (third-party) `dest`, excludes every skill marked private. When `dest` is
 * omitted the third-party (safe) default applies, excluding private skills.
 */
export function buildRoleRecommendationPrompt(
  map: SkillMap,
  dest: EgressDestination = { provider: 'openai', kind: 'keyed-cloud' },
): string {
  return buildPayloadPrompt(buildDiscoveryPayload(map, dest));
}

/**
 * Convert an {@link AiRoleRecommendation} into a {@link RoleSuggestion} (R47.3).
 * The model returns a free-text title and reason, not a scored role spec, so the
 * suggestion is NOT given a fabricated fit score: `matchScore` is 0 with no
 * matched/gap skills and a label that flags it as an AI suggestion to review.
 * It carries the AI's reason as its rationale. A suggestion enters the user's
 * preferences only when explicitly accepted via {@link capturePreferences}.
 */
function toRoleSuggestion(rec: AiRoleRecommendation): RoleSuggestion {
  const slugBase = rec.title
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/#/g, 'sharp')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const rationale =
    rec.rationale.length > 0
      ? `AI-suggested role: ${rec.rationale} Review and accept it before it enters your preferences.`
      : 'AI-suggested role. Review and accept it before it enters your preferences.';
  return {
    slug: asRoleSlug(slugBase.length > 0 ? slugBase : 'role'),
    title: rec.title,
    // The model is not asked to categorise; default to an employed position.
    roleType: 'employed',
    description: rec.rationale.length > 0 ? rec.rationale : rec.title,
    matchScore: 0,
    estimated: true,
    scoreLabel: 'AI-suggested — review before adding',
    matchedSkills: [],
    gapSkills: [],
    rationale,
  };
}

/**
 * The Role_Matcher's `role_discovery` operation. `scriptOnly` is the
 * deterministic scored suggestions; `aiAssisted` adds AI-recommended roles as
 * confirm-before-entry suggestions, routed through the gate.
 */
export class RoleDiscoveryOperation extends BaseAssistableOperation<
  RoleDiscoveryInput,
  RoleSuggestion[],
  AiRoleRecommendation
> {
  constructor(private readonly transport: AssistTransport) {
    super();
  }

  /** Deterministic, evidence-scored role suggestions (R20). Zero provider calls. */
  protected computeBaseline(input: RoleDiscoveryInput): RoleSuggestion[] {
    return suggestRoles(input.map, input.locale, input.options);
  }

  /** Ask the model for additional roles from the employer-free payload (R20.6). */
  protected async fetchSuggestions(
    input: RoleDiscoveryInput,
    dest: EgressDestination,
    baseline: RoleSuggestion[],
  ): Promise<readonly AiRoleRecommendation[]> {
    const payload = buildDiscoveryPayload(input.map, dest);
    // "Both" → the model reviews/refines the script-matched roles; "AI only" →
    // it recommends from the skills alone. Either way the payload is the
    // employer-free skills+durations set (R20.6, R47.2).
    const prompt =
      input.review === true
        ? buildRoleReviewPrompt(payload, baseline.map((r) => r.title))
        : buildPayloadPrompt(payload);
    const reply = await this.transport(prompt, dest);
    return parseAiRoles(reply);
  }

  /**
   * Request AI role recommendations for the skill map, routed through the Egress
   * Gate via the injected transport (design "Role_Matcher"; R20.6, R47.2,
   * R47.4). The request is the employer-free, level-inferring
   * {@link RoleDiscoveryPayload} — skill phrasing, an approximate experience
   * duration, and a category only — and, for a keyed cloud (third-party) `dest`,
   * excludes every skill marked private. The returned roles are SUGGESTIONS: the
   * user must explicitly accept one (via {@link capturePreferences}) before it
   * enters preferences, so none of these carries a fabricated fit score (R47.3).
   */
  async recommendRolesAi(
    map: SkillMap,
    dest: EgressDestination,
  ): Promise<RoleSuggestion[]> {
    const prompt = buildPayloadPrompt(buildDiscoveryPayload(map, dest));
    const reply = await this.transport(prompt, dest);
    return parseAiRoles(reply).map(toRoleSuggestion);
  }
}

/** Construct a {@link RoleDiscoveryOperation} bound to a gate-routed transport. */
export function createRoleDiscoveryOperation(
  transport: AssistTransport,
): RoleDiscoveryOperation {
  return new RoleDiscoveryOperation(transport);
}
