// Fallback storage tier: OPFS/IndexedDB persistence with `.zip` export/import
// (Requirements 3.1–3.5, 34.4).
//
// On browsers without the File System Access API (Safari, Firefox, mobile) the
// Storage_Adapter cannot write a real Markdown folder. This tier instead keeps
// the canonical Memory Store in browser-local storage (OPFS for binary,
// IndexedDB for text/index — see `./fallback-persistence`), surfaces the
// documented degraded-tier notice (R3.2), and offers one-click `.zip`
// export/import of the *entire* store (R3.3–3.5) so the user always owns a
// portable copy.
//
// It builds on the shared in-memory `MemoryTree` (`@core/storage`), the same
// canonical model the File System Access tier uses, so both tiers serialise to
// and from one identical structure and round-trip losslessly (design Property 5).

import type { MemoryDir, MemoryPath, StorageAdapter, StorageTier } from './storage';
import { MemoryTree } from '@core/storage';
import {
  createFallbackPersistence,
  type FallbackPersistence,
} from './fallback-persistence';
import { exportTreeToZip, importZipToTree } from './memory-store-zip';

/**
 * The documented degraded-tier notice shown while the fallback tier is active
 * (R3.2). States that data lives inside the browser rather than in a chosen
 * folder, and points the user at export/import for a portable copy.
 */
export const DEGRADED_TIER_NOTICE =
  'Career Agent is running in a documented degraded storage tier. Your Memory ' +
  'Store is kept inside this browser (OPFS/IndexedDB) rather than as files in a ' +
  'folder you control. Use Export to download a .zip backup of your entire ' +
  'Memory Store, and Import to restore it on another browser or device.';

/** Construction options for {@link FallbackStorageAdapter}. */
export interface FallbackStorageAdapterOptions {
  /** Persistence backend; defaults to OPFS/IndexedDB with an in-memory fallback. */
  persistence?: FallbackPersistence;
  /** Clock for session-log timestamps; forwarded to the underlying tree. */
  now?: () => string;
}

export class FallbackStorageAdapter implements StorageAdapter {
  private tree: MemoryTree;
  private readonly persistence: FallbackPersistence;
  private readonly now?: () => string;
  private hydrated = false;

  constructor(options: FallbackStorageAdapterOptions = {}) {
    this.now = options.now;
    this.persistence = options.persistence ?? createFallbackPersistence();
    this.tree = new MemoryTree({ now: this.now });
  }

  /** Capability-detection result — always the fallback tier here (R3.1). */
  tier(): StorageTier {
    return 'fallback';
  }

  /**
   * The documented degraded-tier notice the UI displays while this tier is
   * active (R3.2).
   */
  notice(): string {
    return DEGRADED_TIER_NOTICE;
  }

  /**
   * No-op in the fallback tier: there is no real folder to pick. Present to
   * satisfy the shared adapter contract (folder selection is R2.1, FS Access).
   */
  async selectRoot(): Promise<void> {
    // Intentionally empty.
  }

  async read(path: MemoryPath): Promise<string | Uint8Array> {
    await this.hydrate();
    return this.tree.read(path);
  }

  async write(path: MemoryPath, data: string | Uint8Array): Promise<void> {
    await this.hydrate();
    this.tree.write(path, data);
    await this.persistence.save(this.tree.snapshot());
  }

  async list(dir: MemoryDir): Promise<MemoryPath[]> {
    await this.hydrate();
    return this.tree.list(dir);
  }

  /**
   * One-click export of the entire store as a single `.zip` in the canonical
   * directory structure (R3.3, R3.5, R34.4).
   */
  async exportZip(): Promise<Blob> {
    await this.hydrate();
    return exportTreeToZip(this.tree);
  }

  /**
   * One-click import that restores the entire store from a `.zip` (R3.4, R3.5).
   *
   * Transactional: the archive is parsed into a fresh tree and only committed
   * (in memory and to persistence) once it has fully validated. A malformed
   * archive throws {@link import('./memory-store-zip').MalformedArchiveError}
   * and leaves the existing store completely intact (design §Error Handling).
   */
  async importZip(zip: Blob): Promise<void> {
    await this.hydrate();
    const next = await importZipToTree(zip, { now: this.now });
    // Persist first so a persistence failure also leaves the live tree intact.
    await this.persistence.save(next.snapshot());
    this.tree = next;
  }

  /** Fully delete the entire Memory Store, in memory and on disk (R34.4). */
  async deleteAll(): Promise<void> {
    this.tree.deleteAll();
    this.hydrated = true; // avoid re-hydrating stale persisted data afterwards
    await this.persistence.clear();
  }

  /**
   * Register a lost-access handler to satisfy the contract. The fallback tier
   * never loses access (data is owned by the browser, not a revocable folder),
   * so the handler is intentionally ignored here (R2.4 applies to FS Access).
   */
  onAccessLost(_handler: () => void): void {
    // Intentionally ignored: the fallback tier cannot lose access.
  }

  /** Lazily hydrate the in-memory tree from persistence on first access. */
  private async hydrate(): Promise<void> {
    if (this.hydrated) {
      return;
    }
    const snapshot = await this.persistence.load();
    if (snapshot) {
      this.tree.loadSnapshot(snapshot);
    }
    this.hydrated = true;
  }
}
