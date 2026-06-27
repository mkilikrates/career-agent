// Session resume + the outstanding-items summary (R35.1; design §SessionSummary).
//
// On return, the Career_Agent loads and summarises the current state of the
// Memory Store and identifies what is still outstanding so the user can pick up
// exactly where they left off or jump to any phase (R35.1, R35.2). This module
// owns the pure, framework-agnostic core of that:
//
//   1. A `MemoryStoreReader` collaborator — injected into the orchestrator
//      (see `career-agent.ts`) — that knows the canonical Memory Store layout
//      and hydrates it into a `ResumeStoreState` of real domain objects. The
//      orchestrator never parses Markdown itself; it asks the reader. This is
//      the DI boundary the spec calls for (a Storage_Adapter / Memory Store
//      reader), and it keeps provider access routed ONLY through the Egress
//      Gate (the reader touches no provider, the orchestrator's egress
//      invariant from task 17.1 is untouched).
//
//   2. `computeOutstanding(state)` — the trust-critical computation (design
//      Property 16): for ANY Memory Store state, the outstanding list equals
//      EXACTLY the union of
//        * unanswered questions       (interview questions not yet completed or
//                                       passed — includes in-progress and
//                                       Soft-Closed/flagged answers, R24.4, R25.2),
//        * flagged talking points     (confirmed `STAR-NN` points carrying a
//                                       missing-element flag, R25.1, R28.4),
//        * unreviewed skill entries   (skill-map entries the user has not yet
//                                       reviewed/confirmed),
//        * unresolved conflicts       (conflict records with no recorded
//                                       resolution, R9.2, R9.4)
//      present in the store. It is pure and deterministic.
//
//   3. `summariseSession(state)` — runs the resume-time state-healing pass
//      (R36) over the store and assembles the full `SessionSummary` (phase
//      statuses + outstanding union + healing report).
//
// Everything here is pure: no I/O, no providers, no XState. The orchestrator
// drives it.
//
// Requirements: 35.1.

import type {
  ConflictRecord,
  HealingReport,
  RoleSlug,
  SkillMapEntry,
  StarFlag,
} from '@core/types';
import { heal, type StoreFile } from '@core/healing';
import {
  flaggedResponses,
  resumeState,
  type InterviewFile,
  type OutstandingReason,
} from '@core/interview';
import { INITIAL_PHASE, PHASE_SEQUENCE, type Phase } from './phases';

const asString = (v: unknown): string => v as unknown as string;

/**
 * Coarse per-phase status surfaced in the resume summary (design SessionSummary
 * `phaseStates`). It is a summary signal for the UI, not a gate: no phase is
 * blocked on another (design §Phase Pipeline), and the phase hub can still jump
 * anywhere (R35.2).
 *   - `pending`     — the phase has produced no artefacts yet;
 *   - `in-progress` — the phase has artefacts but still has outstanding items;
 *   - `complete`    — the phase has artefacts and nothing outstanding.
 */
export type PhaseStatus = 'pending' | 'in-progress' | 'complete';

/** The kind of outstanding item, one per clause of the R35.1 union. */
export type OutstandingKind =
  | 'unanswered-question'
  | 'flagged-talking-point'
  | 'unreviewed-skill'
  | 'unresolved-conflict';

/**
 * A single item still needing the user's attention on resume (R35.1). The
 * union of these over a store is what {@link computeOutstanding} returns.
 */
export interface OutstandingItem {
  /** Which clause of the R35.1 union this item belongs to. */
  readonly kind: OutstandingKind;
  /**
   * A stable reference identifying the item within the store: the `Q-NN`
   * question id, the `STAR-NN` talking-point id, the `SKILL-…` entry id, or the
   * conflicting field name. Lets the UI navigate straight to it.
   */
  readonly ref: string;
  /** Human-readable one-line summary for surfacing in the resume screen. */
  readonly detail: string;
  /** The owning role's interview file slug, for interview-derived items. */
  readonly roleSlug?: RoleSlug;
  /** Why an interview question is outstanding (R25.2): unanswered/in-progress/flagged. */
  readonly reason?: OutstandingReason;
  /** Missing-element flags carried by a question/talking point (R25.1). */
  readonly flags?: readonly StarFlag[];
}

/**
 * The hydrated Memory Store state a {@link MemoryStoreReader} returns for resume
 * (R35.1). It carries real domain objects — never raw Markdown — so the
 * outstanding computation works on actual types, not guesses.
 */
