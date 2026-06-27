import { describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_PROVIDER_ID,
  DefaultProviderManager,
  LOCAL_PROVIDER_ID,
  NoProviderKeyError,
  OPENAI_PROVIDER_ID,
  ProviderCapabilityError,
  UnknownProviderError,
  defaultProviderPlugins,
  type ProviderPlugin,
} from './provider-manager';
import {
  InMemoryKeyVaultStorage,
  WebCryptoKeyVault,
  type KeyVault,
} from './vault';
import type {
  AudioBlob,
  ChatRequest,
  ChatResponse,
  LlmProvider,
  ProviderId,
  RedactedPayload,
  SttProvider,
  Transcript,
} from './provider';

const REDACTED: RedactedPayload = { __brand: 'RedactedPayload' } as RedactedPayload;
const CHAT_OK: ChatResponse = { __brand: 'ChatResponse' } as ChatResponse;
const AUDIO: AudioBlob = { __brand: 'AudioBlob', format: 'wav', bytes: new Uint8Array([0, 1]) };

/**
 * A spying fake LLM provider that records every (request, key) it receives, so
 * tests can assert which key — if any — reached which provider (R5.3).
 */
class SpyLlmProvider implements LlmProvider {
  readonly calls: Array<{ req: ChatRequest; key: string }> = [];

  constructor(
    readonly id: ProviderId,
    private readonly behaviour: 'ok' | { reject: unknown } = 'ok',
  ) {}

  async chat(req: ChatRequest, key: string): Promise<ChatResponse> {
    this.calls.push({ req, key });
    if (this.behaviour !== 'ok') {
      throw this.behaviour.reject;
    }
    return CHAT_OK;
  }

  /** Keys this provider has seen across all calls. */
  keysSeen(): string[] {
    return this.calls.map((c) => c.key);
  }
}

/** A spying fake STT provider recording every (audio, key) it receives (R5.3). */
class SpySttProvider implements SttProvider {
  readonly calls: Array<{ audio: AudioBlob; key: string }> = [];

  constructor(private readonly text = 'transcribed answer') {}

  async transcribe(audio: AudioBlob, key: string): Promise<Transcript> {
    this.calls.push({ audio, key });
    return { __brand: 'Transcript', text: this.text };
  }

  keysSeen(): string[] {
    return this.calls.map((c) => c.key);
  }
}

/** A real Web Crypto vault over inspectable in-memory storage. */
function makeVault(): { vault: KeyVault; storage: InMemoryKeyVaultStorage } {
  const storage = new InMemoryKeyVaultStorage();
  const vault = new WebCryptoKeyVault({ storage });
  return { vault, storage };
}

function makeManager(
  plugins: ProviderPlugin[],
  vaultOverride?: KeyVault,
): { manager: DefaultProviderManager; vault: KeyVault; storage?: InMemoryKeyVaultStorage } {
  if (vaultOverride) {
    return { manager: new DefaultProviderManager({ vault: vaultOverride, providers: plugins }), vault: vaultOverride };
  }
  const { vault, storage } = makeVault();
  return {
    manager: new DefaultProviderManager({ vault, providers: plugins }),
    vault,
    storage,
  };
}

describe('DefaultProviderManager — pluggable registry (R4.1)', () => {
  it('lists registered providers in registration order', () => {
    const { vault } = makeVault();
    const manager = new DefaultProviderManager({
      vault,
      providers: defaultProviderPlugins(),
    });

    expect(manager.listProviders()).toEqual([
      { id: OPENAI_PROVIDER_ID, displayName: 'OpenAI' },
      { id: ANTHROPIC_PROVIDER_ID, displayName: 'Anthropic' },
      { id: LOCAL_PROVIDER_ID, displayName: 'Local (self-hosted)', keyless: true },
    ]);
  });

  it('supports runtime registration of a new pluggable provider', () => {
    const { vault } = makeVault();
    const manager = new DefaultProviderManager({ vault });
    expect(manager.listProviders()).toEqual([]);

    manager.register({
      descriptor: { id: 'custom', displayName: 'Custom Co' },
      setupGuide: '## Custom',
      llm: new SpyLlmProvider('custom'),
    });

    expect(manager.listProviders()).toEqual([{ id: 'custom', displayName: 'Custom Co' }]);
  });

  it('replaces a provider when re-registered under the same id', () => {
    const { vault } = makeVault();
    const manager = new DefaultProviderManager({ vault });
    manager.register({ descriptor: { id: 'p', displayName: 'First' }, setupGuide: 'a' });
    manager.register({ descriptor: { id: 'p', displayName: 'Second' }, setupGuide: 'b' });

    expect(manager.listProviders()).toEqual([{ id: 'p', displayName: 'Second' }]);
  });
});

