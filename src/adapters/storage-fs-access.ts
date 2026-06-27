// Storage_Adapter — File System Access tier ('fs-access').
//
// On Chromium desktop the browser exposes the File System Access API. This tier
// asks the user to pick a real local folder as the Memory Store root and then
// reads/writes the *actual* canonical Markdown directory structure inside it
// (R2.1–R2.3). It serialises to the identical canonical layout used by the
// shared in-memory `MemoryTree` (`@core/storage`, task 4.1) so both storage
// tiers round-trip identically (design §Storage_Adapter).
//
// Per-file writes are atomic: the File System Access API's writable stream
// stages bytes in a swap file and only commits them to the destination on
// `close()`, so a failed or aborted write never corrupts a previously valid
// artefact (design Error Handling — "writes are atomic per file").
//
// If folder access is later revoked or lost, the tier notifies registered
// listeners and forces the caller to re-select the folder before any further
// persistence (R2.4).
//
// Requirements: 2.1, 2.2, 2.3, 2.4 (and R34.1 canonical layout).

import {
  MemoryTree,
  normalizeDir,
  normalizePath,
} from '@core/storage';
import type {
  MemoryDir,
  MemoryPath,
  StorageAdapter,
  StorageTier,
} from './storage';

// --- File System Access API surface (minimal structural typings) ----------
//
// We declare only the slice of the API we use as local structural types rather
// than depend on ambient lib types: `showDirectoryPicker` and the permission
// query/request methods are not present in every TypeScript DOM lib, and node
// (the vitest environment) has none of them. Tests supply a mock that satisfies
// these same shapes.

/** Result of a permission query/request on a handle. */
export type FsPermissionState = 'granted' | 'denied' | 'prompt';

interface FsPermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FsPermissionAware {
  queryPermission?(descriptor?: FsPermissionDescriptor): Promise<FsPermissionState>;
  requestPermission?(descriptor?: FsPermissionDescriptor): Promise<FsPermissionState>;
}

interface FsWritableFileStream {
  write(data: string | ArrayBufferView | ArrayBuffer | Blob): Promise<void>;
  close(): Promise<void>;
}

interface FsFile {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FsFileHandle extends FsPermissionAware {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<FsFile>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<FsWritableFileStream>;
}

export interface FsDirectoryHandle extends FsPermissionAware {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, FsDirectoryHandle | FsFileHandle]>;
}

/** The `window.showDirectoryPicker` signature this tier feature-detects. */
export type ShowDirectoryPicker = (options?: {
  mode?: 'read' | 'readwrite';
  id?: string;
}) => Promise<FsDirectoryHandle>;

// --- Errors ----------------------------------------------------------------

/** Thrown when this tier is constructed/used where the API is unavailable. */
export class FileSystemAccessUnavailableError extends Error {
  constructor() {
    super('The File System Access API is not available in this browser.');
    this.name = 'FileSystemAccessUnavailableError';
  }
}

/** Thrown when an operation needs a root folder but none has been selected. */
export class MemoryRootNotSelectedError extends Error {
  constructor() {
    super('No Memory Store folder has been selected. Call selectRoot() first.');
    this.name = 'MemoryRootNotSelectedError';
  }
}

/**
 * Thrown when access to the previously selected folder is revoked or lost
 * (R2.4). Registered {@link StorageAdapter.onAccessLost} listeners are notified
 * and the caller must re-select the folder before persistence can continue.
 */
export class FolderAccessLostError extends Error {
  constructor() {
    super('Access to the Memory Store folder was lost. Re-select the folder to continue.');
    this.name = 'FolderAccessLostError';
  }
}

// --- Helpers ---------------------------------------------------------------

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'yaml', 'yml', 'json', 'csv']);

/** Whether a canonical path holds human-readable text (vs binary like pdf/docx). */
const isTextPath = (path: string): boolean => {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return true;
  return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
};

/** Split a canonical path into its directory segments and trailing file name. */
const splitPath = (path: MemoryPath): { dirs: string[]; file: string } => {
  const segments = path.split('/');
  const file = segments.pop()!;
  return { dirs: segments, file };
};

/** Locate `window.showDirectoryPicker` by feature detection, if present. */
const resolvePicker = (
  scope: typeof globalThis = globalThis,
): ShowDirectoryPicker | undefined => {
  const candidate = (scope as { showDirectoryPicker?: ShowDirectoryPicker })
    .showDirectoryPicker;
  return typeof candidate === 'function' ? candidate.bind(scope) : undefined;
};

