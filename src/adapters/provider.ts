// Provider_Manager / LlmProvider / SttProvider — PLACEHOLDER interfaces only
// (no logic, no implementation).
//
// Pluggable Bring-Your-Own-Key (BYOK) provider abstraction. The agent ships NO
// shared key and requires a user-supplied key for all LLM/STT operations.
// Keys live only in the encrypted Web Crypto vault (see ./vault), are decrypted
// just-in-time, transmitted only to their owning provider, and are never
// written to the Memory Store. Implemented later in task 5.x.
//
// No @core domain component may import a provider client directly; all provider
// calls pass through the single Egress Gate. These are placeholder boundary
// types only — concrete shapes are defined in tasks 1.2 / 5.x.
//
// Requirements: 4, 5.

/** Identifies a supported provider (e.g. an OpenAI/Anthropic registry id). */
export type ProviderId = string;

/** Session/UI language tag used to localise setup guidance. */
export type Locale = string;

/** Markdown setup guidance text. */
export type Markdown = string;

/**
 * Minimised, PII-screened payload produced by the Egress Gate after the
 * PII_Scanner has removed every detected high-risk value (R6.4).
 *
 * The `__brand` marker keeps the type nominal (it cannot be confused with a
 * raw `string`), while `text` carries the actual minimised, redacted content
 * that the Egress Gate (task 6.2) hands to the Provider_Manager for
 * transmission. No detected secret is ever preserved verbatim in `text`
 * (R6.5).
 */
export interface RedactedPayload {
  readonly __brand: 'RedactedPayload';
  /** Minimised, PII-screened text safe to transmit to the chosen provider. */
  readonly text: string;
  /**
   * When `true`, the user has NOT consented to model training/improvement use,
   * so the provider client should request the strongest no-retention/no-training
   * posture the provider supports (e.g. OpenAI `store: false`). Set by the Egress
   * Gate from the session consent state (R42.1). Most BYOK providers already
   * exclude API data from training by default; this makes the user's preference
   * explicit on the wire where the provider exposes a lever.
   */
  readonly noTraining?: boolean;
}

/** Result of a provider key validation test call (R4.3). */
export interface ValidationResult {
  readonly valid: boolean;
  readonly reason?: string;
}

/** Descriptor for a registered provider in the pluggable registry. */
export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly displayName: string;
  /**
   * When `true`, the provider operates without an API key (R43.2): it targets a
   * self-hosted OpenAI-Compatible Endpoint on the user's own machine. The UI
   * uses this to show base-URL/model fields instead of an API-key field, and the
   * Provider_Manager bypasses the empty-key guard and the vault entirely.
   */
  readonly keyless?: boolean;
}

/** Opaque response returned from a provider call. */
export interface ProviderResponse {
  readonly __brand: 'ProviderResponse';
}

/** Opaque request/response placeholders for the provider abstraction. */
export interface ChatRequest {
  readonly __brand: 'ChatRequest';
}
export interface ChatResponse {
  readonly __brand: 'ChatResponse';
}

/**
 * The audio container formats accepted for transcription. Uploaded answers are
 * restricted to MP3/WAV (R26.1); in-browser recordings (R26.4) additionally
 * produce `webm`, the browser `MediaRecorder`'s native container. All three are
 * valid STT payloads; the upload path enforces the MP3/WAV-only subset itself.
 */
export type AudioFormat = 'mp3' | 'wav' | 'webm';

/**
 * The minimal audio payload transmitted to an STT provider for transcription
 * (R26.1, R26.2). Like {@link RedactedPayload}, the `__brand` keeps the type
 * nominal while the concrete fields carry exactly what an STT client needs —
 * the validated container `format` and the raw `bytes` — and nothing more
 * (R7.2). Audio cannot be screened by the text-based PII_Scanner, so the
 * scanner screens the *resulting* {@link Transcript} before it is fed onward
 * (R26.2 → Requirement 6); see the Egress Gate's STT path.
 */
export interface AudioBlob {
  readonly __brand: 'AudioBlob';
  /** The validated container format (MP3/WAV uploads, or WebM/WAV recordings). */
  readonly format: AudioFormat;
  /** The raw audio bytes transmitted to the chosen STT provider (R7.2, R7.4). */
  readonly bytes: Uint8Array;
}

/**
 * A speech-to-text transcription result. The `__brand` keeps the type nominal
 * while `text` carries the transcribed words. The transcript text is screened
 * by the PII_Scanner at the Egress Gate before any further processing (R26.2 →
 * Requirement 6) and surfaced to the user for confirmation/correction (R26.3).
 */
export interface Transcript {
  readonly __brand: 'Transcript';
  /** The transcribed text returned by the STT provider. */
  readonly text: string;
}

/**
 * Optional behaviour flags for a speech-to-text call (R26.5). Defaults to
 * normal, same-language transcription when omitted.
 */
export interface SttOptions {
  /**
   * When `true`, request a translate-to-English transcription instead of a
   * same-language transcript (R26.5). OpenAI-compatible Whisper servers expose
   * this via the dedicated `/audio/translations` endpoint, which always outputs
   * English regardless of the source language.
   */
  readonly translateToEnglish?: boolean;
}

export interface ProviderManager {
  /** Pluggable registry (R4.1). */
  listProviders(): ProviderDescriptor[];
  /** README-style key guidance (R4.2). */
  setupGuide(p: ProviderId, locale: Locale): Markdown;
  /** Validate key via a test call (R4.3). */
  validateKey(p: ProviderId, key: string): Promise<ValidationResult>;
  /** Store encrypted (Web Crypto); never in Memory Store (R5.1, R5.2). */
  storeKey(p: ProviderId, key: string): Promise<void>;
  /** Remove the encrypted key (R5.4). */
  removeKey(p: ProviderId): Promise<void>;
  /** Send a redacted payload; key goes to owning provider only (R5.3). */
  send(p: ProviderId, payload: RedactedPayload): Promise<ProviderResponse>;
  /**
   * Transcribe audio via the owning provider's STT client (R26.2). The key is
   * decrypted just-in-time and routed only to that provider (R5.3); the audio
   * is the minimal payload transmitted (R7.2, R7.4). When
   * `options.translateToEnglish` is set, the call requests a translate-to-English
   * transcription instead of a same-language transcript (R26.5).
   */
  transcribe(p: ProviderId, audio: AudioBlob, options?: SttOptions): Promise<Transcript>;
}

/** Provider abstraction so LLM providers are pluggable. */
export interface LlmProvider {
  readonly id: ProviderId;
  chat(req: ChatRequest, key: string): Promise<ChatResponse>;
}

/** Speech-to-text provider abstraction (R26). */
export interface SttProvider {
  transcribe(audio: AudioBlob, key: string, options?: SttOptions): Promise<Transcript>;
}
