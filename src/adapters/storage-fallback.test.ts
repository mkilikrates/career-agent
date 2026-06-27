import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { asMemoryPath } from '@core/types';
import { MemoryTree, STORE_ROOT } from '@core/storage';
import {
  DEGRADED_TIER_NOTICE,
  FallbackStorageAdapter,
} from './storage-fallback';
import { InMemoryPersistence } from './fallback-persistence';
import {
  MalformedArchiveError,
  exportTreeToZip,
  importZipToTree,
} from './memory-store-zip';

const fixedClock = () => '2024-05-01T00:00:00.000Z';

/** A fresh adapter backed by an inspectable in-memory persistence. */
const makeAdapter = () => {
  const persistence = new InMemoryPersistence();
  const adapter = new FallbackStorageAdapter({ persistence, now: fixedClock });
  return { adapter, persistence };
};

describe('FallbackStorageAdapter — tier and degraded-tier notice (R3.1, R3.2)', () => {
  it('reports the fallback tier', () => {
    const { adapter } = makeAdapter();
    expect(adapter.tier()).toBe('fallback');
  });

  it('exposes the documented degraded-tier notice', () => {
    const { adapter } = makeAdapter();
    expect(adapter.notice()).toBe(DEGRADED_TIER_NOTICE);
    // The notice must communicate the degraded nature of the tier (R3.2).
    expect(adapter.notice().toLowerCase()).toContain('degraded');
  });
});

describe('FallbackStorageAdapter — read/write/list persistence (R3.1)', () => {
  it('writes then reads text and binary content back', async () => {
    const { adapter } = makeAdapter();
    await adapter.write(asMemoryPath('profile/skill_map.md'), '# Skills\n');
    await adapter.write(
      asMemoryPath('outputs/cv_sre_v1.pdf'),
      new Uint8Array([0, 1, 2, 255]),
    );

    expect(await adapter.read(asMemoryPath('profile/skill_map.md'))).toBe('# Skills\n');
    expect(await adapter.read(asMemoryPath('outputs/cv_sre_v1.pdf'))).toEqual(
      new Uint8Array([0, 1, 2, 255]),
    );
  });

  it('lists by directory in sorted order', async () => {
    const { adapter } = makeAdapter();
    await adapter.write(asMemoryPath('profile/skill_map.md'), 'a');
    await adapter.write(asMemoryPath('profile/accomplishments.md'), 'b');
    await adapter.write(asMemoryPath('config/locale.md'), 'c');

    expect(await adapter.list('profile')).toEqual([
      'profile/accomplishments.md',
      'profile/skill_map.md',
    ]);
  });

  it('hydrates a new adapter from previously persisted data', async () => {
    const persistence = new InMemoryPersistence();
    const first = new FallbackStorageAdapter({ persistence, now: fixedClock });
    await first.write(asMemoryPath('profile/skill_map.md'), 'persisted');

    // A brand-new adapter over the same persistence must see the prior write.
    const second = new FallbackStorageAdapter({ persistence, now: fixedClock });
    expect(await second.read(asMemoryPath('profile/skill_map.md'))).toBe('persisted');
  });
});

describe('FallbackStorageAdapter — one-click .zip export/import (R3.3, R3.4, R3.5)', () => {
  it('exports a single .zip laid out in the canonical directory structure', async () => {
    const { adapter } = makeAdapter();
    await adapter.write(asMemoryPath('profile/skill_map.md'), '# Skills\n');
    await adapter.write(asMemoryPath('outputs/cv_sre_v1.pdf'), new Uint8Array([9, 8, 7]));

    const blob = await adapter.exportZip();
    expect(blob.type).toBe('application/zip');

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    expect(names).toEqual([
      `${STORE_ROOT}/outputs/cv_sre_v1.pdf`,
      `${STORE_ROOT}/profile/skill_map.md`,
    ]);
  });

  it('round-trips a mixed text/binary store through export then import', async () => {
    const source = makeAdapter();
    await source.adapter.write(asMemoryPath('profile/skill_map.md'), '# Skills\n');
    await source.adapter.write(
      asMemoryPath('outputs/cv_sre_v1.pdf'),
      new Uint8Array([10, 20, 30, 200]),
    );
    await source.adapter.write(asMemoryPath('config/locale.md'), 'en-GB');

    const blob = await source.adapter.exportZip();

    const target = makeAdapter();
    await target.adapter.importZip(blob);

    expect(await target.adapter.list('')).toEqual([
      'config/locale.md',
      'outputs/cv_sre_v1.pdf',
      'profile/skill_map.md',
    ]);
    expect(await target.adapter.read(asMemoryPath('profile/skill_map.md'))).toBe('# Skills\n');
    expect(await target.adapter.read(asMemoryPath('config/locale.md'))).toBe('en-GB');
    expect(await target.adapter.read(asMemoryPath('outputs/cv_sre_v1.pdf'))).toEqual(
      new Uint8Array([10, 20, 30, 200]),
    );
  });

  it('import replaces the entire store (restores the archive wholesale)', async () => {
    const source = makeAdapter();
    await source.adapter.write(asMemoryPath('profile/skill_map.md'), 'from-archive');
    const blob = await source.adapter.exportZip();

    const target = makeAdapter();
    await target.adapter.write(asMemoryPath('config/locale.md'), 'pre-existing');
    await target.adapter.importZip(blob);

    // Pre-existing content not in the archive is gone; archive content is present.
    expect(await target.adapter.list('')).toEqual(['profile/skill_map.md']);
    expect(await target.adapter.read(asMemoryPath('profile/skill_map.md'))).toBe('from-archive');
  });
});

