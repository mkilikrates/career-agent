// Adaptive rate-limit and context-window awareness for provider calls.
//
// Two layers:
//   1. A STATIC model-capabilities table mapping known model ID patterns to
//      their context-window size (max input tokens). Used for the first call
//      when no runtime data is available.
//   2. A RUNTIME cache populated from `x-ratelimit-*` response headers after
//      each successful call. Subsequent budget checks use the real numbers.
//
// Together these let the app estimate whether a payload fits BEFORE sending,
// so it can trim background context proactively rather than hitting a 429.

/**
 * Static context-window sizes (max input tokens) for known model families.
 * When a model isn't in this table, a conservative default (30,000) is used.
 * These are approximate and may lag behind provider updates — the runtime
 * header cache always takes precedence when available.
 */
const MODEL_CONTEXT_WINDOWS: readonly [RegExp, number][] = [
  // OpenAI
  [/^gpt-4o-mini/i, 128_000],
  [/^gpt-4o/i, 128_000],
  [/^gpt-4\.1/i, 1_000_000],
  [/^gpt-4-turbo/i, 128_000],
  [/^gpt-4\.5/i, 128_000],
  [/^gpt-5\.5/i, 1_000_000],
  [/^o[1-9]/i, 200_000], // o1, o3, o4-mini
  [/^chatgpt-4o/i, 128_000],
  // Anthropic
  [/^claude-3-5-haiku/i, 200_000],
  [/^claude-3-5-sonnet/i, 200_000],
  [/^claude-sonnet-4/i, 200_000],
  [/^claude-3-opus/i, 200_000],
  [/^claude-4/i, 200_000],
  // Local (common)
  [/^llama3/i, 8_000],
  [/^llama3\.1/i, 128_000],
  [/^llama3\.2/i, 128_000],
  [/^llama3\.3/i, 128_000],
  [/^qwen2\.5/i, 32_000],
  [/^gemma3/i, 8_000],
  [/^deepseek-r1/i, 64_000],
  [/^mistral/i, 32_000],
  [/^phi/i, 128_000],
];

/** Conservative fallback when the model isn't in the static table. */
const DEFAULT_CONTEXT_WINDOW = 30_000;

/**
 * Look up the static context-window size for a model ID. Returns the first
 * matching entry from the table, or the conservative default.
 */
export function staticContextWindow(modelId: string): number {
  for (const [pattern, tokens] of MODEL_CONTEXT_WINDOWS) {
    if (pattern.test(modelId)) return tokens;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// --- Runtime rate-limit cache from response headers ------------------------

interface RateLimitSnapshot {
  /** Total token-per-minute limit for this provider/model (from x-ratelimit-limit-tokens). */
  readonly limitTokens: number;
  /** Remaining tokens in the current window (from x-ratelimit-remaining-tokens). */
  readonly remainingTokens: number;
  /** When this snapshot was captured (Date.now()). */
  readonly capturedAt: number;
}

/**
 * In-memory cache of the most recent rate-limit headers per provider. Keyed by
 * provider ID (e.g. "openai", "anthropic"). Only populated after a real call
 * returns headers; never populated from a validation probe. Not persisted — it
 * resets on page reload, which is fine since rate-limit windows reset quickly.
 */
const runtimeCache = new Map<string, RateLimitSnapshot>();

/**
 * Capture rate-limit info from provider response headers. Call this after every
 * successful chat/response call. Silently no-ops when headers aren't present
 * (local servers typically don't send them) or when the response object doesn't
 * expose a standard `Headers` interface (e.g. in tests with minimal mocks).
 */
export function captureRateLimits(providerId: string, headers: Headers | undefined | null): void {
  if (!headers || typeof headers.get !== 'function') return;
  const limitStr = headers.get('x-ratelimit-limit-tokens');
  const remainingStr = headers.get('x-ratelimit-remaining-tokens');
  if (!limitStr || !remainingStr) return;
  const limitTokens = Number.parseInt(limitStr, 10);
  const remainingTokens = Number.parseInt(remainingStr, 10);
  if (!Number.isFinite(limitTokens) || !Number.isFinite(remainingTokens)) return;
  runtimeCache.set(providerId, { limitTokens, remainingTokens, capturedAt: Date.now() });
}

/**
 * Get the most recent rate-limit snapshot for a provider, or undefined if no
 * headers have been captured yet (first call, or local provider).
 */
export function getRateLimits(providerId: string): RateLimitSnapshot | undefined {
  return runtimeCache.get(providerId);
}

/**
 * Estimate whether a payload of `estimatedTokens` will fit within the known
 * limits for the given provider + model. Uses runtime headers when available
 * (most accurate), falling back to the static context-window table.
 *
 * Returns the safe budget (max tokens the request should use for input + output)
 * so the caller can trim if needed.
 */
export function estimateBudget(providerId: string, modelId: string): number {
  const runtime = runtimeCache.get(providerId);
  if (runtime && runtime.capturedAt > Date.now() - 120_000) {
    // Runtime data is fresh (< 2 min old) — use remaining tokens as the budget.
    // This is conservative: remaining resets each minute window, so a stale
    // snapshot might undercount, but it's safe (trim more, never exceed).
    return runtime.remainingTokens;
  }
  // No runtime data — use the static context-window as a proxy.
  return staticContextWindow(modelId);
}

/**
 * Rough token estimate from character count. GPT-family models average ~4 chars
 * per token for English; this is deliberately conservative (rounds up) so we
 * trim rather than overshoot.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Given a desired budget and a payload estimate, returns how many characters of
 * "background context" (e.g. the skills list) should be kept. If the core prompt
 * already fits, the full context can be kept; otherwise it should be trimmed to
 * this byte count. Returns `Infinity` when no trimming is needed.
 */
export function contextBudgetChars(
  totalBudget: number,
  corePromptTokens: number,
  maxCompletionTokens: number,
): number {
  const available = totalBudget - corePromptTokens - maxCompletionTokens;
  if (available <= 0) return 0;
  // Convert token budget back to chars (inverse of estimateTokens).
  return Math.floor(available * 3.5);
}
