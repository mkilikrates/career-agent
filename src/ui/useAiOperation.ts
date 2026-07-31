// @ui/useAiOperation — shared hook for AI-assist busy/error state and try/catch
// wiring. Eliminates the duplicated `[aiBusy, setAiBusy] + [aiError, setAiError]
// + try/catch` pattern across screens.

import { useState } from 'react';

/**
 * Shared hook that manages the busy/error state for an AI-assist operation and
 * wraps the async execution in a standard try/catch/finally. Used by screens
 * that wire AI-assist (OutputScreen, RoleDiscoveryScreen, etc.).
 */
export function useAiOperation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, setError, run };
}
