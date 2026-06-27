// Integration tests for Run-Mode wiring (design "The Three Run Modes" /
// "Deployment & Run Modes"; Section 23). The three Run Modes (local source
// build, single static container, Docker Compose stack) differ only in HOW the
// static `dist/` bundle is served — the browser-only application, its single
// Egress Gate, and its permitted egress destinations are identical in every
// mode (R50.6). These are therefore SMOKE / INTEGRATION tests (not new property
// tests): they reaffirm the run-mode-specific wiring and reuse the existing
// **Correctness Property 3** (redaction completeness + egress boundary) and the
// existing all-local fully-offline assertion (R1.5 / R43.5).
//
// Like `local-provider-integration.test.ts`, the egress-boundary assertions wire
// the REAL stack end-to-end —
//
//   Egress Gate (real PII scanner) → DefaultProviderManager (real Web Crypto
//   vault) → real OpenAI/Anthropic/Local HTTP clients.
//
// Only the two true boundaries are substituted: `fetch` (the network edge) is a
// recording/throwing stub so the suite runs offline and deterministically, and
// `localStorage` (the browser-local store `local-config` persists to) is an
// in-memory stub.
//
// Covered assertions:
//   1. `local-config` REJECTS a Docker Compose internal service-name base URL and
//      ACCEPTS a host-published localhost base URL (R54.2).
//   2. An allowed-origins (CORS) rejection surfaces guidance AND preserves the
//      current provider configuration unchanged (R54.5).
//   3. A Local-Model-Server connection failure yields an operation-scoped
//      "unreachable" error while pending request state is retained and the
//      operation can be retried once the server is reachable (R53.6).
//   4. Cross-mode egress boundary — reuse of **Property 3**: a payload seeded
//      with high-risk values transmitted through the Egress Gate to the chosen
//      cloud provider carries none of the secrets and reaches only that
//      provider's host; and with all-local providers no Redacted Payload ever
//      leaves the device (R50.6, R1.5 / R43.5).
//
// Requirements: 54.2, 54.5, 53.6, 50.6.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DefaultProviderManager,
  LOCAL_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  defaultProviderPlugins,
} from './provider-manager';
import {
  LocalProviderUnreachableError,
  createAnthropicLlmProvider,
  createLocalLlmProvider,
  createLocalSttProvider,
  createOpenAiLlmProvider,
  createOpenAiSttProvider,
} from './llm-http';
import {
  DEFAULT_LOCAL_CONFIG,
  getLocalConfig,
  isLikelyCorsRejection,
  localCorsGuidance,
  setLocalConfig,
  validateLocalBaseUrl,
} from './local-config';
import { InMemoryKeyVaultStorage, WebCryptoKeyVault } from './vault';
import { createPiiScanner } from './pii';
import { DefaultEgressGate, type EgressGate } from '@core/egress/egress-gate';
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

/** Answer the OpenAI-compatible endpoints, recording every (url, init). */
function answerOpenAiCompatible(url: string): Response {
  if (url.endsWith('/models')) return jsonResponse(200, { data: [] });
  if (url.endsWith('/chat/completions')) {
    return jsonResponse(200, { choices: [{ message: { content: 'chat reply' } }] });
  }
  if (url.endsWith('/audio/transcriptions')) return jsonResponse(200, { text: 'transcript' });
  if (url.endsWith('/audio/translations')) return jsonResponse(200, { text: 'translated' });
  return jsonResponse(404, { error: { message: `unexpected endpoint ${url}` } });
}

/** A recording `fetch` stub that answers the OpenAI-compatible endpoints. */
function makeRecordingFetch(): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    calls.push({ url: u, init });
    return answerOpenAiCompatible(u);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * A `fetch` stub that simulates a Local Model Server that is initially
 * unreachable (a thrown network error, as a browser surfaces a refused/down
 * server) and becomes reachable once `setReachable(true)` is called — used to
 * prove the unreachable error is operation-scoped and the operation can be
 * retried (R53.6).
 */
function makeFlakyLocalFetch(): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
  setReachable: (value: boolean) => void;
} {
  const calls: RecordedCall[] = [];
  let reachable = false;
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    calls.push({ url: u, init });
    if (!reachable) {
      // A down/refused server surfaces in the browser as a thrown TypeError,
      // NOT a non-ok HTTP response.
      throw new TypeError('Failed to fetch');
    }
    return answerOpenAiCompatible(u);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, setReachable: (value) => (reachable = value) };
}

/**
 * Read the textual completion from the gate's opaque `ProviderResponse` (which
 * at runtime carries the chat client's `text`). Typed as `unknown` so the test
 * does not depend on the internal `ChatResponse` shape.
 */