describe('DefaultProviderManager — setup guidance (R4.2)', () => {
  it('returns README-style guidance for each default provider', () => {
    const { manager } = makeManager(defaultProviderPlugins());
    const openai = manager.setupGuide(OPENAI_PROVIDER_ID, 'en');
    expect(openai).toContain('OpenAI');
    expect(openai).toContain('api-keys');
    const anthropic = manager.setupGuide(ANTHROPIC_PROVIDER_ID, 'en');
    expect(anthropic).toContain('Anthropic');
  });

  it('localises guidance by locale (pt-BR vs en)', () => {
    const { manager } = makeManager(defaultProviderPlugins());
    expect(manager.setupGuide(OPENAI_PROVIDER_ID, 'pt-BR')).toContain('Conectar');
    expect(manager.setupGuide(OPENAI_PROVIDER_ID, 'en')).toContain('Connect');
  });

  it('throws for an unknown provider', () => {
    const { manager } = makeManager(defaultProviderPlugins());
    expect(() => manager.setupGuide('nope', 'en')).toThrow(UnknownProviderError);
  });
});

describe('DefaultProviderManager — key validation (R4.3, R4.4)', () => {
  it('reports a valid key when the test call succeeds', async () => {
    const llm = new SpyLlmProvider(OPENAI_PROVIDER_ID, 'ok');
    const { manager } = makeManager([
      { descriptor: { id: OPENAI_PROVIDER_ID, displayName: 'OpenAI' }, setupGuide: 'g', llm },
    ]);

    const result = await manager.validateKey(OPENAI_PROVIDER_ID, 'sk-valid');

    expect(result).toEqual({ valid: true });
    // The test call carried the user-supplied key to the owning provider only.
    expect(llm.keysSeen()).toEqual(['sk-valid']);
  });

  it('reports invalid with the failure reason when the test call fails (R4.4)', async () => {
    const llm = new SpyLlmProvider(OPENAI_PROVIDER_ID, {
      reject: new Error('401 Unauthorized: invalid API key'),
    });
    const { manager } = makeManager([
      { descriptor: { id: OPENAI_PROVIDER_ID, displayName: 'OpenAI' }, setupGuide: 'g', llm },
    ]);

    const result = await manager.validateKey(OPENAI_PROVIDER_ID, 'sk-bad');

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('401 Unauthorized: invalid API key');
  });

  it('rejects an empty key without issuing a test call', async () => {
    const llm = new SpyLlmProvider(OPENAI_PROVIDER_ID, 'ok');
    const { manager } = makeManager([
      { descriptor: { id: OPENAI_PROVIDER_ID, displayName: 'OpenAI' }, setupGuide: 'g', llm },
    ]);

    const result = await manager.validateKey(OPENAI_PROVIDER_ID, '   ');

    expect(result.valid).toBe(false);
    expect(llm.calls).toHaveLength(0);
  });

  it('does not persist a key as a side effect of validation', async () => {
    const llm = new SpyLlmProvider(OPENAI_PROVIDER_ID, 'ok');
    const { vault, storage } = makeVault();
    const manager = new DefaultProviderManager({
      vault,
      providers: [
        { descriptor: { id: OPENAI_PROVIDER_ID, displayName: 'OpenAI' }, setupGuide: 'g', llm },
      ],
    });

    await manager.validateKey(OPENAI_PROVIDER_ID, 'sk-valid');

    expect(await vault.has(OPENAI_PROVIDER_ID)).toBe(false);
    expect(storage.values()).toHaveLength(0);
  });
});

