// Interview coaching data models (R22, R23, R25, R28).

import type { QuestionId, SkillId, SkillTerm, StarId } from './brands';

/**
 * What a generated interview question is grounded in (R22.2):
 *   - `behavioural` — a STAR question per core skill the role requires that the
 *     user's profile already matches (grounded in {@link Question.skill});
 *   - `gap` — a STAR question targeting an identified skill gap (grounded in
 *     {@link Question.gap});
 *   - `motivation` — a professional-motivation question (grounded in neither).
 */
export type QuestionCategory = 'behavioural' | 'gap' | 'motivation';

/**
 * A role-grounded interview question (R22.1, R22.2). Questions are generated
 * deterministically from the skill match between the user's skill map and the
 * target role, so the same role + map always yields the same questions with the
 * same stable per-role ids.
 */
export interface Question {
  /** Stable per-role question id (`Q-NN`), never renumbered within a role. */
  id: QuestionId;
  /** Which of the three grounded categories this question is (R22.2). */
  category: QuestionCategory;
  /**
   * Whether the prompt is framed for a STAR answer (Situation/Task/Action/
   * Result). Behavioural and gap questions are STAR-framed; the professional
   * motivation question is open but not strictly STAR-framed.
   */
  starFramed: boolean;
  /** The open question text presented to the user. */
  prompt: string;
  /** The matched core skill a `behavioural` question is grounded in (R22.1). */
  skill?: SkillId;
  /** The identified gap term a `gap` question targets (R22.2). */
  gap?: SkillTerm;
}

/** Missing STAR-element flags raised during coaching (R25.1). */
export type StarFlag =
  | 'needs_metric'
  | 'needs_action'
  | 'needs_situation'
  | 'needs_task';

/**
 * The four elements of a STAR answer the coach guides the user through (R24.1).
 * The coaching loop elicits them in this canonical order; each maps to exactly
 * one {@link StarFlag} when it is missing (R25.1).
 */
export type StarElement = 'situation' | 'task' | 'action' | 'result';

/**
 * Lifecycle of a per-question answer in a coaching session (R24.4, R25):
 *   - `in_progress` — the per-question loop is still collecting elements;
 *   - `complete` — all four STAR elements were captured (a loop exit, R24.4);
 *   - `soft_closed` — the user accepted a partial answer with a missing-element
 *     flag and moved on (a loop exit, R25.1);
 *   - `passed` — the user explicitly skipped the question (a loop exit, R24.4).
 * Only these three terminal states (or completion) end the loop — no other exit.
 */
export type ResponseStatus = 'in_progress' | 'complete' | 'soft_closed' | 'passed';

/**
 * A captured (or in-progress) answer to one interview {@link Question} (R24,
 * R25). The coach accumulates the four STAR elements as the user provides them,
 * raising {@link flags} for any element the user Soft-Closes on (R25.1). The
 * answer is persisted in the interview file so a paused session resumes at this
 * exact point and any flags resurface (R25.2, R25.4).
 */
export interface StarAnswer {
  /** The question this answer belongs to. */
  questionId: QuestionId;
  /** The Situation element, in the user's own words (R24.1). */
  situation?: string;
  /** The Task element, in the user's own words (R24.1). */
  task?: string;
  /** The Action element, in the user's own words (R24.1). */
  action?: string;
  /** The Result element, in the user's own words (R24.1). */
  result?: string;
  /** Missing-element flags raised by Soft-Close (R25.1). */
  flags: StarFlag[];
  /** Where this answer sits in the per-question loop lifecycle (R24.4). */
  status: ResponseStatus;
}

/**
 * The result of the content/delivery firewall's content analysis of an answer
 * (R27.1, R27.2). It is derived from the STAR answer's *content only*: every
 * delivery signal — verbal tics, hesitations, accent, dialect, non-standard
 * phrasing, and transcription artefacts — has already been stripped/neutralised
 * and is never represented here, so this analysis is identical for two
 * transcripts that differ only in delivery (the structural firewall). It
 * deliberately carries NO delivery/quality metric (no filler counts, pace,
 * disfluency score, etc.): delivery is removed and ignored, never scored.
 */