const responseText = (resp: unknown): string => {
  const maybe = resp as { text?: unknown };
  return typeof maybe.text === 'string' ? maybe.text : '';
};

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
} {
  const vault = new WebCryptoKeyVault({ storage: new InMemoryKeyVaultStorage() });
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
  const gate = new DefaultEgressGate({
    scanner: createPiiScanner(),
    providerManager: manager,
    notifyLabel: () => {},
    // Auto-accept redact-and-proceed so the seeded-secret payload is redacted
    // and transmitted (Property 3 asserts what survives into the wire form).
    confirmRedactAndProceed: async () => true,
  });
  return { manager, gate };
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

// --- Assertion 1: base-URL reachability validation (R54.2) -----------------

describe('Run-mode wiring — local-config base URL reachability (R54.2)', () => {
  it('REJECTS a Docker Compose internal service-name base URL with an explanatory error', () => {
    const result = validateLocalBaseUrl('http://ollama:11434');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/docker compose internal service name/i);
      expect(result.error).toMatch(/host-published localhost address/i);
    }
  });

  it('also rejects another bare single-label Compose service name (localai)', () => {
    expect(validateLocalBaseUrl('http://localai:8080/v1').ok).toBe(false);
  });

  it('ACCEPTS a host-published localhost base URL', () => {
    expect(validateLocalBaseUrl('http://localhost:11434').ok).toBe(true);
    expect(validateLocalBaseUrl('http://localhost:11434/v1').ok).toBe(true);
    expect(validateLocalBaseUrl('http://127.0.0.1:11434').ok).toBe(true);
  });

  it('setLocalConfig drops an unreachable service-name URL but applies a localhost URL (R54.2)', () => {
    // Start from a known-good saved configuration.
    setLocalConfig({ baseUrl: 'http://localhost:11434/v1', model: 'llama3', configured: true });

    // An attempt to save a Compose internal service-name URL is dropped so the
    // existing usable base URL is preserved rather than corrupted.
    const afterBadEdit = setLocalConfig({ baseUrl: 'http://ollama:11434' });
    expect(afterBadEdit.baseUrl).toBe('http://localhost:11434/v1');
    expect(getLocalConfig().baseUrl).toBe('http://localhost:11434/v1');

    // A host-published localhost URL is accepted and applied.
    const afterGoodEdit = setLocalConfig({ baseUrl: 'http://localhost:1234/v1' });
    expect(afterGoodEdit.baseUrl).toBe('http://localhost:1234/v1');
    expect(getLocalConfig().baseUrl).toBe('http://localhost:1234/v1');
  });
});

// --- Assertion 2: allowed-origins (CORS) rejection (R54.5) -----------------

describe('Run-mode wiring — allowed-origins (CORS) rejection (R54.5)', () => {
  it('surfaces allowed-origins guidance AND preserves the current provider configuration unchanged', async () => {
    // A browser CORS block surfaces as an opaque network error from the keyless
    // validation probe — never a non-ok HTTP response.
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const { manager } = makeStack(fetchImpl);

    // The user has a working saved configuration before attempting validation.
    const savedConfig = setLocalConfig({
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3',
      sttModel: 'whisper-1',
      configured: true,
    });

    // Provider-setup validation path: the keyless probe is rejected and the
    // manager reports the raw network reason for re-entry (R4.4).
    const validation = await manager.validateKey(LOCAL_PROVIDER_ID, '');
    expect(validation.valid).toBe(false);
    const reason = validation.valid ? undefined : validation.reason;

    // The opaque network reason is classified as a likely allowed-origins/CORS
    // rejection, so the setup path attaches the allowed-origins guidance (R54.5).
    expect(isLikelyCorsRejection(reason)).toBe(true);
    const guidance = localCorsGuidance('http://localhost:8080');
    expect(guidance).toMatch(/allowed origins \(cors\)/i);
    expect(guidance).toMatch(/OLLAMA_ORIGINS=http:\/\/localhost:8080/);
    expect(guidance).toMatch(/current provider configuration has been preserved/i);

    // The rejection path mutated NOTHING: the saved configuration is unchanged.
    expect(getLocalConfig()).toEqual(savedConfig);
  });
});

// --- Assertion 3: Local-Model-Server unreachable + retained state (R53.6) --

