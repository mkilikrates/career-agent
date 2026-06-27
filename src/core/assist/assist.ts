// @core/assist — the shared AI-assist Opt-In-First contract (design "AI Assist
// Opt-In-First Pattern (shared)").
//
// Four components offer optional AI help — Skill_Mapper (skill discovery),
// Role_Matcher (role recommendations), Interview_Coach (STAR question generation
// and educational summaries), and Output_Engine (CV tailoring). Rather than each
// inventing its own opt-in, they share ONE opt-in-first contract so the behaviour
// is identical everywhere (Requirements 14.5/14.6, 20.4/20.5, 22.5/22.6,
// 28.5, 30.7, 47.7/47.8).
//
// The contract enforces two trust-critical invariants BY DESIGN:
//
//   1. Opt-in-first / script-only completeness — `scriptOnly(input)` produces a
//      COMPLETE, deterministic result and MUST issue ZERO provider calls
//      (R14.6, R20.5, R22.5, R28.5, R30.7, R47.8). Because it takes no
//      EgressDestination and is synchronous, it has no means of reaching a
//      provider: the type system makes a provider call from this path
//      unrepresentable.
//
//   2. Supplement-not-replace + confirm-before-entry — `aiAssisted(input, dest)`
//      establishes the SAME deterministic baseline first, then adds
//      provider-derived supplements routed through the Egress Gate. Supplements
//      never replace the baseline (R22.6) and are surfaced as unconfirmed
//      *suggestions* that require explicit user confirmation before entering the
//      knowledge base (R47.3). The result shape ({@link AssistOutcome}) always
//      carries the full `baseline`, and every supplement is an
//      {@link AssistSuggestion} flagged `requiresConfirmation: true`.
//
// This module is framework-agnostic @core domain logic: pure data shapes plus a
// base implementation that wires the two invariants together. It imports NO
// provider client — the actual transmission flows through the single Egress Gate
// (@core/egress), reached only from the `aiAssisted` path via the injected
// supplement step.
//
// Requirements: 14.5, 14.6, 20.4, 20.5, 22.5, 28.5, 30.7, 47.7, 47.8.

import type { ProviderId } from '@adapters/provider';
import type { DestinationKind } from '@core/egress';

/**
 * Whether the operation runs purely deterministically, also requests AI
 * supplements, or runs only the AI path. The mode is chosen by the user BEFORE
 * the operation runs (R14.5, R20.4, R47.7) — it is never inferred mid-flight.
 *   - `script-only`  — deterministic baseline only; no provider is ever called.
 *   - `ai-assisted`  — deterministic baseline PLUS provider-derived suggestions.
 *   - `ai-only`      — the AI path only; the deterministic baseline is computed
 *                      internally (for de-dupe and the non-blocking fallback) but
 *                      the UI offers only the AI action and presents only AI
 *                      results. On a provider failure it still falls back to the
 *                      deterministic baseline so the user is never stranded.
 */
export type AssistMode = 'script-only' | 'ai-assisted' | 'ai-only';

/**
 * The AI-assistable capability the choice applies to. One member per opt-in
 * surface across the four components, so a single {@link AssistChoice} can be
 * routed uniformly by the orchestrator (design "Where the choice is surfaced").
 */
export type AssistCapability =
  | 'skill_discovery' // Skill_Mapper (R47.7)
  | 'role_discovery' // Role_Matcher (R20.4)
  | 'star_questions' // Interview_Coach STAR question generation (R22.5)
  | 'star_summary' // Interview_Coach educational summary (R28.5)
  | 'cv_tailoring'; // Output_Engine CV tailoring (R30.7)

/**
 * The user's pre-operation selection captured by each phase screen and passed to
 * the orchestrator (design "Where the choice is surfaced"). It pairs the chosen
 * {@link AssistMode} with the {@link AssistCapability} it applies to so the
 * orchestrator can branch: `script-only` calls only `scriptOnly(...)` and never
 * constructs an Egress request; `ai-assisted` establishes the baseline and then
 * runs `aiAssisted(...)` through the Egress Gate.
 */
export interface AssistChoice {
  /** The user's pre-operation selection (R14.5, R20.4, R47.7). */
  readonly mode: AssistMode;
  /** Which AI-assistable capability the choice applies to. */
  readonly capability: AssistCapability;
}

/**
 * Where the `aiAssisted` path's provider call is destined. This is the minimal
 * descriptor the Egress Gate needs to route and label the call: the user's
 * chosen `provider` (the sole permitted destination, R7.4) and, optionally, the
 * `kind` of destination (a keyed cloud third-party vs a keyless on-device Local
 * Provider) which scopes private-item exclusion (R46.4) and the network label
 * (R7.6). It is deliberately small and provider-client-free so @core stays
 * framework-agnostic; the gate (@core/egress) reuses these same primitives
 * ({@link ProviderId}, {@link DestinationKind}).
 */