export interface ContentAnalysis {
  /**
   * The canonical, delivery-stripped content tokens of the whole answer, in
   * STAR order. The basis for anything fed into the skill map (R27.1).
   */
  readonly tokens: readonly string[];
  /** The normalised content text (the {@link tokens} joined by single spaces). */
  readonly content: string;
  /**
   * The normalised, content-only text of each STAR element (R27.1). Absent
   * elements normalise to the empty string. This is what the CV path consumes.
   */
  readonly elements: Readonly<Record<StarElement, string>>;
  /** Count of content words after delivery is removed (a content measure only). */
  readonly contentWordCount: number;
}

/**
 * The delivery-invariant content an answer contributes to the skill map and CV
 * path (R27.1). Produced ONLY through the content/delivery firewall, so two
 * transcripts differing only in delivery produce an identical contribution
 * (design Property 15). It is the single boundary object that downstream
 * skill-map updates (R29) and talking-point refinement (R28) consume, ensuring
 * delivery can never influence either path.
 */
export interface ContentContribution {
  /** The question the contributing answer belongs to. */
  readonly questionId: QuestionId;
  /** Full normalised content feeding the skill map (R27.1). */
  readonly content: string;
  /** Content tokens for downstream skill detection (delivery-invariant). */
  readonly tokens: readonly string[];
  /** Per-STAR-element content feeding the CV / talking-point path (R27.1). */
  readonly elements: Readonly<Record<StarElement, string>>;
}

/**
 * One piece of supporting evidence for a newly-revealed skill candidate (R29.1).
 * It names the confirmed talking point (`STAR-NN`) the skill surfaced in and the
 * delivery-stripped content it was revealed in, so a later confirmation can wire
 * the proof link AND a reviewer can see the user's own answer it came from. The
 * content is firewall-stripped (it is the talking point's polished text), so it
 * is delivery-invariant and never derives from a job title (R27, No-Fabrication).
 */
export interface RevealedSkillEvidence {
  /** The confirmed talking point (`STAR-NN`) the skill was revealed in (R29.1). */
  readonly talkingPoint: StarId;
  /** The delivery-stripped content the skill surfaced in (R27.1, R29.1). */
  readonly content: string;
}

/**
 * A single newly-revealed skill candidate detected at the end of a coaching
 * session (R29.1) — a skill referenced by the user's CONFIRMED talking points
 * that is not yet represented in the skill map. It is a PROPOSAL only: nothing
 * enters the map until the user explicitly confirms it (R29.2). Each candidate
 * carries the evidence (the talking points it surfaced in) so a confirmation can
 * wire the corresponding STAR links (R29.3).
 */
export interface SkillCandidate {
  /** The skill id the confirmed talking points reference but the map lacks. */
  readonly skill: SkillId;
  /** The canonical slug compared against the skill map (R29.1, via `skillSlug`). */
  readonly slug: string;
  /** The talking points (and their content) the skill was revealed in (R29.1). */
  readonly evidence: RevealedSkillEvidence[];
}

/**
 * The set of skills a coaching session revealed that are NOT yet in the skill
 * map (R29.1). It is surfaced UNAPPLIED for explicit user confirmation (R29.2):
 * detection only ever proposes; applying confirmed candidates is a separate,
 * explicit step. An empty `candidates` list means the session revealed nothing
 * new.
 */
export interface SkillDelta {
  /** Newly-revealed skill candidates, surfaced unapplied for confirmation (R29.2). */
  readonly candidates: SkillCandidate[];
}

/** A polished STAR talking point with a stable id (R23, R28). */
export interface TalkingPoint {
  id: StarId; // STAR-NN, never reused/renumbered (R23.2)
  situation?: string;
  task?: string;
  action?: string;
  result?: string;
  flags: StarFlag[]; // R25.1
  polished: string; // first-person past-tense (R28.3)
  skills: SkillId[];
  retired?: boolean; // marked not deleted (R23.3)
}
