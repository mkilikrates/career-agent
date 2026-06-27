// Phase-wizard controller (@ui) — task 19.1.
//
// The thin, framework-agnostic glue between the React phase wizard / review
// screens and the XState orchestrator (`@core/orchestrator`). It dispatches the
// orchestrator's navigation events (the PHASE HUB jump, R35.2, and linear
// `advance`), reads the active phase straight from the orchestrator's snapshot,
// projects the resume `SessionSummary` into a per-phase view the UI renders, and
// — critically — PERSISTS after every confirmed step (R35.2 "resumable
// six-phase pipeline"; design "Markdown is the database").
//
// It is deliberately React-free so the wiring can be unit-tested under the
// project's node test environment: the React component (`PhaseWizard.tsx`)
// subscribes to it and re-renders, but holds no orchestration logic itself.
//
// Boundary note: this controller talks ONLY to the orchestrator and a Memory
// Store projection. It never imports a provider client, and it never reaches a
// provider — provider access exists solely inside the orchestrator, routed
// through the single Egress Gate (Requirements 6, 7). Persistence writes go to
// the canonical in-memory `MemoryTree` (the hydrated projection of the Markdown
// store), matching how the rest of the shell persists (locale, consent).
//
// Requirements: 1.1, 35.1, 35.2.

import {
  PHASE_SEQUENCE,
  PHASE_LABELS,
  type CareerAgent,
  type Phase,
  type SessionSummary,
  type PhaseStatus,
  type OutstandingItem,
} from '@core/orchestrator';
import type { StoreFile } from '@core/healing';
import type { MemoryStoreReader, ResumeStoreState } from '@core/orchestrator';
import { MemoryTree } from '@core/storage';
import { asMemoryPath } from '@core/types';

/**
 * Canonical Memory Store file that records the phase the user is currently in,
 * so a returning session can continue from the last point (R35.1). It lives in
 * the `config/` directory of the canonical layout and carries a single
 * `phase: <slug>` line — human-readable, like the rest of the store.
 */
export const SESSION_STATE_PATH = asMemoryPath('config/session_state.md');

const SESSION_STATE_HEADING = '# Session State';

/** Serialise the current-phase pointer to the canonical `session_state.md` form. */
export const renderSessionState = (phase: Phase): string =>
  `${SESSION_STATE_HEADING}\n\nphase: ${phase}\n`;

/** Parse the current-phase pointer from `session_state.md`, if present/valid. */
export const parseSessionState = (markdown: string): Phase | undefined => {
  const match = markdown.match(/^phase:\s*([a-z-]+)\s*$/m);
  const value = match?.[1];
  return value && (PHASE_SEQUENCE as readonly string[]).includes(value)
    ? (value as Phase)
    : undefined;
};

/**
 * The persistence sink the controller calls after a confirmed step (R35.2). It
 * is injected so the controller stays storage-agnostic; the default
 * implementation writes to a {@link MemoryTree}.
 */
export interface PhasePersistence {
  /**
   * Persist that the pipeline is now at `phase`. `confirmed` is true for an
   * explicit "confirm and continue" step (which also records a session-log
   * confirmation, R34.3) and false for a plain hub navigation.
   */
  persistPhase(phase: Phase, options: { readonly confirmed: boolean }): void | Promise<void>;
}

/**
 * Build a {@link PhasePersistence} backed by the canonical in-memory
 * {@link MemoryTree}. A confirmed step writes the phase pointer AND appends a
 * user-confirmation entry to `log/session_log.md` (R34.3); a plain navigation
 * only updates the pointer so the resume point always reflects where the user
 * is (R35.1).
 */
export const createMemoryTreePersistence = (store: MemoryTree): PhasePersistence => ({
  persistPhase(phase, { confirmed }) {
    store.write(SESSION_STATE_PATH, renderSessionState(phase));
    if (confirmed) {
      store.logConfirmation(`Confirmed phase "${PHASE_LABELS[phase]}" (${phase}).`);
    }
  },
});

/**
 * A reader that hydrates the minimal resume state from a {@link MemoryTree}: the
 * text store files (so the resume-time state-healing pass runs over the real
 * store, R36) and the persisted current-phase pointer (continue-from-last,
 * R35.1). It touches no provider, preserving the Egress-Gate-only invariant.
 *
 * Domain collections (skills, interviews, conflicts) are surfaced by their own
 * engines/tasks; this reader returns them empty so the wizard can drive
 * navigation and resume without re-implementing per-phase hydration here.
 */
export const createMemoryTreeResumeReader = (store: MemoryTree): MemoryStoreReader => ({
  load(): ResumeStoreState {
    const storeFiles: StoreFile[] = [];
    for (const path of store.paths()) {
      const content = store.read(path);
      if (typeof content === 'string') {
        storeFiles.push({ path, markdown: content });
      }
    }
    const lastPhase = store.has(SESSION_STATE_PATH)
      ? parseSessionState(store.readText(SESSION_STATE_PATH))
      : undefined;
    return {
      storeFiles,
      skills: [],
      interviews: [],
      conflicts: [],
      ...(lastPhase ? { lastPhase } : {}),
    };
  },
});

