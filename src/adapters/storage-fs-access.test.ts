import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMemoryPath } from '@core/types';
import {
  FileSystemAccessStorage,
  FileSystemAccessUnavailableError,
  FolderAccessLostError,
  MemoryRootNotSelectedError,
  type FsDirectoryHandle,
  type FsFileHandle,
  type FsPermissionState,
  type ShowDirectoryPicker,
} from './storage-fs-access';

// --- Mocked File System Access API ----------------------------------------
// vitest runs in node, which has no real File System Access API. These mocks
// satisfy the same structural shapes the adapter depends on (design: external
// boundaries are mocked).

const accessError = (name: 'NotAllowedError' | 'SecurityError'): Error => {
  const error = new Error(`${name} (mock)`);
  error.name = name;
  return error;
};

const notFoundError = (): Error => {
  const error = new Error('A requested file or directory could not be found.');
  error.name = 'NotFoundError';
  return error;
};

class MockFile {
  constructor(private readonly bytes: Uint8Array) {}
  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.slice().buffer;
  }
}

interface MockFileOptions {
  /** Throw a generic (non-access) error during write to exercise atomicity. */
  failWriteGeneric?: boolean;
  /** Throw an access error during write to exercise lost-access detection. */
  failWriteAccess?: boolean;
}

class MockWritable {
  private staged: Uint8Array | null = null;
  constructor(
    private readonly handle: MockFileHandle,
    private readonly options: MockFileOptions,
  ) {}

  async write(data: string | ArrayBufferView | ArrayBuffer | Blob): Promise<void> {
    if (this.options.failWriteGeneric) throw new Error('disk full (mock)');
    if (this.options.failWriteAccess) throw accessError('NotAllowedError');
    this.staged =
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : new Uint8Array(data as ArrayBuffer);
  }

  async close(): Promise<void> {
    // Atomic commit: destination only changes once staged bytes are committed.
    if (this.staged !== null) this.handle.commit(this.staged);
  }
}

class MockFileHandle implements FsFileHandle {
  readonly kind = 'file' as const;
  content: Uint8Array;
  constructor(
    readonly name: string,
    content: Uint8Array = new Uint8Array(),
    private readonly options: MockFileOptions = {},
  ) {
    this.content = content;
  }
  async getFile(): Promise<MockFile> {
    return new MockFile(this.content);
  }
  async createWritable(): Promise<MockWritable> {
    return new MockWritable(this, this.options);
  }
  commit(bytes: Uint8Array): void {
    this.content = bytes;
  }
}

class MockDirectoryHandle implements FsDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, MockDirectoryHandle | MockFileHandle>();
  permission: FsPermissionState = 'granted';

  constructor(readonly name = 'memory-store') {}

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MockDirectoryHandle> {
    const existing = this.children.get(name);
    if (!existing) {
      if (!options?.create) throw notFoundError();
      const dir = new MockDirectoryHandle(name);
      this.children.set(name, dir);
      return dir;
    }
    if (existing.kind !== 'directory') throw new Error(`${name} is a file`);
    return existing;
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MockFileHandle> {
    const existing = this.children.get(name);
    if (!existing) {
      if (!options?.create) throw notFoundError();
      const file = new MockFileHandle(name);
      this.children.set(name, file);
      return file;
    }
    if (existing.kind !== 'file') throw new Error(`${name} is a directory`);
    return existing;
  }

  async removeEntry(name: string): Promise<void> {
    this.children.delete(name);
  }

  async *entries(): AsyncIterableIterator<[string, MockDirectoryHandle | MockFileHandle]> {
    for (const entry of this.children) {
      yield entry;
    }
  }

  async queryPermission(): Promise<FsPermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<FsPermissionState> {
    return this.permission;
  }

  /** Test helper: pre-seed a file at a canonical path. */
  seed(path: string, content: Uint8Array, options?: MockFileOptions): MockFileHandle {
    const segments = path.split('/');
    const fileName = segments.pop()!;
    let dir: MockDirectoryHandle = this;
    for (const segment of segments) {
      let next = dir.children.get(segment);
      if (!next || next.kind !== 'directory') {
        next = new MockDirectoryHandle(segment);
        dir.children.set(segment, next);
      }
      dir = next as MockDirectoryHandle;
    }
    const handle = new MockFileHandle(fileName, content, options);
    dir.children.set(fileName, handle);
    return handle;
  }
}

