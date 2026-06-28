// Real BYOK LLM HTTP clients (OpenAI + Anthropic) — the concrete `LlmProvider`
// implementations injected into the Provider_Manager registry.
//
// This is the ONE place that performs an outbound network request to a provider.
// It is an adapter: it implements the `LlmProvider` boundary port and is wired
// into the `DefaultProviderManager` only at the composition root (ui/runtime.ts).
// The Provider_Manager itself is reached only through the single Egress Gate, so
// the Egress-Gate-only network boundary (Requirements 6, 7) is preserved — these
// clients are never imported by any @core domain component.
//
// The user-supplied key is received per call and handed straight to the provider
// in the request headers; it is never stored or logged here (R5.3).
//
// Boundary contract (see ./provider-manager):
//   * The Provider_Manager calls `chat(VALIDATION_PROBE, key)` to validate a key
//     (R4.3). The probe carries no prompt text, so we issue a cheap, no-token
//     auth check (GET /models) and report a useful failure reason on rejection.
//   * The Provider_Manager calls `chat(redactedPayload, key)` to send a real,
//     PII-screened request built by the Egress Gate; the payload's `text` is the
//     prompt. The textual completion is returned on the (opaque) response.
//
// CORS note: OpenAI permits direct browser calls; Anthropic requires the
// `anthropic-dangerous-direct-browser-access` header to enable browser CORS.
//
// Requirements: 4.3, 4.4, 5.3, 7.2, 7.4.

import type {
  AudioBlob,
  ChatRequest,
  ChatResponse,
  LlmProvider,
  SttProvider,
  SttOptions,
  Transcript,
} from './provider';
import { OPENAI_PROVIDER_ID, ANTHROPIC_PROVIDER_ID, LOCAL_PROVIDER_ID } from './provider-manager';
import { getLocalConfig, isLocalConnectionFailure, localUnreachableMessage } from './local-config';

/** A provider chat response that also carries the textual completion. */
export interface LlmChatResponse extends ChatResponse {
  readonly text: string;
}

/** Read the textual completion from an (opaque) provider chat response. */
export const readChatResponseText = (resp: ChatResponse): string => {
  const maybe = resp as { text?: unknown };
  return typeof maybe.text === 'string' ? maybe.text : '';
};

/** Shared options for the HTTP LLM clients. */
export interface HttpLlmOptions {
  /** Override the model used for real completions. */
  readonly model?: string;
  /** Override the API base URL (e.g. for a proxy or a mock in tests). */
  readonly baseUrl?: string;
  /** Inject a `fetch` implementation (defaults to the global `fetch`). */
  readonly fetchImpl?: typeof fetch;
  /** Cap the completion length for real requests. */
  readonly maxTokens?: number;
}

/** The prompt text carried by a real request, or '' for a validation probe. */
const promptText = (req: ChatRequest): string => {
  const maybe = req as { text?: unknown };
  return typeof maybe.text === 'string' ? maybe.text.trim() : '';
};

/**
 * Whether the request asks for the strongest no-training/no-retention posture
 * (R42.1). Carried on the redacted payload by the Egress Gate from the session
 * consent state.
 */
const noTraining = (req: ChatRequest): boolean => {
  const maybe = req as { noTraining?: unknown };
  return maybe.noTraining === true;
};

const resolveFetch = (override?: typeof fetch): typeof fetch => {
  const impl = override ?? (globalThis.fetch as typeof fetch | undefined);
  if (!impl) {
    throw new Error('No fetch implementation is available in this environment.');
  }
  return impl.bind(globalThis);
};

const readJson = async (res: Response): Promise<unknown> => {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
};

/** Pull a human-readable error message out of a provider error body. */
const extractErrorMessage = (data: unknown): string | undefined => {
  if (data && typeof data === 'object') {
    const err = (data as { error?: unknown }).error;
    if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
      return (err as { message: string }).message;
    }
    const msg = (data as { message?: unknown }).message;
    if (typeof msg === 'string') {
      return msg;
    }
  }
  return undefined;
};

const providerError = (status: number, data: unknown): string => {
  const message = extractErrorMessage(data);
  return message ? `${status}: ${message}` : `Request failed with status ${status}.`;
};

const ok = (): LlmChatResponse => ({ __brand: 'ChatResponse', text: '' });

/** Bearer auth header, omitted entirely for keyless (local) servers. */
const bearer = (key: string): Record<string, string> =>
  key.trim().length > 0 ? { authorization: `Bearer ${key}` } : {};