describe('FallbackStorageAdapter — malformed archive leaves store intact (R3.4)', () => {
  it('rejects bytes that are not a readable .zip and preserves the store', async () => {
    const { adapter } = makeAdapter();
    await adapter.write(asMemoryPath('profile/skill_map.md'), 'keep-me');

    const garbage = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'application/zip' });
    await expect(adapter.importZip(garbage)).rejects.toBeInstanceOf(MalformedArchiveError);

    // Existing store is completely untouched after a failed import.
    expect(await adapter.list('')).toEqual(['profile/skill_map.md']);
    expect(await adapter.read(asMemoryPath('profile/skill_map.md'))).toBe('keep-me');
  });

  it('rejects an archive containing a non-canonical path and preserves the store', async () => {
    const { adapter, persistence } = makeAdapter();
    await adapter.write(asMemoryPath('profile/skill_map.md'), 'keep-me');
    const before = await persistence.load();

    const zip = new JSZip();
    zip.file(`${STORE_ROOT}/profile/skill_map.md`, 'incoming');
    zip.file('totally/outside/the-layout.md', 'malicious');
    const blob = new Blob([await zip.generateAsync({ type: 'arraybuffer' })]);

    await expect(adapter.importZip(blob)).rejects.toBeInstanceOf(MalformedArchiveError);

    // In-memory store unchanged...
    expect(await adapter.read(asMemoryPath('profile/skill_map.md'))).toBe('keep-me');
    // ...and persistence was never overwritten.
    expect(await persistence.load()).toEqual(before);
  });

  it('rejects an archive with a path-traversal entry', async () => {
    const zip = new JSZip();
    zip.file('career_agent/profile/../../etc/passwd', 'x');
    const blob = new Blob([await zip.generateAsync({ type: 'arraybuffer' })]);

    await expect(importZipToTree(blob)).rejects.toBeInstanceOf(MalformedArchiveError);
  });
});

describe('FallbackStorageAdapter — deleteAll (R34.4)', () => {
  it('empties the store in memory and in persistence', async () => {
    const { adapter, persistence } = makeAdapter();
    await adapter.write(asMemoryPath('profile/skill_map.md'), 'x');

    await adapter.deleteAll();

    expect(await adapter.list('')).toEqual([]);
    expect(await persistence.load()).toBeNull();
  });
});

describe('memory-store-zip codec (R3.3, R3.4)', () => {
  it('exports and re-imports an empty store as an empty store', async () => {
    const blob = await exportTreeToZip(new MemoryTree());
    const tree = await importZipToTree(blob);
    expect(tree.paths()).toEqual([]);
  });

  it('reconstructs an identical snapshot through the archive', async () => {
    const tree = new MemoryTree({ now: fixedClock });
    tree.write('profile/skill_map.md', '# Skills\n');
    tree.write('outputs/cv_sre_v1.pdf', new Uint8Array([1, 2, 3, 253, 254, 255]));
    tree.logAction('exported the store');

    const blob = await exportTreeToZip(tree);
    const rebuilt = await importZipToTree(blob, { now: fixedClock });

    expect(rebuilt.snapshot()).toEqual(tree.snapshot());
  });
});
