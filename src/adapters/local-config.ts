// Local (self-hosted, OpenAI-compatible) provider configuration.
//
// The "Local" provider points at a self-hosted, OpenAI-compatible model server
// (Ollama by default; also LocalAI, LM Studio, llama.cpp, vLLM, …). Unlike the
// BYOK cloud providers it needs NO API key, but it DOES need a base URL and the
// model names the user configured on their server — these vary per setup, so
// they are stored editable in browser-local storage (never in the Memory Store)
// and read just-in-time by the local provider client.
//
// Because the server runs on the user's own machine (localhost), using it keeps
// the app fully local: no data leaves the device. Requests still pass through
// the single Egress Gate for consistent labelling/PII-screening.

/** The editable local-provider configuration. */
export interface LocalProviderConfig {
  /** OpenAI-compatible base URL, e.g. `http://localhost:11434/v1` (Ollama). */
  readonly baseUrl: string;
  /** Chat/completions model name as configured on the local server. */
  readonly model: string;
  /** Speech-to-text model name (e.g. a Whisper model) on the local server. */
  readonly sttModel: string;
  /**
   * Maximum completion tokens for a local chat request (R43.6). Defaults to
   * {@link DEFAULT_LOCAL_MAX_TOKENS} — higher than the cloud clients' 512 —
   * because reasoning models emit a chain-of-thought before their answer and
   * need budget for both. User-editable; tokens are free on a local server.
   */
  readonly maxTokens: number;
  /** Whether the user has validated/saved a working local configuration. */
  readonly configured: boolean;
}

/**
 * Default maximum completion tokens for the Local Provider (R43.6). Set well
 * above the cloud clients' 512 so a reasoning model (e.g. `deepseek-r1`) has
 * room to finish thinking AND still emit its full answer; at 512 the reasoning
 * alone exhausts the budget and `message.content` comes back empty.
 */
export const DEFAULT_LOCAL_MAX_TOKENS = 2048;

/**
 * Coerce an arbitrary persisted value into a usable positive-integer token
 * limit, falling back to {@link DEFAULT_LOCAL_MAX_TOKENS} for anything that is
 * not a finite positive number (R43.6). Fractional values are floored.
 */
const normaliseMaxTokens = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return DEFAULT_LOCAL_MAX_TOKENS;
  }
  return Math.floor(value);
};

/** Whether a candidate `maxTokens` value is a usable positive integer (R43.6). */
export const isValidMaxTokens = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1;

// Host-published localhost defaults (R54.1). In the Docker Compose Stack the
// browser runs on the HOST and is outside the Compose network, so it can only
// reach a model server through its **host-published port** — never through a
// Compose internal service name. The reachable browser-facing base URLs are
// therefore host-published localhost addresses:
//   - chat (Ollama):        http://localhost:11434
//   - speech-to-text (LocalAI/whisper, behind the `stt` profile): http://localhost:8081
// These are documented as constants so the UI/Provider_Manager and the Compose
// outline agree on the reachable defaults. The single editable `baseUrl` below
// keeps the existing chat default working (`http://localhost:11434/v1`, the
// `/v1` OpenAI-compatible suffix Ollama expects); a separate STT base URL field
// is intentionally not introduced (no schema change) — the host-published STT
// default is recorded here for documentation and reuse.
export const HOST_PUBLISHED_CHAT_BASE_URL = 'http://localhost:11434';
export const HOST_PUBLISHED_STT_BASE_URL = 'http://localhost:8081';

// Ollama defaults; the user edits these to match their own server/models so the
// Local Provider can equally target LocalAI, LM Studio, llama.cpp server, or vLLM.
// - baseUrl: Ollama's OpenAI-compatible endpoint (`http://localhost:11434/v1`),
//   a host-published localhost address reachable from the browser (R54.1).
// - model: `llama3`, a widely-available Ollama chat model and a sensible default;
//   users on lower-capacity hardware can switch to a smaller model (Requirement 43.4).
// - sttModel: `whisper-1`, the standard OpenAI-compatible speech-to-text model name.
export const DEFAULT_LOCAL_CONFIG: LocalProviderConfig = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'llama3',
  sttModel: 'whisper-1',
  maxTokens: DEFAULT_LOCAL_MAX_TOKENS,
  configured: false,
};

const STORAGE_KEY = 'career-agent.local-provider';

/** Resolve a browser-local storage backend, if available (guarded for tests/SSR). */
const storage = (): Storage | null => {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
};