export interface EgressDestination {
  /** The user's chosen provider — the only permitted destination (R7.4). */
  readonly provider: ProviderId;
  /**
   * Whether the destination is a keyed cloud (third-party) provider or a keyless
   * on-device Local Provider. Optional because some callers carry it separately;
   * when present it scopes private-item exclusion (R46.4) and labelling (R7.6).
   */
  readonly kind?: DestinationKind;
}

/**
 * A single provider-derived supplement, modelled as an explicitly UNCONFIRMED
 * suggestion that is distinct from the confirmed deterministic baseline. The
 * `requiresConfirmation: true` literal makes it impossible to construct a
 * supplement that does not require explicit user confirmation before it enters
 * the knowledge base (R47.3, R22.6 supplement-not-replace).
 */
export interface AssistSuggestion<TSuggestion> {
  /** The model-proposed value. Trusted only after explicit user confirmation. */
  readonly value: TSuggestion;
  /** Marks the value as provider-derived (not part of the deterministic baseline). */
  readonly origin: 'ai-suggestion';
  /** Always `true`: a suggestion must be user-confirmed before entry (R47.3). */
  readonly requiresConfirmation: true;
}

/**
 * The result shape shared by both assist paths. It ALWAYS carries the full
 * deterministic `baseline`; `suggestions` are the provider-derived supplements,
 * which are always empty on the `script-only` path and, on the `ai-assisted`
 * path, are added ALONGSIDE the baseline (never replacing it, R22.6). Every entry
 * in `suggestions` requires explicit user confirmation before it enters the
 * knowledge base (R47.3).
 *
 * Components use a concrete `AssistOutcome<TBaseline, TSuggestion>` as the
 * `TResult` of their {@link AssistableOperation} so the supplement-not-replace
 * and confirm-before-entry invariants hold uniformly across all four (25.2).
 */
export interface AssistOutcome<TBaseline, TSuggestion> {
  /** Which path produced this outcome (R14.5). */
  readonly mode: AssistMode;
  /** The complete, deterministic, already-confirmed baseline — always present. */
  readonly baseline: TBaseline;
  /**
   * Provider-derived supplements requiring explicit user confirmation. Empty for
   * `script-only`; for `ai-assisted` these supplement the baseline (R22.6).
   */
  readonly suggestions: readonly AssistSuggestion<TSuggestion>[];
}

/**
 * Every AI-assistable operation implements this shape (design "AI Assist
 * Opt-In-First Pattern"). The orchestrator branches on the user's
 * {@link AssistChoice}:
 *   - `scriptOnly(input)` returns a COMPLETE, deterministic result and MUST issue
 *     ZERO provider calls (R14.6, R20.5, R22.5, R28.5, R30.7, R47.8). It takes no
 *     {@link EgressDestination} and is synchronous, so it cannot reach a provider.
 *   - `aiAssisted(input, dest)` establishes the deterministic baseline first,
 *     then adds provider-derived supplements routed through the Egress Gate. The
 *     supplements never replace the baseline (R22.6) and require explicit user
 *     confirmation before entering the knowledge base (R47.3). Because the
 *     script-only path is a precondition of the AI-assisted path, the
 *     deterministic result is always available regardless of provider state.
 */
export interface AssistableOperation<TInput, TResult> {
  /** Deterministic, complete result; issues zero provider calls (R14.6, R47.8). */
  scriptOnly(input: TInput): TResult;
  /** Deterministic baseline PLUS gate-routed, user-confirmable supplements (R22.6, R47.3). */
  aiAssisted(input: TInput, dest: EgressDestination): Promise<TResult>;
}

/** Type guard: the choice selects the deterministic-only path (R14.5). */
export function isScriptOnly(choice: AssistChoice): boolean {
  return choice.mode === 'script-only';
}

/** Type guard: the choice opts into AI supplements alongside the baseline (R14.5). */
export function isAiAssisted(choice: AssistChoice): boolean {
  return choice.mode === 'ai-assisted';
}

/** Type guard: the choice selects the AI-only path (no script results presented). */
export function isAiOnly(choice: AssistChoice): boolean {
  return choice.mode === 'ai-only';
}

/**
 * Whether the choice reaches a provider at all (any AI mode). `script-only` is
 * the only mode that never constructs an Egress request.
 */
export function usesProvider(choice: AssistChoice): boolean {
  return choice.mode !== 'script-only';
}