const pickerFor = (handle: FsDirectoryHandle): ShowDirectoryPicker => () =>
  Promise.resolve(handle);

const newAdapter = async (): Promise<{
  adapter: FileSystemAccessStorage;
  root: MockDirectoryHandle;
}> => {
  const root = new MockDirectoryHandle();
  const adapter = new FileSystemAccessStorage({ showDirectoryPicker: pickerFor(root) });
  await adapter.selectRoot();
  return { adapter, root };
};

afterEach(() => {
  delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  vi.restoreAllMocks();
});

describe('FileSystemAccessStorage — capability detection (R2.1)', () => {
  it('reports the tier id', () => {
    const adapter = new FileSystemAccessStorage({ showDirectoryPicker: pickerFor(new MockDirectoryHandle()) });
    expect(adapter.tier()).toBe('fs-access');
  });

  it('detects support from window.showDirectoryPicker', () => {
    expect(FileSystemAccessStorage.isSupported()).toBe(false);
    (globalThis as { showDirectoryPicker?: ShowDirectoryPicker }).showDirectoryPicker =
      pickerFor(new MockDirectoryHandle());
    expect(FileSystemAccessStorage.isSupported()).toBe(true);
  });

  it('throws when selectRoot is called without API support', async () => {
    const adapter = new FileSystemAccessStorage();
    await expect(adapter.selectRoot()).rejects.toBeInstanceOf(
      FileSystemAccessUnavailableError,
    );
  });

  it('throws when operating before a root is selected', async () => {
    const adapter = new FileSystemAccessStorage({
      showDirectoryPicker: pickerFor(new MockDirectoryHandle()),
    });
    await expect(adapter.read(asMemoryPath('profile/skill_map.md'))).rejects.toBeInstanceOf(
      MemoryRootNotSelectedError,
    );
  });
});

describe('FileSystemAccessStorage — read/write canonical layout (R2.2, R2.3)', () => {
  it('writes Markdown to the canonical directory structure and reads it back', async () => {
    const { adapter, root } = await newAdapter();
    await adapter.write(asMemoryPath('profile/skill_map.md'), '# Skill Map\n');

    // Real nested folder/file created under the selected root.
    const profile = root.children.get('profile') as MockDirectoryHandle;
    expect(profile.kind).toBe('directory');
    expect(profile.children.has('skill_map.md')).toBe(true);

    expect(await adapter.read(asMemoryPath('profile/skill_map.md'))).toBe('# Skill Map\n');
  });

  it('round-trips binary output files as bytes', async () => {
    const { adapter } = await newAdapter();
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 255, 10]);
    await adapter.write(asMemoryPath('outputs/cv_sre_v1.pdf'), pdf);

    const read = await adapter.read(asMemoryPath('outputs/cv_sre_v1.pdf'));
    expect(read).toBeInstanceOf(Uint8Array);
    expect(read).toEqual(pdf);
  });

  it('normalises a store-root-prefixed path to the canonical layout', async () => {
    const { adapter, root } = await newAdapter();
    await adapter.write(asMemoryPath('career_agent/config/locale.md'), 'en');
    const config = root.children.get('config') as MockDirectoryHandle;
    expect(config.children.has('locale.md')).toBe(true);
    expect(await adapter.read(asMemoryPath('config/locale.md'))).toBe('en');
  });

  it('lists canonical paths under a directory, sorted, scoped by prefix', async () => {
    const { adapter } = await newAdapter();
    await adapter.write(asMemoryPath('profile/skill_map.md'), 'a');
    await adapter.write(asMemoryPath('profile/accomplishments.md'), 'b');
    await adapter.write(asMemoryPath('config/locale.md'), 'c');

    expect(await adapter.list('profile')).toEqual([
      'profile/accomplishments.md',
      'profile/skill_map.md',
    ]);
    expect(await adapter.list('')).toEqual([
      'config/locale.md',
      'profile/accomplishments.md',
      'profile/skill_map.md',
    ]);
  });

  it('hydrates the projection from a folder that already has files', async () => {
    const root = new MockDirectoryHandle();
    root.seed('profile/skill_map.md', new TextEncoder().encode('# Pre-existing\n'));
    const adapter = new FileSystemAccessStorage({ showDirectoryPicker: pickerFor(root) });
    await adapter.selectRoot();

    expect(await adapter.list('profile')).toEqual(['profile/skill_map.md']);
    expect(await adapter.read(asMemoryPath('profile/skill_map.md'))).toBe('# Pre-existing\n');
  });

  it('surfaces a missing-file read as a non-access error', async () => {
    const { adapter } = await newAdapter();
    await expect(adapter.read(asMemoryPath('profile/skill_map.md'))).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });
});

