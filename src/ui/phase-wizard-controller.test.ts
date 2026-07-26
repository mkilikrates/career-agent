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
    store,
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

  it('marks earlier phases complete only when their artefact is present', async () => {
    const { controller, store } = makeController();
    // Write artefacts for the first two phases
    store.write(CANONICAL_FILES.rawExtractions, '# Raw Extractions\n');
    store.write(CANONICAL_FILES.skillMap, '# Skill Map\n');
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

  it('shows earlier phases as in-progress (not complete) when artefact is missing', async () => {
    const { controller } = makeController();
    // Advance without writing artefacts — the bug was that these showed 'complete'
    await controller.confirmStep(); // ingest -> skill-map
    await controller.confirmStep(); // skill-map -> role-discovery
    const phases = controller.phases();

    // Without artefacts, earlier phases should NOT be 'complete'
    expect(phases.find((p) => p.phase === 'ingest')?.status).toBe('in-progress');
    expect(phases.find((p) => p.phase === 'skill-map')?.status).toBe('in-progress');
    expect(phases.find((p) => p.phase === 'role-discovery')).toMatchObject({
      current: true,
      status: 'in-progress',
    });
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

describe('PhaseWizardController — artefact-presence gating (R48.2–48.4)', () => {
  it('marks a phase complete when its artefact is present in the store', () => {
    const store = new MemoryTree();
    store.write(CANONICAL_FILES.rawExtractions, '# Extractions\n');
    const { controller } = makeController(store);
    // Even though we're on ingest (index 0), the artefact makes it 'complete'
    const phases = controller.phases();
    expect(phases.find((p) => p.phase === 'ingest')?.status).toBe('complete');
  });

  it('marks interview-coaching complete when any interview file exists', async () => {
    const store = new MemoryTree();
    store.write('interviews/interview_cloud-architect.md', '# Interview\n');
    const { controller } = makeController(store);
    await controller.goToPhase('memory');
    const phases = controller.phases();
    expect(phases.find((p) => p.phase === 'interview-coaching')?.status).toBe('complete');
  });

  it('marks output complete when any cv_ output exists', async () => {
    const store = new MemoryTree();
    store.write('outputs/cv_cloud-architect_v1.md', '# CV\n');
    const { controller } = makeController(store);
    await controller.goToPhase('memory');
    const phases = controller.phases();
    expect(phases.find((p) => p.phase === 'output')?.status).toBe('complete');
  });

  it('memory phase is always complete (no gating)', async () => {
    const { controller } = makeController();
    await controller.goToPhase('memory');
    // Even though we just jumped to memory with no artefacts, memory's gate always passes
    const phases = controller.phases();
    expect(phases.find((p) => p.phase === 'memory')?.status).toBe('complete');
  });

  it('reports correct statuses when all artefacts are present', async () => {
    const store = new MemoryTree();
    store.write(CANONICAL_FILES.rawExtractions, '# Extractions\n');
    store.write(CANONICAL_FILES.skillMap, '# Skills\n');
    store.write(CANONICAL_FILES.rolePreferences, '# Roles\n');
    store.write('interviews/interview_sre.md', '# Interview\n');
    store.write('outputs/cv_sre_v1.md', '# CV\n');
    const { controller } = makeController(store);
    await controller.goToPhase('output');
    const phases = controller.phases();

    expect(phases.find((p) => p.phase === 'ingest')?.status).toBe('complete');
    expect(phases.find((p) => p.phase === 'skill-map')?.status).toBe('complete');
    expect(phases.find((p) => p.phase === 'role-discovery')?.status).toBe('complete');
    expect(phases.find((p) => p.phase === 'interview-coaching')?.status).toBe('complete');
    // output is current AND has artefact → 'complete' takes precedence
    expect(phases.find((p) => p.phase === 'output')?.status).toBe('complete');
    // memory is always complete
    expect(phases.find((p) => p.phase === 'memory')?.status).toBe('complete');
  });

  it('phase before current without artefact is in-progress, not complete', async () => {
    const store = new MemoryTree();
    // Only write the raw_extractions artefact, skip skill_map
    store.write(CANONICAL_FILES.rawExtractions, '# Extractions\n');
    const { controller } = makeController(store);
    await controller.confirmStep(); // ingest -> skill-map
    await controller.confirmStep(); // skill-map -> role-discovery
    const phases = controller.phases();

    // ingest has its artefact → complete
    expect(phases.find((p) => p.phase === 'ingest')?.status).toBe('complete');
    // skill-map was visited (before current) but has no artefact → in-progress
    expect(phases.find((p) => p.phase === 'skill-map')?.status).toBe('in-progress');
    // role-discovery is current → in-progress
    expect(phases.find((p) => p.phase === 'role-discovery')?.status).toBe('in-progress');
  });
});