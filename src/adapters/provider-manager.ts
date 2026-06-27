// Provider_Manager — concrete pluggable BYOK implementation.
//
// Implements the `ProviderManager` contract declared in `./provider`. The agent
// ships **no shared or built-in key** (R4.5): every LLM/STT operation requires a
// user-supplied key. Keys live only in the encrypted Web Crypto vault
// (`./vault`), are decrypted just-in-time inside `validateKey`/`send`, are
// transmitted only to their owning provider (R5.3), and are never retained or
// written to the Memory Store (R5.2).
//
// The registry is pluggable (R4.1): providers are injected as dependencies (the
// same DI convention used by `storage-fallback.ts` and `vault.ts`) and can be
// registered/overridden at runtime, so adding a provider requires no change to
// this module. Each provider carries README-style setup guidance (R4.2),
// validation issues a real test call and reports the failure reason for
// re-entry (R4.3, R4.4), and key removal deletes the encrypted entry (R5.4).
//
// Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.3, 5.4.

import type { KeyVault } from './vault';
import type {
  AudioBlob,
  ChatRequest,
  Locale,
  Markdown,
  ProviderDescriptor,
  ProviderId,
  ProviderManager,
  ProviderResponse,
  RedactedPayload,
  LlmProvider,
  SttProvider,
  Transcript,
  SttOptions,
  ValidationResult,
} from './provider';

/** Raised when an operation targets a provider id that is not registered. */
export class UnknownProviderError extends Error {
  constructor(public readonly provider: ProviderId) {
    super(`No provider is registered with id "${provider}".`);
    this.name = 'UnknownProviderError';
  }
}

/**
 * Raised when a registered provider lacks the capability an operation needs
 * (e.g. issuing an LLM call against a provider that only wired an STT client).
 */
export class ProviderCapabilityError extends Error {
  constructor(
    public readonly provider: ProviderId,
    public readonly capability: 'llm' | 'stt',
  ) {
    super(`Provider "${provider}" has no ${capability} capability wired.`);
    this.name = 'ProviderCapabilityError';
  }
}

/**
 * Raised when an operation needs a stored key but none exists. Reinforces R4.5:
 * there is no fallback/built-in key, so the user must supply one first.
 */
export class NoProviderKeyError extends Error {
  constructor(public readonly provider: ProviderId) {
    super(
      `No API key is stored for provider "${provider}". A user-supplied key is ` +
        `required; the agent ships no shared or built-in key.`,
    );
    this.name = 'NoProviderKeyError';
  }
}

/**
 * A pluggable provider registration. Carries the registry descriptor (R4.1),
 * README-style setup guidance (R4.2), and the injected client(s) used for the
 * validation test call and for outbound `send`/`transcribe` operations.
 *
 * `setupGuide` may be plain Markdown or a function of locale, so guidance can be
 * localised (R4.2) without this module hardcoding any provider specifics.
 */
export interface ProviderPlugin {
  readonly descriptor: ProviderDescriptor;
  readonly setupGuide: Markdown | ((locale: Locale) => Markdown);
  /** LLM client (BYOK). Receives the plaintext key per call and never stores it. */
  readonly llm?: LlmProvider;
  /** Optional speech-to-text client for the same provider id (R26). */
  readonly stt?: SttProvider;
  /**
   * When `true`, the provider is keyless (R43.2): it targets a self-hosted
   * OpenAI-Compatible Endpoint on the user's own machine and needs no API key.
   * The manager bypasses the empty-key guard in `validateKey` and skips the
   * vault decrypt in `send`/`transcribe`, handing the provider client an empty
   * key (the client omits the auth header for keyless servers).
   */
  readonly keyless?: boolean;
}

/** Construction options for {@link DefaultProviderManager}. */
export interface ProviderManagerOptions {
  /** Encrypted key vault used for store/remove and just-in-time decrypt. */
  readonly vault: KeyVault;
  /** Initial pluggable provider registrations (R4.1). */
  readonly providers?: readonly ProviderPlugin[];
}

