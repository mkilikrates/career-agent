// Source-trace inspector (@ui) — task 19.2.
//
// The thin presentation boundary over {@link inspectClaim} / the Provenance /
// Citation Service trace lookup (R38.2). The user enters the reference of a
// claim they want to inspect (a BULLET-NN / STAR-NN / skill id, e.g. one shown
// against an output line) and the inspector presents that claim's SOURCE TRACE:
// every provenance record backing it — a source-document line, an explicit user
// confirmation, or a confirmed interview answer — so a user can audit exactly
// where any claim came from.
//
// All orchestration/projection lives in `source-trace-inspector.ts`; this
// component only holds the input/result UI state and renders. Every user-facing
// string is read from the externalised locale resources via `t(...)` (R41.8);
// none are hardcoded here. No provider client is imported — the lookup is a pure
// resolution over the in-memory provenance index supplied by the runtime, so
// the Egress-Gate-only provider boundary is preserved (Requirements 6, 7).

import { useState } from 'react';
import { inspectClaim, type SourceTraceView, type TraceLookup } from './source-trace-inspector';
import { Button, TextField } from './design-system';

export interface SourceTraceInspectorProps {
  /** The Provenance / Citation Service trace lookup (R38.2). */
  readonly lookup: TraceLookup;
  /** Bound i18n translator (resolves externalised strings, R41.8). */
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}

/** Render the claim-reference input and the resolved source trace. */
export function SourceTraceInspector({ lookup, t }: SourceTraceInspectorProps) {
  const [refInput, setRefInput] = useState('');
  const [view, setView] = useState<SourceTraceView>({ status: 'empty' });

  // Resolve the entered claim ref to its source trace on demand (R38.2).
  const handleInspect = () => setView(inspectClaim(lookup, refInput));

  return (
    <section aria-label={t('inspector.heading')}>
      <h2>{t('inspector.heading')}</h2>
      <p>{t('inspector.intro')}</p>

      <TextField
        label={t('inspector.refLabel')}
        type="text"
        value={refInput}
        onChange={(e) => setRefInput(e.target.value)}
      />{' '}
      <Button onClick={handleInspect}>{t('inspector.inspect')}</Button>

      {/* Resolved source trace, or the empty / unresolved state. */}
      {view.status === 'empty' ? (
        <p>
          <small>{t('inspector.empty')}</small>
        </p>
      ) : view.status === 'unresolved' ? (
        <p data-status="unresolved">{t('inspector.unresolved', { ref: view.ref })}</p>
      ) : (
        <div data-status="resolved" data-ref={view.ref}>
          <h3>{t('inspector.resolvedHeading', { ref: view.ref })}</h3>
          <ol>
            {view.citations.map((citation, index) => (
              <li key={`${citation.kind}-${index}`} data-citation-kind={citation.kind}>
                {t(citation.i18nKey, citation.params)}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