/** Read the persisted local config, merged over defaults. */
export const getLocalConfig = (): LocalProviderConfig => {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_LOCAL_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<LocalProviderConfig>;
    return {
      baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim() ? parsed.baseUrl : DEFAULT_LOCAL_CONFIG.baseUrl,
      model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model : DEFAULT_LOCAL_CONFIG.model,
      sttModel: typeof parsed.sttModel === 'string' && parsed.sttModel.trim() ? parsed.sttModel : DEFAULT_LOCAL_CONFIG.sttModel,
      maxTokens: normaliseMaxTokens(parsed.maxTokens),
      configured: parsed.configured === true,
    };
  } catch {
    return DEFAULT_LOCAL_CONFIG;
  }
};

/** The result of validating a candidate Local Provider base URL (R54.2). */
export type LocalBaseUrlValidation = { ok: true } | { ok: false; error: string };

/** Does `host` look like a dotted IPv4 literal (e.g. `192.168.0.10`)? */
const isIpv4Literal = (host: string): boolean =>
  /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);

/**
 * Validate a Local Provider base URL for **host-browser reachability** (R54.1,
 * R54.2).
 *
 * In the Docker Compose Stack the browser runs on the host, outside the Compose
 * network, so it can only reach a model server through a **host-published port**
 * (a localhost address). A base URL whose host is a Docker Compose **internal
 * service name** (e.g. `http://ollama:11434`, `http://localai:8080`) resolves
 * only container-to-container and *will fail from the browser*, so it is
 * rejected with an explanatory error.
 *
 * A bare single-label hostname is treated as a likely Compose service name and
 * rejected. Everything genuinely reachable is accepted:
 *   - `localhost`, `127.0.0.1`, `::1` (the loopback host);
 *   - any IPv4/IPv6 literal;
 *   - any dotted host / FQDN (contains a `.`).
 *
 * The function never throws; it returns `{ ok: false, error }` for the caller to
 * surface, leaving the existing saved configuration untouched.
 */
export const validateLocalBaseUrl = (url: string): LocalBaseUrlValidation => {
  const trimmed = (url ?? '').trim();
  if (!trimmed) {
    return {
      ok: false,
      error:
        'A base URL is required. Use a host-published localhost address such as ' +
        `${HOST_PUBLISHED_CHAT_BASE_URL} (chat) or ${HOST_PUBLISHED_STT_BASE_URL} (speech-to-text).`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error:
        `"${trimmed}" is not a valid URL. Use a host-published localhost address such as ` +
        `${HOST_PUBLISHED_CHAT_BASE_URL}.`,
    };
  }

  const host = parsed.hostname.toLowerCase();

  // IPv6 literals arrive bracketed from URL.hostname (e.g. "[::1]"); accept them.
  if (host.startsWith('[') && host.endsWith(']')) {
    return { ok: true };
  }
  // Loopback, IP literals, and any dotted host / FQDN are reachable from the browser.
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.includes('.') ||
    isIpv4Literal(host)
  ) {
    return { ok: true };
  }

  // A bare single-label hostname (not localhost, no dot, not an IP) is almost
  // certainly a Docker Compose internal service name (e.g. `ollama`, `localai`).
  return {
    ok: false,
    error:
      `The base URL host "${parsed.hostname}" looks like a Docker Compose internal service name. ` +
      'It resolves only container-to-container and cannot be reached from your browser. ' +
      'The host browser can only reach a model server via a host-published localhost address — ' +
      `use http://localhost:<published-port> (for example ${HOST_PUBLISHED_CHAT_BASE_URL} for chat ` +
      `or ${HOST_PUBLISHED_STT_BASE_URL} for speech-to-text).`,
  };
};

/**
 * Guidance shown when a Local Model Server **rejects the browser request because
 * the served origin is not allowed** (CORS / allowed-origins, R54.5). The caller
 * surfaces this text alongside the rejection reason; it does NOT mutate the saved
 * provider configuration, so the current config is preserved.
 *
 * `servedOrigin` is the exact origin (scheme, host, port) the app is served from
 * (e.g. `http://localhost:8080`); when unknown a representative example is used.
 */
export const localCorsGuidance = (servedOrigin?: string): string => {
  const origin = servedOrigin?.trim() || 'http://localhost:8080';
  const named = servedOrigin?.trim()
    ? `your served origin (${origin})`
    : `your served origin (for example ${origin})`;
  return [
    `The local model server refused the request because ${named} is not in its allowed origins (CORS).`,
    'Add that exact origin (scheme, host, and port) to the model server\u2019s allowed-origins configuration:',
    `\u2022 Ollama (chat): set OLLAMA_ORIGINS=${origin}`,
    `\u2022 LocalAI (speech-to-text): set its CORS allow-origins, e.g. CORS_ALLOW_ORIGINS=${origin}`,
    'Your current provider configuration has been preserved.',
  ].join('\n');
};

