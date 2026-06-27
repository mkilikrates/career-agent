// The adaptive STAR coaching loop controller (R63.1, R63.3, R63.4, R63.5).
//
// Once a question is selected (AI-generated, script-generated, or user-authored,
// R63.1) this controller drives one question's coaching loop:
//
//   question → answer (typed text OR recorded/uploaded audio transcribed through
//   the EXISTING gated Whisper/STT path) → adequacy assessment (task 31.2's
//   stateless, gate-routed {@link assessAdequacy}) → follow-up → …
//
// The chat model is STATELESS across turns, so the controller owns ALL the loop
// state the model cannot: the accumulated answers (`answersSoFar`), the AI
// follow-up COUNT, and the termination decision. Every assessment call carries
// the full context (role, competency, original question, every answer so far)
// through the injected {@link AssistTransport} — the ONLY path to a provider,
// which itself routes through the single Egress Gate. This module imports NO
// provider client and performs NO transcription of its own: an audio answer is
// transcribed by the existing {@link uploadAudio}/{@link transcribeRecording}
// path and surfaced as a {@link ConfirmedTranscript}, whose confirmed text is
// fed in via {@link StarCoachingLoop.submitTranscript} — the loop never invents
// a new STT path.
//
// The loop is capped at three AI follow-ups per question (R63.3). On reaching the
// cap, if the model STILL has a follow-up, the controller offers a "dig deeper"
// opt-in and continues ONLY when the user opts in (R63.4). The user may STOP at
// any round (R63.5). A loop ends for exactly one {@link CoachingLoopReason}:
// the answer is sufficient (`enough`), the model offered no follow-up
// (`no-follow-up`), the cap was reached and dig-deeper declined (`cap-reached`),
// or the user stopped (`user-stop`).
//
// Everything here is a deterministic state machine: the only non-determinism is
// the injected transport, so the controller is fully testable with a fake
// transport returning the strict adequacy reply format.

import type { RolePreference } from '@core/types';
import type { AssistTransport, EgressDestination } from '@core/assist';
import {
  assessAdequacy,
  type AdequacyAssessment,
  type AdequacyInput,
} from './coach-assist';
import type { ConfirmedTranscript } from './audio';

/**
 * The maximum number of AI follow-ups presented per question before the loop
 * reaches the cap and a "dig deeper" opt-in is required to continue (R63.3).
 */
export const MAX_AI_FOLLOW_UPS = 3;

/**
 * Why a question's coaching loop ended — exactly one of four exits (R63.3–R63.5):
 *   - `enough`       — the model reported the answer is sufficient (ENOUGH=yes, R63.3);
 *   - `no-follow-up` — not sufficient, but the model offered no follow-up (FOLLOWUP=none);
 *   - `cap-reached`  — the three-follow-up cap was hit and dig-deeper was declined (R63.4);
 *   - `user-stop`    — the user stopped the loop at some round (R63.5).
 */
export type CoachingLoopReason =
  | 'enough'
  | 'no-follow-up'
  | 'cap-reached'
  | 'user-stop';

/**
 * The next action the UI should take. A discriminated union so the UI branches
 * exhaustively: collect an answer, ask the user whether to dig deeper past the
 * cap, or render the finished loop.
 */
export type CoachingLoopAction =
  | CoachingAwaitAnswer
  | CoachingAwaitDigDeeper
  | CoachingFinished;

/**
 * The loop is waiting for the user to provide an answer (R63.1). `followUp` is
 * the AI follow-up prompt to present, or `null` for the FIRST answer to the
 * original selected question. The answer may be typed or a confirmed audio
 * transcript (the existing gated STT path).
 */
export interface CoachingAwaitAnswer {
  readonly kind: 'await-answer';
  /** The AI follow-up to present, or `null` for the initial answer (R63.1, R63.3). */
  readonly followUp: string | null;
  /** How many AI follow-ups have been presented so far (0 before the first). */
  readonly followUpCount: number;
}

/**
 * The cap was reached and the model still has a follow-up, so the user is asked
 * whether to continue digging deeper beyond the cap or to stop (R63.4). The loop
 * continues ONLY if the user opts in via {@link StarCoachingLoop.digDeeper}; it
 * ends (`cap-reached`) on {@link StarCoachingLoop.declineDigDeeper} or
 * {@link StarCoachingLoop.stop}.
 */
export interface CoachingAwaitDigDeeper {
  readonly kind: 'await-dig-deeper';
  /** The further follow-up offered beyond the cap, presented only on opt-in (R63.4). */
  readonly followUp: string;
  /** AI follow-ups presented so far (== the cap when this offer is made). */
  readonly followUpCount: number;
}

