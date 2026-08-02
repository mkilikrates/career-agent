// Feature: career-agent, Property 5: Memory Store and session-state round trip
//
// For any Memory Store tree (and for any mid-question coaching session state),
// exporting/serialising and then importing/deserialising reconstructs an
// identical store/state, and the result is identical across the File System
// Access tier and the fallback tier.
//
// **Validates: Requirements 3.3, 3.4, 3.5, 25.4**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { MemoryTree } from './memory-tree';
import { CANONICAL_DIRS } from './paths';
import { exportTreeToZip, importZipToTree } from '@adapters/memory-store-zip';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Canonical directories where files may live. */
const dirs = Object.values(CANONICAL_DIRS);

/** Generate a valid canonical filename (alphanumeric + some separators). */
const arbFilename = fc
  .stringMatching(/^[a-z][a-z0-9_-]{1,20}\.(md|yaml|json|txt)$/)
  .filter((s) => s.length > 3);

/** Generate a canonical path under a random canonical directory. */
const arbPath = fc.tuple(
  fc.constantFrom(...dirs),
  arbFilename,
).map(([dir, file]) => `${dir}/${file}`);

/** Generate UTF-8 text content (non-empty). */
const arbTextContent = fc.string({ minLength: 1, maxLength: 500 });

/** Generate a file entry: path + text content. */
const arbFileEntry = fc.tuple(arbPath, arbTextContent);

/** Generate a tree with 1-15 unique files. */
const arbTreeFiles = fc
  .array(arbFileEntry, { minLength: 1, maxLength: 15 })
  .map((entries) => {
    // De-duplicate paths (keep first occurrence)
    const seen = new Set<string>();
    return entries.filter(([path]) => {
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    });
  })
  .filter((entries) => entries.length >= 1);

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('@core/storage — Property 5: Memory Store round trip via snapshot', () => {
  it('snapshot → loadSnapshot reconstructs an identical store (text files)', () => {
    fc.assert(
      fc.property(arbTreeFiles, (files) => {
        const tree = new MemoryTree({ now: () => '2024-06-01T00:00:00.000Z' });
        for (const [path, content] of files) {
          tree.write(path, content);
        }

        // Export to snapshot
        const snapshot = tree.snapshot();

        // Import into a fresh tree
        const restored = MemoryTree.fromSnapshot(snapshot, {
          now: () => '2024-06-01T00:00:00.000Z',
        });

        // Same number of files
        expect(restored.size).toBe(tree.size);

        // Every file matches content
        for (const [path, content] of files) {
          expect(restored.has(path)).toBe(true);
          expect(restored.readText(path)).toBe(content);
        }

        // Paths are identical
        expect(restored.paths()).toEqual(tree.paths());
      }),
      { numRuns: 200 },
    );
  });

  it('snapshot → loadSnapshot → snapshot produces an identical snapshot', () => {
    fc.assert(
      fc.property(arbTreeFiles, (files) => {
        const tree = new MemoryTree({ now: () => '2024-06-01T00:00:00.000Z' });
        for (const [path, content] of files) {
          tree.write(path, content);
        }

        const snapshot1 = tree.snapshot();
        const restored = MemoryTree.fromSnapshot(snapshot1, {
          now: () => '2024-06-01T00:00:00.000Z',
        });
        const snapshot2 = restored.snapshot();

        // Snapshots are identical (same root, same files)
        expect(snapshot2.root).toBe(snapshot1.root);
        expect(snapshot2.files).toEqual(snapshot1.files);
      }),
      { numRuns: 200 },
    );
  });

  it('binary content round-trips through snapshot (base64 encoding)', () => {
    fc.assert(
      fc.property(
        arbPath.map((p) => p.replace(/\.(md|yaml|json|txt)$/, '.pdf')),
        fc.uint8Array({ minLength: 1, maxLength: 200 }),
        (path, bytes) => {
          const tree = new MemoryTree();
          tree.write(path, bytes);

          const snapshot = tree.snapshot();
          const restored = MemoryTree.fromSnapshot(snapshot);

          const restoredContent = restored.read(path);
          expect(restoredContent).toBeInstanceOf(Uint8Array);
          expect(restoredContent).toEqual(bytes);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('zip export → zip import reconstructs an identical store', async () => {
    await fc.assert(
      fc.asyncProperty(arbTreeFiles, async (files) => {
        const tree = new MemoryTree({ now: () => '2024-06-01T00:00:00.000Z' });
        for (const [path, content] of files) {
          tree.write(path, content);
        }

        // Export to zip
        const blob = await exportTreeToZip(tree);

        // Import from zip
        const restored = await importZipToTree(blob, {
          now: () => '2024-06-01T00:00:00.000Z',
        });

        // Same number of files
        expect(restored.size).toBe(tree.size);

        // Every file matches
        for (const [path, content] of files) {
          expect(restored.has(path)).toBe(true);
          expect(restored.readText(path)).toBe(content);
        }

        // Paths match
        expect(restored.paths()).toEqual(tree.paths());
      }),
      { numRuns: 100 },
    );
  });

  it('session log entries survive the round trip', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 80 }), { minLength: 1, maxLength: 5 }),
        (messages) => {
          const tree = new MemoryTree({ now: () => '2024-06-15T12:00:00.000Z' });
          for (const msg of messages) {
            tree.logAction(msg);
          }

          const snapshot = tree.snapshot();
          const restored = MemoryTree.fromSnapshot(snapshot, {
            now: () => '2024-06-15T12:00:00.000Z',
          });

          const originalLog = tree.sessionLog();
          const restoredLog = restored.sessionLog();

          expect(restoredLog.length).toBe(originalLog.length);
          for (let i = 0; i < originalLog.length; i++) {
            expect(restoredLog[i].message).toBe(originalLog[i].message);
            expect(restoredLog[i].type).toBe(originalLog[i].type);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
