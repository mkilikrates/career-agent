// Source-trace inspector projection (@ui) — task 19.2.
//
// The framework-agnostic glue between the React source-trace inspector
// component and the Provenance / Citation Service trace lookup (R38.2). Given a
// claim reference the user wants to inspect, it resolves the claim to its
// source trace via the injected trace lookup and projects each provenance
// record into a render-ready citation carrying an i18n key + interpolation
// params — so the React layer only calls `t(...)` and never embeds a hardcoded
// user-facing string (R41.8).
//
// Like the phase-wizard controller, it is deliberately React-free so the wiring
// is unit-testable under the project's node test environment. It imports only
// `@core/provenance` / `@core/types` types; it touches no provider, no network,
// and no Memory Store, preserving the UI's module boundary (the UI reaches a
// provider only through the orchestrator behind the single Egress Gate —
// Requirements 6, 7).

import type { ClaimRef, SourceTrace } from '@core/provenance';
import type { Provenance } from '@core/types';

/**
 * The trace lookup the inspector calls to resolve a claim ref to its source
 * trace (R38.2). Returns `undefined` when the claim resolves to no provenance
 * (an unresolved claim). This is exactly the shape exposed by the runtime,
 * which binds it to the session's {@link ProvenanceIndex}.
 */
export type TraceLookup = (ref: ClaimRef) => SourceTrace | undefined;

/** A single provenance record projected for display through i18n. */
export interface CitationView {
  /** The provenance discriminator, preserved for React keying / styling. */
  readonly kind: Provenance['kind'];
  /** Externalised string key the React layer resolves with `t(...)` (R41.8). */
  readonly i18nKey: string;
  /** Interpolation params for the i18n string. */
  readonly params: Record<string, string | number>;
}

/**
 * The render-ready result of inspecting a claim:
 *   * `empty`      — no reference entered yet (initial / cleared state);
 *   * `unresolved` — the reference resolves to no provenance (R38.2);
 *   * `resolved`   — the reference resolves to a non-empty source trace, with
 *                    each citation projected for display.
 */
export type SourceTraceView =
  | { readonly status: 'empty' }
  | { readonly status: 'unresolved'; readonly ref: string }
  | {
      readonly status: 'resolved';
      readonly ref: string;
      readonly citations: readonly CitationView[];
    };

/** Project one provenance record into a render-ready, i18n-keyed citation. */
const citationOf = (record: Provenance): CitationView => {
  switch (record.kind) {
    case 'source_line':
      return {
        kind: 'source_line',
        i18nKey: 'inspector.citation.sourceLine',
        params: { doc: record.doc as unknown as string, line: record.line, quote: record.quote },
      };
    case 'user_confirmation':
      return {
        kind: 'user_confirmation',
        i18nKey: 'inspector.citation.userConfirmation',
        params: { at: record.at as unknown as string, note: record.note },
      };
    case 'interview_answer':
      return {
        kind: 'interview_answer',
        i18nKey: 'inspector.citation.interviewAnswer',
        params: { star: record.star as unknown as string },
      };
  }
};

/**
 * Resolve a (raw, user-entered) claim reference to a {@link SourceTraceView} via
 * the trace lookup (R38.2). A blank/whitespace-only reference yields `empty`; an
 * unknown reference yields `unresolved`; a resolvable reference yields the full
 * source trace with each provenance record projected for display.
 *
 * The reference is keyed only by its string value (provenance refs are branded
 * strings), so the trimmed input is handed to the lookup as-is — any of the
 * stable id kinds (BULLET-NN, STAR-NN, item / skill ids) resolves correctly.
 */
export function inspectClaim(lookup: TraceLookup, rawRef: string): SourceTraceView {
  const ref = rawRef.trim();
  if (ref.length === 0) {
    return { status: 'empty' };
  }
  const trace = lookup(ref as unknown as ClaimRef);
  if (!trace) {
    return { status: 'unresolved', ref };
  }
  return { status: 'resolved', ref, citations: trace.provenance.map(citationOf) };
}