describe('DefaultProviderManager — store/remove encrypted key (R5.1, R5.2, R5.4)', () => {
  it('stores the key encrypted via the vault (no plaintext persisted)', async () => {
    const { vault, storage } = makeVault();
    const manager = new DefaultProviderManager({ vault, providers: defaultProviderPlugins() });

    await manager.storeKey(OPENAI_PROVIDER_ID, 'sk-secret-value');

    expect(await vault.has(OPENAI_PROVIDER_ID)).toBe(true);
    // The plaintext key must never appear in the persisted ciphertext (R5.1).
    for (const value of storage.values()) {
      expect(value).not.toContain('sk-secret-value');
    }
  });

  it('removeKey deletes the encrypted key from storage (R5.4)', async () => {
    const { vault } = makeVault();
    const manager = new DefaultProviderManager({ vault, providers: defaultProviderPlugins() });
    await manager.storeKey(OPENAI_PROVIDER_ID, 'sk-secret-value');
    expect(await vault.has(OPENAI_PROVIDER_ID)).toBe(true);

    await manager.removeKey(OPENAI_PROVIDER_ID);

    expect(await vault.has(OPENAI_PROVIDER_ID)).toBe(false);
  });

  it('refuses to store a key for an unknown provider', async () => {
    const { manager } = makeManager(defaultProviderPlugins());
    await expect(manager.storeKey('nope', 'sk')).rejects.toThrow(UnknownProviderError);
  });
});

describe('DefaultProviderManager — send routes the key only to its owner (R5.3)', () => {
  it('decrypts just-in-time and delivers the key only to the owning provider', async () => {
    const openai = new SpyLlmProvider(OPENAI_PROVIDER_ID, 'ok');
    const anthropic = new SpyLlmProvider(ANTHROPIC_PROVIDER_ID, 'ok');
    const { vault } = makeVault();
    const manager = new DefaultProviderManager({
      vault,
      providers: [
        { descriptor: { id: OPENAI_PROVIDER_ID, displayName: 'OpenAI' }, setupGuide: 'g', llm: openai },
        { descriptor: { id: ANTHROPIC_PROVIDER_ID, displayName: 'Anthropic' }, setupGuide: 'g', llm: anthropic },
      ],
    });

    await manager.storeKey(OPENAI_PROVIDER_ID, 'sk-openai');
    await manager.storeKey(ANTHROPIC_PROVIDER_ID, 'sk-anthropic');

    await manager.send(OPENAI_PROVIDER_ID, REDACTED);

    // Only OpenAI received a call, and it received OpenAI's key — never Anthropic's.
    expect(openai.keysSeen()).toEqual(['sk-openai']);
    expect(anthropic.calls).toHaveLength(0);
  });

  it('passes the redacted payload through unchanged to the provider', async () => {
    const openai = new SpyLlmProvider(OPENAI_PROVIDER_ID, 'ok');
    const { vault } = makeVault();
    const manager = new DefaultProviderManager({
      vault,
      providers: [
        { descriptor: { id: OPENAI_PROVIDER_ID, displayName: 'OpenAI' }, setupGuide: 'g', llm: openai },
      ],
    });
    await manager.storeKey(OPENAI_PROVIDER_ID, 'sk-openai');

    const response = await manager.send(OPENAI_PROVIDER_ID, REDACTED);

    expect(response).toBe(CHAT_OK);
    expect(openai.calls[0]?.req).toBe(REDACTED as unknown as ChatRequest);
  });

  it('fails closed when no key is stored — no shared/built-in key (R4.5)', async () => {
    const openai = new SpyLlmProvider(OPENAI_PROVIDER_ID, 'ok');
    const { manager } = makeManager([
      { descriptor: { id: OPENAI_PROVIDER_ID, displayName: 'OpenAI' }, setupGuide: 'g', llm: openai },
    ]);

    await expect(manager.send(OPENAI_PROVIDER_ID, REDACTED)).rejects.toThrow(NoProviderKeyError);
    // No key existed, so the provider was never contacted.
    expect(openai.calls).toHaveLength(0);
  });

  it('throws for a provider with no LLM capability wired', async () => {
    const { vault } = makeVault();
    const manager = new DefaultProviderManager({
      vault,
      providers: [{ descriptor: { id: 'stt-only', displayName: 'STT' }, setupGuide: 'g' }],
    });
    await manager.storeKey('stt-only', 'sk');

    await expect(manager.send('stt-only', REDACTED)).rejects.toThrow(ProviderCapabilityError);
  });
});

