// Interview_Coach AI-assist operations (capabilities `star_questions` and
// `star_summary`) routed through the shared opt-in-first contract (tasks 25.2 +
// 27.1/27.4; design "AI Assist Opt-In-First Pattern" + "Interview_Coach").
//
// The Interview_Coach exposes TWO AI-assistable surfaces, each adapted to the
// shared {@link BaseAssistableOperation} so both inherit the trust-critical
// invariants:
//
//   - STAR question generation (`star_questions`, R22.4–R22.9):
//       * `scriptOnly` → the deterministic role-grounded {@link generateQuestions}
//         set with ZERO provider calls (R22.5). The transport is never reached.
//       * `aiAssisted` → the SAME script questions PLUS AI question prompts as
//         confirm-before-entry suggestions; the script set is always carried in
//         full so the AI questions SUPPLEMENT and never replace them (R22.6). The
//         prompt asks the model to FIRST infer the behaviours/qualities that
//         matter most for the target role (so it generalises to any job) and
//         THEN write behaviour-first STAR questions (technical depth capped at
//         one) (R22.6) and, for a keyed cloud (third-party) destination,
//         EXCLUDES every private skill from the request (R22.7, R46.4/46.5). On a
//         provider failure the shared fallback (see `runAssist`) returns the
//         script-only baseline so the script questions remain available and
//         pending coaching state is preserved (R22.8). AI questions are PRACTICE
//         PROMPTS, never factual claims, so they are not gated by the
//         No-Fabrication harness (R22.9): they are surfaced as unconfirmed
//         suggestions and never enter the knowledge base / claims extraction.
//
//   - Educational STAR summary (`star_summary`, R28.5–R28.8):
//       * `scriptOnly` → a deterministic {@link StarTeachingSummary} built ONLY
//         from the user's own delivery-stripped answer content plus a FIXED
//         guidance note, with ZERO provider calls (R28.5). It is a teaching
//         artefact, structurally DISTINCT from the polished {@link refine}
//         talking point and never a substitute for it (R28.5).
//       * `aiAssisted` → the SAME teaching summary PLUS an AI-elaborated teaching
//         summary as a confirm-before-entry suggestion, whose prompt instructs the
//         model to reference ONLY the user's content and invent no fact (R28.8).
//
// All provider access is via the injected gate-routed {@link AssistTransport};
// this module imports no provider client.

import type {
  Question,
  RolePreference,
  StarAnswer,
  StarElement,
} from '@core/types';
import {
  BaseAssistableOperation,
  type AssistTransport,
  type EgressDestination,
} from '@core/assist';
import type { SkillMap } from '@core/skills';
import { generateQuestions } from './questions';
import { refine, type TalkingPointDraft } from './refine';
import { contentContribution } from './firewall';
import type { DeliveryLexicon } from './firewall';
import { STAR_ORDER } from './coach';

// --- STAR question generation (`star_questions`) ---------------------------

/** Input to the STAR-question assist operation. */
export interface StarQuestionsInput {
  /** The target role the questions are grounded in (R22.1). */
  readonly role: RolePreference;
  /** The confirmed skill map used to ground behavioural questions (R22.1). */
  readonly map: SkillMap;
}

/**
 * A single AI-proposed STAR question prompt (a practice prompt, supplement). The
 * model tags each question with the competency/quality it probes (R62.3); the
 * `question` is what the user sees, while `competency` is retained for the
 * adaptive coaching loop and the per-question summary (R63.2, R63.6).
 */
export interface StarQuestionSuggestion {
  /** The behaviour/quality the question probes, retained for the loop (R62.3). */
  readonly competency: string;
  /** The open behavioural question text shown to the user (R62.3). */
  readonly question: string;
}

/** The delimiter separating a question's competency tag from its text (R62.3). */
const COMPETENCY_DELIMITER = '::';

/**
 * Parse a model reply into competency-tagged practice questions. The model is
 * asked to return one question per line as `<competency> :: <question>` (R62.3),
 * so parsing:
 *   - strips any leading list marker (`-`, `*`, `1.`);
 *   - splits on the FIRST `::` delimiter into `{ competency, question }`;
 *   - DROPS any line lacking the delimiter — this also discards model preambles
 *     and trailing chatter, which never carry a `::` (R62.3);
 *   - drops lines whose competency or question is empty / too short to be a
 *     question; and
 *   - de-duplicates by question text (case-insensitive).
 */
