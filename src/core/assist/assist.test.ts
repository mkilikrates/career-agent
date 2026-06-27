// Unit tests for the shared AI-assist Opt-In-First contract (Requirements
// 14.5/14.6, 20.4/20.5, 22.5, 28.5, 30.7, 47.7/47.8).
//
// These cover the contract's two trust-critical invariants:
//   - script-only completeness with ZERO provider calls (R14.6, R47.8); and
//   - ai-assisted supplement-not-replace (R22.6) with confirm-before-entry
//     (R47.3) — the baseline is always carried through and supplements are
//     flagged as unconfirmed suggestions.

import { describe, expect, it, vi } from 'vitest';

import {
  aiAssistedOutcome,
  assistSuggestion,
  BaseAssistableOperation,
  isAiAssisted,
  isScriptOnly,
  scriptOnlyOutcome,
  type AssistChoice,
  type AssistSuggestion,
  type EgressDestination,
} from './assist';

const DEST: EgressDestination = { provider: 'openai', kind: 'keyed-cloud' };

describe('AssistChoice guards (R14.5)', () => {
  it('isScriptOnly / isAiAssisted reflect the pre-operation mode', () => {
    const scriptOnly: AssistChoice = { mode: 'script-only', capability: 'skill_discovery' };
    const aiAssisted: AssistChoice = { mode: 'ai-assisted', capability: 'cv_tailoring' };
    expect(isScriptOnly(scriptOnly)).toBe(true);
    expect(isAiAssisted(scriptOnly)).toBe(false);
    expect(isScriptOnly(aiAssisted)).toBe(false);
    expect(isAiAssisted(aiAssisted)).toBe(true);
  });
});

describe('assistSuggestion — unconfirmed by construction (R47.3)', () => {
  it('wraps a value as an AI-origin suggestion that requires confirmation', () => {
    const s = assistSuggestion('system design');
    expect(s.value).toBe('system design');
    expect(s.origin).toBe('ai-suggestion');
    expect(s.requiresConfirmation).toBe(true);
  });
});

describe('scriptOnlyOutcome — complete deterministic result (R14.6, R47.8)', () => {
  it('carries the baseline with no suggestions', () => {
    const out = scriptOnlyOutcome(['a', 'b']);
    expect(out.mode).toBe('script-only');
    expect(out.baseline).toEqual(['a', 'b']);
    expect(out.suggestions).toEqual([]);
  });
});

describe('aiAssistedOutcome — supplement-not-replace (R22.6, R47.3)', () => {
  it('always carries the full baseline alongside the supplements', () => {
    const out = aiAssistedOutcome(['baseline-skill'], ['ai-skill-1', 'ai-skill-2']);
    expect(out.mode).toBe('ai-assisted');
    expect(out.baseline).toEqual(['baseline-skill']);
    expect(out.suggestions.map((s) => s.value)).toEqual(['ai-skill-1', 'ai-skill-2']);
  });

  it('flags every supplement as an unconfirmed suggestion (R47.3)', () => {
    const out = aiAssistedOutcome(0, [1, 2, 3]);
    expect(out.suggestions).toHaveLength(3);
    for (const s of out.suggestions) {
      expect(s.origin).toBe('ai-suggestion');
      expect(s.requiresConfirmation).toBe(true);
    }
  });

  it('accepts already-wrapped suggestions without double-wrapping', () => {
    const pre: AssistSuggestion<string> = assistSuggestion('pre-wrapped');
    const out = aiAssistedOutcome('base', [pre, 'raw']);
    expect(out.suggestions[0]).toBe(pre);
    expect(out.suggestions[1]).toEqual(assistSuggestion('raw'));
  });
});

// A concrete operation used to exercise the base class invariants. The baseline
// is a deterministic transform of the input; the supplement step records whether
// it was invoked so we can assert the script-only path never reaches it.
class UppercaseAssist extends BaseAssistableOperation<string, string, string> {
  readonly fetchSpy = vi.fn(async (input: string) => [`${input}!`, `${input}?`]);

  protected computeBaseline(input: string): string {
    return input.toUpperCase();
  }

  protected fetchSuggestions(
    input: string,
    _dest: EgressDestination,
    _baseline: string,
  ): Promise<readonly string[]> {
    return this.fetchSpy(input);
  }
}

describe('BaseAssistableOperation — opt-in-first invariants', () => {
  it('scriptOnly returns the deterministic baseline and issues ZERO provider calls (R14.6, R47.8)', () => {
    const op = new UppercaseAssist();
    const out = op.scriptOnly('hello');
    expect(out.mode).toBe('script-only');
    expect(out.baseline).toBe('HELLO');
    expect(out.suggestions).toEqual([]);
    // The supplement (provider-reaching) step must never run on the script path.
    expect(op.fetchSpy).not.toHaveBeenCalled();
  });

  it('aiAssisted establishes the baseline first, then supplements it (R22.6)', async () => {
    const op = new UppercaseAssist();
    const out = await op.aiAssisted('hello', DEST);
    expect(out.mode).toBe('ai-assisted');
    // Baseline identical to the script-only path — never replaced.
    expect(out.baseline).toBe('HELLO');
    expect(out.suggestions.map((s) => s.value)).toEqual(['hello!', 'hello?']);
    expect(op.fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('aiAssisted marks every supplement as requiring confirmation (R47.3)', async () => {
    const op = new UppercaseAssist();
    const out = await op.aiAssisted('x', DEST);
    for (const s of out.suggestions) {
      expect(s.requiresConfirmation).toBe(true);
      expect(s.origin).toBe('ai-suggestion');
    }
  });

  it('the script-only baseline is always available regardless of provider state (Property 19)', async () => {
    const op = new UppercaseAssist();
    op.fetchSpy.mockRejectedValueOnce(new Error('provider down'));
    // script-only is unaffected by provider failure.
    expect(op.scriptOnly('safe').baseline).toBe('SAFE');
    // ai-assisted rejects, but the baseline was computable independently.
    await expect(op.aiAssisted('safe', DEST)).rejects.toThrow('provider down');
    expect(op.scriptOnly('safe').baseline).toBe('SAFE');
  });
});