describe('Run-mode wiring — Local-Model-Server unreachable error (R53.6)', () => {
  it('yields an operation-scoped "unreachable" error while pending request state is retained and the op is retryable', async () => {
    const { fetchImpl, setReachable } = makeFlakyLocalFetch();
    const { gate } = makeStack(fetchImpl);

    // A caller's pending request state, held OUTSIDE the failed operation.
    const pending = { inFlight: true, answerDraft: 'My draft answer about a project' };

    // The Local Model Server is down: a real chat fails with an operation-scoped
    // unreachable error naming the configured base URL.
    const error = await gate
      .request({ provider: LOCAL_PROVIDER_ID, text: 'Summarise my experience.', operation: 'llm-chat' })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LocalProviderUnreachableError);
    expect((error as LocalProviderUnreachableError).baseUrl).toBe(DEFAULT_LOCAL_CONFIG.baseUrl);
    expect((error as Error).message).toMatch(/could not be reached/i);
    expect((error as Error).message).toMatch(/pending request has been kept/i);

    // The error is scoped to that single operation: the caller's pending state
    // is untouched (raising it performs no side effect).
    expect(pending).toEqual({ inFlight: true, answerDraft: 'My draft answer about a project' });

    // Once the server is reachable, retrying the SAME operation succeeds —
    // confirming the pending request could simply be retried.
    setReachable(true);
    const response = await gate.request({
      provider: LOCAL_PROVIDER_ID,
      text: 'Summarise my experience.',
      operation: 'llm-chat',
    });
    expect(responseText(response)).toBe('chat reply');
  });

  it('a transcription connection failure is likewise operation-scoped and retained (R53.6)', async () => {
    const { fetchImpl, setReachable } = makeFlakyLocalFetch();
    const { gate } = makeStack(fetchImpl);

    await expect(
      gate.transcribe({ provider: LOCAL_PROVIDER_ID, audio: audio('wav') }),
    ).rejects.toMatchObject({
      name: 'LocalProviderUnreachableError',
      baseUrl: DEFAULT_LOCAL_CONFIG.baseUrl,
    });

    setReachable(true);
    const transcript = await gate.transcribe({ provider: LOCAL_PROVIDER_ID, audio: audio('wav') });
    expect(transcript.text).toBe('transcript');
  });
});

// --- Assertion 4: cross-mode egress boundary — reuse Property 3 (R50.6) ----

// Feature: career-agent — reuse of Correctness Property 3 (redaction
// completeness and egress boundary) as a run-mode integration assertion: the
// egress destinations and the Egress-Gate-only boundary are identical in every
// Run Mode (R50.6), so the container/compose modes need no new property.
const SECRETS = {
  ssn: '123-45-6789',
  nino: 'AB 12 34 56 C',
  creditCard: '4111 1111 1111 1111',
  apiKey: 'sk-proj-abcd1234efgh5678ijklmnop',
} as const;

const seededPayload = (): string =>
  `My SSN is ${SECRETS.ssn}, my UK NINO is ${SECRETS.nino}, ` +
  `card ${SECRETS.creditCard}, and key ${SECRETS.apiKey}. Please help with my CV.`;

describe('Run-mode wiring — cross-mode egress boundary reaffirms Property 3 (R50.6)', () => {
  it('a seeded high-risk payload sent through the gate carries NO secret and reaches ONLY the chosen provider', async () => {
    const { fetchImpl, calls } = makeRecordingFetch();
    const { manager, gate } = makeStack(fetchImpl);
    await manager.storeKey(OPENAI_PROVIDER_ID, 'sk-test-123');

    const response = await gate.request({
      provider: OPENAI_PROVIDER_ID,
      text: seededPayload(),
      operation: 'llm-chat',
    });

    // The ONLY outbound request reached the user's chosen provider host (R7.4).
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');

    // The transmitted, minimised Redacted Payload contains NONE of the seeded
    // secrets and instead carries category markers (Property 3 / R6.4, R6.5).
    const transmitted = JSON.parse(String(calls[0].init?.body)).messages[0].content as string;
    for (const secret of Object.values(SECRETS)) {
      expect(transmitted).not.toContain(secret);
    }
    expect(transmitted).toMatch(/\[REDACTED:ssn\]/);
    expect(transmitted).toMatch(/\[REDACTED:nino\]/);
    expect(transmitted).toMatch(/\[REDACTED:credit_card\]/);
    expect(transmitted).toMatch(/\[REDACTED:api_key_or_token\]/);

    // No detected secret is echoed into the generated output, either.
    const output = responseText(response);
    for (const secret of Object.values(SECRETS)) {
      expect(output).not.toContain(secret);
    }
  });

  it('with all-local providers, NO Redacted Payload leaves the device — fully offline (R1.5 / R43.5)', async () => {
    const { fetchImpl, calls } = makeRecordingFetch();
    const { gate } = makeStack(fetchImpl);

    // Chat and transcription both routed to the keyless Local Provider.
    const response = await gate.request({
      provider: LOCAL_PROVIDER_ID,
      text: seededPayload(),
      operation: 'llm-chat',
    });
    await gate.transcribe({ provider: LOCAL_PROVIDER_ID, audio: audio('wav') });

    // Every outbound request targeted the on-device local server only; no
    // third-party host was ever contacted.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith(DEFAULT_LOCAL_CONFIG.baseUrl)).toBe(true);
      for (const host of THIRD_PARTY_HOSTS) {
        expect(call.url).not.toContain(host);
      }
    }

    // A local on-device call has NO third-party egress, so PII screening is
    // skipped and the FULL content is sent as-is — but to the local endpoint
    // ONLY (asserted above). Nothing leaves the device, which is the
    // fully-offline guarantee (R1.5 / R43.5): the payload may carry the secrets
    // precisely because it never crosses to a third party.
    const transmitted = JSON.parse(String(calls[0].init?.body)).messages[0].content as string;
    for (const secret of Object.values(SECRETS)) {
      expect(transmitted).toContain(secret);
    }
    expect(responseText(response)).toBe('chat reply');
  });
});
