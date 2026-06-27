// The canonical in-memory Memory Store model (R34.1, R34.3, R34.4).
//
// The Memory Store *is* the canonical state of the app; in-memory objects are a
// hydrated projection of Markdown that must round-trip losslessly (design
// §Architecture). `MemoryTree` is that projection: a single in-memory model of
// the canonical directory layout (see `./paths`) that BOTH storage tiers build
// on — the File System Access tier (task 4.2) and the OPFS/IndexedDB fallback
// tier (task 4.3). Because both tiers serialise to and from this identical
// structure, they round-trip identically (R3.3–3.5, design Property 5).
//
// Responsibilities:
//   * read / write / list / delete of canonical paths (R34.1)
//   * recording agent actions, user confirmations, and conflict resolutions in
//     `log/session_log.md` (R34.3, R9.4)
//   * full export snapshot + reconstruction, and `deleteAll` (R34.4)

import type { MemoryPath } from '@core/types';
import { asISODate } from '@core/types';
import {
  CANONICAL_FILES,
  isUnderDir,
  normalizeDir,
  normalizePath,
} from './paths';
import {
  parseSessionLog,
  renderSessionLog,
  type SessionLogEntry,
  type SessionLogEventType,
} from './session-log';

/** File content as stored in the tree: text (Markdown/YAML) or raw bytes. */
export type FileContent = string | Uint8Array;

/** Wire-friendly encoding tag for a serialised file. */
export type FileEncoding = 'utf-8' | 'base64';

/** A single serialised file in a {@link MemoryTreeSnapshot}. */
export interface MemoryFileSnapshot {
  path: MemoryPath;
  encoding: FileEncoding;
  content: string;
}

/**
 * A fully serialisable snapshot of the entire store. This is the shared
 * serialization format both tiers use to export/import, guaranteeing identical
 * round trips across tiers (R34.4, design Property 5).
 */
export interface MemoryTreeSnapshot {
  root: string;
  files: MemoryFileSnapshot[];
}

/** Optional construction hooks (a clock, primarily for deterministic tests). */
export interface MemoryTreeOptions {
  /** Source of timestamps for session-log entries; defaults to wall clock. */
  now?: () => string;
}

/** Thrown when reading a path that is not present in the tree. */
export class MemoryPathNotFoundError extends Error {
  constructor(path: string) {
    super(`Memory Store path not found: "${path}"`);
    this.name = 'MemoryPathNotFoundError';
  }
}

const isBinary = (content: FileContent): content is Uint8Array =>
  content instanceof Uint8Array;

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

const cloneContent = (content: FileContent): FileContent =>
  isBinary(content) ? new Uint8Array(content) : content;

/**
 * In-memory model of the canonical Memory Store. Keys are canonical,
 * root-relative paths (e.g. `profile/skill_map.md`); see `./paths`.
 */
export class MemoryTree {
  private readonly files = new Map<string, FileContent>();
  private readonly now: () => string;

  constructor(options: MemoryTreeOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // --- Core file operations (R34.1) --------------------------------------

  /** Write text or binary content to a canonical path (R34.1). */
  write(path: string, data: FileContent): this {
    const key = normalizePath(path);
    this.files.set(key, cloneContent(data));
    return this;
  }

  /** Read a path's content, throwing {@link MemoryPathNotFoundError} if absent. */
  read(path: string): FileContent {
    const key = normalizePath(path);
    const content = this.files.get(key);
    if (content === undefined) {
      throw new MemoryPathNotFoundError(key);
    }
    return cloneContent(content);
  }

  /** Read a text file, throwing if the stored content is binary. */
  readText(path: string): string {
    const content = this.read(path);
    if (isBinary(content)) {
      throw new TypeError(`Path "${normalizePath(path)}" holds binary, not text`);
    }
    return content;
  }

  /** Whether a path is present in the tree. */
  has(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  /** Delete a single path; returns whether it existed. */
  delete(path: string): boolean {
    return this.files.delete(normalizePath(path));
  }

  /** Every path in the tree, in ascending lexicographic order. */
  paths(): MemoryPath[] {
    return [...this.files.keys()].sort().map((p) => p as MemoryPath);
  }

  /**
   * List the paths beneath a directory (e.g. `profile`, `outputs`). Passing an
   * empty string or the store root lists the whole tree.
   */
  list(dir = ''): MemoryPath[] {
    const prefix = normalizeDir(dir);
    return this.paths().filter((p) => isUnderDir(p, prefix));
  }

  /** Number of files currently in the store. */
  get size(): number {
    return this.files.size;
  }

  // --- Session log (R34.3, R9.4) -----------------------------------------

  /** Append a pre-built entry to `log/session_log.md`. */
  appendLog(type: SessionLogEventType, message: string): this {
    const entries = this.sessionLog();
    entries.push({ at: asISODate(this.now()), type, message });
    this.files.set(CANONICAL_FILES.sessionLog, renderSessionLog(entries));
    return this;
  }

  /** Record an agent action (R34.3). */
  logAction(message: string): this {
    return this.appendLog('action', message);
  }

  /** Record a user confirmation (R34.3). */
  logConfirmation(message: string): this {
    return this.appendLog('confirmation', message);
  }

  /** Record a conflict resolution (R34.3, R9.4). */
  logConflictResolution(message: string): this {
    return this.appendLog('conflict-resolution', message);
  }

  /** The parsed session-log entries (empty when no log has been written). */
  sessionLog(): SessionLogEntry[] {
    const raw = this.files.get(CANONICAL_FILES.sessionLog);
    if (raw === undefined || isBinary(raw)) {
      return [];
    }
    return parseSessionLog(raw);
  }

  // --- Export / import / delete (R34.4) ----------------------------------

  /**
   * Produce a fully serialisable snapshot of the entire store. This is the
   * shared serialization both tiers persist/round-trip through (R34.4).
   */
  snapshot(): MemoryTreeSnapshot {
    const files: MemoryFileSnapshot[] = this.paths().map((path) => {
      const content = this.files.get(path)!;
      return isBinary(content)
        ? { path, encoding: 'base64', content: bytesToBase64(content) }
        : { path, encoding: 'utf-8', content };
    });
    return { root: 'career_agent', files };
  }

  /** Replace the entire store contents from a snapshot (R34.4 import). */
  loadSnapshot(snapshot: MemoryTreeSnapshot): this {
    this.files.clear();
    for (const file of snapshot.files) {
      const data: FileContent =
        file.encoding === 'base64' ? base64ToBytes(file.content) : file.content;
      // Re-normalise so an imported snapshot is validated against the layout.
      this.files.set(normalizePath(file.path), data);
    }
    return this;
  }

  /** Build a fresh tree from a snapshot. */
  static fromSnapshot(snapshot: MemoryTreeSnapshot, options?: MemoryTreeOptions): MemoryTree {
    return new MemoryTree(options).loadSnapshot(snapshot);
  }

  /** Delete the entire Memory Store (R34.4). */
  deleteAll(): this {
    this.files.clear();
    return this;
  }
}