// --- Shared OpenAI-compatible transport ------------------------------------
//
// OpenAI, and any self-hosted OpenAI-Compatible Endpoint (Ollama, LocalAI, LM
// Studio, llama.cpp server, vLLM), expose the same `/chat/completions`,
// `GET /models`, and `/audio/transcriptions` shapes. The local provider reuses
// this transport verbatim; the only differences are where the base URL/model
// come from (static for OpenAI, read per call from `local-config` for local)
// and that the keyless local server gets no auth header — which `bearer()`
// already handles, since it omits the header for an empty key.

const extractOpenAiText = (data: unknown): string => {
  const choices = (data as { choices?: unknown }).choices;
  if (Array.isArray(choices)) {
    const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message
      ?.content;
    if (typeof content === 'string') {
      return content;
    }
  }
  return '';
};

/** Resolved per-call transport config for an OpenAI-compatible chat client. */
interface OpenAiChatConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly maxTokens: number;
}

/**
 * Issue an OpenAI-compatible chat request (or a no-token validation probe).
 *
 * A request with no prompt text is treated as a validation probe: it issues a
 * cheap `GET /models` auth check that spends no tokens (R4.3) and reports the
 * server's failure reason on rejection (R4.4). A request carrying prompt text
 * issues the `/chat/completions` completion and returns the textual result.
 *
 * The `key` is handed straight to the server via `bearer()`, which omits the
 * auth header entirely for keyless (local) servers (R43.2).
 */
const openAiCompatibleChat = async (
  doFetch: typeof fetch,
  config: OpenAiChatConfig,
  req: ChatRequest,
  key: string,
): Promise<ChatResponse> => {
  const prompt = promptText(req);

  // Validation probe: a cheap auth check that spends no tokens (R4.3).
  if (prompt.length === 0) {
    const res = await doFetch(`${config.baseUrl}/models`, {
      headers: { ...bearer(key) },
    });
    if (!res.ok) {
      throw new Error(providerError(res.status, await readJson(res)));
    }
    return ok();
  }

  const res = await doFetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...bearer(key),
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      messages: [{ role: 'user', content: prompt }],
      // OpenAI does not train on API data by default; `store: false`
      // additionally opts out of 30-day retention when the user has not
      // consented to training/improvement use (R42.1). Self-hosted servers
      // ignore the unknown field, and being local they never egress anyway.
      ...(noTraining(req) ? { store: false } : {}),
    }),
  });
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(providerError(res.status, data));
  }
  return { __brand: 'ChatResponse', text: extractOpenAiText(data) } as LlmChatResponse;
};

/**
 * Issue an OpenAI-compatible Whisper transcription. The audio is the minimal
 * payload (R7.2); `bearer()` omits the auth header for keyless local servers.
 *
 * When `options.translateToEnglish` is set the request targets the Whisper
 * `/audio/translations` endpoint, which always outputs English regardless of
 * the source language (R26.5); otherwise it uses `/audio/transcriptions` for a
 * same-language transcript.
 */
const openAiCompatibleTranscribe = async (
  doFetch: typeof fetch,
  baseUrl: string,
  model: string,
  audio: AudioBlob,
  key: string,
  options: SttOptions = {},
): Promise<Transcript> => {
  const form = new FormData();
  // Copy into a definite ArrayBuffer so the Blob type-checks across libs.
  const buffer = audio.bytes.slice().buffer as ArrayBuffer;
  const blob = new Blob([buffer], { type: AUDIO_MIME[audio.format] ?? 'application/octet-stream' });
  form.append('file', blob, `answer.${audio.format}`);
  form.append('model', model);
  // The translations endpoint always outputs English; transcriptions keeps the
  // source language (R26.5).
  const endpoint = options.translateToEnglish ? 'audio/translations' : 'audio/transcriptions';
  const res = await doFetch(`${baseUrl}/${endpoint}`, {
    method: 'POST',
    headers: { ...bearer(key) },
    body: form,
  });
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(providerError(res.status, data));
  }
  const text = typeof (data as { text?: unknown }).text === 'string'
    ? (data as { text: string }).text
    : '';
  return { __brand: 'Transcript', text };
};

// --- OpenAI -----------------------------------------------------------------

const OPENAI_BASE = 'https://api.openai.com/v1';
const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

/** Build the OpenAI {@link LlmProvider} (Chat Completions API). */
export function createOpenAiLlmProvider(options: HttpLlmOptions = {}): LlmProvider {
  const baseUrl = options.baseUrl ?? OPENAI_BASE;
  const model = options.model ?? OPENAI_DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? 512;

  return {
    id: OPENAI_PROVIDER_ID,
    async chat(req, key): Promise<ChatResponse> {
      const doFetch = resolveFetch(options.fetchImpl);
      return openAiCompatibleChat(doFetch, { baseUrl, model, maxTokens }, req, key);
    },
  };
}

