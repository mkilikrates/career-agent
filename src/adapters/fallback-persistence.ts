// Persistence backend for the fallback storage tier (R3.1).
//
// On browsers without the File System Access API the Memory Store is kept in
// browser-local storage. Per design, large/binary artefacts live in OPFS and
// text/index data lives in IndexedDB (via `idb`). The {@link FallbackPersistence}
// interface is the swappable boundary the fallback adapter persists its
// canonical {@link MemoryTreeSnapshot} through; the concrete
// {@link OpfsIdbPersistence} is the real browser implementation, while tests
// (and non-browser environments) supply an in-memory double.

import { openDB, type IDBPDatabase } from 'idb';
import type { MemoryTreeSnapshot } from '@core/storage';

/**
 * The swappable persistence boundary for the fallback tier. Stores and restores
 * the whole store as a single canonical snapshot so the adapter logic stays
 * independent of the underlying browser APIs (and testable without them).
 */
export interface FallbackPersistence {
  /** Load the persisted snapshot, or `null` when nothing has been stored yet. */
  load(): Promise<MemoryTreeSnapshot | null>;
  /** Persist the entire store, replacing any previously stored snapshot. */
  save(snapshot: MemoryTreeSnapshot): Promise<void>;
  /** Remove all persisted data (R34.4 full delete). */
  clear(): Promise<void>;
}

// --- base64 <-> bytes (binary lives in OPFS as raw bytes) -----------------

const base64ToBytes = (b64: string): Uint8Array => {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

/** OPFS uses a flat namespace; canonical `/` separators are escaped per entry. */
const opfsName = (canonicalPath: string): string =>
  encodeURIComponent(canonicalPath);

// --- In-memory double ------------------------------------------------------

/**
 * A non-persistent {@link FallbackPersistence} used in tests and any
 * environment lacking OPFS/IndexedDB. It keeps the snapshot in memory only, so
 * the adapter's logic can be exercised without browser storage APIs.
 */
export class InMemoryPersistence implements FallbackPersistence {
  private snapshot: MemoryTreeSnapshot | null = null;

  async load(): Promise<MemoryTreeSnapshot | null> {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  async save(snapshot: MemoryTreeSnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot);
  }

  async clear(): Promise<void> {
    this.snapshot = null;
  }
}

// --- Real browser backend: OPFS (binary) + IndexedDB (text/index) ---------

const DB_NAME = 'career-agent-memory-store';
const DB_VERSION = 1;
/** IndexedDB object store for text files, keyed by canonical path. */
const TEXT_STORE = 'text-files';
/** IndexedDB object store holding the single store-wide index record. */
const INDEX_STORE = 'index';
const INDEX_KEY = 'snapshot-index';
/** OPFS sub-directory holding raw binary artefacts. */
const OPFS_DIR = 'career-agent-blobs';

/** The lightweight index persisted in IndexedDB describing the whole store. */
interface SnapshotIndex {
  root: string;
  entries: { path: string; encoding: 'utf-8' | 'base64' }[];
}

/**
 * Real fallback persistence: text content and the store index live in
 * IndexedDB (via `idb`); binary artefacts live in OPFS as raw bytes. Together
 * they reconstitute the identical canonical {@link MemoryTreeSnapshot} (R3.1).
 */
export class OpfsIdbPersistence implements FallbackPersistence {
  private dbPromise?: Promise<IDBPDatabase>;

  private db(): Promise<IDBPDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(TEXT_STORE)) {
            db.createObjectStore(TEXT_STORE);
          }
          if (!db.objectStoreNames.contains(INDEX_STORE)) {
            db.createObjectStore(INDEX_STORE);
          }
        },
      });
    }
    return this.dbPromise;
  }

  private async opfsDir(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(OPFS_DIR, { create: true });
  }

  async load(): Promise<MemoryTreeSnapshot | null> {
    const db = await this.db();
    const index = (await db.get(INDEX_STORE, INDEX_KEY)) as SnapshotIndex | undefined;
    if (!index) {
      return null;
    }

    const dir = await this.opfsDir();
    const files = await Promise.all(
      index.entries.map(async ({ path, encoding }) => {
        if (encoding === 'utf-8') {
          const content = (await db.get(TEXT_STORE, path)) as string | undefined;
          return { path, encoding, content: content ?? '' } as const;
        }
        const handle = await dir.getFileHandle(opfsName(path));
        const file = await handle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        return { path, encoding, content: bytesToBase64(bytes) } as const;
      }),
    );

    return {
      root: index.root,
      files: files.map((f) => ({
        path: f.path as MemoryTreeSnapshot['files'][number]['path'],
        encoding: f.encoding,
        content: f.content,
      })),
    };
  }

  async save(snapshot: MemoryTreeSnapshot): Promise<void> {
    // Replace everything so a save reflects exactly the supplied snapshot.
    await this.clear();

    const db = await this.db();
    const dir = await this.opfsDir();

    for (const file of snapshot.files) {
      if (file.encoding === 'utf-8') {
        await db.put(TEXT_STORE, file.content, file.path);
      } else {
        const handle = await dir.getFileHandle(opfsName(file.path), { create: true });
        const writable = await handle.createWritable();
        await writable.write(base64ToBytes(file.content) as unknown as FileSystemWriteChunkType);
        await writable.close();
      }
    }

    const index: SnapshotIndex = {
      root: snapshot.root,
      entries: snapshot.files.map((f) => ({ path: f.path, encoding: f.encoding })),
    };
    await db.put(INDEX_STORE, index, INDEX_KEY);
  }

  async clear(): Promise<void> {
    const db = await this.db();
    await db.clear(TEXT_STORE);
    await db.clear(INDEX_STORE);

    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry(OPFS_DIR, { recursive: true });
    } catch {
      // Directory may not exist yet; nothing to remove.
    }
  }
}

/**
 * Build the appropriate persistence for the current environment: the real
 * OPFS/IndexedDB backend when those APIs exist, otherwise a non-persistent
 * in-memory double (so the app still runs, e.g. in tests or unsupported envs).
 */
export const createFallbackPersistence = (): FallbackPersistence => {
  const hasOpfs =
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function';
  const hasIndexedDb = typeof indexedDB !== 'undefined';
  return hasOpfs && hasIndexedDb ? new OpfsIdbPersistence() : new InMemoryPersistence();
};
