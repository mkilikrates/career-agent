// Save-status context (@ui) — task 33.7 (R68.1, R68.2, R68.4, R68.5).
//
// Provides a `SaveStatusContext` that exposes:
//   - `status`: 'saved' | 'saving' | 'temporary'
//   - `notifySaved()`: called after a persist completes to flash "Saved just now"
//
// At startup, the provider probes IndexedDB with a small write to detect whether
// the session is temporary (incognito/OPFS-fallback-only environments where IDB
// may be unavailable or quota-limited). If the probe fails, `status` is locked
// to 'temporary' for the entire session so the user sees the amber warning.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The persistence status surfaced in the header. */
export type SaveStatus = 'saved' | 'saving' | 'temporary';

export interface SaveStatusContextValue {
  /** Current persistence status. */
  readonly status: SaveStatus;
  /** Whether the "just now" flash is active (within 2 s of the last save). */
  readonly flash: boolean;
  /** Notify the context that a persist operation just completed successfully. */
  readonly notifySaved: () => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const SaveStatusContext = createContext<SaveStatusContextValue>({
  status: 'saved',
  flash: false,
  notifySaved: () => {},
});

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const IDB_PROBE_NAME = '__ca_probe';
const FLASH_DURATION_MS = 2000;

/**
 * Attempt a small IndexedDB write to determine whether this session can persist
 * data. Returns `true` when persistence is available; `false` when it is not
 * (e.g. incognito mode on Safari, or IDB is disabled).
 */
async function probeIndexedDB(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  try {
    const req = indexedDB.open(IDB_PROBE_NAME, 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('probe')) {
          db.createObjectStore('probe');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // Attempt a transactional write — some incognito environments accept the
    // open but reject writes due to quota.
    const tx = db.transaction('probe', 'readwrite');
    tx.objectStore('probe').put('ok', 'test');
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    // Clean up the probe database so it does not linger.
    indexedDB.deleteDatabase(IDB_PROBE_NAME);
    return true;
  } catch {
    // Any failure means persistence is unavailable.
    try {
      indexedDB.deleteDatabase(IDB_PROBE_NAME);
    } catch {
      // Best-effort cleanup; ignore.
    }
    return false;
  }
}

export interface SaveStatusProviderProps {
  readonly children: React.ReactNode;
}

export function SaveStatusProvider({ children }: SaveStatusProviderProps) {
  // Determined once on mount: whether the environment can persist data.
  const [baseStatus, setBaseStatus] = useState<'saved' | 'temporary'>('saved');
  // True for FLASH_DURATION_MS after notifySaved() is called.
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Probe IndexedDB on mount to detect temporary-session environments.
  useEffect(() => {
    let cancelled = false;
    void probeIndexedDB().then((ok) => {
      if (!cancelled && !ok) setBaseStatus('temporary');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const notifySaved = useCallback(() => {
    // No flash in temporary mode — status is always 'temporary'.
    if (baseStatus === 'temporary') return;
    setFlash(true);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(false), FLASH_DURATION_MS);
  }, [baseStatus]);

  // Cleanup flash timer on unmount.
  useEffect(() => {
    return () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    };
  }, []);

  const status: SaveStatus = baseStatus === 'temporary' ? 'temporary' : 'saved';

  return (
    <SaveStatusContext.Provider value={{ status, flash, notifySaved }}>
      {children}
    </SaveStatusContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Read the current save status and access `notifySaved`. */
export function useSaveStatus(): SaveStatusContextValue {
  return useContext(SaveStatusContext);
}