describe('DefaultProviderManager — no shared/built-in key (R4.5)', () => {
  it('starts with no stored key for any provider', async () => {
    const { vault } = makeVault();
    const manager = new DefaultProviderManager({ vault, providers: defaultProviderPlugins() });

    for (const { id } of manager.listProviders()) {
      expect(await vault.has(id)).toBe(false);
    }
  });

  it('never retains the key after sending (decrypts only just-in-time)', async () => {
    const openai = new SpyLlmProvider(OPENAI_PROVIDER_ID, 'ok');
    const { vault } = makeVault();
    const decryptSpy = vi.spyOn(vault, 'decrypt');
    const manager = new DefaultProviderManager({
      vault,
      providers: [
        { descriptor: { id: OPENAI_PROVIDER_ID, displayName: 'OpenAI' }, setupGuide: 'g', llm: openai },
      ],
    });
    await manager.storeKey(OPENAI_PROVIDER_ID, 'sk-openai');

    await manager.send(OPENAI_PROVIDER_ID, REDACTED);
    await manager.send(OPENAI_PROVIDER_ID, REDACTED);

    // Each send re-decrypts from the vault rather than caching the plaintext.
    expect(decryptSpy).toHaveBeenCalledTimes(2);
  });
});

describe('DefaultProviderManager — transcribe routes the key only to its owner (R5.3, R26.2)', () => {
  it('decrypts just-in-time and delivers the audio + key only to the owning STT provider', async () => {
    const openaiStt = new SpySttProvider('openai transcript');
    const anthropicStt = new SpySttProvider('anthropic transcript');
    const { vault } = makeVault();
    const manager = new DefaultProviderManager({
      vault,
      providers: [
        { descriptor: { id: OPENAI_PROVIDER_ID, displayName: 'OpenAI' }, setupGuide: 'g', stt: openaiStt },
        { descriptor: { id: ANTHROPIC_PROVIDER_ID, displayName: 'Anthropic' }, setupGuide: 'g', stt: anthropicStt },
      ],
    });
    await manager.storeKey(OPENAI_PROVIDER_ID, 'sk-openai');
    await manager.storeKey(ANTHROPIC_PROVIDER_ID, 'sk-anthropic');

    const transcript = await manager.transcribe(OPENAI_PROVIDER_ID, AUDIO);

    expect(transcript.text).toBe('openai transcript');
    // Only OpenAI's STT received a call, and only OpenAI's key.
    expect(openaiStt.keysSeen()).toEqual(['sk-openai']);
    expect(openaiStt.calls[0]?.audio).toBe(AUDIO);
    expect(anthropicStt.calls).toHaveLength(0);
  });

  it('throws for a provider with no STT capability wired', async () => {
    const { vault } = makeVault();
    const manager = new DefaultProviderManager({
      vault,
      providers: [{ descriptor: { id: 'llm-only', displayName: 'LLM' }, setupGuide: 'g', llm: new SpyLlmProvider('llm-only') }],
    });
    await manager.storeKey('llm-only', 'sk');

    await expect(manager.transcribe('llm-only', AUDIO)).rejects.toThrow(ProviderCapabilityError);
  });

  it('fails closed when no key is stored — no shared/built-in key (R4.5)', async () => {
    const stt = new SpySttProvider();
    const { manager } = makeManager([
      { descriptor: { id: OPENAI_PROVIDER_ID, displayName: 'OpenAI' }, setupGuide: 'g', stt },
    ]);

    await expect(manager.transcribe(OPENAI_PROVIDER_ID, AUDIO)).rejects.toThrow(NoProviderKeyError);
    expect(stt.calls).toHaveLength(0);
  });
});

