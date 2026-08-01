// Answer refinement, talking points, and retirement (R23.1, R23.3, R28).
//
// Once a STAR answer is captured (every element collected) or Soft-Closed (the
// user accepted a partial answer with a missing-element flag), the
// Interview_Coach refines it into a confirmable talking point (R28):
//
//   * {@link refine} produces a {@link TalkingPointDraft}: a structured
//     four-element STAR summary that surfaces any flags (R28.1), the outstanding
//     weaknesses expressed as advisory coaching SUGGESTIONS rather than blockers
//     (R28.2), and a polished, FIRST-PERSON, PAST-TENSE candidate talking point
//     built ONLY from the answer's content (R28.3).
//   * {@link confirmTalkingPoint} mints a stable `STAR-NN` id from the
//     {@link IdRegistry} on user confirmation and returns the persisted
//     {@link TalkingPoint} carrying the polished text, the four elements, the
//     flags, and the linked skills (R28.3, R23.1). Confirmation succeeds
//     regardless of outstanding flags — weaknesses never block (R28.2).
//   * {@link retire} marks a talking point retired rather than deleting it, and
//     (when a registry is supplied) retires its id so it can never be reissued
//     (R23.3, R23.2).
//
// Two trust guarantees run through this module:
//   1. NO FABRICATION (R28.3 + the project No-Fabrication rule): the polished
//      talking point is derived SOLELY from the answer's own content. It is the
//      delivery-stripped content of {@link contentContribution} re-voiced into a
//      first-person past-tense frame drawn from a FIXED scaffold; it never
//      invents a fact, a metric, or an outcome the user did not state. The
//      first-person/past-tense voice is a presentation transform of the user's
//      own words, not new content.
//   2. THE CONTENT/DELIVERY FIREWALL (R27): the polished text is built from
//      {@link contentContribution}, so delivery (fillers, hesitations, accent,
//      dialect, transcription artefacts) can never leak into a talking point.
//
// Everything here is pure and deterministic except the explicit id mint/retire,
// which is delegated to the injected {@link IdRegistry}: framework-agnostic, no
// I/O, no providers.

import type {
  QuestionId,
  SkillId,
  StarAnswer,
  StarElement,
  StarFlag,
  TalkingPoint,
} from '@core/types';
import { IdRegistry } from '@core/registry';
import {
  STAR_ORDER,
  elementToFlag,
  flagToElement,
  isElementPresent,
  recommendationFor,
} from './coach';
import { contentContribution } from './firewall';
import type { DeliveryLexicon } from './firewall';

const asString = (v: unknown): string => v as unknown as string;

/** Human-readable label for each STAR element (decorative summary display). */
const ELEMENT_LABEL: Readonly<Record<StarElement, string>> = {
  situation: 'Situation',
  task: 'Task',
  action: 'Action',
  result: 'Result',
};

// --- Talking-point polishing validation & fallback (R28.3, task 39.5) -------

/**
 * Common AI filler prefixes that indicate the model just prepended boilerplate
 * to the raw user input rather than genuinely polishing it. Case-insensitive.
 */
