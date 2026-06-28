// Integration tests for the keyless Local Provider and per-capability routing.
//
// Unlike the focused unit tests in `llm-http.test.ts` / `provider-manager.test.ts`
// / `egress-gate.test.ts`, these wire the REAL stack together end-to-end:
//
//   Egress Gate (real PII scanner) → DefaultProviderManager (real Web Crypto
//   vault) → real OpenAI/Anthropic/Local HTTP clients (createDefaultLlmClients).
//
// Only the two true boundaries are substituted: `fetch` (the network edge) is a
// recording stub so the suite runs offline and deterministically, and
// `localStorage` (the browser-local store the local-config persists to) is an
// in-memory stub. Everything between the gate and the network is the production
// wiring, so these tests pin the cross-component behaviour the design relies on.
//
// Covered scenarios:
//   1. Keyless validate/send/transcribe — the auth header is OMITTED for the
//      keyless local server and PRESENT (Bearer) for a keyed cloud provider.
//   2. `local-config` round-trip — base URL/model/sttModel persist in
//      browser-local storage (never the Memory Store) and apply on the very
//      next call.
//   3. Per-capability routing — chat routes to provider A and STT to provider B
//      independently (R44).
//   4. No-payload-leaves-device — when every selected provider is local, no
//      request ever reaches a third-party host; the gate labels each call as a
//      local on-device operation with no third-party egress (R43.5).
//   5. Whisper translate-to-English (`/audio/translations`) for BOTH the OpenAI
//      client and the local equivalent (R26.5).
//
// Requirements: 43, 44, 26.5, 46.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DefaultProviderManager,
  LOCAL_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  defaultProviderPlugins,
} from './provider-manager';
import {
  createAnthropicLlmProvider,
  createLocalLlmProvider,
  createLocalSttProvider,
  createOpenAiLlmProvider,
  createOpenAiSttProvider,
} from './llm-http';
import { DEFAULT_LOCAL_CONFIG, getLocalConfig, setLocalConfig } from './local-config';
import { InMemoryKeyVaultStorage, WebCryptoKeyVault } from './vault';
import { createPiiScanner } from './pii';
import {
  DefaultEgressGate,
  type EgressGate,
  type NetworkOperationLabel,
} from '@core/egress/egress-gate';
import type { AudioBlob } from './provider';

// --- Test doubles for the two boundaries -----------------------------------

/** A minimal in-memory `localStorage` stub (the browser-local store). */
class MemoryStorage {
  readonly map = new Map<string, string>();
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

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

/** A recorded outbound request at the network boundary. */
interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/**
 * A recording `fetch` stub that answers the OpenAI-compatible endpoints the
 * clients call. It records every (url, init) so tests can assert WHERE requests
 * went and WHICH headers were sent.
 */
function makeRecordingFetch(): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith('/models')) return jsonResponse(200, { data: [] });
    if (u.endsWith('/chat/completions')) {
      return jsonResponse(200, { choices: [{ message: { content: 'chat reply' } }] });
    }
    if (u.endsWith('/audio/transcriptions')) {
      return jsonResponse(200, { text: 'same-language transcript' });
    }
    if (u.endsWith('/audio/translations')) {
      return jsonResponse(200, { text: 'translated to english' });
    }
    return jsonResponse(404, { error: { message: `unexpected endpoint ${u}` } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Read an HTTP client's request headers as a plain record (they are objects). */
const headersOf = (init: RequestInit | undefined): Record<string, string> =>
  (init?.headers ?? {}) as Record<string, string>;

const audio = (format: 'mp3' | 'wav' = 'wav'): AudioBlob => ({
  __brand: 'AudioBlob',
  format,
  bytes: new Uint8Array([1, 2, 3, 4]),
});

/**
 * Assemble the real stack over the injected `fetch`: production provider clients
 * (OpenAI/Anthropic/Local), a real Web Crypto vault, and a real Egress Gate with
 * the real PII scanner. Only `fetch` and `localStorage` are stubbed.
 */
function makeStack(fetchImpl: typeof fetch): {
  manager: DefaultProviderManager;
  gate: EgressGate;
  labels: NetworkOperationLabel[];
} {
  const vault = new WebCryptoKeyVault({ storage: new InMemoryKeyVaultStorage() });
  // The same production clients `createDefaultLlmClients` composes, but with the
  // injected `fetch` wired into EVERY client so the integration test fully owns
  // the network boundary. (`createDefaultLlmClients` does not forward `fetchImpl`
  // to the OpenAI STT client, which would otherwise escape to the real network.)
  const clients = {
    openai: {
      llm: createOpenAiLlmProvider({ fetchImpl }),
      stt: createOpenAiSttProvider({ fetchImpl }),
    },
    anthropic: { llm: createAnthropicLlmProvider({ fetchImpl }) },
    local: {
      llm: createLocalLlmProvider({ fetchImpl }),
      stt: createLocalSttProvider({ fetchImpl }),
    },
  };
  const manager = new DefaultProviderManager({
    vault,
    providers: defaultProviderPlugins(clients),
  });
  const labels: NetworkOperationLabel[] = [];
  const gate = new DefaultEgressGate({
    scanner: createPiiScanner(),
    providerManager: manager,
    notifyLabel: (label) => labels.push(label),
    confirmRedactAndProceed: async () => true,
  });
  return { manager, gate, labels };
}

const THIRD_PARTY_HOSTS = ['api.openai.com', 'api.anthropic.com'];

let previousLocalStorage: Storage | undefined;

beforeEach(() => {
  previousLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  (globalThis as { localStorage?: Storage }).localStorage =
    new MemoryStorage() as unknown as Storage;
});

afterEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = previousLocalStorage;
  vi.restoreAllMocks();
});