export function parseQuestionPrompts(reply: string): StarQuestionSuggestion[] {
  const out: StarQuestionSuggestion[] = [];
  const seen = new Set<string>();
  for (const raw of reply.split('\n')) {
    const line = raw.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim();
    const delimiter = line.indexOf(COMPETENCY_DELIMITER);
    // Drop lines without the delimiter (also removes preambles/chatter).
    if (delimiter < 0) continue;
    const competency = line.slice(0, delimiter).trim();
    const question = line.slice(delimiter + COMPETENCY_DELIMITER.length).trim();
    if (competency.length === 0 || question.length < 8) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ competency, question });
  }
  return out;
}

/**
 * Whether a destination is a keyed cloud (third-party) provider. A keyless Local
 * Provider runs on the user's own device with no third-party egress, so private
 * items may be included (R46.5). Any other destination — including one whose
 * `kind` is absent — is treated as third-party, the SAFE default: over-excluding
 * a private item is harmless, whereas the reverse would leak it (R22.7, R46.4).
 */
const isThirdParty = (dest: EgressDestination): boolean =>
  dest.kind !== 'keyless-local';

/**
 * The skill names carried in the question-generation request, scoped to the
 * destination (R22.7). For a keyed cloud (third-party) `dest` every skill marked
 * private is EXCLUDED (R22.7, R46.4); for a keyless Local Provider private
 * skills are retained (R46.5). Preserves the skill map's entry order.
 */
export const starQuestionSkillNames = (
  map: SkillMap,
  dest: EgressDestination,
): string[] => {
  const thirdParty = isThirdParty(dest);
  return map.entries
    .filter((entry) => !(thirdParty && entry.private === true))
    .map((entry) => entry.name);
};

/**
 * Build the behaviour-first STAR-question prompt for the target role (R22.6).
 * Rather than hardcoding a competency list, the prompt asks the model to FIRST
 * infer the behaviours and qualities that matter most for succeeding in this
 * specific role — so it generalises to ANY job, field, or seniority — and THEN
 * write open behavioural STAR practice questions that probe those qualities.
 * Technical depth is capped at a single question (those are easier to prepare
 * for); the model never suggests facts or outcomes for the candidate to claim
 * (R22.9 — practice prompts only). The candidate's skills are passed only as
 * background context and are scoped to `dest`, so for a keyed cloud
 * (third-party) destination private skills are excluded (R22.7, R46.4); for a
 * keyless Local Provider they are retained (R46.5). When `dest` is omitted the
 * third-party (safe) default applies.
 */
export function buildStarQuestionsPrompt(
  role: RolePreference,
  map: SkillMap,
  dest: EgressDestination = { provider: 'openai', kind: 'keyed-cloud' },
): string {
  const skills = starQuestionSkillNames(map, dest).join(', ');
  const description = role.description?.trim();
  return (
    `You are an experienced interviewer preparing behavioural practice questions ` +
    `for a candidate applying to the role of "${role.title}". ` +
    (description ? `The role: ${description}. ` : '') +
    'First, identify the few behaviours and qualities that matter MOST for ' +
    'succeeding in this specific role, whatever the industry or seniority. Then ' +
    'write up to 5 open behavioural STAR-format practice questions that probe ' +
    'those qualities and ask the candidate to recount their own Situation, Task, ' +
    'Action, and Result. Prioritise behaviours and qualities; include at most ' +
    'one question focused on technical depth, since technical topics are easier ' +
    'to prepare for. Do NOT suggest facts or outcomes for them to claim. Return ' +
    'one question per line in the exact format "<competency> :: <question>", ' +
    'where <competency> is the single behaviour or quality that question probes. ' +
    'Use no preamble and no numbering.\n\n' +
    `Use the candidate's background only as context: ${skills}`
  );
}

/**
 * The Interview_Coach's `star_questions` operation. `scriptOnly` is the
 * deterministic role-grounded question set (R22.5); `aiAssisted` adds AI
 * practice questions as confirm-before-entry suggestions that SUPPLEMENT (never
 * replace) the full script set (R22.6). The AI request frames the model as a
 * recruiter for the specific position and excludes private skills for a keyed
 * cloud destination (R22.6, R22.7). AI questions are practice prompts surfaced
 * as unconfirmed suggestions; they never enter the knowledge base / claims
 * extraction, so they are not gated by the No-Fabrication harness (R22.9).
 */
export class StarQuestionsOperation extends BaseAssistableOperation<
  StarQuestionsInput,
  Question[],
  StarQuestionSuggestion
