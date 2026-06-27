// The guided STAR text loop, Soft-Close, and progress (R24, R25).
//
// Once questions are generated (see `./questions`), the Interview_Coach walks
// the user through each question's Situation/Task/Action/Result elements (R24.1)
// and asks a targeted OPEN follow-up whenever an element is missing or vague
// (R24.2). The follow-ups are drawn from a fixed bank of open prompts and the
// coach is *structurally* prevented from proposing facts or outcomes for the
// user to claim: it can only ever return a prompt from {@link OPEN_FOLLOW_UPS},
// never free-form text built from the user's answer (the content firewall,
// R24.3). The per-question loop has exactly three exits — a complete STAR
// answer, the user invoking Soft-Close, or the user explicitly passing — and no
// other (R24.4):
//
//   * {@link collectText} records the next element and either asks the next open
//     follow-up or reports the answer complete (R24.1, R24.2, R24.4).
//   * {@link softClose} accepts the partial answer, attaches the missing
//     element's flag, and surfaces a recommendation for finding/phrasing the
//     element later rather than requiring it now (R25.1, R25.5).
//   * {@link pass} records an explicit skip (R24.4).
//
// {@link progress} exposes the session position ("Q 3 of 8", R25.3). Everything
// here is pure and deterministic: framework-agnostic, no I/O, no providers.

import type {
  Question,
  StarAnswer,
  StarElement,
  StarFlag,
} from '@core/types';
import type { QuestionId } from '@core/types';

// --- STAR element model -----------------------------------------------------

/** The canonical order the coach elicits STAR elements in (R24.1). */
export const STAR_ORDER: readonly StarElement[] = [
  'situation',
  'task',
  'action',
  'result',
];

/** The missing-element flag for each STAR element (R25.1). */
const ELEMENT_FLAG: Readonly<Record<StarElement, StarFlag>> = {
  situation: 'needs_situation',
  task: 'needs_task',
  action: 'needs_action',
  result: 'needs_metric',
};

/** Inverse of {@link ELEMENT_FLAG} — the element a flag identifies. */
const FLAG_ELEMENT: Readonly<Record<StarFlag, StarElement>> = {
  needs_situation: 'situation',
  needs_task: 'task',
  needs_action: 'action',
  needs_metric: 'result',
};

/** The flag that identifies a missing STAR element (R25.1). */
export const elementToFlag = (element: StarElement): StarFlag =>
  ELEMENT_FLAG[element];

/** The STAR element a missing-element flag identifies (R25.1). */
export const flagToElement = (flag: StarFlag): StarElement => FLAG_ELEMENT[flag];

/**
 * Minimum word count for a STAR element to count as adequately answered. An
 * element that is absent, or present but below this threshold, is treated as
 * "missing or vague" and triggers an open follow-up (R24.2).
 */
export const MIN_ELEMENT_WORDS = 4;

const wordCount = (text: string): number => (text.match(/\S+/g) ?? []).length;

/** True when an element value is present and not too vague to accept (R24.2). */
export const isElementPresent = (value: string | undefined): boolean =>
  value !== undefined && wordCount(value) >= MIN_ELEMENT_WORDS;

/**
 * The STAR elements still missing or vague in an answer, in canonical order
 * (R24.1, R24.2). The basis for the next open follow-up and for the resume
 * outstanding set.
 */
export const outstandingElements = (answer: StarAnswer): StarElement[] =>
  STAR_ORDER.filter((element) => !isElementPresent(answer[element]));

// --- The open follow-up bank (content firewall, R24.3) ----------------------

/**
 * The fixed bank of OPEN follow-up prompts, one list per STAR element (R24.2,
 * R24.3). Every prompt is a genuinely open question and none suggests a
 * specific fact or outcome for the user to claim. Because follow-ups can only
 * be drawn from this fixed bank, the coach is structurally unable to feed the
 * user answers — the content firewall is a property of the data, not of a
 * runtime check.
 */
export const OPEN_FOLLOW_UPS: Readonly<Record<StarElement, readonly string[]>> = {
  situation: [
    'Can you set the scene for me — where were you and what was going on at the time?',
    'What was the broader context or challenge you were facing?',
  ],
  task: [
    'What were you specifically responsible for in that situation?',
    'What goal or problem was yours to own here?',
  ],
  action: [
    'What did you personally do next?',
    'Can you walk me through the steps you took yourself?',
  ],
  result: [
    'How did it turn out, and how did you know?',
    'What changed as a result of what you did?',
  ],
};

/**
 * An open follow-up prompt for a missing element (R24.2, R24.3). Deterministic:
 * `attempt` selects a phrasing from the element's fixed bank (wrapping), so
 * re-asking the same element can vary wording without ever leaving the bank.
 */
export const openFollowUp = (element: StarElement, attempt = 0): string => {
  const bank = OPEN_FOLLOW_UPS[element];
  return bank[((attempt % bank.length) + bank.length) % bank.length];
};

// --- Recommendations for later (R25.5) --------------------------------------

/**
 * The fixed bank of "find or phrase it later" recommendations, one per STAR
 * element (R25.5). Like the follow-up bank these never propose a fact — they
 * only suggest where the user might honestly recover or phrase the element
 * later, so Soft-Close never requires the element immediately.
 */