// --- Scenario 1: keyless auth-header omission (R43.2) ----------------------

describe('Keyless local provider — auth header omitted across validate/send/transcribe (R43.2)', () => {
  it('validateKey issues a keyless GET /models with no authorization header', async () => {
    const { fetchImpl, calls } = makeRecordingFetch();
    const { manager } = makeStack(fetchImpl);

    const result = await manager.validateKey(LOCAL_PROVIDER_ID, '');

    expect(result).toEqual({ valid: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${DEFAULT_LOCAL_CONFIG.baseUrl}/models`);
    expect(headersOf(calls[0].init)).not.toHaveProperty('authorization');
  });

  it('a gated chat send reaches /chat/completions with no authorization header', async () => {
    const { fetchImpl, calls } = makeRecordingFetch();
    const { gate } = makeStack(fetchImpl);

    await gate.request({
      provider: LOCAL_PROVIDER_ID,
      text: 'Summarise my experience.',
      operation: 'llm-chat',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${DEFAULT_LOCAL_CONFIG.baseUrl}/chat/completions`);
    expect(headersOf(calls[0].init)).not.toHaveProperty('authorization');
  });

  it('a gated transcription reaches /audio/transcriptions with no authorization header', async () => {
    const { fetchImpl, calls } = makeRecordingFetch();
    const { gate } = makeStack(fetchImpl);

    await gate.transcribe({ provider: LOCAL_PROVIDER_ID, audio: audio('wav') });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${DEFAULT_LOCAL_CONFIG.baseUrl}/audio/transcriptions`);
    expect(headersOf(calls[0].init)).not.toHaveProperty('authorization');
  });

  it('a keyed cloud send DOES carry the Bearer header (contrast with keyless)', async () => {
    const { fetchImpl, calls } = makeRecordingFetch();
    const { manager, gate } = makeStack(fetchImpl);
    await manager.storeKey(OPENAI_PROVIDER_ID, 'sk-test-123');

    await gate.request({ provider: OPENAI_PROVIDER_ID, text: 'hello', operation: 'llm-chat' });

    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(headersOf(calls[0].init)).toMatchObject({ authorization: 'Bearer sk-test-123' });
  });
});

// --- Scenario 2: local-config round-trip (R43.1, R43.3, R43.4) -------------

describe('local-config round-trip — persisted in browser-local storage only', () => {
  it('persists baseUrl/model/sttModel to browser-local storage and reads them back', () => {
    const store = (globalThis as { localStorage?: Storage }).localStorage as unknown as MemoryStorage;

    setLocalConfig({
      baseUrl: 'http://localhost:1234/v1',
      model: 'mistral',
      sttModel: 'whisper-large',
      configured: true,
    });

    // The config lives under the dedicated browser-local key, and NOTHING else
    // (no Memory Store handle/content) is written.
    expect(store.map.size).toBe(1);
    const [key] = [...store.map.keys()];
    expect(key).toBe('career-agent.local-provider');
    const persisted = JSON.parse(store.getItem(key) as string);
    expect(persisted).toMatchObject({
      baseUrl: 'http://localhost:1234/v1',
      model: 'mistral',
      sttModel: 'whisper-large',
      configured: true,
    });

    const roundTripped = getLocalConfig();
    expect(roundTripped).toEqual({
      baseUrl: 'http://localhost:1234/v1',
      model: 'mistral',
      sttModel: 'whisper-large',
      maxTokens: DEFAULT_LOCAL_CONFIG.maxTokens,
      configured: true,
    });
  });

  it('edits apply immediately to the very next gated chat and transcription call', async () => {
    const { fetchImpl, calls } = makeRecordingFetch();
    const { gate } = makeStack(fetchImpl);

    // First call against the default Ollama endpoint/model.
    await gate.request({ provider: LOCAL_PROVIDER_ID, text: 'first', operation: 'llm-chat' });

    // Edit the local config — a lower-capacity chat model + a different STT model
    // on a LocalAI-style port (R43.3, R43.4).
    setLocalConfig({
      baseUrl: 'http://localhost:8080/v1',
      model: 'phi3:mini',
      sttModel: 'whisper-base',
    });

    await gate.request({ provider: LOCAL_PROVIDER_ID, text: 'second', operation: 'llm-chat' });
    await gate.transcribe({ provider: LOCAL_PROVIDER_ID, audio: audio('mp3') });

    // Call 0 used the defaults; calls 1 & 2 used the edited config immediately.
    expect(calls[0].url).toBe(`${DEFAULT_LOCAL_CONFIG.baseUrl}/chat/completions`);
    expect(JSON.parse(String(calls[0].init?.body)).model).toBe(DEFAULT_LOCAL_CONFIG.model);

    expect(calls[1].url).toBe('http://localhost:8080/v1/chat/completions');
    expect(JSON.parse(String(calls[1].init?.body)).model).toBe('phi3:mini');

    expect(calls[2].url).toBe('http://localhost:8080/v1/audio/transcriptions');
    expect((calls[2].init?.body as FormData).get('model')).toBe('whisper-base');
  });
});

// --- Scenario 3: per-capability routing (R44) ------------------------------

describe('Per-capability routing — chat and STT route to independent providers (R44)', () => {
  it('routes chat to provider A (OpenAI) and STT to provider B (Local) independently', async () => {
    const { fetchImpl, calls } = makeRecordingFetch();
    const { manager, gate } = makeStack(fetchImpl);
    await manager.storeKey(OPENAI_PROVIDER_ID, 'sk-chat-key');

    // Chat → the user's chosen chat provider (OpenAI, cloud, keyed).
    await gate.request({ provider: OPENAI_PROVIDER_ID, text: 'coach me', operation: 'llm-chat' });
    // STT → the independently chosen transcription provider (Local, keyless).
    await gate.transcribe({ provider: LOCAL_PROVIDER_ID, audio: audio('wav') });

    expect(calls).toHaveLength(2);
    // Chat hit OpenAI with its Bearer key.
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(headersOf(calls[0].init)).toMatchObject({ authorization: 'Bearer sk-chat-key' });
    // STT hit the local server, keyless — entirely independent of the chat provider.
    expect(calls[1].url).toBe(`${DEFAULT_LOCAL_CONFIG.baseUrl}/audio/transcriptions`);
    expect(headersOf(calls[1].init)).not.toHaveProperty('authorization');
  });

  it('routes chat to Local and STT to OpenAI when the selection is reversed (R44)', async () => {
    const { fetchImpl, calls } = makeRecordingFetch();
    const { manager, gate } = makeStack(fetchImpl);
    await manager.storeKey(OPENAI_PROVIDER_ID, 'sk-stt-key');

    await gate.request({ provider: LOCAL_PROVIDER_ID, text: 'coach me', operation: 'llm-chat' });
    await gate.transcribe({ provider: OPENAI_PROVIDER_ID, audio: audio('mp3') });

    expect(calls[0].url).toBe(`${DEFAULT_LOCAL_CONFIG.baseUrl}/chat/completions`);
    expect(headersOf(calls[0].init)).not.toHaveProperty('authorization');
    expect(calls[1].url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(headersOf(calls[1].init)).toMatchObject({ authorization: 'Bearer sk-stt-key' });
  });
});

// --- Scenario 4: no payload leaves the device when all-local (R43.5) -------

describe('All-local providers — no Redacted Payload leaves the device (R43.5)', () => {
  it('chat and transcription both stay on localhost; no third-party host is contacted', async () => {
    const { fetchImpl, calls } = makeRecordingFetch();
    const { gate, labels } = makeStack(fetchImpl);

    await gate.request({ provider: LOCAL_PROVIDER_ID, text: 'fully offline', operation: 'llm-chat' });
    await gate.transcribe({ provider: LOCAL_PROVIDER_ID, audio: audio('wav') });

    // Every outbound request targeted the local on-device server only.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith(DEFAULT_LOCAL_CONFIG.baseUrl)).toBe(true);
      for (const host of THIRD_PARTY_HOSTS) {
        expect(call.url).not.toContain(host);
      }
    }

    // The gate labelled both operations as local on-device with no third-party egress.
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.provider).toBe(LOCAL_PROVIDER_ID);
      expect(label.thirdParty).toBe(false);
      expect(label.description).toMatch(/local on-device call with no third-party egress/i);
    }
  });
});

// --- Scenario 5: Whisper translate-to-English path (R26.5) -----------------

describe('Whisper translate-to-English path — /audio/translations (R26.5)', () => {
  it('OpenAI STT targets /audio/translations when translateToEnglish is set', async () => {
    const { fetchImpl, calls } = makeRecordingFetch();
    const { manager, gate } = makeStack(fetchImpl);
    await manager.storeKey(OPENAI_PROVIDER_ID, 'sk-test-123');

    const result = await gate.transcribe({
      provider: OPENAI_PROVIDER_ID,
      audio: audio('mp3'),
      translateToEnglish: true,
    });

    expect(calls[0].url).toBe('https://api.openai.com/v1/audio/translations');
    expect(headersOf(calls[0].init)).toMatchObject({ authorization: 'Bearer sk-test-123' });
    expect(result.text).toBe('translated to english');
  });

  it('Local STT targets /audio/translations (keyless) when translateToEnglish is set', async () => {
    const { fetchImpl, calls } = makeRecordingFetch();
    const { gate } = makeStack(fetchImpl);

    const result = await gate.transcribe({
      provider: LOCAL_PROVIDER_ID,
      audio: audio('wav'),
      translateToEnglish: true,
    });

    expect(calls[0].url).toBe(`${DEFAULT_LOCAL_CONFIG.baseUrl}/audio/translations`);
    expect(headersOf(calls[0].init)).not.toHaveProperty('authorization');
    expect(result.text).toBe('translated to english');
  });

  it('omitting translateToEnglish keeps both providers on /audio/transcriptions (R26.5)', async () => {
    const { fetchImpl, calls } = makeRecordingFetch();
    const { manager, gate } = makeStack(fetchImpl);
    await manager.storeKey(OPENAI_PROVIDER_ID, 'sk-test-123');

    await gate.transcribe({ provider: OPENAI_PROVIDER_ID, audio: audio('mp3') });
    await gate.transcribe({ provider: LOCAL_PROVIDER_ID, audio: audio('wav') });

    expect(calls[0].url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(calls[1].url).toBe(`${DEFAULT_LOCAL_CONFIG.baseUrl}/audio/transcriptions`);
  });
});
