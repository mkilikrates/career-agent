// Custom OpenAI-Compatible provider configuration.
//
// The "Custom OpenAI-Compatible" provider points at a user-specified,
// OpenAI-compatible cloud endpoint (any server implementing `/v1/chat/completions`
// and `GET /v1/models`). Unlike the keyless Local Provider it requires an API
// key (stored in the encrypted vault), but like the local provider it needs a
// user-editable base URL — stored in browser-local storage (never in the Memory
// Store) and read just-in-time by the custom provider client.

/** The editable custom OpenAI-compatible provider configuration. */
export interface CustomOpenaiConfig {
  /** OpenAI-compatible base URL, e.g. `https://my-proxy.example.com/v1`. */
  readonly baseUrl: string;
  /** Chat model name for completions. */
  readonly model: string;
}

export const DEFAULT_CUSTOM_OPENAI_CONFIG: CustomOpenaiConfig = {
  baseUrl: '',
  model: '',
};

const STORAGE_KEY = 'career-agent.custom-openai';

/** Resolve a browser-local storage backend, if available (guarded for tests/SSR). */
const storage = (): Storage | null => {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
};

/** Read the persisted custom OpenAI-compatible config, merged over defaults. */
export const getCustomOpenaiConfig = (): CustomOpenaiConfig => {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_CUSTOM_OPENAI_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<CustomOpenaiConfig>;
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : DEFAULT_CUSTOM_OPENAI_CONFIG.baseUrl,
      model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_CUSTOM_OPENAI_CONFIG.model,
    };
  } catch {
    return DEFAULT_CUSTOM_OPENAI_CONFIG;
  }
};

/** Persist a partial update to the custom OpenAI-compatible config. */
export const setCustomOpenaiConfig = (patch: Partial<CustomOpenaiConfig>): CustomOpenaiConfig => {
  const next = { ...getCustomOpenaiConfig(), ...patch };
  storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
};