> {
  constructor(private readonly transport: AssistTransport) {
    super();
  }

  /** Deterministic role-grounded STAR questions (R22.1). Zero provider calls. */
  protected computeBaseline(input: StarQuestionsInput): Question[] {
    return generateQuestions(input.role, input.map);
  }

  /**
   * Ask the model for additional practice questions: it first infers the
   * behaviours/qualities that matter most for the target role and then writes
   * behaviour-first STAR questions (technical depth capped at one) (R22.6),
   * excluding private skills for a keyed cloud (third-party) destination
   * (R22.7). Returns unconfirmed practice-prompt
   * suggestions only — never factual claims (R22.9).
   */
  protected async fetchSuggestions(
    input: StarQuestionsInput,
    dest: EgressDestination,
  ): Promise<readonly StarQuestionSuggestion[]> {
    const reply = await this.transport(
      buildStarQuestionsPrompt(input.role, input.map, dest),
      dest,
    );
    return parseQuestionPrompts(reply);
  }
}

/** Construct a {@link StarQuestionsOperation} bound to a gate-routed transport. */
export function createStarQuestionsOperation(
  transport: AssistTransport,
): StarQuestionsOperation {
  return new StarQuestionsOperation(transport);
}

// --- Educational STAR summary (`star_summary`, R28.5–R28.8) ----------------

/**
 * The educational STAR TEACHING ARTEFACT (R28.7). It identifies the Situation,
 * Task, Action, and Result components of the user's OWN answer — each taken
 * verbatim from the answer's delivery-stripped content, never invented (R28.8) —
 * and pairs them with `guidance` explaining what a good STAR-format answer looks
 * like. It is structurally DISTINCT from the polished {@link TalkingPointDraft}
 * talking point and never a substitute for it (R28.5).
 */
export interface StarTeachingSummary {
  /** The user's Situation content, identified from their own answer (R28.8). */
  readonly situation: string;
  /** The user's Task content, identified from their own answer (R28.8). */
  readonly task: string;
  /** The user's Action content, identified from their own answer (R28.8). */
  readonly action: string;
  /** The user's Result content, identified from their own answer (R28.8). */
  readonly result: string;
  /** Teaching guidance on what a good STAR-format answer looks like (R28.7). */
  readonly guidance: string;
}

/** Input to the educational-summary assist operation. */
export interface StarSummaryInput {
  /** The captured/Soft-Closed STAR answer to summarise. */
  readonly answer: StarAnswer;
  /** Optional delivery lexicon for the content firewall (default the shipped one). */
  readonly lexicon?: DeliveryLexicon;
}

/** An AI-elaborated teaching summary (a suggestion requiring confirmation). */
export type StarSummarySuggestion = StarTeachingSummary;

/**
 * The FIXED teaching note explaining what a good STAR-format answer looks like
 * (R28.7). It is generic STAR coaching — it references no specific fact about the
 * user — so the deterministic teaching summary invents nothing (R28.8).
 */
export const STAR_GUIDANCE =
  'A strong STAR answer sets the Situation (the concrete context you were in), ' +
  'states the Task (what you were specifically responsible for), describes the ' +
  'Action (the steps you personally took), and ends with a measurable Result. ' +
  'Keep each element distinct, speak in the first person, and ground the result ' +
  'in an outcome you can honestly evidence.';

/**
 * Build the deterministic {@link StarTeachingSummary} from a STAR answer (R28.6,
 * R28.7). Each STAR component is taken from the answer's delivery-stripped
 * content via the content/delivery firewall, so it reflects ONLY the user's own
 * words and invents no fact (R28.8). The `guidance` is the fixed {@link
 * STAR_GUIDANCE} teaching note. Pure; makes ZERO provider calls (R28.5).
 */
export function buildTeachingSummary(
  answer: StarAnswer,
  lexicon?: DeliveryLexicon,
): StarTeachingSummary {
  const contribution = contentContribution(answer, lexicon);
  return {
    situation: contribution.elements.situation,
    task: contribution.elements.task,
    action: contribution.elements.action,
    result: contribution.elements.result,
    guidance: STAR_GUIDANCE,
  };
}

/**
 * Build the educational-summary prompt bound STRICTLY to the user's own answer
 * content (R28.8). The model is told to identify the four STAR components from
 * ONLY the supplied content, to explain what a good STAR answer looks like, and
 * to invent NO new fact (No-Fabrication Rule). The prompt carries the
 * delivery-stripped per-element content from the {@link StarTeachingSummary}.
 */
