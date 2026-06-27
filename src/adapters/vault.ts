// Key Vault (Web Crypto) — encrypted local storage for BYOK provider keys.
//
// Encrypts API keys at rest with AES-GCM under a *non-extractable* key derived
// (PBKDF2) from a per-device random salt, persists only the ciphertext + IV
// (+ salt) to browser-local storage, and decrypts just-in-time. A plaintext key
// is NEVER persisted, and a key is NEVER written to the Memory Store / Storage
// Adapter — the vault talks only to a small `localStorage`-style backend that is
// completely independent of the canonical Markdown Memory Store.
//
// Requirements: 5.1 (encrypted in browser-local storage), 5.2 (never in the
// Memory Store), 5.4 (removal deletes the encrypted key). Just-in-time decrypt
// supports R5.3 (the Provider_Manager hands the plaintext straight to the owning
// provider and never retains it).

import type { ProviderId } from './provider';

/**
 * Minimal `localStorage`-compatible backend the vault persists to. The browser
 * `Storage` interface satisfies this structurally, so the default is
 * `globalThis.localStorage`; tests (and non-browser environments) inject
 * {@link InMemoryKeyVaultStorage}.
 */
export interface KeyVaultStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface KeyVault {
  /** Encrypt and persist a provider key in browser-local storage (R5.1). */
  store(p: ProviderId, key: string): Promise<void>;
  /** Decrypt a stored key just-in-time for its owning provider (R5.3). */
  decrypt(p: ProviderId): Promise<string>;
  /** Delete the encrypted key (R5.4). */
  remove(p: ProviderId): Promise<void>;
  /** Whether an encrypted key exists for the provider. */
  has(p: ProviderId): Promise<boolean>;
}

/** Raised when no encrypted key exists for the requested provider. */
export class KeyNotFoundError extends Error {
  constructor(public readonly provider: ProviderId) {
    super(`No encrypted key stored for provider "${provider}".`);
    this.name = 'KeyNotFoundError';
  }
}

/** Raised when neither a usable storage backend nor Web Crypto is available. */
export class KeyVaultUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyVaultUnavailableError';
  }
}

/** Raised when a persisted entry cannot be parsed/decoded (corrupt storage). */
export class CorruptKeyEntryError extends Error {
  constructor(public readonly provider: ProviderId) {
    super(`Stored key entry for provider "${provider}" is corrupt or unreadable.`);
    this.name = 'CorruptKeyEntryError';
  }
}

/**
 * An in-memory {@link KeyVaultStorage} for tests and non-browser environments.
 * Inspectable via {@link entries} so tests can assert no plaintext is persisted.
 */
export class InMemoryKeyVaultStorage implements KeyVaultStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  /** All persisted [key, value] pairs (for inspection in tests). */
  entries(): Array<[string, string]> {
    return [...this.map.entries()];
  }

  /** All persisted values (for inspection in tests). */
  values(): string[] {
    return [...this.map.values()];
  }
}

/** Shape persisted per provider: AES-GCM ciphertext + the IV used to seal it. */
interface StoredEntry {
  /** AES-GCM initialisation vector, base64. */
  readonly iv: string;
  /** AES-GCM ciphertext (includes the auth tag), base64. */
  readonly ct: string;
}

export interface WebCryptoKeyVaultOptions {
  /** Persistence backend; defaults to `globalThis.localStorage`. */
  storage?: KeyVaultStorage;
  /** Web Crypto implementation; defaults to `globalThis.crypto`. */
  crypto?: Crypto;
  /** Storage-key namespace; lets multiple vaults coexist. */
  namespace?: string;
}

const DEFAULT_NAMESPACE = 'career-agent.vault';
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const IV_BYTES = 12; // 96-bit IV, the AES-GCM recommendation.
const AES_KEY_BITS = 256;

/**
 * Fixed application keying material fed into PBKDF2 alongside the per-device
 * random salt. Combined with the salt this yields a stable, *non-extractable*
 * AES-GCM key per device, without requiring a user passphrase. The salt — not
 * this constant — provides the entropy that makes each device's key unique.
 */
const APP_KEYING_MATERIAL = 'career-agent::web-crypto-key-vault::v1';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Web Crypto implementation of {@link KeyVault}.
 *
 * Keys are sealed with AES-GCM under a non-extractable key derived (PBKDF2,
 * SHA-256) from a per-device random salt. Only `{ iv, ct }` plus the salt are
 * persisted to the injected browser-local storage; the plaintext key and the
 * derived key object never leave memory, and nothing is written to the Memory
 * Store (R5.1, R5.2).
 */
