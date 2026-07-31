// Feature: career-agent, Property 19: Opt-in-first AI orchestration
//
// For any AI-assistable operation and any input, when the user selects
// `script-only`, the operation produces a result with ZERO provider calls. Uses
// a call-counting mock transport to verify.
//
// **Validates: Requirements 14.6, 20.5, 22.5, 28.5, 30.7, 47.8**

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import {
  BaseAssistableOperation,
  runAssist,
  type AssistTransport,
  type EgressDestination,
} from './index';
import type { AssistCapability } from './assist';

// ---------------------------------------------------------------------------
// Mock operation
// ---------------------------------------------------------------------------

/**
 * A generic AssistableOperation for testing. scriptOnly returns a deterministic
 * baseline from the input. aiAssisted calls the transport (which should never be
 * called in script-only mode).
 */
class CountingOperation extends BaseAssistableOperation<string, string, string> {
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
    return reply.split(',').filter(Boolean);
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Arbitrary capabilities that can be script-only. */
const arbCapability: fc.Arbitrary<AssistCapability> = fc.constantFrom(
  'skill_discovery',
  'role_discovery',
  'star_questions',
  'star_summary',
  'cv_tailoring',
);

/** Arbitrary input strings. */
const arbInput = fc.string({ minLength: 1, maxLength: 100 });

/** Arbitrary destination (for the test, we always supply one to prove it's ignored). */
const arbDest: fc.Arbitrary<EgressDestination> = fc.constantFrom(
  { provider: 'openai', kind: 'keyed-cloud' } as EgressDestination,
  { provider: 'anthropic', kind: 'keyed-cloud' } as EgressDestination,
  { provider: 'ollama', kind: 'keyless-local' } as EgressDestination,
);

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe('@core/assist — Property 19: Opt-in-first (script-only → zero provider calls)', () => {
  it('script-only mode produces a baseline result with ZERO transport calls for any input', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbCapability,
        arbInput,
        arbDest,
        async (capability, input, dest) => {
          const transport = vi.fn<AssistTransport>(async () => 'should-not-be-called');
          const op = new CountingOperation(transport);

          const { outcome, error } = await runAssist(
            op,
            input,
            { mode: 'script-only', capability },
            dest,
          );

          // ZERO provider calls (transport never invoked)
          expect(transport).not.toHaveBeenCalled();

          // The result contains a baseline (the deterministic result)
          expect(outcome.baseline).toBe(`baseline:${input}`);

          // No suggestions in script-only mode
          expect(outcome.suggestions).toEqual([]);

          // No error
          expect(error).toBeUndefined();

          // Mode is script-only
          expect(outcome.mode).toBe('script-only');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('script-only mode is indifferent to the destination — always zero calls', async () => {
    await fc.assert(
      fc.asyncProperty(arbInput, async (input) => {
        const transport = vi.fn<AssistTransport>(async () => 'never');
        const op = new CountingOperation(transport);

        // Even with a valid destination, script-only NEVER reaches the transport
        const { outcome } = await runAssist(
          op,
          input,
          { mode: 'script-only', capability: 'skill_discovery' },
          { provider: 'openai', kind: 'keyed-cloud' },
        );
        expect(transport).not.toHaveBeenCalled();
        expect(outcome.baseline).toBe(`baseline:${input}`);
      }),
      { numRuns: 100 },
    );
  });

  it('when ai-assisted but NO destination is provided, zero provider calls occur', async () => {
    await fc.assert(
      fc.asyncProperty(arbCapability, arbInput, async (capability, input) => {
        const transport = vi.fn<AssistTransport>(async () => 'never');
        const op = new CountingOperation(transport);

        // ai-assisted without destination → falls back to script-only
        const { outcome } = await runAssist(
          op,
          input,
          { mode: 'ai-assisted', capability },
          undefined, // no destination
        );
        expect(transport).not.toHaveBeenCalled();
        expect(outcome.mode).toBe('script-only');
        expect(outcome.baseline).toBe(`baseline:${input}`);
      }),
      { numRuns: 100 },
    );
  });
});