// --- Anthropic --------------------------------------------------------------

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_DEFAULT_MODEL = 'claude-3-5-haiku-latest';
const ANTHROPIC_VERSION = '2023-06-01';

/** Headers required for direct browser (CORS) access to the Anthropic API. */
const anthropicHeaders = (key: string): Record<string, string> => ({
  'x-api-key': key,
  'anthropic-version': ANTHROPIC_VERSION,
  // Anthropic blocks browser calls unless this opt-in header is present.
  'anthropic-dangerous-direct-browser-access': 'true',
});

const extractAnthropicText = (data: unknown): string => {
  const content = (data as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : '',
      )
      .join('');
  }
  return '';
};

/** Build the Anthropic {@link LlmProvider} (Messages API). */
export function createAnthropicLlmProvider(options: HttpLlmOptions = {}): LlmProvider {
  const baseUrl = options.baseUrl ?? ANTHROPIC_BASE;
  const model = options.model ?? ANTHROPIC_DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? 512;

  return {
    id: ANTHROPIC_PROVIDER_ID,
    async chat(req, key): Promise<ChatResponse> {
      const doFetch = resolveFetch(options.fetchImpl);
      const prompt = promptText(req);

      // Validation probe: a cheap auth check that spends no tokens (R4.3).
      if (prompt.length === 0) {
        const res = await doFetch(`${baseUrl}/models`, { headers: anthropicHeaders(key) });
        if (!res.ok) {
          throw new Error(providerError(res.status, await readJson(res)));
        }
        return ok();
      }

      const res = await doFetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...anthropicHeaders(key) },
        body: JSON.stringify({
          // Anthropic does not train on API inputs/outputs by default, and the
          // Messages API exposes no per-request training toggle, so `noTraining`
          // needs no wire change here — the default already honours it (R42.1).
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        throw new Error(providerError(res.status, data));
      }
      return { __brand: 'ChatResponse', text: extractAnthropicText(data) } as LlmChatResponse;
    },
  };
}

/**
 * Convenience factory for the default seed clients, shaped for
 * `defaultProviderPlugins(...)`. Wired at the composition root only.
 */
export function createDefaultLlmClients(options: HttpLlmOptions = {}) {
  return {
    openai: {
      llm: createOpenAiLlmProvider(options),
      stt: createOpenAiSttProvider(),
    },
    anthropic: { llm: createAnthropicLlmProvider(options) },
    // Keyless local provider (R43): base URL/model come from `local-config` per
    // call, so only fetch/maxTokens overrides are forwarded here.
    local: {
      llm: createLocalLlmProvider({ fetchImpl: options.fetchImpl, maxTokens: options.maxTokens }),
      stt: createLocalSttProvider({ fetchImpl: options.fetchImpl }),
    },
  };
}

// --- OpenAI speech-to-text (Whisper) ---------------------------------------

/** MIME type for the supported audio container formats. */
const AUDIO_MIME: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  webm: 'audio/webm',
};

