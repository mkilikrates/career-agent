// Memory & Maintenance screen (@ui) — Phase 6 (R34), on the shared design system.
//
// Surfaces the user-owned Memory Store: lists the stored files, shows the
// session log (actions / confirmations / conflict resolutions, R34.3), and
// supports a full export/import of the store as a JSON snapshot so the user can
// back it up and restore it (R34.4). Local only — no provider is touched.
//
// Built entirely from the shared component library and screen-state primitives,
// so its controls inherit the design tokens, keyboard operability, focus
// indicator (R58.1, R58.4, R58.10), and the empty/error states are consistent
// with every other screen (R58.6, R58.8). No typography/colour/spacing is
// hardcoded here.

import { useState } from 'react';
import { MemoryTree } from '@core/storage';
import { Button, Row, EmptyState, ErrorState, Banner } from './design-system';

export interface MemoryScreenProps {
  readonly store: MemoryTree;
  /** Notify the shell that the store changed (e.g. after an import) to re-render. */
  readonly onChanged: () => void;
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}

export function MemoryScreen({ store, onChanged, t }: MemoryScreenProps) {
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');

  const paths = store.paths();
  const log = store.sessionLog();

  const handleExport = () => {
    const json = JSON.stringify(store.snapshot(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'career-agent-memory-store.json';
    a.click();
    URL.revokeObjectURL(url);
    setError('');
    setStatus(t('memory.exported'));
  };

  const handleImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      store.loadSnapshot(JSON.parse(text));
      onChanged();
      setError('');
      setStatus(t('memory.imported', { count: store.paths().length }));
    } catch (e) {
      // Error state: describe the failure + recovery, keep the screen usable so
      // no prior input is lost (R58.8).
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section aria-label={t('memory.heading')} data-memory-screen>
      <h3>{t('memory.heading')}</h3>
      <p>{t('memory.intro')}</p>

      <Row>
        <Button onClick={handleExport}>{t('memory.export')}</Button>
        <label>
          {t('memory.import')}{' '}
          <input
            type="file"
            aria-label={t('memory.import')}
            accept=".json,application/json"
            onChange={(e) => {
              void handleImport(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
      </Row>

      {error ? (
        <ErrorState message={t('memory.error', { reason: error })} recovery={t('memory.errorRecovery')} />
      ) : status ? (
        <Banner role="status">
          <small>{status}</small>
        </Banner>
      ) : null}

      <h4>{t('memory.filesHeading')}</h4>
      {paths.length === 0 ? (
        <EmptyState message={t('memory.noFiles')} />
      ) : (
        <ul>
          {paths.map((p) => (
            <li key={p as unknown as string}>
              <small>{p as unknown as string}</small>
            </li>
          ))}
        </ul>
      )}

      <h4>{t('memory.logHeading')}</h4>
      {log.length === 0 ? (
        <EmptyState message={t('memory.noLog')} />
      ) : (
        <ul>
          {log.map((entry, i) => (
            <li key={`${entry.at}-${i}`}>
              <small>
                [{entry.type}] {entry.message}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