export function buildStarSummaryPrompt(summary: StarTeachingSummary): string {
  const line = (label: string, content: string): string =>
    `${label}: ${content.trim().length > 0 ? content.trim() : '(not provided)'}`;
  return (
    'Here is a candidate\'s STAR interview answer, broken into the content they ' +
    'provided for each element. Write a short educational summary that identifies ' +
    'the Situation, Task, Action, and Result in their answer and explains what a ' +
    'good STAR-format answer looks like. Use ONLY the content below — do not add, ' +
    'assume, or invent any fact, metric, or outcome the candidate did not state. ' +
    'Return only the teaching summary.\n\n' +
    STAR_ORDER.map((el) =>
      line(el[0].toUpperCase() + el.slice(1), summaryElement(summary, el)),
    ).join('\n')
  );
}

/** Read a STAR element's content off a {@link StarTeachingSummary}. */
const summaryElement = (summary: StarTeachingSummary, element: StarElement): string =>
  summary[element];

/**
 * The Interview_Coach's `star_summary` operation (R28.5–R28.8). `scriptOnly` is
 * the deterministic {@link StarTeachingSummary} teaching artefact (zero provider
 * calls, R28.5); `aiAssisted` adds an AI-elaborated teaching summary as a
 * confirm-before-entry suggestion whose prompt is bound strictly to the user's
 * own content and invents no fact (R28.8). The teaching artefact is distinct from
 * the polished talking point produced by {@link refine}/`confirmTalkingPoint`.
 */
export class StarSummaryOperation extends BaseAssistableOperation<
  StarSummaryInput,
  StarTeachingSummary,
  StarSummarySuggestion
> {
  constructor(private readonly transport: AssistTransport) {
    super();
  }

  /** Deterministic teaching artefact from the user's own content (R28.6–R28.8). */
  protected computeBaseline(input: StarSummaryInput): StarTeachingSummary {
    return buildTeachingSummary(input.answer, input.lexicon);
  }

  /**
   * Ask the model for an elaborated teaching summary bound strictly to the
   * user's content (R28.8). The model returns guidance text; the four STAR
   * components remain the user's own content, so no fact can be invented.
   */
  protected async fetchSuggestions(
    _input: StarSummaryInput,
    dest: EgressDestination,
    baseline: StarTeachingSummary,
  ): Promise<readonly StarSummarySuggestion[]> {
    const reply = await this.transport(buildStarSummaryPrompt(baseline), dest);
    const guidance = reply.trim();
    if (guidance.length === 0) return [];
    return [{ ...baseline, guidance }];
  }
}

/** Construct a {@link StarSummaryOperation} bound to a gate-routed transport. */
export function createStarSummaryOperation(
  transport: AssistTransport,
): StarSummaryOperation {
  return new StarSummaryOperation(transport);
}

/**
 * Opt-in educational STAR summary (design `educationalSummary(answer, dest)`;
 * R28.6–R28.8). Produces the {@link StarTeachingSummary} teaching artefact — the
 * user's own S/T/A/R content (R28.6, R28.8) plus AI-elaborated `guidance` on what
 * a good STAR answer looks like (R28.7). The artefact is bound strictly to the
 * user's content; the prompt forbids invented facts (R28.8). On a provider
 * failure this falls back NON-BLOCKINGLY to the deterministic baseline (with the
 * fixed {@link STAR_GUIDANCE}), so the teaching artefact is always available.
 *
 * This is the AI path; the script-only path is {@link buildTeachingSummary},
 * which makes ZERO provider calls (R28.5). The teaching artefact is DISTINCT from
 * the polished talking point ({@link refine}) and never a substitute for it.
 */
export async function educationalSummary(
  answer: StarAnswer,
  dest: EgressDestination,
  transport: AssistTransport,
  options: { lexicon?: DeliveryLexicon } = {},
): Promise<StarTeachingSummary> {
  const baseline = buildTeachingSummary(answer, options.lexicon);
  try {
    const reply = await transport(buildStarSummaryPrompt(baseline), dest);
    const guidance = reply.trim();
    return guidance.length > 0 ? { ...baseline, guidance } : baseline;
  } catch {
    // Non-blocking fallback: the deterministic teaching artefact is always
    // available, so an unreachable provider never blocks the educational summary.
    return baseline;
  }
}

/**
 * The script-only educational STAR summary (R28.5). The deterministic teaching
 * artefact built purely from the user's own content with the fixed guidance
 * note, making ZERO provider calls. Alias of {@link buildTeachingSummary} for
 * call-site clarity at the opt-out path.
 */
export function educationalSummaryScriptOnly(
  answer: StarAnswer,
  lexicon?: DeliveryLexicon,
): StarTeachingSummary {
  return buildTeachingSummary(answer, lexicon);
}