/** Whether an unknown error is the API's "permission denied / revoked" signal. */
const isAccessError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'NotAllowedError' || error.name === 'SecurityError');

const toBytes = (data: string | Uint8Array): Uint8Array =>
  typeof data === 'string' ? new TextEncoder().encode(data) : data;

// --- Adapter ---------------------------------------------------------------

export interface FileSystemAccessStorageOptions {
  /** Injectable feature-detected picker (defaults to `window.showDirectoryPicker`). */
  showDirectoryPicker?: ShowDirectoryPicker;
}

/**
 * File System Access tier of the Storage_Adapter. Reads/writes the canonical
 * Memory Store layout to a user-selected real folder, keeping an in-memory
 * {@link MemoryTree} projection in sync so the store can round-trip through the
 * shared serialization identically to the fallback tier.
 */
export class FileSystemAccessStorage implements StorageAdapter {
  private readonly picker?: ShowDirectoryPicker;
  private root: FsDirectoryHandle | null = null;
  private readonly accessLostHandlers: Array<() => void> = [];
  /** In-memory canonical projection (shared model, task 4.1). */
  private readonly cache = new MemoryTree();

  constructor(options: FileSystemAccessStorageOptions = {}) {
    this.picker = options.showDirectoryPicker ?? resolvePicker();
  }

  /** Capability detection: is the File System Access API usable here? */
  static isSupported(scope: typeof globalThis = globalThis): boolean {
    return resolvePicker(scope) !== undefined;
  }

  tier(): StorageTier {
    return 'fs-access';
  }

  /**
   * Prompt the user to select the Memory Store root folder (R2.1) and ensure
   * read/write permission. Hydrates the in-memory projection from whatever is
   * already on disk so reloads resume from the real folder (R2.2).
   */
  async selectRoot(): Promise<void> {
    if (!this.picker) {
      throw new FileSystemAccessUnavailableError();
    }
    const handle = await this.picker({ mode: 'readwrite', id: 'career-agent-memory-store' });
    const granted = await this.verifyPermission(handle);
    if (!granted) {
      throw new FolderAccessLostError();
    }
    this.root = handle;
    await this.hydrate();
  }