/**
 * An opaque probe request used for the validation test call (R4.3). Concrete
 * provider clients interpret it as a minimal, cheap request; here it is only a
 * branded placeholder, matching the boundary `ChatRequest` type.
 */
const VALIDATION_PROBE = { __brand: 'ChatRequest' } as ChatRequest;

/**
 * Concrete pluggable {@link ProviderManager}.
 *
 * Holds **no** key material of its own. Keys are read from the injected
 * {@link KeyVault} only at the moment of use and handed straight to the owning
 * provider's client (R5.3); the manager keeps no copy.
 */
export class DefaultProviderManager implements ProviderManager {
  private readonly vault: KeyVault;
  /** Insertion-ordered registry keyed by provider id (R4.1). */
  private readonly registry = new Map<ProviderId, ProviderPlugin>();

  constructor(options: ProviderManagerOptions) {
    this.vault = options.vault;
    for (const plugin of options.providers ?? []) {
      this.register(plugin);
    }
  }

  /**
   * Register (or replace) a provider at runtime. This is the pluggability seam
   * (R4.1): no built-in provider list is hardcoded into the manager.
   */
  register(plugin: ProviderPlugin): void {
    this.registry.set(plugin.descriptor.id, plugin);
  }

  /** Pluggable registry listing, in registration order (R4.1). */
  listProviders(): ProviderDescriptor[] {
    return [...this.registry.values()].map((plugin) => plugin.descriptor);
  }

  /** README-style setup guidance for a provider, localised by `locale` (R4.2). */
  setupGuide(p: ProviderId, locale: Locale): Markdown {
    const plugin = this.requirePlugin(p);
    const { setupGuide } = plugin;
    return typeof setupGuide === 'function' ? setupGuide(locale) : setupGuide;
  }

  /**
   * Validate a user-supplied key by issuing a real test call to the selected
   * provider (R4.3). On success returns `{ valid: true }`; on failure returns
   * `{ valid: false, reason }` so the UI can show the reason and prompt re-entry
   * (R4.4). The key is passed only to the owning provider and is never stored as
   * a side effect of validation.
   */
  async validateKey(p: ProviderId, key: string): Promise<ValidationResult> {
    const plugin = this.requirePlugin(p);
    if (!plugin.llm) {
      throw new ProviderCapabilityError(p, 'llm');
    }
    // Keyless providers (e.g. a self-hosted Local Provider) need no key, so the
    // empty-key guard is bypassed and the test call runs with an empty key
    // (the client omits the auth header) — R43.2.
    if (!plugin.keyless && key.trim().length === 0) {
      return { valid: false, reason: 'API key must not be empty.' };
    }
    try {
      await plugin.llm.chat(VALIDATION_PROBE, key);
      return { valid: true };
    } catch (error) {
      return { valid: false, reason: describeError(error) };
    }
  }

  /** Encrypt and persist the key via the vault; never to the Memory Store (R5.1, R5.2). */
  async storeKey(p: ProviderId, key: string): Promise<void> {
    // Validate the provider exists before persisting anything.
    this.requirePlugin(p);
    await this.vault.store(p, key);
  }

  /** Delete the encrypted key from browser-local storage (R5.4). */
  async removeKey(p: ProviderId): Promise<void> {
    await this.vault.remove(p);
  }

  /**
   * Send a redacted payload to its owning provider (R5.3). The key is decrypted
   * just-in-time from the vault, handed only to the targeted provider's client,
   * and never retained by the manager.
   */
  async send(p: ProviderId, payload: RedactedPayload): Promise<ProviderResponse> {
    const plugin = this.requirePlugin(p);
    if (!plugin.llm) {
      throw new ProviderCapabilityError(p, 'llm');
    }
    const key = await this.resolveKey(plugin);
    // The opaque RedactedPayload is the request body delivered to the provider.
    const request = payload as unknown as ChatRequest;
    const response = await plugin.llm.chat(request, key);
    return response as unknown as ProviderResponse;
  }