// Re-export to keep the polished talking-point type adjacent for callers that
// import both artefacts from the assist surface (the teaching summary is
// DISTINCT from this draft — R28.5).
export type { TalkingPointDraft };

// --- Adaptive STAR coaching loop: adequacy / follow-up (R63.2, R63.7) -------

/**
 * Whether a single STAR element is covered by the candidate's answer so far, as
 * assessed by the model. Mirrors the strict `covered | missing` reply tokens
 * (design "Adaptive STAR coaching loop").
 */
export type StarCoverage = 'covered' | 'missing';

/**
 * Input to the adequacy/follow-up assist operation (R63.2). The chat model is
 * STATELESS across turns, so every call carries the FULL context: the target
 * `role`, the `competency` the question probes (carried from the question
 * generator, R62.3), the original `question`, and ALL `answersSoFar` in order —
 * the operation persists no state of its own.
 */
export interface AdequacyInput {
  /** The target role the practice answer is grounded in (R63.2). */
  readonly role: RolePreference;
  /** The behaviour/quality the question probes, carried from R62.3. */
  readonly competency: string;
  /** The original question the candidate is answering (R63.2). */
  readonly question: string;
  /** Every answer the candidate has given for this question so far, in order (R63.2). */
  readonly answersSoFar: readonly string[];
}

/**
 * The model's per-turn assessment of a STAR practice answer (R63.2). Each STAR
 * element is `covered` or `missing`; `enough` is whether the answer is now
 * sufficient; `followUp` is ONE open practice prompt to cover what is missing,
 * or `null` when the model offers none. The assessment is derived ONLY from the
 * candidate's own words and invents no fact; the follow-up is a practice prompt,
 * never a factual claim (R63.7).
 */
export interface AdequacyAssessment {
  /** Whether the candidate stated their Situation (R63.2). */
  readonly situation: StarCoverage;
  /** Whether the candidate stated their Task (R63.2). */
  readonly task: StarCoverage;
  /** Whether the candidate stated their Action (R63.2). */
  readonly action: StarCoverage;
  /** Whether the candidate stated their Result (R63.2). */
  readonly result: StarCoverage;
  /** Whether the answer is now sufficient (the loop stops when `true`, R63.3). */
  readonly enough: boolean;
  /** One open follow-up practice prompt, or `null` when the model offers none (R63.2, R63.7). */
  readonly followUp: string | null;
}

/** The exact reply-format labels the adequacy prompt asks for and the parser reads. */
const ADEQUACY_LABELS = {
  situation: 'SITUATION',
  task: 'TASK',
  action: 'ACTION',
  result: 'RESULT',
  enough: 'ENOUGH',
  followUp: 'FOLLOWUP',
} as const;

/**
 * Build the adequacy/follow-up prompt for one coaching turn (R63.2). Because the
 * model is stateless, the prompt carries the full context — role, competency,
 * original question, and every answer so far — and binds the assessment STRICTLY
 * to the candidate's own words: it must judge each STAR element, decide whether
 * the answer is sufficient, and offer ONE open follow-up when it is not, while
 * inventing no fact (No-Fabrication, R63.7). The follow-up is framed as a
 * practice prompt, never a statement of fact. The reply must use the EXACT
 * strict format the parser reads ({@link parseAdequacyReply}).
 */
export function buildAdequacyPrompt(input: AdequacyInput): string {
  const description = input.role.description?.trim();
  const answers = input.answersSoFar
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  const answersBlock =
    answers.length > 0
      ? answers.map((a, i) => `${i + 1}. ${a}`).join('\n')
      : '(no answer yet)';
  return (
    `You are an experienced interview coach assessing a candidate's STAR practice ` +
    `answer for the role of "${input.role.title}". ` +
    (description ? `The role: ${description}. ` : '') +
    `The competency being practised is "${input.competency}". ` +
    `The original question was: "${input.question}".\n\n` +
    `Here is everything the candidate has said so far, in order:\n` +
    `${answersBlock}\n\n` +
    `Assess the answer using ONLY the candidate's own words above — do not add, ` +
    `assume, or invent any fact, detail, metric, or outcome they did not state. ` +
    `Decide whether each STAR element (Situation, Task, Action, Result) is ` +
    `covered or missing, whether the answer is now sufficient overall, and, when ` +
    `it is not sufficient, ONE open follow-up question that would help the ` +
    `candidate cover what is missing. The follow-up is a practice prompt, never a ` +
    `statement of fact.\n\n` +
    `Reply in EXACTLY this format, one field per line, and nothing else:\n` +
    `${ADEQUACY_LABELS.situation}: covered or missing\n` +
    `${ADEQUACY_LABELS.task}: covered or missing\n` +
    `${ADEQUACY_LABELS.action}: covered or missing\n` +
    `${ADEQUACY_LABELS.result}: covered or missing\n` +
    `${ADEQUACY_LABELS.enough}: yes or no\n` +
    `${ADEQUACY_LABELS.followUp}: <one open follow-up question, or "none">`
  );
}