/**
 * Heuristic: does a connection-failure reason look like a CORS / allowed-origins
 * rejection? Browsers surface blocked cross-origin requests as opaque network
 * errors ("Failed to fetch", "NetworkError", a bare TypeError), so we match those
 * along with any explicit CORS/origin wording to decide whether to attach the
 * allowed-origins guidance (R54.5).
 */
export const isLikelyCorsRejection = (reason: string | undefined | null): boolean => {
  if (!reason) return false;
  return /\b(cors|origin|failed to fetch|networkerror|network error|cross-origin)\b/i.test(reason);
};

/**
 * Heuristic: does a thrown value look like a **connection failure / no response**
 * from a Local Model Server (R53.6)? A model server that is down, refused, or
 * never answers surfaces in the browser not as a non-ok HTTP response but as a
 * thrown error — a `TypeError` ("Failed to fetch"), an `AbortError`/timeout, or
 * a bare network error. (An undefined/empty response also blows up while reading
 * `res.ok`, which manifests as a `TypeError` here.) We match those shapes so the
 * Local Provider call path can map them to a clear, operation-scoped
 * "unreachable" error rather than leaking the raw fetch failure.
 *
 * This is intentionally distinct from {@link isLikelyCorsRejection}: that helper
 * classifies a *reason string* in the provider setup/validation path to attach
 * allowed-origins guidance (R54.5); this helper classifies a *thrown error* in
 * the live chat/STT operation path to surface the unreachable error (R53.6).
 */
export const isLocalConnectionFailure = (error: unknown): boolean => {
  if (error instanceof TypeError) return true;
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
    return /\b(failed to fetch|networkerror|network error|fetch failed|load failed|connection refused|econnrefused|enotfound|econnreset|network request failed)\b/i.test(
      error.message,
    );
  }
  return false;
};

/**
 * Build the operation-scoped "unreachable" message shown when a call to a Local
 * Model Server fails to connect or returns no response (R53.6). It names the
 * `baseUrl` that could not be reached and points at the host-published localhost
 * addresses the Compose stack / model server should be listening on, so the user
 * can confirm the server is running and reachable. The caller surfaces this for
 * the single failed operation only and does NOT clear the user's pending request
 * state — the message reassures the user the request was kept so they can retry.
 */
export const localUnreachableMessage = (baseUrl: string): string => {
  const target = baseUrl?.trim() || 'the configured base URL';
  return (
    `The local model server at ${target} could not be reached. ` +
    'Confirm the Compose stack / model server is running and reachable at its ' +
    `host-published localhost address (for example ${HOST_PUBLISHED_CHAT_BASE_URL} ` +
    `for chat or ${HOST_PUBLISHED_STT_BASE_URL} for speech-to-text). ` +
    'Your pending request has been kept, so you can retry once the server is reachable.'
  );
};

/**
 * Persist a partial update to the local config.
 *
 * Guards base-URL reachability (R54.2): if the patch carries a `baseUrl` that is
 * NOT reachable from the host browser (a Compose internal service name, etc.),
 * the `baseUrl` is dropped from the persisted patch so the existing saved
 * configuration is preserved rather than corrupted. Callers that need the
 * explanatory error should pre-check with {@link validateLocalBaseUrl}.
 */
export const setLocalConfig = (patch: Partial<LocalProviderConfig>): LocalProviderConfig => {
  let sanitized: Partial<LocalProviderConfig> = { ...patch };
  if (typeof sanitized.baseUrl === 'string' && !validateLocalBaseUrl(sanitized.baseUrl).ok) {
    // Never overwrite a usable saved base URL with an unreachable one. Omit the
    // key (rather than `delete`, which is invalid on the readonly property).
    const { baseUrl: _rejected, ...rest } = sanitized;
    sanitized = rest;
  }
  // Never overwrite a usable saved token limit with a non-positive/invalid one
  // (R43.6); drop the key so the existing saved value is preserved.
  if ('maxTokens' in sanitized && !isValidMaxTokens(sanitized.maxTokens)) {
    const { maxTokens: _rejectedTokens, ...rest } = sanitized;
    sanitized = rest;
  }
  const next = { ...getLocalConfig(), ...sanitized };
  storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
};

/** Whether a usable local configuration has been saved. */
export const isLocalConfigured = (): boolean => getLocalConfig().configured;