  /**
   * Transcribe audio through the owning provider's STT client (R26), decrypting
   * the key just-in-time and routing it only to that provider (R5.3). The
   * optional `translateToEnglish` flag is forwarded to the STT client so it can
   * request a translate-to-English transcription (R26.5).
   */
  async transcribe(p: ProviderId, audio: AudioBlob, options?: SttOptions): Promise<Transcript> {
    const plugin = this.requirePlugin(p);
    if (!plugin.stt) {
      throw new ProviderCapabilityError(p, 'stt');
    }
    const key = await this.resolveKey(plugin);
    return plugin.stt.transcribe(audio, key, options);
  }

  /** Look up a registered plugin or fail loudly. */
  private requirePlugin(p: ProviderId): ProviderPlugin {
    const plugin = this.registry.get(p);
    if (!plugin) {
      throw new UnknownProviderError(p);
    }
    return plugin;
  }

  /**
   * Resolve the plaintext key to hand the provider client for an outbound call.
   * Keyless providers (R43.2) skip the vault entirely and use an empty key — the
   * client omits the auth header for self-hosted endpoints. Keyed providers
   * decrypt their owning key just-in-time (R5.3).
   */
  private async resolveKey(plugin: ProviderPlugin): Promise<string> {
    if (plugin.keyless) {
      return '';
    }
    return this.decryptOwnerKey(plugin.descriptor.id);
  }

  /**
   * Decrypt the owning provider's key just-in-time. Throws {@link NoProviderKeyError}
   * when no key is stored — there is no shared/built-in fallback (R4.5).
   */
  private async decryptOwnerKey(p: ProviderId): Promise<string> {
    if (!(await this.vault.has(p))) {
      throw new NoProviderKeyError(p);
    }
    return this.vault.decrypt(p);
  }
}

/** Best-effort human-readable reason from an unknown thrown value (R4.4). */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return 'The provider rejected the key during the validation test call.';
}

// --- Default pluggable provider seed (R4.1) --------------------------------

/** Provider id constants for the providers seeded by default. */
export const OPENAI_PROVIDER_ID: ProviderId = 'openai';
export const ANTHROPIC_PROVIDER_ID: ProviderId = 'anthropic';
/** Keyless, self-hosted OpenAI-Compatible Endpoint provider (R43). */
export const LOCAL_PROVIDER_ID: ProviderId = 'local';

/**
 * Injected clients for the default seed. Clients are supplied by the caller
 * (DI) rather than hardcoded here, keeping the registry pluggable and ensuring
 * the manager ships with descriptors/guidance but **no** key material (R4.5).
 */
export interface DefaultProviderClients {
  readonly openai?: { readonly llm?: LlmProvider; readonly stt?: SttProvider };
  readonly anthropic?: { readonly llm?: LlmProvider; readonly stt?: SttProvider };
  readonly local?: { readonly llm?: LlmProvider; readonly stt?: SttProvider };
}

/**
 * Build the default OpenAI/Anthropic provider registrations: descriptors plus
 * README-style, locale-aware setup guidance (R4.1, R4.2). Provider clients are
 * injected; when omitted the descriptor and guidance are still listed so the UI
 * can render the setup flow.
 */
export function defaultProviderPlugins(
  clients: DefaultProviderClients = {},
): ProviderPlugin[] {
  return [
    {
      descriptor: { id: OPENAI_PROVIDER_ID, displayName: 'OpenAI' },
      setupGuide: (locale) => openAiSetupGuide(locale),
      llm: clients.openai?.llm,
      stt: clients.openai?.stt,
    },
    {
      descriptor: { id: ANTHROPIC_PROVIDER_ID, displayName: 'Anthropic' },
      setupGuide: (locale) => anthropicSetupGuide(locale),
      llm: clients.anthropic?.llm,
      stt: clients.anthropic?.stt,
    },
    {
      descriptor: { id: LOCAL_PROVIDER_ID, displayName: 'Local (self-hosted)', keyless: true },
      setupGuide: (locale) => localSetupGuide(locale),
      keyless: true,
      llm: clients.local?.llm,
      stt: clients.local?.stt,
    },
  ];
}

