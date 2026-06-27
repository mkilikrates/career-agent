import { describe, expect, it } from 'vitest';
import {
  CorruptKeyEntryError,
  InMemoryKeyVaultStorage,
  KeyNotFoundError,
  KeyVaultUnavailableError,
  WebCryptoKeyVault,
} from './vault';

/** A fresh vault backed by an inspectable in-memory storage backend. */
const makeVault = (namespace = 'test.vault') => {
  const storage = new InMemoryKeyVaultStorage();
  const vault = new WebCryptoKeyVault({ storage, namespace });
  return { vault, storage };
};

const SAMPLE_KEY = 'sk-live-0123456789abcdefABCDEF';

describe('WebCryptoKeyVault — store/decrypt round-trip (R5.1)', () => {
  it('decrypts back exactly what was stored', async () => {
    const { vault } = makeVault();
    await vault.store('openai', SAMPLE_KEY);
    expect(await vault.decrypt('openai')).toBe(SAMPLE_KEY);
  });

  it('round-trips keys with unicode and special characters', async () => {
    const { vault } = makeVault();
    const tricky = 'kéy-✓-😀-\n\t-"quoted"-{json}';
    await vault.store('anthropic', tricky);
    expect(await vault.decrypt('anthropic')).toBe(tricky);
  });

  it('round-trips an empty string', async () => {
    const { vault } = makeVault();
    await vault.store('openai', '');
    expect(await vault.decrypt('openai')).toBe('');
  });

  it('keeps separate keys per provider', async () => {
    const { vault } = makeVault();
    await vault.store('openai', 'key-openai');
    await vault.store('anthropic', 'key-anthropic');
    expect(await vault.decrypt('openai')).toBe('key-openai');
    expect(await vault.decrypt('anthropic')).toBe('key-anthropic');
  });

  it('overwrites an existing key on re-store', async () => {
    const { vault } = makeVault();
    await vault.store('openai', 'first');
    await vault.store('openai', 'second');
    expect(await vault.decrypt('openai')).toBe('second');
  });

  it('uses a fresh IV per encryption (ciphertext differs for equal plaintext)', async () => {
    const { vault, storage } = makeVault();
    await vault.store('openai', SAMPLE_KEY);
    const first = storage.getItem('test.vault.key.openai');
    await vault.store('openai', SAMPLE_KEY);
    const second = storage.getItem('test.vault.key.openai');
    expect(first).not.toBe(second);
  });

  it('decrypts after the derived key is re-derived from persisted salt (reload)', async () => {
    const storage = new InMemoryKeyVaultStorage();
    const first = new WebCryptoKeyVault({ storage, namespace: 'reload.vault' });
    await first.store('openai', SAMPLE_KEY);

    // A brand-new vault instance over the same storage simulates a page reload.
    const second = new WebCryptoKeyVault({ storage, namespace: 'reload.vault' });
    expect(await second.decrypt('openai')).toBe(SAMPLE_KEY);
  });
});

describe('WebCryptoKeyVault — encrypted at rest, no plaintext persisted (R5.1, R5.2)', () => {
  it('never persists the plaintext key in any stored value', async () => {
    const { vault, storage } = makeVault();
    await vault.store('openai', SAMPLE_KEY);

    for (const value of storage.values()) {
      expect(value).not.toContain(SAMPLE_KEY);
    }
  });

  it('persists only ciphertext + IV under the provider entry (no plaintext field)', async () => {
    const { vault, storage } = makeVault();
    await vault.store('openai', SAMPLE_KEY);

    const raw = storage.getItem('test.vault.key.openai');
    expect(raw).not.toBeNull();
    const entry = JSON.parse(raw as string);
    expect(Object.keys(entry).sort()).toEqual(['ct', 'iv']);
    expect(entry.ct).not.toContain(SAMPLE_KEY);
  });

  it('writes only namespaced vault keys (salt + per-provider entries)', async () => {
    const { vault, storage } = makeVault();
    await vault.store('openai', SAMPLE_KEY);

    const keys = storage.entries().map(([k]) => k).sort();
    expect(keys).toEqual(['test.vault.key.openai', 'test.vault.salt']);
  });
});

describe('WebCryptoKeyVault — has (presence check)', () => {
  it('reports false before storing and true after', async () => {
    const { vault } = makeVault();
    expect(await vault.has('openai')).toBe(false);
    await vault.store('openai', SAMPLE_KEY);
    expect(await vault.has('openai')).toBe(true);
  });
});

describe('WebCryptoKeyVault — remove (R5.4)', () => {
  it('deletes the encrypted key from storage', async () => {
    const { vault, storage } = makeVault();
    await vault.store('openai', SAMPLE_KEY);
    await vault.remove('openai');

    expect(await vault.has('openai')).toBe(false);
    expect(storage.getItem('test.vault.key.openai')).toBeNull();
  });

  it('makes a removed key undecryptable', async () => {
    const { vault } = makeVault();
    await vault.store('openai', SAMPLE_KEY);
    await vault.remove('openai');
    await expect(vault.decrypt('openai')).rejects.toBeInstanceOf(KeyNotFoundError);
  });

  it('is a no-op when removing a key that does not exist', async () => {
    const { vault } = makeVault();
    await expect(vault.remove('openai')).resolves.toBeUndefined();
  });
});

describe('WebCryptoKeyVault — error handling', () => {
  it('throws KeyNotFoundError when decrypting a missing key', async () => {
    const { vault } = makeVault();
    await expect(vault.decrypt('openai')).rejects.toBeInstanceOf(KeyNotFoundError);
  });

  it('throws CorruptKeyEntryError on tampered ciphertext', async () => {
    const { vault, storage } = makeVault();
    await vault.store('openai', SAMPLE_KEY);

    const entry = JSON.parse(storage.getItem('test.vault.key.openai') as string);
    // Flip the ciphertext so AES-GCM authentication fails on decrypt.
    entry.ct = entry.ct.startsWith('A') ? `B${entry.ct.slice(1)}` : `A${entry.ct.slice(1)}`;
    storage.setItem('test.vault.key.openai', JSON.stringify(entry));

    await expect(vault.decrypt('openai')).rejects.toBeInstanceOf(CorruptKeyEntryError);
  });

  it('throws CorruptKeyEntryError on unparseable stored entry', async () => {
    const { vault, storage } = makeVault();
    storage.setItem('test.vault.key.openai', 'not-json');
    await expect(vault.decrypt('openai')).rejects.toBeInstanceOf(CorruptKeyEntryError);
  });

  it('throws KeyVaultUnavailableError when Web Crypto is missing', () => {
    const storage = new InMemoryKeyVaultStorage();
    expect(
      () =>
        new WebCryptoKeyVault({
          storage,
          crypto: {} as Crypto,
        }),
    ).toThrow(KeyVaultUnavailableError);
  });
});