/** The loop has ended for one {@link CoachingLoopReason} (R63.3–R63.5). */
export interface CoachingFinished {
  readonly kind: 'finished';
  /** Which of the four exits ended the loop. */
  readonly reason: CoachingLoopReason;
  /** The latest adequacy assessment, or `null` if the loop was stopped before any. */
  readonly assessment: AdequacyAssessment | null;
}

/** The selected question's context the loop is grounded in (R63.1). */
export interface CoachingLoopInit {
  /** The target role the practice answer is grounded in (R63.2). */
  readonly role: RolePreference;
  /** The behaviour/quality the question probes, carried from R62.3. */
  readonly competency: string;
  /** The selected question (AI-generated, script-generated, or user-authored, R63.1). */
  readonly question: string;
}

/** Optional controller knobs (mainly for tests). */
export interface CoachingLoopOptions {
  /** Override the AI follow-up cap; defaults to {@link MAX_AI_FOLLOW_UPS} (R63.3). */
  readonly maxFollowUps?: number;
}

/** An immutable snapshot of the loop's state, safe to hand to the UI. */
export interface CoachingLoopSnapshot {
  /** The target role the loop is grounded in. */
  readonly role: RolePreference;
  /** The competency the question probes (R62.3). */
  readonly competency: string;
  /** The original selected question (R63.1). */
  readonly question: string;
  /** Every answer the user has given for this question so far, in order (R63.2). */
  readonly answersSoFar: readonly string[];
  /** How many AI follow-ups have been presented so far. */
  readonly followUpCount: number;
  /** The next action the UI should take. */
  readonly action: CoachingLoopAction;
  /** The latest adequacy assessment, or `null` before the first answer. */
  readonly lastAssessment: AdequacyAssessment | null;
}

/** Raised when a controller action is invoked in an invalid state. */
export class CoachingLoopStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoachingLoopStateError';
  }
}

/**
 * The adaptive STAR coaching loop controller for ONE question (R63.1, R63.3–R63.5).
 *
 * Lifecycle: construct with the selected question's context, then alternately
 * read {@link action}/{@link state} and drive the loop:
 *   - {@link submitAnswer} / {@link submitTranscript} records an answer and runs
 *     one gate-routed adequacy assessment, advancing the loop one turn;
 *   - {@link digDeeper} continues past the cap when the model still has a
 *     follow-up (R63.4);
 *   - {@link declineDigDeeper} ends the loop at the cap (R63.4);
 *   - {@link stop} ends the loop at any round (R63.5).
 *
 * The controller is STATELESS-model-aware: it accumulates `answersSoFar`, counts
 * AI follow-ups, and decides termination, since the chat model retains nothing
 * between turns. On a provider failure during assessment the call rejects and
 * the loop's state is LEFT UNCHANGED (the answer is committed only after a
 * successful assessment), so the caller can retry the same answer without losing
 * its place or double-counting.
 */
export class StarCoachingLoop {
  private readonly role: RolePreference;
  private readonly competency: string;
  private readonly question: string;
  private readonly dest: EgressDestination;
  private readonly transport: AssistTransport;
  private readonly cap: number;

  private answers: readonly string[] = [];
  private followUps = 0;
  private lastAssessment: AdequacyAssessment | null = null;
  private currentAction: CoachingLoopAction;

  constructor(
    init: CoachingLoopInit,
    dest: EgressDestination,
    transport: AssistTransport,
    options: CoachingLoopOptions = {},
  ) {
    this.role = init.role;
    this.competency = init.competency;
    this.question = init.question;
    this.dest = dest;
    this.transport = transport;
    this.cap = options.maxFollowUps ?? MAX_AI_FOLLOW_UPS;
    // The loop opens awaiting the first answer to the original question (R63.1).
    this.currentAction = { kind: 'await-answer', followUp: null, followUpCount: 0 };
  }

  /** The next action the UI should take. */
  get action(): CoachingLoopAction {
    return this.currentAction;
  }

  /** Whether the loop has ended (any {@link CoachingLoopReason}). */
  get isFinished(): boolean {
    return this.currentAction.kind === 'finished';
  }

  /** An immutable snapshot of the loop's full state. */
  get state(): CoachingLoopSnapshot {
    return {
      role: this.role,
      competency: this.competency,
      question: this.question,
      answersSoFar: [...this.answers],
      followUpCount: this.followUps,
      action: this.currentAction,
      lastAssessment: this.lastAssessment,
    };
  }