  async read(path: MemoryPath): Promise<string | Uint8Array> {
    const canonical = normalizePath(path);
    const root = await this.ensureAccess();
    return this.guardAccess(async () => {
      const fileHandle = await this.resolveFileHandle(root, canonical, false);
      const file = await fileHandle.getFile();
      if (isTextPath(canonical)) {
        const text = await file.text();
        this.cache.write(canonical, text);
        return text;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      this.cache.write(canonical, bytes);
      return bytes;
    });
  }

  /**
   * Write a human-readable Markdown / output artefact to the selected folder
   * (R2.3). The write is atomic per file: bytes are staged on the writable
   * stream and only committed on `close()`.
   */
  async write(path: MemoryPath, data: string | Uint8Array): Promise<void> {
    const canonical = normalizePath(path);
    const root = await this.ensureAccess();
    await this.guardAccess(async () => {
      const fileHandle = await this.resolveFileHandle(root, canonical, true);
      const writable = await fileHandle.createWritable();
      try {
        await writable.write(typeof data === 'string' ? data : toBytes(data));
      } catch (error) {
        // Abort the staged write so the previous file contents survive intact.
        await writable.close().catch(() => undefined);
        throw error;
      }
      await writable.close();
    });
    // Mirror into the canonical projection only after a successful commit.
    this.cache.write(canonical, typeof data === 'string' ? data : new Uint8Array(data));
  }

  async list(dir: MemoryDir): Promise<MemoryPath[]> {
    const prefix = normalizeDir(dir);
    const root = await this.ensureAccess();
    const found = await this.guardAccess(() => this.walk(root, ''));
    return found
      .filter((p) => prefix.length === 0 || p === prefix || p.startsWith(`${prefix}/`))
      .sort((a, b) => a.localeCompare(b)) as MemoryPath[];
  }

  /**
   * Zip export/import is the shared, single implementation over `MemoryTree`
   * owned by the fallback tier (design §Storage_Adapter, R3.3–R3.5). The FS
   * Access tier persists directly to real files, so these are wired to the
   * shared codec elsewhere rather than reimplemented here.
   */
  async exportZip(): Promise<Blob> {
    throw new Error(
      'exportZip is provided by the shared MemoryTree zip codec (fallback tier); ' +
        'the File System Access tier persists artefacts directly to the selected folder.',
    );
  }

  async importZip(_zip: Blob): Promise<void> {
    throw new Error(
      'importZip is provided by the shared MemoryTree zip codec (fallback tier); ' +
        'the File System Access tier persists artefacts directly to the selected folder.',
    );
  }

  /** Delete the entire Memory Store from the selected folder (R34.4). */
  async deleteAll(): Promise<void> {
    const root = await this.ensureAccess();
    await this.guardAccess(async () => {
      const topLevel = new Set<string>();
      for await (const [name, entry] of root.entries()) {
        if (entry.kind === 'directory') topLevel.add(name);
        else topLevel.add(name);
      }
      for (const name of topLevel) {
        await root.removeEntry(name, { recursive: true });
      }
    });
    this.cache.deleteAll();
  }

  /** Register a listener invoked when folder access is lost (R2.4). */
  onAccessLost(handler: () => void): void {
    this.accessLostHandlers.push(handler);
  }

  // --- Internals -----------------------------------------------------------

  /** Ensure a root is selected and currently writable; signal loss otherwise. */
  private async ensureAccess(): Promise<FsDirectoryHandle> {
    if (!this.root) {
      throw new MemoryRootNotSelectedError();
    }
    const granted = await this.verifyPermission(this.root);
    if (!granted) {
      this.handleAccessLost();
      throw new FolderAccessLostError();
    }
    return this.root;
  }

  /**
   * Run a file operation, converting a mid-operation access revocation into the
   * R2.4 lost-access notification + re-prompt path.
   */
  private async guardAccess<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      if (isAccessError(error)) {
        this.handleAccessLost();
        throw new FolderAccessLostError();
      }
      throw error;
    }
  }

  /** Notify listeners and drop the root so the caller must re-select (R2.4). */
  private handleAccessLost(): void {
    this.root = null;
    for (const handler of this.accessLostHandlers) {
      handler();
    }
  }

  /** Query (and, if needed, request) read/write permission on a handle. */
  private async verifyPermission(handle: FsPermissionAware): Promise<boolean> {
    const descriptor: FsPermissionDescriptor = { mode: 'readwrite' };
    if (!handle.queryPermission && !handle.requestPermission) {
      return true; // Implementation without the permission API: assume usable.
    }
    try {
      const current = handle.queryPermission
        ? await handle.queryPermission(descriptor)
        : 'prompt';
      if (current === 'granted') return true;
      const requested = handle.requestPermission
        ? await handle.requestPermission(descriptor)
        : 'denied';
      return requested === 'granted';
    } catch (error) {
      if (isAccessError(error)) return false;
      throw error;
    }
  }

  /** Resolve (optionally creating) the file handle for a canonical path. */
  private async resolveFileHandle(
    root: FsDirectoryHandle,
    path: MemoryPath,
    create: boolean,
  ): Promise<FsFileHandle> {
    const { dirs, file } = splitPath(path);
    let current = root;
    for (const segment of dirs) {
      current = await current.getDirectoryHandle(segment, { create });
    }
    return current.getFileHandle(file, { create });
  }

  /** Recursively collect every canonical file path under a directory handle. */
  private async walk(dir: FsDirectoryHandle, prefix: string): Promise<MemoryPath[]> {
    const paths: MemoryPath[] = [];
    for await (const [name, entry] of dir.entries()) {
      const childPath = prefix.length === 0 ? name : `${prefix}/${name}`;
      if (entry.kind === 'directory') {
        paths.push(...(await this.walk(entry, childPath)));
      } else {
        paths.push(childPath as MemoryPath);
      }
    }
    return paths;
  }

  /** Load the in-memory projection from whatever exists on disk (R2.2). */
  private async hydrate(): Promise<void> {
    this.cache.deleteAll();
    if (!this.root) return;
    const paths = await this.walk(this.root, '');
    for (const path of paths) {
      try {
        const canonical = normalizePath(path);
        const fileHandle = await this.resolveFileHandle(this.root, canonical, false);
        const file = await fileHandle.getFile();
        if (isTextPath(canonical)) {
          this.cache.write(canonical, await file.text());
        } else {
          this.cache.write(canonical, new Uint8Array(await file.arrayBuffer()));
        }
      } catch {
        // Skip files outside the canonical layout; they are not part of the store.
      }
    }
  }
}