/** Options for the OpenAI STT client. */
export interface OpenAiSttOptions {
  readonly model?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Build the OpenAI speech-to-text {@link SttProvider} (Whisper transcription
 * API, R26.2). The audio is the minimal payload (R7.2); the key is handed to the
 * provider per call and never stored. Called only via the Egress Gate's STT
 * path, which screens the resulting transcript before release (R26.2 → R6).
 */
export function createOpenAiSttProvider(options: OpenAiSttOptions = {}): SttProvider {
  const baseUrl = options.baseUrl ?? OPENAI_BASE;
  const model = options.model ?? 'whisper-1';
  return {
    async transcribe(audio: AudioBlob, key: string, sttOptions?: SttOptions): Promise<Transcript> {
      const doFetch = resolveFetch(options.fetchImpl);
      return openAiCompatibleTranscribe(doFetch, baseUrl, model, audio, key, sttOptions);
    },
  };
}

// --- Local / self-hosted OpenAI-Compatible Endpoint (R43) ------------------
//
// The keyless Local Provider targets a self-hosted, OpenAI-compatible runtime
// (Ollama by default; also LocalAI, LM Studio, llama.cpp server, vLLM). It
// reuses the shared OpenAI-compatible transport above and differs only in two
// ways: it needs NO API key (the auth header is omitted via `bearer('')`), and
// the base URL + model names are user-editable per setup, so they are read from
// `getLocalConfig()` *at call time* rather than captured at construction —
// editing the config in the UI takes effect on the very next request without
// rebuilding the provider client. Because the server runs on the user's own
// machine, no Redacted Payload leaves the device (R43.5).

/** Options for the keyless Local LLM client. */
export interface LocalLlmOptions {
  /** Inject a `fetch` implementation (defaults to the global `fetch`). */
  readonly fetchImpl?: typeof fetch;
  /** Cap the completion length for real requests. */
  readonly maxTokens?: number;
}

/** Options for the keyless Local STT client. */
export interface LocalSttOptions {
  /** Inject a `fetch` implementation (defaults to the global `fetch`). */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Raised when a call to the keyless Local Model Server fails to connect or
 * returns no response (R53.6). Unlike a non-ok HTTP response (which surfaces the
 * server's own status/message), a server that is down, refused, timed out, or
 * silent throws a network error; this maps that to a clear, operation-scoped
 * "unreachable" error.
 *
 * It is scoped to the single failed operation and carries the original `cause`
 * for diagnostics. Crucially, raising it performs NO side effect — the Local
 * Provider client writes nothing and clears nothing — so the caller's pending
 * request state (in-flight request, answer draft, pending input) is retained and
 * the user can simply retry once the server is reachable.
 */
export class LocalProviderUnreachableError extends Error {
  constructor(
    public readonly baseUrl: string,
    public readonly cause?: unknown,
  ) {
    super(localUnreachableMessage(baseUrl));
    this.name = 'LocalProviderUnreachableError';
  }
}

/**
 * Run a Local Model Server operation, mapping a connection failure / no-response
 * (a thrown network error) to a {@link LocalProviderUnreachableError} scoped to
 * that single operation (R53.6). A non-ok HTTP response is NOT a connection
 * failure — it is re-thrown unchanged so the server's own status/message (e.g. a
 * validation or model-loading error) still surfaces. The mapping is a pure
 * re-throw: no state is mutated, so the caller's pending request is retained.
 */
const withLocalReachability = async <T>(baseUrl: string, op: () => Promise<T>): Promise<T> => {
  try {
    return await op();
  } catch (error) {
    if (isLocalConnectionFailure(error)) {
      throw new LocalProviderUnreachableError(baseUrl, error);
    }
    throw error;
  }
};

/**
 * Build the keyless Local {@link LlmProvider} (R43). The base URL and chat model
 * are read from `getLocalConfig()` on every call so the user's edits apply
 * immediately. The auth header is omitted for the keyless server.
 */
export function createLocalLlmProvider(options: LocalLlmOptions = {}): LlmProvider {
  const fallbackMaxTokens = options.maxTokens ?? 512;
  return {
    id: LOCAL_PROVIDER_ID,
    async chat(req, key): Promise<ChatResponse> {
      const doFetch = resolveFetch(options.fetchImpl);
      const { baseUrl, model, maxTokens: configuredMaxTokens } = getLocalConfig();
      // The completion-token limit is read from local-config per call (R43.6) so
      // a user edit applies on the next request; it defaults high enough for a
      // reasoning model to finish thinking and still return its answer.
      const maxTokens = configuredMaxTokens ?? fallbackMaxTokens;
      // A real chat operation that fails to connect / gets no response surfaces
      // as an operation-scoped "unreachable" error (R53.6). The no-prompt
      // validation probe is deliberately left to surface the raw failure reason
      // so the provider-setup path can still classify allowed-origins/CORS
      // rejections (R54.5) and report the server's own reason (R4.4).
      const isProbe = promptText(req).length === 0;
      if (isProbe) {
        return openAiCompatibleChat(doFetch, { baseUrl, model, maxTokens }, req, key);
      }
      return withLocalReachability(baseUrl, () =>
        openAiCompatibleChat(doFetch, { baseUrl, model, maxTokens }, req, key),
      );
    },
  };
}

/**
 * Build the keyless Local speech-to-text {@link SttProvider} (R43, R26.2). The
 * base URL and STT model are read from `getLocalConfig()` per call so config
 * edits apply immediately; the auth header is omitted for the keyless server.
 */
export function createLocalSttProvider(options: LocalSttOptions = {}): SttProvider {
  return {
    async transcribe(audio: AudioBlob, key: string, sttOptions?: SttOptions): Promise<Transcript> {
      const doFetch = resolveFetch(options.fetchImpl);
      const { baseUrl, sttModel } = getLocalConfig();
      // A transcription that fails to connect / gets no response surfaces as an
      // operation-scoped "unreachable" error (R53.6); a non-ok HTTP response
      // still surfaces the server's own reason unchanged.
      return withLocalReachability(baseUrl, () =>
        openAiCompatibleTranscribe(doFetch, baseUrl, sttModel, audio, key, sttOptions),
      );
    },
  };
}