/** A single phase as projected for the wizard nav / review screen. */
export interface PhaseView {
  readonly phase: Phase;
  /** Zero-based position in the canonical pipeline order. */
  readonly index: number;
  /** Coarse status from the resume summary (defaults when no summary yet). */
  readonly status: PhaseStatus;
  /** Whether this is the orchestrator's active phase. */
  readonly current: boolean;
}

/** Options for {@link PhaseWizardController}. */
export interface PhaseWizardControllerOptions {
  /** The orchestrator the wizard drives (phase hub + linear advance). */
  readonly agent: CareerAgent;
  /** Where confirmed steps are persisted (R35.2). */
  readonly persistence: PhasePersistence;
}

/**
 * Coordinates the phase wizard with the orchestrator. Subscribers (the React
 * shell) are notified on every phase change and after each persisted step, and
 * read the current phase, the per-phase views, and the outstanding-items list
 * from here.
 */
export class PhaseWizardController {
  private readonly agent: CareerAgent;
  private readonly persistence: PhasePersistence;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeAgent: () => void;
  private currentSummary: SessionSummary | null = null;

  constructor(options: PhaseWizardControllerOptions) {
    this.agent = options.agent;
    this.persistence = options.persistence;
    // Re-render the shell whenever the orchestrator's phase changes.
    this.unsubscribeAgent = this.agent.onPhaseChange(() => this.emit());
  }

  /**
   * Load the resume summary and continue from the user's last phase (R35.1).
   * Returns the summary so the caller can surface outstanding items immediately.
   */
  async resume(): Promise<SessionSummary> {
    this.currentSummary = await this.agent.resumeSession();
    this.emit();
    return this.currentSummary;
  }

  /** The orchestrator's active phase (read straight from its snapshot). */
  currentPhase(): Phase {
    return this.agent.currentPhase();
  }

  /** The most recent resume summary, or `null` before {@link resume}. */
  summary(): SessionSummary | null {
    return this.currentSummary;
  }

  /** The outstanding-items union from the last summary (R35.1). */
  outstanding(): readonly OutstandingItem[] {
    return this.currentSummary?.outstanding ?? [];
  }

  /** Whether the pipeline is on its final phase (no further `advance`). */
  isFinalPhase(): boolean {
    return this.currentPhase() === PHASE_SEQUENCE[PHASE_SEQUENCE.length - 1];
  }

  /**
   * Project every phase into a {@link PhaseView} for the nav / review screen.
   *
   * Progress is derived from the pipeline position so it always reflects where
   * the user actually is: the current phase is `in-progress`, every phase before
   * it is `complete`, and later phases fall back to the resume summary's status
   * (or `pending`). This deliberately takes precedence over a stale resume
   * summary for the current/earlier phases — otherwise the summary computed once
   * at resume (e.g. all-`pending` for a fresh store) would keep showing "not
   * started" even after the user confirms and advances.
   */
  phases(): PhaseView[] {
    const current = this.currentPhase();
    const currentIndex = PHASE_SEQUENCE.indexOf(current);
    const states = this.currentSummary?.phaseStates;
    return PHASE_SEQUENCE.map((phase, index) => {
      let status: PhaseStatus;
      if (phase === current) {
        status = 'in-progress';
      } else if (index < currentIndex) {
        status = 'complete';
      } else {
        status = states?.[phase] ?? 'pending';
      }
      return { phase, index, status, current: phase === current };
    });
  }

  /**
   * Phase hub (R35.2): jump directly to any phase. The resume pointer is
   * persisted (unconfirmed) so a return continues from here, but no confirmation
   * is recorded — confirming a phase's work is {@link confirmStep}.
   */
  async goToPhase(phase: Phase): Promise<void> {
    if (phase === this.currentPhase()) {
      return;
    }
    await this.agent.jumpToPhase(phase);
    await this.persistence.persistPhase(phase, { confirmed: false });
    this.emit();
  }

  /**
   * Confirm the current phase's work and advance to the next phase (R35.2). The
   * confirmed step is PERSISTED before advancing (design "persist after every
   * confirmed step"): the phase pointer is updated and a confirmation is logged.
   * On the final phase the confirmation is still persisted; `advance` is a no-op.
   * Returns the phase the pipeline is in after the step.
   */
  async confirmStep(): Promise<Phase> {
    const confirmed = this.currentPhase();
    await this.persistence.persistPhase(confirmed, { confirmed: true });
    await this.agent.advance();
    const next = this.currentPhase();
    if (next !== confirmed) {
      // Record the resume pointer at the phase we advanced into.
      await this.persistence.persistPhase(next, { confirmed: false });
    }
    this.emit();
    return next;
  }

  /** Subscribe to phase / state changes; returns an unsubscribe handle. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Tear down the orchestrator subscription and drop listeners. */
  dispose(): void {
    this.unsubscribeAgent();
    this.listeners.clear();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
