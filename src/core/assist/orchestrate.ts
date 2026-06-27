// @core/assist orchestration — the shared "run an assist choice" helper that
// every AI-assistable component (Skill_Mapper, Role_Matcher, Interview_Coach,
// Output_Engine) is driven through (task 25.2).
//
// The shared {@link AssistableOperation} (task 25.1) already guarantees the two
// trust-critical invariants by construction: `scriptOnly` issues zero provider
// calls, and `aiAssisted` always carries the full deterministic baseline plus
// confirm-before-entry suggestions. What this module adds is the ONE place the
// orchestrator/UI branches on the user's pre-operation {@link AssistChoice} and,
// crucially, the NON-BLOCKING provider-failure fallback the design mandates:
//
//   - `script-only` (or no destination) → call `operation.scriptOnly(input)` and
//     NEVER construct an Egress request. This is the default trust-preserving
//     route and is fully functional on its own (R14.5/14.6, R20.4/20.5, R22.5,
//     R28.5, R30.7, R47.7/47.8).
//   - `ai-assisted` → call `operation.aiAssisted(input, dest)`, whose supplements
//     route through the Egress Gate. If the provider call fails, fall back to the
//     already-available deterministic baseline and surface a NON-BLOCKING error,
//     preserving phase state (R22.8, R30.7). Because `scriptOnly` is a
//     precondition of `aiAssisted`, the deterministic result is ALWAYS available
//     regardless of provider state — the mechanism behind Correctness Property 19.
//
// This module imports NO provider client and never reaches the Provider_Manager:
// the only path to a provider is the {@link AssistTransport} the component's
// operation was constructed with, which itself routes through the single Egress
// Gate. So the Egress-Gate-only architectural boundary is preserved.
//
// Requirements: 14.5, 20.4, 22.4, 28.5, 30.7, 47.3, 47.7.

import type { ProviderId } from '@adapters/provider';
import type {
  AssistableOperation,
  AssistChoice,
  AssistOutcome,
  EgressDestination,
} from './assist';
import { isScriptOnly } from './assist';

/**
 * The single gate-routed transport an AI-assistable operation uses to fetch its
 * provider-derived supplements. Given a prompt and the chosen
 * {@link EgressDestination}, it returns the model's reply text. It is injected
 * (DI) so @core stays framework- and provider-client-agnostic: the concrete
 * transport wraps the orchestrator's `requestProvider`, which delegates to the
 * single Egress Gate (PII pre-screening, network labelling, payload
 * minimisation, transmit-to-chosen-provider-only). A component operation calls
 * the transport ONLY from its `aiAssisted` path, never from `scriptOnly`.
 */
export type AssistTransport = (
  prompt: string,
  dest: EgressDestination,
) => Promise<string>;

/**
 * A non-blocking provider-failure record (R22.8, R30.7). When the `ai-assisted`
 * path's provider call fails, {@link runAssist} returns the deterministic
 * baseline as the outcome AND this error so the UI can surface "AI assist was
 * unavailable" without losing the user's place or the script-only result.
 */
export interface AssistError {
  /** Which AI-assistable capability the failed call applied to. */
  readonly capability: AssistChoice['capability'];
  /** The provider the failed call was destined for. */
  readonly provider: ProviderId;
  /** Human-readable failure message (never a secret value). */
  readonly message: string;
  /** The original thrown cause, for logging/diagnostics. */
  readonly cause: unknown;
}

/**
 * The result of {@link runAssist}: the {@link AssistOutcome} (always carrying the
 * full deterministic baseline) plus, when the AI path failed, a NON-BLOCKING
 * {@link AssistError}. On success `error` is absent; on a script-only run `error`
 * is always absent (there is no provider call to fail).
 */
export interface AssistRunResult<TBaseline, TSuggestion> {
  /** The outcome — baseline always present; suggestions present only on success. */
  readonly outcome: AssistOutcome<TBaseline, TSuggestion>;
  /** Set only when the ai-assisted provider call failed (non-blocking). */
  readonly error?: AssistError;
}

/**
 * Run an {@link AssistableOperation} for the user's pre-operation
 * {@link AssistChoice}, branching exactly as the design's "Where the choice is
 * surfaced" section dictates and applying the non-blocking provider-failure
 * fallback.
 *
 *   - `script-only`, or `ai-assisted` with no destination available → run the
 *     deterministic `scriptOnly` path only. No Egress request is ever
 *     constructed (the transport is never reached).
 *   - `ai-assisted` with a destination → run `aiAssisted`; on ANY failure, fall
 *     back to the deterministic baseline (recomputed deterministically by
 *     `scriptOnly`, so phase state is preserved) and return a non-blocking
 *     {@link AssistError}.
 *
 * The returned outcome ALWAYS contains the full baseline, and every AI
 * suggestion in it is flagged `requiresConfirmation: true` by the contract, so
 * Correctness Property 19 holds for callers of this helper.
 */
export async function runAssist<TInput, TBaseline, TSuggestion>(
  operation: AssistableOperation<TInput, AssistOutcome<TBaseline, TSuggestion>>,
  input: TInput,
  choice: AssistChoice,
  dest?: EgressDestination,
): Promise<AssistRunResult<TBaseline, TSuggestion>> {
  // script-only (or no destination to send to) → deterministic only, zero
  // provider calls (R14.6, R47.8). The transport is never invoked.
  if (isScriptOnly(choice) || !dest) {
    return { outcome: operation.scriptOnly(input) };
  }

  try {
    // ai-assisted / ai-only → baseline first (inside aiAssisted), then
    // gate-routed supplements. The contract carries the full baseline through
    // unchanged. For ai-only the outcome mode is relabelled so the UI can
    // present only the AI results (the baseline is still carried for fallback).
    const outcome = await operation.aiAssisted(input, dest);
    return {
      outcome: choice.mode === 'ai-only' ? { ...outcome, mode: 'ai-only' } : outcome,
    };
  } catch (cause) {
    // Non-blocking fallback (R22.8, R30.7): the deterministic baseline is always
    // available because scriptOnly is a precondition of aiAssisted. Recomputing
    // it here is pure and side-effect-free, so phase state is preserved.
    return {
      outcome: operation.scriptOnly(input),
      error: {
        capability: choice.capability,
        provider: dest.provider,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      },
    };
  }
}
