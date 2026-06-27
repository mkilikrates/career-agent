// The Career_Agent six-phase statechart (design §Pipeline state: XState; R35.2).
//
// Models the resumable Ingest → Skill Map → Role Discovery → Interview Coaching
// → Output → Memory pipeline as a single compound XState machine. Each phase is
// a child state of the root. Two events drive navigation:
//
//   - `ADVANCE`     — step forward to the next phase in canonical order. No-op
//                     on the final phase (`memory`).
//   - `JUMP_TO_PHASE` — the PHASE HUB (R35.2): jump directly to ANY phase from
//                     any phase, forward or backward, without stepping through
//                     the ones in between.
//
// The active phase IS the machine's state value (one of the six phase slugs),
// so there is no duplicated bookkeeping: the orchestrator reads the phase
// directly from the snapshot. The machine is deterministic and side-effect-free:
// it carries no provider clients, no Storage_Adapter, and no Egress Gate. The
// orchestrator (`career-agent.ts`) owns those collaborators and drives this
// machine. Keeping the statechart pure means the resumable phase model can be
// unit-tested in isolation and reused under any packaging (browser today, Tauri
// later).
//
// Session resume (task 17.2) and re-entry triggers (task 17.3) are intentionally
// NOT modelled here yet; this statechart provides the phase states and the hub
// those tasks will build on.
//
// Requirements: 35.2.

import { setup } from 'xstate';
import { INITIAL_PHASE, PHASE_SEQUENCE, type Phase } from './phases';

/** Step forward to the next phase in canonical order (no-op on the last phase). */
export interface AdvanceEvent {
  readonly type: 'ADVANCE';
}

/** Phase-hub jump: go directly to any phase from any phase (R35.2). */
export interface JumpToPhaseEvent {
  readonly type: 'JUMP_TO_PHASE';
  readonly phase: Phase;
}

/** The full event union accepted by the pipeline statechart. */
export type PipelineEvent = AdvanceEvent | JumpToPhaseEvent;

/**
 * The Career_Agent pipeline statechart. Six phase states under a compound root;
 * the root handles `JUMP_TO_PHASE` so the hub works from any phase, and each
 * phase handles `ADVANCE` for linear progress to the next phase. The terminal
 * phase (`memory`) has no `ADVANCE`, so it is a no-op there.
 */
export const pipelineMachine = setup({
  types: {
    events: {} as PipelineEvent,
  },
}).createMachine({
  id: 'career-agent-pipeline',
  initial: INITIAL_PHASE,
  // The phase hub (R35.2): a single jump transition, valid from ANY phase,
  // routed by the event's `phase` to that phase's state node.
  on: {
    JUMP_TO_PHASE: [
      { guard: ({ event }) => event.phase === 'ingest', target: '.ingest' },
      { guard: ({ event }) => event.phase === 'skill-map', target: '.skill-map' },
      { guard: ({ event }) => event.phase === 'role-discovery', target: '.role-discovery' },
      {
        guard: ({ event }) => event.phase === 'interview-coaching',
        target: '.interview-coaching',
      },
      { guard: ({ event }) => event.phase === 'output', target: '.output' },
      { guard: ({ event }) => event.phase === 'memory', target: '.memory' },
    ],
  },
  states: {
    ingest: { on: { ADVANCE: { target: 'skill-map' } } },
    'skill-map': { on: { ADVANCE: { target: 'role-discovery' } } },
    'role-discovery': { on: { ADVANCE: { target: 'interview-coaching' } } },
    'interview-coaching': { on: { ADVANCE: { target: 'output' } } },
    output: { on: { ADVANCE: { target: 'memory' } } },
    memory: {},
  },
});

/**
 * The full set of state-value strings the machine can report — exactly the six
 * canonical phases. Exposed for exhaustiveness checks in tests and the UI.
 */
export const PIPELINE_STATE_VALUES: readonly Phase[] = PHASE_SEQUENCE;
