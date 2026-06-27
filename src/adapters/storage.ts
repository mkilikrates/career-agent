// Storage_Adapter — PLACEHOLDER interface only (no logic, no implementation).
//
// A single interface abstracting both storage tiers. Tier selection is by
// capability detection at startup:
//   - Tier A: File System Access API (Chromium desktop, real Markdown folder)
//   - Tier B: OPFS + IndexedDB fallback, with one-click .zip export/import
//
// Both tiers serialise to the identical canonical directory structure and must
// round-trip identically. The shared, in-memory canonical model is `MemoryTree`
// in `@core/storage` (task 4.1); the tiers persist/hydrate it (tasks 4.2/4.3).
//
// Requirements: 2, 3, 34.

import type { MemoryPath as CanonicalMemoryPath } from '@core/types';

/**
 * Path to a single artefact within the Memory Store, in the canonical,
 * root-relative spelling produced by `@core/storage` `normalizePath`
 * (e.g. `profile/skill_map.md`). Branded so it cannot be confused with a raw
 * string (task 1.2 / 4.1).
 */
export type MemoryPath = CanonicalMemoryPath;

/** A directory within the canonical Memory Store layout (e.g. `profile`). */
export type MemoryDir = string;

/** Which storage tier is active, chosen by capability detection. */
export type StorageTier = 'fs-access' | 'fallback';

export interface StorageAdapter {
  /** Capability detection result (R2 vs R3). */
  tier(): StorageTier;
  /** FS Access folder pick (R2.1). */
  selectRoot(): Promise<void>;
  read(path: MemoryPath): Promise<string | Uint8Array>;
  /** Human-readable Markdown / output file write (R2.3, R34.1). */
  write(path: MemoryPath, data: string | Uint8Array): Promise<void>;
  list(dir: MemoryDir): Promise<MemoryPath[]>;
  /** One-click export of the entire store (R3.3 fallback, R34.4). */
  exportZip(): Promise<Blob>;
  /** Import of a previously exported archive (R3.4). */
  importZip(zip: Blob): Promise<void>;
  /** Full delete of the Memory Store (R34.4). */
  deleteAll(): Promise<void>;
  /** Re-prompt handler when folder access is lost (R2.4). */
  onAccessLost(handler: () => void): void;
}