export interface ResumeStoreState {
  /**
   * Every Markdown file in the store, paired with its canonical path. Used by
   * the resume-time state-healing pass to collect id declarations (R36.1).
   */
  readonly storeFiles: readonly StoreFile[];
  /** All skill-map entries currently in the store (R14). */
  readonly skills: readonly SkillMapEntry[];
  /**
   * The ids of skill entries the user has already reviewed/confirmed. A skill
   * entry whose id is absent from this set is treated as UNREVIEWED and surfaces
   * as an outstanding item (R35.1). Omitted ⇒ no entry has been reviewed yet.
   */
  readonly reviewedSkillIds?: ReadonlySet<string>;
  /** Every per-role interview file in the store (R22.3). */
  readonly interviews: readonly InterviewFile[];
  /** Conflict records detected during ingestion (R9.2); some may be unresolved. */
  readonly conflicts: readonly ConflictRecord[];
  /**
   * Optional explicit per-phase statuses the reader determined from the store
   * layout. Merged over the derived defaults; lets a reader that knows more than
   * the hydrated collections (e.g. which outputs exist) refine the summary.
   */
  readonly phaseStates?: Partial<Record<Phase, PhaseStatus>>;
  /**
   * The phase the user was last in, for continue-from-last (R35.1). When absent
   * it is derived as the furthest phase that has any artefacts.
   */
  readonly lastPhase?: Phase;
}

/**
 * Reads and hydrates the Memory Store for resume (R35.1). Injected into the
 * orchestrator so it never parses the store itself and never reaches a provider
 * — keeping the Egress-Gate-only invariant from task 17.1 intact. `load` may be
 * sync or async.
 */
export interface MemoryStoreReader {
  load(): ResumeStoreState | Promise<ResumeStoreState>;
}

/**
 * The full resume summary returned to the UI (design §SessionSummary, R35.1):
 * a coarse status per phase, the union of everything outstanding, the resume
 * point for continue-from-last, and the state-healing report (R36).
 */
export interface SessionSummary {
  /** Coarse status of each of the six pipeline phases. */
  readonly phaseStates: Record<Phase, PhaseStatus>;
  /** The union of all outstanding items in the store (R35.1). */
  readonly outstanding: readonly OutstandingItem[];
  /** The phase to continue from (continue-from-last, R35.1). */
  readonly resumePhase: Phase;
  /** The resume-time reference-integrity report (R36). */
  readonly healingReport: HealingReport;
}

/** A talking point is "flagged" when it carries a missing-element flag and is live (R25.1). */
const isFlaggedTalkingPoint = (flags: readonly StarFlag[], retired: boolean | undefined): boolean =>
  flags.length > 0 && retired !== true;

/**
 * Compute the outstanding-items union for a Memory Store state (R35.1, design
 * Property 16). Deterministic and pure: items are emitted in a stable order —
 * unanswered questions (per interview file, in question order), then flagged
 * talking points (per interview file, in document order), then unreviewed skill
 * entries (in store order), then unresolved conflicts (in store order). The
 * result equals EXACTLY the union of those four sets and nothing else.
 */
export const computeOutstanding = (state: ResumeStoreState): OutstandingItem[] => {
  const items: OutstandingItem[] = [];

  // 1. Unanswered questions — every question not yet completed or passed. This
  //    reuses the interview module's resume reconstruction, which classifies a
  //    question as unanswered, in-progress, or flagged (Soft-Closed) and so
  //    captures the "a Soft-Closed answer reappears in the outstanding set"
  //    guarantee (R24.4, R25.2, design Property 16).
  for (const file of state.interviews) {
    for (const item of resumeState(file).outstanding) {
      items.push({
        kind: 'unanswered-question',
        ref: asString(item.questionId),
        detail: `Interview "${file.roleTitle || asString(file.roleSlug)}": question ${asString(
          item.questionId,
        )} is ${item.reason}.`,
        roleSlug: file.roleSlug,
        reason: item.reason,
        flags: item.flags,
      });
    }
  }

  // 2. Flagged talking points — confirmed STAR-NN points carrying a missing-
  //    element flag, surfaced so the flag resurfaces on resume (R25.1, R28.4).
  for (const file of state.interviews) {
    for (const tp of file.talkingPoints ?? []) {
      if (isFlaggedTalkingPoint(tp.flags, tp.retired)) {
        items.push({
          kind: 'flagged-talking-point',
          ref: asString(tp.id),
          detail: `Talking point ${asString(tp.id)} is flagged: ${tp.flags.join(', ')}.`,
          roleSlug: file.roleSlug,
          flags: tp.flags,
        });
      }
    }
  }

  // 3. Unreviewed skill entries — entries the user has not yet reviewed (R35.1).
  const reviewed = state.reviewedSkillIds ?? new Set<string>();
  for (const skill of state.skills) {
    if (!reviewed.has(asString(skill.id))) {
      items.push({
        kind: 'unreviewed-skill',
        ref: asString(skill.id),
        detail: `Skill "${skill.name}" (${asString(skill.id)}) has not been reviewed.`,
      });
    }
  }

  // 4. Unresolved conflicts — conflict records with no recorded resolution
  //    (R9.2, R9.4).
  for (const conflict of state.conflicts) {
    if (conflict.resolved === undefined) {
      items.push({
        kind: 'unresolved-conflict',
        ref: conflict.field,
        detail: `Unresolved conflict on field "${conflict.field}" (${conflict.candidates.length} candidate(s)).`,
      });
    }
  }

  return items;
};

