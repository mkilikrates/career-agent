// Unit tests for the shared assist orchestration helper `runAssist` (task 25.2).
//
// These pin the two trust-critical invariants and the non-blocking fallback at
// the orchestration layer, independent of any specific component:
//   * script-only → zero provider calls (the transport is never reached);
//   * ai-assisted → baseline + confirm-before-entry suggestions;
//   * provider failure → fall back to the baseline with a non-blocking error.

import { describe, it, expect, vi } from 'vitest';
import {
  BaseAssistableOperation,
  runAssist,
  type AssistTransport,
  type EgressDestination,
} from './index';

const DEST: EgressDestination = { provider: 'openai', kind: 'keyed-cloud' };

/** A tiny operation: baseline echoes the input; suggestions come from the gate. */
class EchoOperation extends BaseAssistableOperation<string, string, string> {
  constructor(private readonly transport: AssistTransport) {
    super();
  }
  protected computeBaseline(input: string): string {
    return `baseline:${input}`;
  }
  protected async fetchSuggestions(
    input: string,
    dest: EgressDestination,
  ): Promise<readonly string[]> {
    const reply = await this.transport(`prompt:${input}`, dest);
    return reply.split(',').map((s) => s.trim()).filter(Boolean);
  }
}

describe('runAssist — script-only path (R14.6, R47.8)', () => {
  it('issues ZERO provider calls and returns the baseline with no suggestions', async () => {
    const transport = vi.fn<AssistTransport>(async () => 'never');
    const op = new EchoOperation(transport);

    const { outcome, error } = await runAssist(
      op,
      'x',
      { mode: 'script-only', capability: 'skill_discovery' },
      DEST,
    );

    expect(transport).not.toHaveBeenCalled();
    expect(outcome.mode).toBe('script-only');
    expect(outcome.baseline).toBe('baseline:x');
    expect(outcome.suggestions).toEqual([]);
    expect(error).toBeUndefined();
  });

  it('issues ZERO provider calls when ai-assisted is chosen but no destination exists', async () => {
    const transport = vi.fn<AssistTransport>(async () => 'never');
    const op = new EchoOperation(transport);

    const { outcome } = await runAssist(op, 'x', {
      mode: 'ai-assisted',
      capability: 'skill_discovery',
    });

    expect(transport).not.toHaveBeenCalled();
    expect(outcome.mode).toBe('script-only');
  });
});

describe('runAssist — ai-assisted path (R22.6, R47.3)', () => {
  it('returns the full baseline PLUS confirm-before-entry suggestions', async () => {
    const transport = vi.fn<AssistTransport>(async () => 'one, two');
    const op = new EchoOperation(transport);

    const { outcome, error } = await runAssist(
      op,
      'x',
      { mode: 'ai-assisted', capability: 'skill_discovery' },
      DEST,
    );

    expect(transport).toHaveBeenCalledTimes(1);
    expect(outcome.mode).toBe('ai-assisted');
    expect(outcome.baseline).toBe('baseline:x'); // baseline always carried in full
    expect(outcome.suggestions.map((s) => s.value)).toEqual(['one', 'two']);
    // Every suggestion requires explicit confirmation before entry (R47.3).
    expect(outcome.suggestions.every((s) => s.requiresConfirmation === true)).toBe(true);
    expect(outcome.suggestions.every((s) => s.origin === 'ai-suggestion')).toBe(true);
    expect(error).toBeUndefined();
  });
});

describe('runAssist — ai-only path', () => {
  it('calls the provider, relabels the outcome ai-only, and still carries the baseline', async () => {
    const transport = vi.fn<AssistTransport>(async () => 'alpha, beta');
    const op = new EchoOperation(transport);

    const { outcome, error } = await runAssist(
      op,
      'x',
      { mode: 'ai-only', capability: 'role_discovery' },
      DEST,
    );

    expect(transport).toHaveBeenCalledTimes(1);
    expect(outcome.mode).toBe('ai-only');
    // Baseline is still computed/carried (for de-dupe + fallback), even though
    // the UI presents only the AI suggestions in this mode.
    expect(outcome.baseline).toBe('baseline:x');
    expect(outcome.suggestions.map((s) => s.value)).toEqual(['alpha', 'beta']);
    expect(error).toBeUndefined();
  });

  it('falls back to the deterministic baseline on provider failure (non-blocking)', async () => {
    const transport = vi.fn<AssistTransport>(async () => {
      throw new Error('offline');
    });
    const op = new EchoOperation(transport);

    const { outcome, error } = await runAssist(
      op,
      'x',
      { mode: 'ai-only', capability: 'role_discovery' },
      DEST,
    );

    expect(outcome.baseline).toBe('baseline:x');
    expect(error?.message).toContain('offline');
  });

  it('issues ZERO provider calls when ai-only is chosen but no destination exists', async () => {
    const transport = vi.fn<AssistTransport>(async () => 'never');
    const op = new EchoOperation(transport);

    const { outcome } = await runAssist(op, 'x', {
      mode: 'ai-only',
      capability: 'role_discovery',
    });

    expect(transport).not.toHaveBeenCalled();
    expect(outcome.mode).toBe('script-only');
  });
});

describe('runAssist — provider failure fallback (R22.8, R30.7)', () => {
  it('falls back to the deterministic baseline with a NON-BLOCKING error', async () => {
    const transport = vi.fn<AssistTransport>(async () => {
      throw new Error('provider down');
    });
    const op = new EchoOperation(transport);

    const { outcome, error } = await runAssist(
      op,
      'x',
      { mode: 'ai-assisted', capability: 'cv_tailoring' },
      DEST,
    );

    // The baseline is always available because scriptOnly is a precondition.
    expect(outcome.baseline).toBe('baseline:x');
    expect(outcome.suggestions).toEqual([]);
    // The error is surfaced but non-blocking (returned, not thrown).
    expect(error).toBeDefined();
    expect(error?.capability).toBe('cv_tailoring');
    expect(error?.provider).toBe('openai');
    expect(error?.message).toContain('provider down');
  });
});