export class WebCryptoKeyVault implements KeyVault {
  private readonly storage: KeyVaultStorage;
  private readonly crypto: Crypto;
  private readonly namespace: string;
  private cryptoKey: Promise<CryptoKey> | null = null;

  constructor(options: WebCryptoKeyVaultOptions = {}) {
    const storage = options.storage ?? resolveDefaultStorage();
    if (!storage) {
      throw new KeyVaultUnavailableError(
        'No browser-local storage backend available for the key vault.',
      );
    }
    const crypto = options.crypto ?? (globalThis.crypto as Crypto | undefined);
    if (!crypto?.subtle) {
      throw new KeyVaultUnavailableError(
        'Web Crypto (crypto.subtle) is unavailable; cannot operate the key vault.',
      );
    }
    this.storage = storage;
    this.crypto = crypto;
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
  }

  async store(p: ProviderId, key: string): Promise<void> {
    const cryptoKey = await this.getCryptoKey();
    const iv: Uint8Array<ArrayBuffer> = this.crypto.getRandomValues(
      new Uint8Array(IV_BYTES),
    );
    const plaintext = new TextEncoder().encode(key);
    const ct = await this.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      plaintext,
    );
    const entry: StoredEntry = {
      iv: toBase64(iv),
      ct: toBase64(new Uint8Array(ct)),
    };
    this.storage.setItem(this.entryKey(p), JSON.stringify(entry));
  }

  async decrypt(p: ProviderId): Promise<string> {
    const raw = this.storage.getItem(this.entryKey(p));
    if (raw === null) {
      throw new KeyNotFoundError(p);
    }
    let entry: StoredEntry;
    let iv: Uint8Array<ArrayBuffer>;
    let ct: Uint8Array<ArrayBuffer>;
    try {
      entry = JSON.parse(raw) as StoredEntry;
      iv = fromBase64(entry.iv);
      ct = fromBase64(entry.ct);
    } catch {
      throw new CorruptKeyEntryError(p);
    }
    let plaintext: ArrayBuffer;
    try {
      const cryptoKey = await this.getCryptoKey();
      plaintext = await this.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        cryptoKey,
        ct,
      );
    } catch {
      // AES-GCM authentication failed (tampered ciphertext, wrong salt, etc.).
      throw new CorruptKeyEntryError(p);
    }
    return new TextDecoder().decode(plaintext);
  }

  async remove(p: ProviderId): Promise<void> {
    this.storage.removeItem(this.entryKey(p));
  }

  async has(p: ProviderId): Promise<boolean> {
    return this.storage.getItem(this.entryKey(p)) !== null;
  }

  /** Storage key for a provider's encrypted entry. */
  private entryKey(p: ProviderId): string {
    return `${this.namespace}.key.${p}`;
  }

  /** Storage key for the per-device PBKDF2 salt. */
  private get saltKey(): string {
    return `${this.namespace}.salt`;
  }

  /**
   * Derive (once, then cache) the non-extractable AES-GCM key from the
   * per-device salt. The key is created with `extractable: false`, so it can be
   * used to encrypt/decrypt but never read back out of the Web Crypto subsystem.
   */
  private getCryptoKey(): Promise<CryptoKey> {
    if (!this.cryptoKey) {
      this.cryptoKey = this.deriveCryptoKey();
    }
    return this.cryptoKey;
  }

  private async deriveCryptoKey(): Promise<CryptoKey> {
    const salt = this.getOrCreateSalt();
    const baseKey = await this.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(APP_KEYING_MATERIAL),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return this.crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: AES_KEY_BITS },
      false, // non-extractable derived key (R5.1)
      ['encrypt', 'decrypt'],
    );
  }

  /** Read the persisted salt, or generate and persist a fresh random one. */
  private getOrCreateSalt(): Uint8Array<ArrayBuffer> {
    const existing = this.storage.getItem(this.saltKey);
    if (existing !== null) {
      try {
        return fromBase64(existing);
      } catch {
        // Fall through and regenerate a usable salt if the stored one is junk.
      }
    }
    const salt: Uint8Array<ArrayBuffer> = this.crypto.getRandomValues(
      new Uint8Array(SALT_BYTES),
    );
    this.storage.setItem(this.saltKey, toBase64(salt));
    return salt;
  }
}

/** Resolve the default browser-local storage backend, if present. */
function resolveDefaultStorage(): KeyVaultStorage | null {
  try {
    const ls = (globalThis as { localStorage?: KeyVaultStorage }).localStorage;
    return ls ?? null;
  } catch {
    // Accessing localStorage can throw in sandboxed contexts.
    return null;
  }
}
