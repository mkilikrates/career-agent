// Unit tests for the phase-wizard controller (@ui) — task 19.1.
//
// These exercise the wiring between the wizard and the orchestrator: the PHASE
// HUB jump (R35.2), linear confirm-and-advance, persist-after-every-confirmed-
// step (R35.2 resumable pipeline), and continue-from-last-phase on resume
// (R35.1). The orchestrator is the real one; only the Egress Gate is a no-op spy
// (no provider/network is ever touched on this path).

import { describe, expect, it, vi } from 'vitest';

import { createCareerAgent } from '@core/orchestrator';
import type { EgressGate } from '@core/egress';
import { MemoryTree } from '@core/storage';
import { CANONICAL_FILES } from '@core/storage';
import {
  PhaseWizardController,
  createMemoryTreePersistence,
  createMemoryTreeResumeReader,
  parseSessionState,
  renderSessionState,
  SESSION_STATE_PATH,
} from './phase-wizard-controller';

/** A no-op Egress Gate: provider reachability is never exercised by the wizard. */
function makeGate(): EgressGate {
  return {
    request: vi.fn(async () => ({}) as never),
    transcribe: vi.fn(async () => ({ text: '', redactedCategories: [] })),
  } as unknown as EgressGate;
}

function makeController(store = new MemoryTree()) {
  const agent = createCareerAgent({
    egressGate: makeGate(),
    memoryStoreReader: createMemoryTreeResumeReader(store),
  });
  const controller = new PhaseWizardController({
    agent,
    persistence: createMemoryTreePersistence(store),
  });
  return { agent, controller, store };
}

describe('session-state serialization', () => {
  it('round-trips a phase through render/parse', () => {
    expect(parseSessionState(renderSessionState('role-discovery'))).toBe('role-discovery');
  });

  it('returns undefined for an unknown phase slug', () => {
    expect(parseSessionState('phase: not-a-phase\n')).toBeUndefined();
    expect(parseSessionState('# Session State\n')).toBeUndefined();
  });
});

describe('PhaseWizardController — phase views', () => {
  it('starts on ingest and projects all six phases in order', () => {
    const { controller } = makeController();
    const phases = controller.phases();
    expect(phases.map((p) => p.phase)).toEqual([
      'ingest',
      'skill-map',
      'role-discovery',
      'interview-coaching',
      'output',
      'memory',
    ]);
    expect(controller.currentPhase()).toBe('ingest');
    expect(phases[0]).toMatchObject({ current: true, status: 'in-progress' });
    expect(phases[1]).toMatchObject({ current: false, status: 'pending' });
  });

  it('marks earlier phases complete and the current phase in-progress after advancing', async () => {
    const { controller } = makeController();
    await controller.confirmStep(); // ingest -> skill-map
    await controller.confirmStep(); // skill-map -> role-discovery
    const phases = controller.phases();

    expect(phases.find((p) => p.phase === 'ingest')?.status).toBe('complete');
    expect(phases.find((p) => p.phase === 'skill-map')?.status).toBe('complete');
    expect(phases.find((p) => p.phase === 'role-discovery')).toMatchObject({
      current: true,
      status: 'in-progress',
    });
    expect(phases.find((p) => p.phase === 'output')?.status).toBe('pending');
  });
});

describe('PhaseWizardController — phase hub (R35.2)', () => {
  it('jumps directly to any phase and persists the pointer without confirming', async () => {
    const { controller, store } = makeController();
    await controller.goToPhase('output');

    expect(controller.currentPhase()).toBe('output');
    // The resume pointer is updated so a return continues here (R35.1)...
    expect(parseSessionState(store.readText(SESSION_STATE_PATH))).toBe('output');
    // ...but a plain navigation is NOT a confirmed step, so no confirmation is logged.
    expect(store.has(CANONICAL_FILES.sessionLog)).toBe(false);
  });

  it('is a no-op when jumping to the current phase', async () => {
    const { controller, store } = makeController();
    await controller.goToPhase('ingest');
    expect(controller.currentPhase()).toBe('ingest');
    expect(store.has(SESSION_STATE_PATH)).toBe(false);
  });
});

describe('PhaseWizardController — confirm and persist (R35.2)', () => {
  it('persists the confirmed step (pointer + session log) and advances', async () => {
    const { controller, store } = makeController();
    const next = await controller.confirmStep();

    expect(next).toBe('skill-map');
    expect(controller.currentPhase()).toBe('skill-map');
    // Pointer reflects the phase we advanced into (continue-from-last, R35.1).
    expect(parseSessionState(store.readText(SESSION_STATE_PATH))).toBe('skill-map');
    // A user confirmation was recorded for the confirmed phase (R34.3).
    const log = store.sessionLog();
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe('confirmation');
    expect(log[0].message).toContain('ingest');
  });

  it('persists a confirmation on the final phase but does not advance past it', async () => {
    const { controller, store } = makeController();
    await controller.goToPhase('memory');
    const next = await controller.confirmStep();

    expect(next).toBe('memory');
    expect(controller.isFinalPhase()).toBe(true);
    const log = store.sessionLog();
    expect(log.at(-1)?.type).toBe('confirmation');
    expect(log.at(-1)?.message).toContain('memory');
  });
});

describe('PhaseWizardController — resume (R35.1)', () => {
  it('continues from the last persisted phase', async () => {
    const store = new MemoryTree();
    // Simulate a prior session that confirmed through to role-discovery.
    const first = makeController(store);
    await first.controller.confirmStep(); // ingest -> skill-map
    await first.controller.confirmStep(); // skill-map -> role-discovery
    first.controller.dispose();

    // A fresh session over the same store resumes where the user left off.
    const second = makeController(store);
    const summary = await second.controller.resume();

    expect(summary.resumePhase).toBe('role-discovery');
    expect(second.controller.currentPhase()).toBe('role-discovery');
  });

  it('a brand-new store resumes at the initial phase with nothing outstanding', async () => {
    const { controller } = makeController();
    const summary = await controller.resume();
    expect(summary.resumePhase).toBe('ingest');
    expect(controller.outstanding()).toEqual([]);
  });
});

describe('PhaseWizardController — subscription', () => {
  it('notifies subscribers on phase change and stops after unsubscribe', async () => {
    const { controller } = makeController();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    await controller.goToPhase('output');
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    unsubscribe();
    await controller.goToPhase('ingest');
    expect(listener).not.toHaveBeenCalled();
  });
});
