// Unit tests for per-capability provider availability (@ui) — Task 22.6.
//
// These pin the boundary rules that decide which providers the user may select
// right now:
//   * the keyless Local Provider is available iff its local-config is saved
//     (`isLocalConfigured()`), and its availability NEVER consults the key vault
//     (R43.2);
//   * a keyed provider (e.g. openai) is available iff its key is stored in the
//     vault (R5.1);
//   * STT capability filtering shows only providers that wired an STT client
//     (openai + local), excluding anthropic.
//
// The ProviderManager and KeyVault are stubbed: `listProviders` returns a fixed
// registry and `has` is a spy so we can assert it is NOT called for the keyless
// provider. local-config reads come from a small in-memory localStorage stub
// (the test env is `node`), mirroring src/adapters/llm-http.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDescriptor, ProviderManager } from '@adapters/provider';
import type { KeyVault } from '@adapters/vault';
import { setLocalConfig } from '@adapters/local-config';
import { listAvailableProviders, supportsStt } from './provider-availability';

/** A minimal in-memory localStorage stub for exercising `local-config`. */
class MemoryStorage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

/** The registry as wired in the runtime: keyed openai/anthropic + keyless local. */
const REGISTRY: ProviderDescriptor[] = [
  { id: 'openai', displayName: 'OpenAI' },
  { id: 'anthropic', displayName: 'Anthropic' },
  { id: 'local', displayName: 'Local (self-hosted)', keyless: true },
];

/** A stub ProviderManager exposing only the read-only registry this helper uses. */
const providerManager = (providers: ProviderDescriptor[] = REGISTRY): ProviderManager =>
  ({ listProviders: () => providers }) as unknown as ProviderManager;

/** A stub KeyVault whose `has` is a spy; returns true only for ids in `stored`. */
const keyVaultWith = (stored: ReadonlySet<string>) => {
  const has = vi.fn(async (id: string) => stored.has(id));
  const vault = { has } as unknown as KeyVault;
  return { vault, has };
};

const ids = (list: ReadonlyArray<{ id: string }>): string[] => list.map((p) => p.id);

describe('listAvailableProviders — keyless Local Provider (R43.2, Task 22.6)', () => {
  let previous: Storage | undefined;

  beforeEach(() => {
    previous = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage;
  });

  afterEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = previous;
  });

  it('reports the keyless local provider AVAILABLE when local-config is configured, WITHOUT consulting the vault', async () => {
    setLocalConfig({ configured: true });
    const { vault, has } = keyVaultWith(new Set()); // nothing stored in the vault

    const result = await listAvailableProviders(providerManager(), vault, 'chat');

    expect(ids(result)).toContain('local');
    // Availability of the keyless provider must NEVER ask the vault.
    expect(has).not.toHaveBeenCalledWith('local');
  });

  it('reports the keyless local provider NOT available when local-config is unconfigured, WITHOUT consulting the vault', async () => {
    setLocalConfig({ configured: false });
    const { vault, has } = keyVaultWith(new Set());

    const result = await listAvailableProviders(providerManager(), vault, 'chat');

    expect(ids(result)).not.toContain('local');
    expect(has).not.toHaveBeenCalledWith('local');
  });

  it('keys availability off the descriptor `keyless` flag, not the literal id "local"', async () => {
    setLocalConfig({ configured: true });
    const { vault, has } = keyVaultWith(new Set());
    // A differently-named keyless provider must still resolve via local-config.
    const registry: ProviderDescriptor[] = [
      { id: 'my-ollama', displayName: 'My Ollama', keyless: true },
    ];

    const result = await listAvailableProviders(providerManager(registry), vault, 'chat');

    expect(ids(result)).toEqual(['my-ollama']);
    expect(has).not.toHaveBeenCalled();
  });
});

describe('listAvailableProviders — keyed providers come from the vault (R5.1)', () => {
  let previous: Storage | undefined;

  beforeEach(() => {
    previous = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage;
    setLocalConfig({ configured: false });
  });

  afterEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = previous;
  });

  it('includes a keyed provider only when its key is stored in the vault', async () => {
    const { vault, has } = keyVaultWith(new Set(['openai']));

    const result = await listAvailableProviders(providerManager(), vault, 'chat');

    expect(ids(result)).toContain('openai');
    expect(ids(result)).not.toContain('anthropic');
    expect(has).toHaveBeenCalledWith('openai');
    expect(has).toHaveBeenCalledWith('anthropic');
  });

  it('excludes a keyed provider when no key is stored', async () => {
    const { vault } = keyVaultWith(new Set());

    const result = await listAvailableProviders(providerManager(), vault, 'chat');

    expect(ids(result)).not.toContain('openai');
    expect(ids(result)).not.toContain('anthropic');
  });
});

describe('listAvailableProviders — STT capability filtering', () => {
  let previous: Storage | undefined;

  beforeEach(() => {
    previous = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage;
    setLocalConfig({ configured: true });
  });

  afterEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = previous;
  });

  it('supportsStt: openai and local are STT-capable; anthropic is not', () => {
    expect(supportsStt('openai')).toBe(true);
    expect(supportsStt('local')).toBe(true);
    expect(supportsStt('anthropic')).toBe(false);
  });

  it('lists only STT-capable available providers for the stt capability', async () => {
    // Both keyed providers have keys, and local-config is configured.
    const { vault } = keyVaultWith(new Set(['openai', 'anthropic']));

    const result = await listAvailableProviders(providerManager(), vault, 'stt');

    // anthropic is filtered out despite having a stored key (no STT client).
    expect(ids(result)).toEqual(['openai', 'local']);
  });

  it('still requires availability for STT: an STT-capable keyed provider without a key is excluded', async () => {
    const { vault } = keyVaultWith(new Set()); // openai has no key

    const result = await listAvailableProviders(providerManager(), vault, 'stt');

    // local remains (configured + STT-capable); openai is excluded (no key).
    expect(ids(result)).toEqual(['local']);
  });
});