/** True when the named interview file still has any outstanding question or flagged point. */
const interviewHasOutstanding = (file: InterviewFile): boolean =>
  resumeState(file).outstanding.length > 0 ||
  (file.talkingPoints ?? []).some((tp) => isFlaggedTalkingPoint(tp.flags, tp.retired)) ||
  flaggedResponses(file).length > 0;

/**
 * Derive a coarse default status for each phase from the hydrated collections.
 * A phase with no artefacts is `pending`; one with artefacts but outstanding
 * work is `in-progress`; one with artefacts and nothing outstanding is
 * `complete`. The reader may override any of these via `state.phaseStates`.
 */
const deriveDefaultPhaseStates = (state: ResumeStoreState): Record<Phase, PhaseStatus> => {
  const hasUnresolvedConflicts = state.conflicts.some((c) => c.resolved === undefined);
  const hasExtractions =
    state.conflicts.length > 0 ||
    state.skills.length > 0 ||
    state.storeFiles.some((f) => f.path.includes('raw_extractions'));
  const reviewed = state.reviewedSkillIds ?? new Set<string>();
  const allSkillsReviewed =
    state.skills.length > 0 && state.skills.every((s) => reviewed.has(asString(s.id)));
  const anyInterviewOutstanding = state.interviews.some(interviewHasOutstanding);

  return {
    ingest: hasExtractions ? (hasUnresolvedConflicts ? 'in-progress' : 'complete') : 'pending',
    'skill-map':
      state.skills.length === 0 ? 'pending' : allSkillsReviewed ? 'complete' : 'in-progress',
    'role-discovery': 'pending',
    'interview-coaching':
      state.interviews.length === 0
        ? 'pending'
        : anyInterviewOutstanding
          ? 'in-progress'
          : 'complete',
    output: 'pending',
    memory: 'pending',
  };
};

/** Compose the per-phase statuses: derived defaults overlaid with the reader's overrides. */
const composePhaseStates = (state: ResumeStoreState): Record<Phase, PhaseStatus> => {
  const derived = deriveDefaultPhaseStates(state);
  if (!state.phaseStates) return derived;
  for (const phase of PHASE_SEQUENCE) {
    const override = state.phaseStates[phase];
    if (override !== undefined) derived[phase] = override;
  }
  return derived;
};

/**
 * The phase to continue from (continue-from-last, R35.1): the reader's
 * explicit `lastPhase` when given, else the furthest phase in canonical order
 * that is not `pending`, else the initial phase for a brand-new store.
 */
export const resumePhaseOf = (
  state: ResumeStoreState,
  phaseStates: Record<Phase, PhaseStatus>,
): Phase => {
  if (state.lastPhase !== undefined) return state.lastPhase;
  let furthest: Phase | undefined;
  for (const phase of PHASE_SEQUENCE) {
    if (phaseStates[phase] !== 'pending') furthest = phase;
  }
  return furthest ?? INITIAL_PHASE;
};

/**
 * Assemble the full {@link SessionSummary} for a resume (R35.1): run the
 * resume-time state-healing pass over the store (R36), compute the outstanding
 * union (Property 16), derive the per-phase statuses, and pick the
 * continue-from-last phase. Pure and deterministic.
 */
export const summariseSession = (state: ResumeStoreState): SessionSummary => {
  const phaseStates = composePhaseStates(state);
  return {
    phaseStates,
    outstanding: computeOutstanding(state),
    resumePhase: resumePhaseOf(state, phaseStates),
    healingReport: heal(state.storeFiles, state.skills),
  };
};
