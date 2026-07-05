// Memory Store `.zip` codec for the fallback storage tier (R3.3, R3.4, R34.4).
//
// The fallback tier cannot write a real folder, so the user's portable copy of
// the Memory Store is a single `.zip` archive laid out in the *identical
// canonical directory structure* used everywhere else (see `@core/storage`
// `paths`). Export walks a `MemoryTree` into that archive; import parses an
// archive back into a *fresh* `MemoryTree`.
//
// Import is deliberately transactional: it builds an entirely new tree and
// throws {@link MalformedArchiveError} on the first sign of trouble (an
// unreadable archive or an entry whose path escapes the canonical layout). The
// caller therefore only ever commits a fully-validated tree, leaving the
// existing store intact on failure (design §Error Handling, R3.4).

import JSZip from 'jszip';
import { MemoryTree, STORE_ROOT, normalizePath } from '@core/storage';

/**
 * Thrown when an imported archive cannot be parsed or contains an entry that
 * does not belong to the canonical Memory Store layout. Carries a specific,
 * user-facing message (R3.4 "reject with a specific message").
 */
export class MalformedArchiveError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MalformedArchiveError';
  }
}

/** MIME type stamped on the exported archive Blob. */
export const ZIP_MIME_TYPE = 'application/zip';

// File extensions whose contents are human-readable text (stored/read as
// strings); anything else round-trips as raw bytes. The canonical layout only
// holds Markdown/YAML text plus binary CV exports (`.pdf`, `.docx`).
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'markdown',
  'yaml',
  'yml',
  'txt',
  'json',
  'csv',
]);

const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
};

const isTextPath = (path: string): boolean => TEXT_EXTENSIONS.has(extensionOf(path));

/** The archive entry name for a canonical path, e.g. `career_agent/profile/x.md`. */
const entryNameFor = (canonicalPath: string): string => `${STORE_ROOT}/${canonicalPath}`;

/**
 * Serialise an entire {@link MemoryTree} into a single `.zip` archive in the
 * canonical directory structure (R3.3). Text files are written as UTF-8 strings
 * and binary files (CV PDFs/DOCX) as raw bytes, so the archive is a faithful,
 * human-browsable copy of the store.
 */
export const exportTreeToZip = async (tree: MemoryTree): Promise<Blob> => {
  const zip = new JSZip();
  for (const path of tree.paths()) {
    zip.file(entryNameFor(path), tree.read(path));
  }
  const bytes = await zip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
  });
  return new Blob([bytes], { type: ZIP_MIME_TYPE });
};

/** JSON snapshot filename placed at the zip root (R72.1). */
export const ZIP_SNAPSHOT_FILENAME = 'career-agent-memory-store.json';

/**
 * Build a "Download session" zip (R72.1, R72.2, R72.5):
 * - All Memory Store files in their canonical directory structure
 * - The JSON snapshot (`career-agent-memory-store.json`) at the archive root
 *
 * The returned filename is timestamped: `career-agent-YYYY-MM-DD.zip` (R72.5).
 */
export const exportSessionZip = async (tree: MemoryTree): Promise<{ blob: Blob; filename: string }> => {
  const zip = new JSZip();
  // Add all files at their canonical paths (R72.2)
  for (const path of tree.paths()) {
    zip.file(entryNameFor(path), tree.read(path));
  }
  // Add JSON snapshot at the root (R72.1)
  const snapshot = JSON.stringify(tree.snapshot(), null, 2);
  zip.file(ZIP_SNAPSHOT_FILENAME, snapshot);

  const bytes = await zip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
  });
  const blob = new Blob([bytes], { type: ZIP_MIME_TYPE });
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filename = `career-agent-${today}.zip`;
  return { blob, filename };
};

/**
 * Parse a previously exported archive into a *fresh* {@link MemoryTree} (R3.4).
 *
 * Builds an entirely new tree and never mutates anything the caller already
 * holds, so a malformed archive can be rejected with the existing store left
 * intact. Throws {@link MalformedArchiveError} when the bytes are not a valid
 * archive or any entry's path is outside the canonical layout.
 */
export const importZipToTree = async (
  zip: Blob,
  options?: { now?: () => string },
): Promise<MemoryTree> => {
  let archive: JSZip;
  try {
    const buffer = await zip.arrayBuffer();
    archive = await JSZip.loadAsync(buffer);
  } catch (cause) {
    throw new MalformedArchiveError(
      'The selected file is not a readable .zip archive.',
      { cause },
    );
  }

  const next = new MemoryTree(options);
  // `JSZip.files` includes synthetic directory entries; skip those and keep
  // only real files. Also skip the root-level JSON snapshot
  // (`career-agent-memory-store.json`) that `exportSessionZip` places at the
  // archive root for portability (R72.1) — it is not part of the canonical
  // directory layout.
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);

  for (const entry of entries) {
    // Skip the root-level JSON snapshot if present (it was placed there for
    // human convenience / re-import via JSON, not as a canonical file).
    const baseName = entry.name.replace(/^.*\//, '');
    if (baseName === ZIP_SNAPSHOT_FILENAME && !entry.name.includes(`${STORE_ROOT}/`)) {
      continue;
    }

    let canonicalPath: string;
    try {
      canonicalPath = normalizePath(entry.name);
    } catch (cause) {
      throw new MalformedArchiveError(
        `Archive contains an entry outside the Memory Store layout: "${entry.name}".`,
        { cause },
      );
    }

    try {
      const content = isTextPath(canonicalPath)
        ? await entry.async('string')
        : await entry.async('uint8array');
      next.write(canonicalPath, content);
    } catch (cause) {
      throw new MalformedArchiveError(
        `Archive entry "${entry.name}" could not be read.`,
        { cause },
      );
    }
  }

  return next;
};
