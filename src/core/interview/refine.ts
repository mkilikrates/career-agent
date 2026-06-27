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