export const LATER_RECOMMENDATIONS: Readonly<Record<StarElement, string>> = {
  situation:
    'Jot down the project, team, or timeframe this happened in later — your ' +
    'calendar, old emails, or commit history can help you place the moment.',
  task:
    'Before the interview, revisit what you were specifically asked or ' +
    'accountable for — a role description or a manager brief can help you ' +
    'phrase the task in your own words.',
  action:
    'Take a moment later to list the concrete steps you personally took — ' +
    'project notes, tickets, or pull requests can jog your memory.',
  result:
    'Look for a number that captures the outcome later — performance reviews, ' +
    'dashboards, or analytics often hold a metric you can phrase honestly.',
};

/** The recommendation for finding/phrasing a missing element later (R25.5). */
export const recommendationFor = (element: StarElement): string =>
  LATER_RECOMMENDATIONS[element];

// --- Loop operations --------------------------------------------------------

/** The result of one {@link collectText} turn in the per-question loop (R24). */
export interface CoachTurn {
  /** The answer with the latest element folded in. */
  answer: StarAnswer;
  /**
   * `complete` once every STAR element is captured (a loop exit, R24.4);
   * `incomplete` while elements are still missing or vague.
   */
  status: 'incomplete' | 'complete';
  /** The STAR elements still missing or vague, in canonical order (R24.2). */
  outstanding: StarElement[];
  /** The element the follow-up targets next; absent once complete. */
  next?: StarElement;
  /** The open follow-up prompt for {@link next}; absent once complete (R24.3). */
  followUp?: string;
}

/** A Soft-Closed answer plus its missing-element flag and later-recommendation. */
export interface FlaggedPoint {
  /** The accepted partial answer, now carrying the missing-element flag. */
  answer: StarAnswer;
  /** The element the user could not (or chose not to) provide (R25.1). */
  element: StarElement;
  /** The explicit flag identifying the missing element (R25.1). */
  flag: StarFlag;
  /** How the user could find or phrase the element later (R25.5). */
  recommendation: string;
}

/** A fresh, empty in-progress answer for a question (R24). */
export const newAnswer = (questionId: QuestionId): StarAnswer => ({
  questionId,
  flags: [],
  status: 'in_progress',
});

/** Append a flag without duplicating one already present. */
const addFlag = (flags: readonly StarFlag[], flag: StarFlag): StarFlag[] =>
  flags.includes(flag) ? [...flags] : [...flags, flag];

/**
 * Record the user's text for the next outstanding STAR element and advance the
 * per-question loop one turn (R24.1, R24.2). The element is the first one still
 * missing or vague (or an explicit `element` override). The returned
 * {@link CoachTurn} either reports the answer `complete` — every element
 * captured, a loop exit (R24.4) — or asks the next OPEN follow-up drawn from
 * the fixed bank (R24.3). Pure: it never mutates `answer` and never proposes a
 * fact or outcome.
 */
export const collectText = (
  answer: StarAnswer,
  text: string,
  element?: StarElement,
): CoachTurn => {
  const target = element ?? outstandingElements(answer)[0];

  // Nothing left to collect — the answer is already complete.
  if (target === undefined) {
    return { answer: { ...answer, status: 'complete' }, status: 'complete', outstanding: [] };
  }

  const updated: StarAnswer = { ...answer, [target]: text };
  const outstanding = outstandingElements(updated);

  if (outstanding.length === 0) {
    return {
      answer: { ...updated, status: 'complete' },
      status: 'complete',
      outstanding,
    };
  }

  const next = outstanding[0];
  return {
    answer: { ...updated, status: 'in_progress' },
    status: 'incomplete',
    outstanding,
    next,
    followUp: openFollowUp(next),
  };
};

/**
 * Soft-Close the current question: accept the partial answer, attach an
 * explicit flag for the `missing` element, mark the answer Soft-Closed (a loop
 * exit, R24.4), and move on (R25.1). Rather than requiring the element now, it
 * returns a recommendation for finding or phrasing it later (R25.5). Pure: it
 * never mutates `answer`.
 */
export const softClose = (
  answer: StarAnswer,
  missing: StarElement,
): FlaggedPoint => {
  const flag = elementToFlag(missing);
  return {
    answer: { ...answer, flags: addFlag(answer.flags, flag), status: 'soft_closed' },
    element: missing,
    flag,
    recommendation: recommendationFor(missing),
  };
};

/**
 * Explicitly pass on a question: a loop exit that records the skip without
 * capturing or flagging any element (R24.4). Pure: it never mutates `answer`.
 */
export const pass = (answer: StarAnswer): StarAnswer => ({
  ...answer,
  status: 'passed',
});

// --- Progress (R25.3) -------------------------------------------------------

/** Session progress, e.g. "Q 3 of 8" (R25.3). */
export interface ProgressIndicator {
  /** 1-based position of the current question. */
  current: number;
  /** Total number of questions in the session. */
  total: number;
  /** Human-readable label, e.g. `"Q 3 of 8"`. */
  label: string;
}

/**
 * The progress indicator for a session positioned at `cursor` (0-based) over
 * `questions` (R25.3). The current position is reported 1-based and clamped
 * into `[1, total]` for display; an empty session reports `Q 0 of 0`.
 */
export const progress = (
  questions: readonly Question[],
  cursor: number,
): ProgressIndicator => {
  const total = questions.length;
  const current = total === 0 ? 0 : Math.min(Math.max(cursor + 1, 1), total);
  return { current, total, label: `Q ${current} of ${total}` };
};
