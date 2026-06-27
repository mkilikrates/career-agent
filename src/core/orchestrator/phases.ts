// Pipeline phases for the Career_Agent orchestrator (design §Phase Pipeline; R35.2).
//
// The agent runs a resumable six-phase pipeline:
//
//   Ingest → Skill Map → Role Discovery → Interview Coaching → Output → Memory
//
// Each phase reads from and writes to the Memory Store after every confirmed
// step, so the user can stop at any point and resume exactly there, and — via
// the phase hub — jump directly to ANY phase rather than only stepping forward
// (R35.2). This module owns the canonical phase vocabulary and the linear
// ordering the hub steps through; it has no dependency on XState so the phase
// model can be reused by the UI shell and tests without pulling in the
// statechart runtime.

/**
 * The six pipeline phases, in canonical order (design §Phase Pipeline and Data
 * Flow). The string values are stable, URL/file-safe slugs suitable for use as
 * statechart state ids and for surfacing in the UI.
 */
export type Phase =
  | 'ingest' // Phase 1: Ingest (R8–R13)
  | 'skill-map' // Phase 2: Skill Map (R14–R19)
  | 'role-discovery' // Phase 3: Role Discovery (R20–R21)
  | 'interview-coaching' // Phase 4: Interview Coaching (R22–R29)
  | 'output' // Phase 5: Output Generation (R30–R33)
  | 'memory'; // Phase 6: Memory & Maintenance (R34–R36)

/**
 * The phases in canonical pipeline order. `ADVANCE` steps through this sequence;
 * the phase hub may target any entry directly (R35.2). Frozen so the ordering
 * cannot be mutated at runtime.
 */
export const PHASE_SEQUENCE: readonly Phase[] = Object.freeze([
  'ingest',
  'skill-map',
  'role-discovery',
  'interview-coaching',
  'output',
  'memory',
] as const);

/** The phase the pipeline starts in for a brand-new session. */
export const INITIAL_PHASE: Phase = 'ingest';

/** Human-readable labels for each phase, for UI surfacing and diagnostics. */
export const PHASE_LABELS: Readonly<Record<Phase, string>> = Object.freeze({
  ingest: 'Ingest',
  'skill-map': 'Skill Map',
  'role-discovery': 'Role Discovery',
  'interview-coaching': 'Interview Coaching',
  output: 'Output Generation',
  memory: 'Memory & Maintenance',
});

/** Type guard: is `value` one of the six canonical phases? */
export function isPhase(value: unknown): value is Phase {
  return typeof value === 'string' && (PHASE_SEQUENCE as readonly string[]).includes(value);
}

/** The zero-based position of `phase` in the canonical sequence. */
export function phaseIndex(phase: Phase): number {
  return PHASE_SEQUENCE.indexOf(phase);
}

/**
 * The phase that linearly follows `phase`, or `null` if `phase` is the last one
 * (`memory`). Used by the orchestrator to resolve an `ADVANCE` step without
 * hard-coding the order in the statechart.
 */
export function nextPhase(phase: Phase): Phase | null {
  const idx = phaseIndex(phase);
  return idx >= 0 && idx < PHASE_SEQUENCE.length - 1 ? PHASE_SEQUENCE[idx + 1] : null;
}

/**
 * The phase that linearly precedes `phase`, or `null` if `phase` is the first
 * one (`ingest`).
 */
export function previousPhase(phase: Phase): Phase | null {
  const idx = phaseIndex(phase);
  return idx > 0 ? PHASE_SEQUENCE[idx - 1] : null;
}