/** True when the locale tag is Brazilian Portuguese. */
function isPtBr(locale: Locale): boolean {
  return locale.toLowerCase().startsWith('pt');
}

function openAiSetupGuide(locale: Locale): Markdown {
  if (isPtBr(locale)) {
    return [
      '## Conectar a OpenAI',
      '',
      '1. Acesse https://platform.openai.com/api-keys e faça login.',
      '2. Clique em **Create new secret key** e copie a chave gerada.',
      '3. Cole a chave abaixo. Ela é validada com uma chamada de teste e',
      '   armazenada criptografada apenas neste navegador.',
      '',
      '> A chave é enviada somente para a OpenAI e nunca é gravada nos seus',
      '> arquivos de carreira.',
    ].join('\n');
  }
  return [
    '## Connect OpenAI',
    '',
    '1. Go to https://platform.openai.com/api-keys and sign in.',
    '2. Click **Create new secret key** and copy the generated key.',
    '3. Paste the key below. It is validated with a test call and stored',
    '   encrypted in this browser only.',
    '',
    '> Your key is sent only to OpenAI and is never written into your career files.',
  ].join('\n');
}

function anthropicSetupGuide(locale: Locale): Markdown {
  if (isPtBr(locale)) {
    return [
      '## Conectar a Anthropic',
      '',
      '1. Acesse https://console.anthropic.com/settings/keys e faça login.',
      '2. Clique em **Create Key** e copie a chave gerada.',
      '3. Cole a chave abaixo. Ela é validada com uma chamada de teste e',
      '   armazenada criptografada apenas neste navegador.',
      '',
      '> A chave é enviada somente para a Anthropic e nunca é gravada nos seus',
      '> arquivos de carreira.',
    ].join('\n');
  }
  return [
    '## Connect Anthropic',
    '',
    '1. Go to https://console.anthropic.com/settings/keys and sign in.',
    '2. Click **Create Key** and copy the generated key.',
    '3. Paste the key below. It is validated with a test call and stored',
    '   encrypted in this browser only.',
    '',
    '> Your key is sent only to Anthropic and is never written into your career files.',
  ].join('\n');
}

/**
 * Setup guidance for the keyless Local Provider (R43). No API key is required;
 * the user points the provider at a self-hosted OpenAI-Compatible Endpoint on
 * their own machine (Ollama by default) and edits the base URL and model names.
 */
function localSetupGuide(locale: Locale): Markdown {
  if (isPtBr(locale)) {
    return [
      '## Conectar um provedor local (auto-hospedado)',
      '',
      '1. Instale um runtime compatível com a API da OpenAI, como o Ollama',
      '   (https://ollama.com), e inicie-o na sua máquina.',
      '2. Baixe um modelo de chat (por exemplo `ollama pull llama3`) e, se for',
      '   transcrever áudio, um modelo de fala compatível.',
      '3. Confirme a URL base (padrão `http://localhost:11434/v1` para o Ollama)',
      '   e os nomes dos modelos abaixo. Nenhuma chave de API é necessária.',
      '',
      '> Como o servidor roda no seu próprio computador, nenhum dado sai do',
      '> dispositivo. Também funciona com LocalAI, LM Studio, llama.cpp e vLLM.',
    ].join('\n');
  }
  return [
    '## Connect a local provider (self-hosted)',
    '',
    '1. Install an OpenAI-compatible runtime such as Ollama',
    '   (https://ollama.com) and start it on your machine.',
    '2. Pull a chat model (for example `ollama pull llama3`) and, if you will',
    '   transcribe audio, a compatible speech model.',
    '3. Confirm the base URL (default `http://localhost:11434/v1` for Ollama)',
    '   and the model names below. No API key is required.',
    '',
    '> Because the server runs on your own machine, no data leaves the device.',
    '> Also works with LocalAI, LM Studio, llama.cpp server, and vLLM.',
  ].join('\n');
}