describe('FileSystemAccessStorage — atomic per-file writes', () => {
  it('leaves the previous file contents intact when a write fails mid-stream', async () => {
    const root = new MockDirectoryHandle();
    // Pre-seed a valid artefact whose writable will fail on the next write.
    root.seed('profile/skill_map.md', new TextEncoder().encode('GOOD'), {
      failWriteGeneric: true,
    });
    const adapter = new FileSystemAccessStorage({ showDirectoryPicker: pickerFor(root) });
    await adapter.selectRoot();

    await expect(
      adapter.write(asMemoryPath('profile/skill_map.md'), 'NEW'),
    ).rejects.toThrow('disk full (mock)');

    // The committed-on-close semantics mean the old bytes survive the failure.
    expect(await adapter.read(asMemoryPath('profile/skill_map.md'))).toBe('GOOD');
  });
});

describe('FileSystemAccessStorage — lost access detection and re-prompt (R2.4)', () => {
  it('notifies listeners and blocks writes when permission is revoked', async () => {
    const { adapter, root } = await newAdapter();
    const onLost = vi.fn();
    adapter.onAccessLost(onLost);

    root.permission = 'denied'; // user revoked folder access

    await expect(adapter.write(asMemoryPath('profile/skill_map.md'), 'x')).rejects.toBeInstanceOf(
      FolderAccessLostError,
    );
    expect(onLost).toHaveBeenCalledTimes(1);

    // Persistence is blocked until the folder is re-selected.
    await expect(adapter.read(asMemoryPath('profile/skill_map.md'))).rejects.toBeInstanceOf(
      MemoryRootNotSelectedError,
    );
  });

  it('detects access loss that happens mid-write', async () => {
    const root = new MockDirectoryHandle();
    root.seed('profile/skill_map.md', new TextEncoder().encode('OLD'), {
      failWriteAccess: true,
    });
    const adapter = new FileSystemAccessStorage({ showDirectoryPicker: pickerFor(root) });
    await adapter.selectRoot();
    const onLost = vi.fn();
    adapter.onAccessLost(onLost);

    await expect(
      adapter.write(asMemoryPath('profile/skill_map.md'), 'NEW'),
    ).rejects.toBeInstanceOf(FolderAccessLostError);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('resumes persistence after the user re-selects a folder', async () => {
    const { adapter, root } = await newAdapter();
    const onLost = vi.fn();
    adapter.onAccessLost(onLost);

    root.permission = 'denied';
    await expect(adapter.write(asMemoryPath('config/locale.md'), 'x')).rejects.toBeInstanceOf(
      FolderAccessLostError,
    );

    // User re-grants and re-selects a fresh folder.
    const newRoot = new MockDirectoryHandle();
    (adapter as unknown as { picker: ShowDirectoryPicker }).picker = pickerFor(newRoot);
    await adapter.selectRoot();
    await adapter.write(asMemoryPath('config/locale.md'), 'pt-BR');
    expect(await adapter.read(asMemoryPath('config/locale.md'))).toBe('pt-BR');
  });
});

describe('FileSystemAccessStorage — deleteAll (R34.4)', () => {
  it('removes every entry from the selected folder', async () => {
    const { adapter, root } = await newAdapter();
    await adapter.write(asMemoryPath('profile/skill_map.md'), 'a');
    await adapter.write(asMemoryPath('config/locale.md'), 'b');

    await adapter.deleteAll();
    expect(root.children.size).toBe(0);
    expect(await adapter.list('')).toEqual([]);
  });
});

describe('FileSystemAccessStorage — zip export/import wiring', () => {
  it('defers zip export/import to the shared fallback-tier codec', async () => {
    const { adapter } = await newAdapter();
    await expect(adapter.exportZip()).rejects.toThrow(/shared MemoryTree zip codec/);
    await expect(adapter.importZip(new Blob())).rejects.toThrow(/shared MemoryTree zip codec/);
  });
});