/**
 * Read the value following a `LABEL:` line from a model reply, tolerating common
 * model noise: leading list markers / blockquote / markdown-bold wrappers around
 * the label, and surrounding emphasis on the value. Returns `null` when the label
 * is absent. Matches the first occurrence.
 */
function adequacyField(lines: readonly string[], label: string): string | null {
  const re = new RegExp(`^[\\s>*_-]*${label}\\s*:?\\s*\\**\\s*:?\\s*(.*)$`, 'i');
  for (const raw of lines) {
    const match = raw.match(re);
    if (match) return match[1].replace(/[*_]+\s*$/, '').trim();
  }
  return null;
}

/** Map a raw coverage value to `covered` only when it explicitly says so; else `missing`. */
const toCoverage = (value: string | null): StarCoverage =>
  value != null && /\bcovered\b/i.test(value) ? 'covered' : 'missing';

/**
 * Parse a strict adequacy reply into a typed {@link AdequacyAssessment} (R63.2).
 * The parser is deliberately forgiving of model formatting noise but conservative
 * about meaning:
 *   - a STAR element counts as `covered` ONLY when its line explicitly says
 *     "covered"; any other or missing value is treated as `missing`, so the loop
 *     keeps probing rather than prematurely declaring coverage;
 *   - `ENOUGH` is `true` ONLY when its line explicitly says "yes" — a missing or
 *     ambiguous value defaults to not-enough (the conservative default; the loop
 *     cap in R63.3/R63.4 prevents runaway probing);
 *   - `FOLLOWUP` is `null` when the line is absent, empty, or says "none"
 *     (case-insensitive); otherwise it is the trimmed question with any format
 *     placeholder brackets/quotes stripped.
 */