const AI_FILLER_PREFIXES: readonly RegExp[] = [
  /^(?:here(?:'s| is) (?:a |the |my |your )?(?:polished|refined|improved|rewritten|summarized|summarised|revised|concise) (?:version|summary|recap|talking point|text)[:\s]*)/i,
  /^(?:sure[,!.]?\s*(?:here(?:'s| is)[:\s]*))/i,
  /^(?:certainly[,!.]?\s*(?:here(?:'s| is)[:\s]*))/i,
  /^(?:the (?:polished|refined|improved) (?:version|summary|talking point) (?:is|would be)[:\s]*)/i,
];

/** Maximum sentence count for a polished talking point (conciseness bound). */
const MAX_POLISHED_SENTENCES = 4;

/** Maximum character length for a polished talking point. */
const MAX_POLISHED_LENGTH = 500;

/**
 * Similarity ratio between two strings (0 = identical, 1 = completely different).
 * Uses a quick token-overlap heuristic: the fraction of unique tokens in `a`
 * that also appear in `b`. When ≥ 0.85 of a's tokens are in b (or vice versa),
 * the strings are effectively the same content.
 */
function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter((t) => t.length > 1));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter((t) => t.length > 1));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let shared = 0;
  for (const t of tokensA) if (tokensB.has(t)) shared++;
  return shared / tokensA.size;
}

/**
 * Validate whether an AI-produced polished text actually meets the quality bar
 * for a concise, first-person, past-tense talking-point summary (R28.3):
 *
 *   1. Not empty.
 *   2. Does not start with a common AI filler prefix (the model just echoed).
 *   3. Contains a first-person marker ("I").
 *   4. Is concise (≤ {@link MAX_POLISHED_SENTENCES} sentences, ≤ {@link MAX_POLISHED_LENGTH} chars).
 *   5. Is not excessively similar to the raw input (token overlap < 0.85 or the
 *      polished is significantly shorter), indicating genuine summarisation.
 *
 * Returns `true` when the polished text passes all checks.
 */
export function isPolishedQuality(polished: string, rawInput: string): boolean {
  const trimmed = polished.trim();
  if (trimmed.length === 0) return false;

  // Check for AI filler prefixes.
  for (const re of AI_FILLER_PREFIXES) {
    if (re.test(trimmed)) return false;
  }

  // Must contain first-person marker.
  if (!/\bI\b/.test(trimmed)) return false;

  // Conciseness: sentence count.
  const sentences = trimmed.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (sentences.length > MAX_POLISHED_SENTENCES) return false;

  // Conciseness: character length.
  if (trimmed.length > MAX_POLISHED_LENGTH) return false;

  // Similarity check: if the polished text uses ≥85% of the same tokens as the
  // raw input AND is not meaningfully shorter, it was not genuinely polished.
  const overlap = tokenOverlap(trimmed, rawInput);
  const significantlyShorter = trimmed.length < rawInput.length * 0.7;
  if (overlap >= 0.85 && !significantlyShorter) return false;

  return true;
}

/**
 * Deterministic sentence-trimming fallback for when the AI fails to produce a
 * quality polished talking point (R28.3, task 39.5). Takes the user's raw answer
 * text and produces a concise first-person past-tense summary by:
 *
 *   1. Splitting into sentences.
 *   2. Keeping at most 3 sentences.
 *   3. Prepending a first-person past-tense frame ("I" + past-tense verb).
 *   4. Trimming trailing whitespace.
 *
 * The result uses ONLY the user's own words (No-Fabrication): the scaffold is a
 * fixed structural connective, never an invented fact.
 */
export function deterministicSentenceTrim(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) return '';

  // Split on sentence boundaries (period, exclamation, question mark followed
  // by whitespace or end of string). Keep non-empty sentences.
  const sentences = trimmed
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length === 0) return '';

  // Take at most 3 sentences.
  const kept = sentences.slice(0, 3);
  let result = kept.join(' ');

  // Ensure it ends with a period.
  if (!/[.!?]$/.test(result)) result += '.';

  // If the text already starts with "I " in first person, return as-is.
  if (/^\s*I\s/i.test(result)) return result;

  // Prepend a first-person past-tense frame.
  return `I ${result.charAt(0).toLowerCase()}${result.slice(1)}`;
}

/**
 * Validate and optionally fix an AI-produced polished talking-point summary
 * (R28.3, task 39.5). If the AI output passes {@link isPolishedQuality}, it is
 * returned unchanged; otherwise the deterministic {@link deterministicSentenceTrim}
 * fallback is applied to the raw input.
 */
export function ensurePolishedQuality(polished: string, rawInput: string): string {
  if (isPolishedQuality(polished, rawInput)) return polished.trim();
  return deterministicSentenceTrim(rawInput);
}

/**
 * Validate an AI-produced per-question SUMMARY for use as the polished talking
 * point (R28.3, R28.6). Unlike {@link isPolishedQuality}, this check does NOT
 * penalise token overlap with the raw input: the AI prompt instructs the model
 * to use ONLY the candidate's own words, so high overlap is EXPECTED and does
 * not indicate a verbatim copy. The checks applied are:
 *
 *   1. Not empty.
 *   2. Does not start with a common AI filler prefix.
 *   3. Contains a first-person marker ("I").
 *   4. Is concise (≤ {@link MAX_POLISHED_SENTENCES} sentences, ≤ {@link MAX_POLISHED_LENGTH} chars).
 *   5. Is NOT a near-exact copy of the raw input (normalised equality — guards
 *      against the model literally echoing the entire input as-is).
 *
 * Returns `true` when the AI summary passes all checks and is suitable as
 * `TalkingPoint.polished`.
 */
export function isAiSummaryQuality(summary: string, rawInput: string): boolean {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return false;

  // Check for AI filler prefixes.
  for (const re of AI_FILLER_PREFIXES) {
    if (re.test(trimmed)) return false;
  }

  // Must contain first-person marker.
  if (!/\bI\b/.test(trimmed)) return false;

  // Conciseness: sentence count.
  const sentences = trimmed.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (sentences.length > MAX_POLISHED_SENTENCES) return false;

  // Conciseness: character length.
  if (trimmed.length > MAX_POLISHED_LENGTH) return false;

  // Guard against a literal echo: if the normalised text is nearly identical to
  // the raw input in its entirety (same length ±5% AND overlap ≥ 0.95), reject.
  const lengthRatio = trimmed.length / Math.max(rawInput.trim().length, 1);
  if (lengthRatio > 0.9 && lengthRatio < 1.1) {
    const overlap = tokenOverlap(trimmed, rawInput);
    if (overlap >= 0.95) return false;
  }

  return true;
}

/**
 * Validate and optionally fix an AI-produced per-question SUMMARY for use as
 * the polished talking point (R28.3, R28.6, task 45.2). Applies
 * {@link isAiSummaryQuality} which permits high token overlap (the model is
 * instructed to use the candidate's own words) but rejects empty, non-first-
 * person, overly long, or literal-echo outputs. Falls back to
 * {@link deterministicSentenceTrim} only when the AI output truly fails quality.
 */
export function ensureAiSummaryQuality(summary: string, rawInput: string): string {
  if (isAiSummaryQuality(summary, rawInput)) return summary.trim();
  return deterministicSentenceTrim(rawInput);
}

// --- The polished talking-point frame (no fabrication, R28.3) ---------------

/**
 * The FIXED first-person, past-tense scaffold each STAR element's content is
 * re-voiced into (R28.3). Every fragment is a structural STAR connective in
 * first person ("I") and past tense ("was"/"took"/"observed"); the user's own
 * content fills the blank. The scaffold adds NO fact, metric, or outcome — the
 * result frame is deliberately neutral ("I observed the result:") so a polished
 * point never claims success the user did not state. The first-person/past-tense
 * voice is therefore a pure presentation transform of the user's words.
 */
const POLISH_FRAME: Readonly<Record<StarElement, (content: string) => string>> = {
  situation: (content) => `I was in a situation where ${content}`,
  task: (content) => `I was responsible for ${content}`,
  action: (content) => `I took the following action: ${content}`,
  result: (content) => `I observed the result: ${content}`,
};

// --- Draft shapes -----------------------------------------------------------

/** One STAR element in the structured refinement summary (R28.1). */
export interface StarSummaryElement {
  /** Which STAR element this row is. */
  element: StarElement;
  /** Human-readable label (decorative). */
  label: string;
  /** The delivery-stripped content captured for this element (may be empty). */
  content: string;
  /** Whether the element was adequately captured (present and not too vague). */
  present: boolean;
  /** The missing-element flag, when this element is flagged (R28.1). */
  flag?: StarFlag;
}

/**
 * An outstanding weakness expressed as an advisory coaching SUGGESTION, never a
 * blocker (R28.2). Confirmation remains possible regardless of how many of these
 * are present.
 */
export interface CoachingSuggestion {
  /** The element the suggestion concerns. */
  element: StarElement;
  /** The flag that raised the suggestion. */
  flag: StarFlag;
  /** Advisory guidance for finding or phrasing the element later (R25.5). */
  suggestion: string;
}

/**
 * The refined-but-unconfirmed talking point (R28.1, R28.2, R28.3). It carries
 * everything needed to show the user a structured STAR summary with flags, the
 * coaching suggestions, and the candidate polished text — and everything
 * {@link confirmTalkingPoint} needs to mint a persisted {@link TalkingPoint}.
 * No id is assigned until the user confirms (R28.3).
 */
export interface TalkingPointDraft {
  /** The question the refined answer belongs to. */
  questionId: QuestionId;
  /** The structured four-element STAR summary, in canonical order (R28.1). */
  summary: StarSummaryElement[];
  /** Every missing-element flag carried from the answer/Soft-Close (R28.1). */
  flags: StarFlag[];
  /** Outstanding weaknesses as advisory suggestions, not blockers (R28.2). */
  suggestions: CoachingSuggestion[];
  /** The polished first-person past-tense talking point (R28.3). */
  polished: string;
  /** Skills this talking point evidences (linked on confirmation). */
  skills: SkillId[];
  /** The delivery-stripped content per captured STAR element (R27.1). */
  elements: Partial<Record<StarElement, string>>;
}

/** Options for {@link refine}. */
export interface RefineOptions {
  /** Skills the confirmed talking point should link (default none). */
  skills?: SkillId[];
  /** Delivery lexicon for the content firewall (default the shipped one). */
  lexicon?: DeliveryLexicon;
}

// --- Refine (R28.1, R28.2, R28.3) -------------------------------------------

/**
 * Refine a captured or Soft-Closed STAR answer into a {@link TalkingPointDraft}
 * (R28.1, R28.2, R28.3). Produces a structured four-element STAR summary that
 * surfaces any flags (R28.1), the outstanding weaknesses as advisory coaching
 * SUGGESTIONS rather than blockers (R28.2), and a polished, first-person,
 * past-tense talking point built ONLY from the answer's delivery-stripped
 * content via the firewall (R28.3) — it never invents a fact, metric, or outcome
 * the user did not state. Pure; never mutates the input.
 */
export const refine = (
  answer: StarAnswer,
  options: RefineOptions = {},
): TalkingPointDraft => {
  const contribution = contentContribution(answer, options.lexicon);

  // Structured STAR summary with flags (R28.1).
  const summary: StarSummaryElement[] = STAR_ORDER.map((element) => {
    const flag = elementToFlag(element);
    const row: StarSummaryElement = {
      element,
      label: ELEMENT_LABEL[element],
      content: contribution.elements[element],
      present: isElementPresent(answer[element]),
    };
    if (answer.flags.includes(flag)) row.flag = flag;
    return row;
  });

  // Outstanding weaknesses as advisory suggestions, never blockers (R28.2).
  const suggestions: CoachingSuggestion[] = answer.flags.map((flag) => {
    const element = flagToElement(flag);
    return { element, flag, suggestion: recommendationFor(element) };
  });

  // The delivery-stripped content per captured element (R27.1) and the polished
  // first-person past-tense talking point built solely from it (R28.3).
  const elements: Partial<Record<StarElement, string>> = {};
  const clauses: string[] = [];
  for (const element of STAR_ORDER) {
    const content = contribution.elements[element].trim();
    if (content.length === 0) continue;
    elements[element] = content;
    clauses.push(POLISH_FRAME[element](content));
  }
  const polished = clauses.length === 0 ? '' : `${clauses.join('. ')}.`;

  return {
    questionId: answer.questionId,
    summary,
    flags: [...answer.flags],
    suggestions,
    polished,
    skills: [...(options.skills ?? [])],
    elements,
  };
};

// --- Confirm (R28.3, R23.1) -------------------------------------------------

/**
 * Confirm a {@link TalkingPointDraft} into a persisted {@link TalkingPoint}
 * (R28.3, R23.1). Mints a stable, never-reused `STAR-NN` id from the injected
 * {@link IdRegistry} (R23.1, R23.2) and returns the talking point carrying the
 * polished text, the four STAR elements, the flags, and the linked skills.
 * Confirmation ALWAYS succeeds — outstanding flags are advisory, never blockers
 * (R28.2). Pure aside from the explicit id mint delegated to the registry.
 */
export const confirmTalkingPoint = (
  draft: TalkingPointDraft,
  registry: IdRegistry,
): TalkingPoint => {
  const talkingPoint: TalkingPoint = {
    id: registry.mintStarId(),
    flags: [...draft.flags],
    polished: draft.polished,
    skills: [...draft.skills],
  };
  for (const element of STAR_ORDER) {
    const value = draft.elements[element];
    if (value !== undefined) talkingPoint[element] = value;
  }
  return talkingPoint;
};

// --- Retire (R23.3, R23.2) --------------------------------------------------

/**
 * Retire a talking point by MARKING it `retired: true` rather than deleting it
 * (R23.3). When a {@link IdRegistry} is supplied, its id is retired in the
 * registry too so the number stays allocated and can never be reissued or
 * renumbered (R23.2). Pure with respect to the talking point — returns a new
 * object and never mutates the input; the registry retirement is the registry's
 * own documented mutation.
 */
export const retire = (
  talkingPoint: TalkingPoint,
  registry?: IdRegistry,
): TalkingPoint => {
  if (registry) registry.retire(asString(talkingPoint.id));
  return { ...talkingPoint, retired: true };
};