/**
 * Wrap a raw model-proposed value as an UNCONFIRMED {@link AssistSuggestion}. The
 * `requiresConfirmation: true` flag is fixed so no caller can mint a supplement
 * that bypasses explicit user confirmation (R47.3).
 */
export function assistSuggestion<TSuggestion>(value: TSuggestion): AssistSuggestion<TSuggestion> {
  return { value, origin: 'ai-suggestion', requiresConfirmation: true };
}

/**
 * Build the `script-only` {@link AssistOutcome}: the complete deterministic
 * baseline with NO suggestions. Used by the `scriptOnly` path, which issues zero
 * provider calls (R14.6, R47.8).
 */
export function scriptOnlyOutcome<TBaseline, TSuggestion = never>(
  baseline: TBaseline,
): AssistOutcome<TBaseline, TSuggestion> {
  return { mode: 'script-only', baseline, suggestions: [] };
}

/**
 * Build the `ai-assisted` {@link AssistOutcome}: the SAME deterministic baseline
 * PLUS provider-derived supplements wrapped as unconfirmed suggestions. The
 * baseline is always carried through unchanged (supplement-not-replace, R22.6),
 * and every supplement requires explicit user confirmation (R47.3). Accepts
 * either already-wrapped suggestions or raw values (wrapped via
 * {@link assistSuggestion}).
 */
export function aiAssistedOutcome<TBaseline, TSuggestion>(
  baseline: TBaseline,
  supplements: readonly (TSuggestion | AssistSuggestion<TSuggestion>)[],
): AssistOutcome<TBaseline, TSuggestion> {
  const suggestions = supplements.map((s) =>
    isAssistSuggestion(s) ? s : assistSuggestion(s),
  );
  return { mode: 'ai-assisted', baseline, suggestions };
}

/** Narrow an arbitrary supplement to an already-wrapped {@link AssistSuggestion}. */
function isAssistSuggestion<TSuggestion>(
  value: TSuggestion | AssistSuggestion<TSuggestion>,
): value is AssistSuggestion<TSuggestion> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as AssistSuggestion<TSuggestion>).origin === 'ai-suggestion' &&
    (value as AssistSuggestion<TSuggestion>).requiresConfirmation === true
  );
}

/**
 * A reusable base implementation that wires the two opt-in-first invariants
 * together so all four components (25.2) get identical behaviour. A concrete
 * operation supplies only:
 *   - {@link computeBaseline} — the pure, deterministic baseline (no provider
 *     call); and
 *   - {@link fetchSuggestions} — the gate-routed supplement step, given the
 *     already-computed baseline so it can supplement rather than replace it.
 *
 * The base guarantees BY CONSTRUCTION that:
 *   - `scriptOnly` calls only `computeBaseline` — zero provider calls (R14.6,
 *     R47.8);
 *   - `aiAssisted` recomputes the SAME baseline first and always returns it
 *     alongside the suggestions (supplement-not-replace, R22.6), with every
 *     suggestion flagged as requiring confirmation (R47.3).
 */
export abstract class BaseAssistableOperation<TInput, TBaseline, TSuggestion>
  implements AssistableOperation<TInput, AssistOutcome<TBaseline, TSuggestion>>
{
  /** Pure, deterministic baseline. MUST NOT call any provider (R14.6, R47.8). */
  protected abstract computeBaseline(input: TInput): TBaseline;

  /**
   * Fetch provider-derived supplements via the Egress Gate. Receives the
   * already-computed `baseline` so supplements extend rather than replace it
   * (R22.6). Returns raw values or wrapped suggestions; the base wraps any raw
   * value as an unconfirmed {@link AssistSuggestion} (R47.3).
   */
  protected abstract fetchSuggestions(
    input: TInput,
    dest: EgressDestination,
    baseline: TBaseline,
  ): Promise<readonly (TSuggestion | AssistSuggestion<TSuggestion>)[]>;

  /** Deterministic, complete result; issues zero provider calls (R14.6, R47.8). */
  scriptOnly(input: TInput): AssistOutcome<TBaseline, TSuggestion> {
    return scriptOnlyOutcome(this.computeBaseline(input));
  }

  /** Baseline first, then gate-routed supplements that require confirmation (R22.6, R47.3). */
  async aiAssisted(
    input: TInput,
    dest: EgressDestination,
  ): Promise<AssistOutcome<TBaseline, TSuggestion>> {
    const baseline = this.computeBaseline(input);
    const supplements = await this.fetchSuggestions(input, dest, baseline);
    return aiAssistedOutcome(baseline, supplements);
  }
}