describe('DefaultProviderManager — keyless Local Provider (R43.2)', () => {
  it('seeds a keyless local provider with localised setup guidance', () => {
    const { manager } = makeManager(defaultProviderPlugins());
    const descriptor = manager
      .listProviders()
      .find((d) => d.id === LOCAL_PROVIDER_ID);
    expect(descriptor).toEqual({
      id: LOCAL_PROVIDER_ID,
      displayName: 'Local (self-hosted)',
      keyless: true,
    });
    expect(manager.setupGuide(LOCAL_PROVIDER_ID, 'en')).toContain('localhost:11434');
    expect(manager.setupGuide(LOCAL_PROVIDER_ID, 'pt-BR')).toContain('auto-hospedado');
  });

  it('validates an empty key for a keyless provider via the test call', async () => {
    const llm = new SpyLlmProvider(LOCAL_PROVIDER_ID, 'ok');
    const { manager } = makeManager([
      {
        descriptor: { id: LOCAL_PROVIDER_ID, displayName: 'Local', keyless: true },
        setupGuide: 'g',
        keyless: true,
        llm,
      },
    ]);

    const result = await manager.validateKey(LOCAL_PROVIDER_ID, '');

    // The empty-key guard is bypassed: the test call runs with an empty key.
    expect(result).toEqual({ valid: true });
    expect(llm.keysSeen()).toEqual(['']);
  });

  it('reports the failure reason when a keyless test call fails (R4.4)', async () => {
    const llm = new SpyLlmProvider(LOCAL_PROVIDER_ID, {
      reject: new Error('Failed to fetch: connection refused'),
    });
    const { manager } = makeManager([
      {
        descriptor: { id: LOCAL_PROVIDER_ID, displayName: 'Local', keyless: true },
        setupGuide: 'g',
        keyless: true,
        llm,
      },
    ]);

    const result = await manager.validateKey(LOCAL_PROVIDER_ID, '');

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Failed to fetch: connection refused');
  });

  it('sends without decrypting the vault and hands the provider an empty key', async () => {
    const llm = new SpyLlmProvider(LOCAL_PROVIDER_ID, 'ok');
    const { vault } = makeVault();
    const decryptSpy = vi.spyOn(vault, 'decrypt');
    const manager = new DefaultProviderManager({
      vault,
      providers: [
        {
          descriptor: { id: LOCAL_PROVIDER_ID, displayName: 'Local', keyless: true },
          setupGuide: 'g',
          keyless: true,
          llm,
        },
      ],
    });

    // No key stored, yet send succeeds (no NoProviderKeyError) and never decrypts.
    const response = await manager.send(LOCAL_PROVIDER_ID, REDACTED);

    expect(response).toBe(CHAT_OK);
    expect(llm.keysSeen()).toEqual(['']);
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('transcribes without decrypting the vault and hands the STT an empty key', async () => {
    const stt = new SpySttProvider('local transcript');
    const { vault } = makeVault();
    const decryptSpy = vi.spyOn(vault, 'decrypt');
    const manager = new DefaultProviderManager({
      vault,
      providers: [
        {
          descriptor: { id: LOCAL_PROVIDER_ID, displayName: 'Local', keyless: true },
          setupGuide: 'g',
          keyless: true,
          stt,
        },
      ],
    });

    const transcript = await manager.transcribe(LOCAL_PROVIDER_ID, AUDIO);

    expect(transcript.text).toBe('local transcript');
    expect(stt.keysSeen()).toEqual(['']);
    expect(decryptSpy).not.toHaveBeenCalled();
  });
});