  /**
   * Record the user's typed answer and run ONE gate-routed adequacy assessment
   * over every answer so far (R63.2), then advance the loop (R63.3, R63.4). The
   * answer is committed to `answersSoFar` only AFTER a successful assessment, so
   * a provider failure rejects without mutating the loop's state — the caller can
   * retry the same answer (failure preserves coaching state).
   */
  async submitAnswer(text: string): Promise<CoachingLoopAction> {
    if (this.currentAction.kind !== 'await-answer') {
      throw new CoachingLoopStateError(
        `Cannot submit an answer while the loop is "${this.currentAction.kind}".`,
      );
    }
    const answersSoFar = [...this.answers, text];
    const input: AdequacyInput = {
      role: this.role,
      competency: this.competency,
      question: this.question,
      answersSoFar,
    };
    // The only provider call — via the injected gate-routed transport. If it
    // throws, nothing below runs, so the loop's state is unchanged (retryable).
    const assessment = await assessAdequacy(input, this.dest, this.transport);
    this.answers = answersSoFar;
    this.lastAssessment = assessment;
    return this.advance(assessment);
  }

  /**
   * Submit a CONFIRMED audio transcript as the answer (R63.1). Requiring a
   * {@link ConfirmedTranscript} (not a raw transcript) reuses — and preserves —
   * the existing gated Whisper/STT confirm-before-processing path: the UI
   * uploads/records audio, transcribes it through the Egress Gate, and confirms
   * it BEFORE it reaches the loop. Delegates to {@link submitAnswer}; the loop
   * never transcribes audio itself.
   */
  async submitTranscript(transcript: ConfirmedTranscript): Promise<CoachingLoopAction> {
    return this.submitAnswer(transcript.text);
  }

  /**
   * Opt into digging deeper past the cap (R63.4). Valid only while an
   * `await-dig-deeper` offer is pending; presents the offered follow-up as the
   * next answer prompt and continues the loop beyond the cap.
   */
  digDeeper(): CoachingLoopAction {
    if (this.currentAction.kind !== 'await-dig-deeper') {
      throw new CoachingLoopStateError(
        'Cannot dig deeper: no dig-deeper offer is pending.',
      );
    }
    const followUp = this.currentAction.followUp;
    this.followUps += 1;
    this.currentAction = {
      kind: 'await-answer',
      followUp,
      followUpCount: this.followUps,
    };
    return this.currentAction;
  }

  /**
   * Decline to dig deeper at the cap, ending the loop with `cap-reached` (R63.4).
   * Valid only while an `await-dig-deeper` offer is pending.
   */
  declineDigDeeper(): CoachingLoopAction {
    if (this.currentAction.kind !== 'await-dig-deeper') {
      throw new CoachingLoopStateError(
        'Cannot decline dig-deeper: no dig-deeper offer is pending.',
      );
    }
    return this.finish('cap-reached');
  }

  /**
   * Stop the loop for this question at any round (R63.5). Idempotent: stopping an
   * already-finished loop returns its existing finished action unchanged.
   */
  stop(): CoachingLoopAction {
    if (this.currentAction.kind === 'finished') return this.currentAction;
    return this.finish('user-stop');
  }

  /**
   * Decide the next action from an assessment (R63.3, R63.4):
   *   - sufficient → finish `enough`;
   *   - not sufficient, no follow-up → finish `no-follow-up`;
   *   - not sufficient, follow-up, under the cap → present the next follow-up;
   *   - not sufficient, follow-up, at/over the cap → offer the dig-deeper opt-in.
   */
  private advance(assessment: AdequacyAssessment): CoachingLoopAction {
    if (assessment.enough) return this.finish('enough');
    if (assessment.followUp === null) return this.finish('no-follow-up');

    if (this.followUps >= this.cap) {
      // Cap reached and the model still has a follow-up: offer dig-deeper (R63.4).
      this.currentAction = {
        kind: 'await-dig-deeper',
        followUp: assessment.followUp,
        followUpCount: this.followUps,
      };
      return this.currentAction;
    }

    // Present the next AI follow-up within the cap (R63.3).
    this.followUps += 1;
    this.currentAction = {
      kind: 'await-answer',
      followUp: assessment.followUp,
      followUpCount: this.followUps,
    };
    return this.currentAction;
  }

  /** Transition to the finished state for `reason`, carrying the last assessment. */
  private finish(reason: CoachingLoopReason): CoachingLoopAction {
    this.currentAction = {
      kind: 'finished',
      reason,
      assessment: this.lastAssessment,
    };
    return this.currentAction;
  }
}

/**
 * Construct a {@link StarCoachingLoop} for a selected question, bound to a
 * gate-routed {@link AssistTransport} (the only path to a provider) and an
 * {@link EgressDestination}. The controller imports no provider client and never
 * transcribes audio; audio answers arrive as confirmed transcripts via the
 * existing gated STT path (R63.1).
 */
export function createStarCoachingLoop(
  init: CoachingLoopInit,
  dest: EgressDestination,
  transport: AssistTransport,
  options: CoachingLoopOptions = {},
): StarCoachingLoop {
  return new StarCoachingLoop(init, dest, transport, options);
}