export function parseAdequacyReply(reply: string): AdequacyAssessment {
  const lines = reply.split('\n');
  const enoughValue = adequacyField(lines, ADEQUACY_LABELS.enough);
  const followUpValue = adequacyField(lines, ADEQUACY_LABELS.followUp);

  let followUp: string | null = null;
  if (followUpValue != null) {
    const cleaned = followUpValue.replace(/^["'<\[(]+|["'>\]).]+$/g, '').trim();
    if (cleaned.length > 0 && !/^none$/i.test(cleaned)) followUp = cleaned;
  }

  return {
    situation: toCoverage(adequacyField(lines, ADEQUACY_LABELS.situation)),
    task: toCoverage(adequacyField(lines, ADEQUACY_LABELS.task)),
    action: toCoverage(adequacyField(lines, ADEQUACY_LABELS.action)),
    result: toCoverage(adequacyField(lines, ADEQUACY_LABELS.result)),
    enough: enoughValue != null && /\byes\b/i.test(enoughValue),
    followUp,
  };
}

/**
 * The adaptive coaching loop's adequacy/follow-up AI operation (R63.2, R63.7).
 * Given one turn's full context — `{ role, competency, question, answersSoFar }`
 * — it sends a single gate-routed request through the injected
 * {@link AssistTransport} (the only path to a provider, which itself routes
 * through the Egress Gate) and parses the strict reply into an
 * {@link AdequacyAssessment}.
 *
 * The operation is STATELESS: it holds no per-question or per-session state, so
 * the caller (the loop controller, task 31.3) owns turn counting, the follow-up
 * cap, and failure handling. The assessment is derived ONLY from the candidate's
 * own words and invents no fact; the follow-up is a practice prompt, never a
 * factual claim (R63.7), so it is not gated by the No-Fabrication harness.
 */
export async function assessAdequacy(
  input: AdequacyInput,
  dest: EgressDestination,
  transport: AssistTransport,
): Promise<AdequacyAssessment> {
  const reply = await transport(buildAdequacyPrompt(input), dest);
  return parseAdequacyReply(reply);
}

// --- Adaptive STAR coaching loop: per-question summary (R63.6, R63.7) -------

/**
 * The per-question coaching summary produced when a question's coaching loop
 * ENDS (R63.6). It is a DISPLAY artefact — it persists nothing itself — derived
 * ONLY from the candidate's own words (R63.7): a short first-person past-tense
 * `summary`, a `star` coverage description (which of Situation/Task/Action/Result
 * the answer covered), the `skills` the answer evidences, and improvement `tips`.
 *
 * The `competency` shown alongside this summary is CARRIED IN from the coaching
 * loop (R62.3, see {@link PerQuestionSummaryInput.competency}); it is never
 * parsed from the model reply. The polished talking point is confirmed and
 * persisted SEPARATELY through the EXISTING path — {@link refine} →
 * `confirmTalkingPoint` → `withTalkingPoint` (R28.3, R28.4) — so this operation
 * introduces no new persistence mechanism.
 *
 * Per the No-Fabrication Rule, the `summary` and `skills` MUST be drawn solely
 * from what the candidate actually said; the prompt forbids inventing any fact,
 * metric, skill, or outcome (R63.7).
 */
export interface PerQuestionSummary {
  /** A 2–3 sentence first-person past-tense recap of the user's own words (R63.6, R63.7). */
  readonly summary: string;
  /** Which of S/T/A/R the answer covered, as described by the model (R63.6). */
  readonly star: string;
  /** Skills the answer evidences, derived ONLY from the user's words (R63.6, R63.7). */
  readonly skills: readonly string[];
  /** One or two actionable tips for improving the answer (R63.6). */
  readonly tips: readonly string[];
}

/**
 * Input to the per-question summary assist operation (R63.6). The chat model is
 * STATELESS, so the call carries the full context — the target `role`, the
 * `competency` the question probed (carried from the question generator, R62.3,
 * NOT parsed back from the reply), the original `question`, and the candidate's
 * `fullAnswer` (every answer for this question, joined). The operation persists
 * no state of its own.
 */
export interface PerQuestionSummaryInput {
  /** The target role the practice answer is grounded in (R63.6). */
  readonly role: RolePreference;
  /** The behaviour/quality the question probed, carried from R62.3 (not parsed). */
  readonly competency: string;
  /** The original question the candidate answered (R63.6). */
  readonly question: string;
  /** The candidate's complete answer for this question (every turn, joined) (R63.6). */
  readonly fullAnswer: string;
}

/** The exact reply-format labels the per-question summary prompt asks for and the parser reads. */
const SUMMARY_LABELS = {
  summary: 'SUMMARY',
  star: 'STAR',
  skills: 'SKILLS',
  tips: 'TIPS',
} as const;

/**
 * Build the per-question summary prompt for a finished coaching loop (R63.6).
 * Because the model is stateless, the prompt carries the full context — role,
 * competency, original question, and the candidate's full answer — and binds the
 * summary STRICTLY to the candidate's own words: the `SUMMARY` and `SKILLS` must
 * be drawn solely from what the candidate actually said, inventing no fact,
 * metric, skill, or outcome (No-Fabrication, R63.7). The reply must use the EXACT
 * strict format the parser reads ({@link parsePerQuestionSummaryReply}).
 */
export function buildPerQuestionSummaryPrompt(input: PerQuestionSummaryInput): string {
  const description = input.role.description?.trim();
  const answer = input.fullAnswer.trim();
  return (
    `You are an experienced interview coach summarising a candidate's completed ` +
    `STAR practice answer for the role of "${input.role.title}". ` +
    (description ? `The role: ${description}. ` : '') +
    `The competency being practised is "${input.competency}". ` +
    `The original question was: "${input.question}".\n\n` +
    `Here is the candidate's full answer:\n` +
    `${answer.length > 0 ? answer : '(no answer given)'}\n\n` +
    `Summarise the answer using ONLY the candidate's own words above — do not add, ` +
    `assume, or invent any fact, detail, metric, skill, or outcome they did not ` +
    `state. The summary and the listed skills MUST be drawn solely from what the ` +
    `candidate actually said; list a skill only when the answer clearly evidences ` +
    `it. Write the summary in the first person and the past tense.\n\n` +
    `Reply in EXACTLY this format, one field per line, and nothing else:\n` +
    `${SUMMARY_LABELS.summary}: <2-3 sentences, first person, past tense>\n` +
    `${SUMMARY_LABELS.star}: <which of Situation, Task, Action, Result the answer covered>\n` +
    `${SUMMARY_LABELS.skills}: <comma-separated skills evidenced in the answer, or "none">\n` +
    `${SUMMARY_LABELS.tips}: <1-2 short actionable tips to improve the answer>`
  );
}

/**
 * Extract each labelled section's text block from a strict reply. Scans line by
 * line: a line opening with `LABEL:` (tolerating leading list markers /
 * blockquote / markdown-bold around the label) starts that label's block, and
 * every following non-empty line until the NEXT recognised label is appended to
 * it. This tolerates multi-line `SUMMARY` and `TIPS` values. Absent labels are
 * omitted. The returned map is keyed by the UPPER-CASE label.
 */
function extractSections(reply: string, labels: readonly string[]): Map<string, string> {
  const labelRe = new RegExp(
    `^[\\s>*_-]*(${labels.join('|')})\\s*\\**\\s*:\\s*\\**\\s*(.*)$`,
    'i',
  );
  const parts = new Map<string, string[]>();
  let current: string | null = null;
  for (const raw of reply.split('\n')) {
    const match = raw.match(labelRe);
    if (match) {
      current = match[1].toUpperCase();
      const rest = match[2].replace(/[*_]+\s*$/, '').trim();
      parts.set(current, rest.length > 0 ? [rest] : []);
      continue;
    }
    if (current !== null && raw.trim().length > 0) {
      parts.get(current)?.push(raw.trim());
    }
  }
  const out = new Map<string, string>();
  for (const [label, lines] of parts) out.set(label, lines.join('\n').trim());
  return out;
}

/**
 * Split a comma/semicolon/newline-separated block into a de-duplicated list,
 * stripping leading list markers and dropping empty entries and a literal
 * "none". Used for the `SKILLS` field.
 */
function splitSkillList(block: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of block.split(/[,;\n]/)) {
    const item = piece.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (item.length === 0 || /^none$/i.test(item)) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Split a tips block into one entry per line (commas are kept WITHIN a tip),
 * stripping leading list markers and dropping empty entries and a literal
 * "none". A single-line block yields a single tip.
 */
function splitTips(block: string): string[] {
  const out: string[] = [];
  for (const piece of block.split(/\n+/)) {
    const item = piece.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (item.length === 0 || /^none$/i.test(item)) continue;
    out.push(item);
  }
  return out;
}

/**
 * Parse a strict per-question summary reply into a typed {@link PerQuestionSummary}
 * (R63.6). The parser tolerates model formatting noise (leading list markers,
 * blockquote, markdown-bold labels, multi-line `SUMMARY`/`TIPS` values) via
 * {@link extractSections}: `summary` and `star` are the trimmed text blocks;
 * `skills` is the comma/semicolon/newline-split list with "none"/empties dropped
 * and de-duplicated; `tips` is one entry per line. The `competency` is NOT parsed
 * here — it is carried in from the coaching loop (R62.3).
 */
export function parsePerQuestionSummaryReply(reply: string): PerQuestionSummary {
  const sections = extractSections(reply, Object.values(SUMMARY_LABELS));
  const get = (label: string): string => sections.get(label) ?? '';
  return {
    summary: get(SUMMARY_LABELS.summary),
    star: get(SUMMARY_LABELS.star),
    skills: splitSkillList(get(SUMMARY_LABELS.skills)),
    tips: splitTips(get(SUMMARY_LABELS.tips)),
  };
}

/**
 * The adaptive coaching loop's per-question summary AI operation (R63.6, R63.7).
 * Produced when a question's coaching loop ENDS: given the full context —
 * `{ role, competency, question, fullAnswer }` — it sends a single gate-routed
 * request through the injected {@link AssistTransport} (the only path to a
 * provider, which itself routes through the Egress Gate) and parses the strict
 * reply into a {@link PerQuestionSummary}.
 *
 * The operation is STATELESS and persists nothing: the `summary` and `skills`
 * are derived ONLY from the candidate's own words and invent no fact (R63.7).
 * The accompanying `competency` is carried in from the loop, not parsed. The
 * polished talking point is confirmed and persisted SEPARATELY through the
 * EXISTING {@link refine} → `confirmTalkingPoint` → `withTalkingPoint` path
 * (R28.3, R28.4) — this operation never persists on its own. As with
 * {@link assessAdequacy}, a provider failure rejects and is handled by the
 * caller; there is no synthesised baseline (a per-question summary requires the
 * provider, R63.6).
 */
export async function perQuestionSummary(
  input: PerQuestionSummaryInput,
  dest: EgressDestination,
  transport: AssistTransport,
): Promise<PerQuestionSummary> {
  const reply = await transport(buildPerQuestionSummaryPrompt(input), dest);
  return parsePerQuestionSummaryReply(reply);
}
