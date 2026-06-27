// In-browser audio recording and recording transcription (R26.4, R26.6–R26.11).
//
// Phase 1 now lets the user practise by RECORDING a spoken answer in the browser
// (R26.4) in addition to uploading one (see ./audio). This reverses the prior
// "no live capture" decision for AUDIO only — live VIDEO capture remains firmly
// out of scope: the controller captures audio and nothing else.
//
// The capture itself is performed by the browser `MediaRecorder` API, which is a
// DOM dependency. To keep this module framework-agnostic (and testable under
// Node) it never touches the DOM directly. Instead it drives an injected
// {@link AudioRecorderPort} — a thin abstraction the shell implements over
// `MediaRecorder` — exactly as ./audio abstracts an uploaded browser `File`
// behind {@link AudioUpload}. The controller layered on top of the port adds the
// trust-critical behaviour the requirements demand:
//
//   * It requests MICROPHONE PERMISSION before recording (R26.4); on denial it
//     fails with an error that names the upload path AND the text-answer path so
//     the user is never stranded (R26.10).
//   * It enforces a ≤600-second duration guard (R26.4) and the same ≤25 MB size
//     guard as uploads, REJECTING an oversized/unsupported take with the reason
//     while leaving the prior answer state untouched (parity with R26.9).
//   * It exposes start / stop / re-record / discard actions (R26.4).
//
// Transcription ({@link transcribeRecording}) follows the SAME gated path as
// {@link uploadAudio}: the take is sent to the user's chosen STT provider through
// the single Egress Gate after PII pre-screening (R26.6), optionally translating
// to English (R26.5), and the screened transcript is returned UNCONFIRMED for
// confirmation/correction before any further processing (R26.7). On confirmation
// {@link collectAndSendTranscript} feeds the confirmed text into the coaching
// loop AND sends it to the chosen chat provider through the Egress Gate (R26.8).
// When no STT provider is configured, transcription fails with an error that
// PRESERVES the captured audio so the user can configure a provider and retry
// (R26.11).

import type { AudioBlob, ProviderId, ProviderResponse } from '@adapters/provider';
import type { EgressGate } from '@core/egress';
import type { StarAnswer, StarElement } from '@core/types';
import {
  collectFromTranscript,
  type ConfirmedTranscript,
  type Transcript,
} from './audio';
import type { CoachTurn } from './coach';

// --- Guards and capture container formats -----------------------------------

/** Maximum recording duration in seconds (R26.4); takes longer are rejected. */
export const MAX_RECORDING_SECONDS = 600;

/** Maximum recorded-audio size in bytes (25 MB), matching the upload guard (R26.9 parity). */
export const MAX_RECORDING_BYTES = 25 * 1024 * 1024;

/**
 * The browser-native capture containers a recording can produce (R26.4).
 * `MediaRecorder` yields WebM on most browsers; WAV is accepted for hosts that
 * capture it. Both are valid STT payloads (see {@link transcribeRecording}).
 */
export type RecordingFormat = 'webm' | 'wav';

/** The accepted in-browser recording containers (R26.4). */
export const ACCEPTED_RECORDING_FORMATS: readonly RecordingFormat[] = [
  'webm',
  'wav',
] as const;

/**
 * Microphone permission state, mirroring the browser `PermissionState` literals
 * WITHOUT importing the DOM type so this module stays framework-agnostic.
 */
export type MicPermissionState = 'granted' | 'denied' | 'prompt';

/**
 * The non-recording answer paths offered when microphone permission is denied
 * (R26.10): an uploaded audio file (see {@link uploadAudio}) or a typed text
 * answer.
 */
export type RecordingFallbackPath = 'upload' | 'text';

/** The fallback paths offered when recording is unavailable (R26.10). */
export const RECORDING_FALLBACK_PATHS: readonly RecordingFallbackPath[] = [
  'upload',
  'text',
] as const;

// --- The injected recorder abstraction (the only DOM seam) ------------------

/**
 * The raw take a recorder produces on stop: the captured audio bytes, the
 * container `format`, and the measured `durationSec`. It is AUDIO ONLY — there is
 * no video field and none is ever captured.
 */
export interface RawTake {
  /** The capture container format. */
  readonly format: RecordingFormat;
  /** The raw captured audio bytes. */
  readonly bytes: Uint8Array;
  /** The measured recording duration in seconds. */
  readonly durationSec: number;
}

/**
 * The thin, injectable abstraction over the browser `MediaRecorder` (audio
 * only). The shell implements this against `navigator.mediaDevices` /
 * `MediaRecorder`; @core logic depends only on this interface, so it never
 * imports a DOM type and is testable under Node with a fake recorder. An
 * implementation MUST request an audio-only media stream and MUST NOT capture
 * video (R26.4).
 */
export interface AudioRecorderPort {
  /** Request MICROPHONE (audio-only) permission before any capture (R26.4). */
  requestMicPermission(): Promise<MicPermissionState>;
  /** Begin an audio-only capture session. */
  start(): void;
  /** Finalise the current capture and return the raw take. */
  stop(): RawTake;
  /** Abort the current capture and release the microphone without a take. */
  cancel(): void;
}

/**
 * A finalised in-browser audio recording (design `RecordedAudio`). It is AUDIO
 * ONLY (no video, R26.4), within the ≤600 s and ≤25 MB guards (validated by
 * {@link RecordingController.stop}). The `__brand` keeps the type nominal so it
 * cannot be confused with an arbitrary object.
 */
export interface RecordedAudio {
  readonly __brand: 'RecordedAudio';
  /** The browser-native capture container (R26.4). */
  readonly format: RecordingFormat;
  /** The captured audio bytes (≤25 MB, R26.9 parity). */
  readonly bytes: Uint8Array;
  /** The recording duration in seconds (≤600, R26.4). */
  readonly durationSec: number;
}

// --- Errors -----------------------------------------------------------------

/**
 * Raised when recording is attempted without granted microphone permission
 * (R26.4). It names the still-available {@link RECORDING_FALLBACK_PATHS} — the
 * upload path and the text-answer path — so the UI can offer them (R26.10).
 */
export class MicrophonePermissionDeniedError extends Error {
  /** The non-recording answer paths still available (R26.10). */
  public readonly alternatives = RECORDING_FALLBACK_PATHS;

  constructor(public readonly state: MicPermissionState) {
    super(
      'Microphone permission was not granted, so in-browser recording is ' +
        'unavailable. You can still answer by uploading an MP3 or WAV audio file ' +
        'or by typing your answer instead.',
    );
    this.name = 'MicrophonePermissionDeniedError';
  }
}

/** Why a recorded take was rejected by the guards (R26.9 parity). */
export type RecordingRejectionReason =
  | 'unsupported-format'
  | 'too-long'
  | 'too-large';

/**
 * Raised when a recorded take violates a guard — an unsupported container, a
 * duration over {@link MAX_RECORDING_SECONDS}, or a size over
 * {@link MAX_RECORDING_BYTES} (R26.9 parity). The take is discarded; the caller's
 * PRIOR answer state is untouched (the controller never mutates the answer), so
 * the user can re-record without losing their place.
 */
export class RecordingRejectedError extends Error {
  constructor(public readonly reason: RecordingRejectionReason, message: string) {
    super(message);
    this.name = 'RecordingRejectedError';
  }
}

/** Raised when a controller action is invoked in an invalid state. */
export class RecordingStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordingStateError';
  }
}

/**
 * Raised when transcription is attempted with no STT provider configured
 * (R26.11). It carries the captured {@link RecordedAudio} so the audio is
 * PRESERVED: the UI prompts the user to configure a provider and can retry
 * transcription with the same recording rather than forcing a re-record.
 */
export class SttProviderNotConfiguredError extends Error {
  constructor(public readonly recording: RecordedAudio) {
    super(
      'No speech-to-text provider is configured. Configure one to transcribe ' +
        'your recording; your captured audio has been preserved.',
    );
    this.name = 'SttProviderNotConfiguredError';
  }
}

// --- The recording controller (R26.4) ---------------------------------------

/**
 * The in-browser recording controller (design `RecordingController`). Exposes
 * start / stop / re-record / discard plus microphone-permission acquisition, all
 * over an injected {@link AudioRecorderPort}. It requests permission before
 * recording (R26.4) and enforces the duration/size guards on stop (R26.9 parity).
 */
export interface RecordingController {
  /** Request microphone permission before recording (R26.4). */
  requestMicPermission(): Promise<MicPermissionState>;
  /** Begin audio-only capture; requires granted permission (R26.4). */
  start(): void;
  /** Finalise the take, enforcing the ≤600 s / ≤25 MB guards (R26.4, R26.9 parity). */
  stop(): RecordedAudio;
  /** Discard the current take/capture and immediately start a new one (R26.4). */
  reRecord(): void;
  /** Drop the current take/capture entirely (R26.4). */
  discard(): void;
}

/** Internal lifecycle state of the controller. */
type RecorderState = 'idle' | 'ready' | 'recording';

/**
 * Validate a raw take against the guards and brand it as a {@link RecordedAudio}
 * (R26.4, R26.9 parity). Rejects an unsupported container, an over-long take, or
 * an over-size take with a {@link RecordingRejectedError} naming the reason.
 */
const finaliseTake = (take: RawTake): RecordedAudio => {
  if (!ACCEPTED_RECORDING_FORMATS.includes(take.format)) {
    throw new RecordingRejectedError(
      'unsupported-format',
      `Recording format "${take.format}" is not supported; recordings must be ` +
        `WebM or WAV. Your previous answer is unchanged.`,
    );
  }
  if (!(take.durationSec <= MAX_RECORDING_SECONDS)) {
    throw new RecordingRejectedError(
      'too-long',
      `Recording is ${Math.round(take.durationSec)}s, over the ` +
        `${MAX_RECORDING_SECONDS}s limit. Your previous answer is unchanged.`,
    );
  }
  if (take.bytes.length > MAX_RECORDING_BYTES) {
    throw new RecordingRejectedError(
      'too-large',
      `Recording is ${take.bytes.length} bytes, over the ${MAX_RECORDING_BYTES}-` +
        `byte (25 MB) limit. Your previous answer is unchanged.`,
    );
  }
  return {
    __brand: 'RecordedAudio',
    format: take.format,
    bytes: take.bytes,
    durationSec: take.durationSec,
  };
};

/** Default {@link RecordingController} over an injected {@link AudioRecorderPort}. */
class DefaultRecordingController implements RecordingController {
  private state: RecorderState = 'idle';
  private permission: MicPermissionState = 'prompt';

  constructor(private readonly port: AudioRecorderPort) {}

  async requestMicPermission(): Promise<MicPermissionState> {
    this.permission = await this.port.requestMicPermission();
    // A granted mic makes the controller ready to record; otherwise it stays
    // idle so start()/reRecord() fail closed with the denial fallback (R26.10).
    this.state = this.permission === 'granted' ? 'ready' : 'idle';
    return this.permission;
  }

  start(): void {
    if (this.permission !== 'granted') {
      throw new MicrophonePermissionDeniedError(this.permission);
    }
    if (this.state === 'recording') {
      throw new RecordingStateError('Already recording; stop or discard first.');
    }
    this.port.start();
    this.state = 'recording';
  }

  stop(): RecordedAudio {
    if (this.state !== 'recording') {
      throw new RecordingStateError('Not recording; nothing to stop.');
    }
    const take = this.port.stop();
    // Whatever the guards decide, capture is over.
    this.state = 'ready';
    // finaliseTake throws on a guard violation; the prior answer is untouched.
    return finaliseTake(take);
  }

  reRecord(): void {
    if (this.permission !== 'granted') {
      throw new MicrophonePermissionDeniedError(this.permission);
    }
    // Drop any in-progress capture, then immediately begin a fresh one.
    if (this.state === 'recording') this.port.cancel();
    this.port.start();
    this.state = 'recording';
  }

  discard(): void {
    if (this.state === 'recording') this.port.cancel();
    this.state = this.permission === 'granted' ? 'ready' : 'idle';
  }
}

/**
 * Construct a {@link RecordingController} over an injected
 * {@link AudioRecorderPort} (R26.4). The port is the only DOM seam, so the
 * controller — and everything that uses it — stays framework-agnostic and
 * testable under Node with a fake recorder.
 */
export const createRecordingController = (
  port: AudioRecorderPort,
): RecordingController => new DefaultRecordingController(port);

// --- Recording transcription (R26.6–R26.8, R26.11) ---------------------------

/** Collaborators {@link transcribeRecording} needs, supplied by the caller (DI). */
export interface TranscribeRecordingOptions {
  /** The single Egress Gate chokepoint used for STT transcription (R26.6). */
  readonly gate: EgressGate;
  /**
   * The user's chosen STT provider — the only permitted destination (R7.4).
   * Empty/undefined means NO STT provider is configured, so transcription fails
   * with a {@link SttProviderNotConfiguredError} that preserves the audio (R26.11).
   */
  readonly provider?: ProviderId;
  /**
   * When `true`, request a translate-to-English transcription rather than a
   * same-language transcript (R26.5). Defaults to `false` when omitted.
   */
  readonly translateToEnglish?: boolean;
}

/**
 * Transcribe an in-browser {@link RecordedAudio} through the Egress Gate (R26.6).
 * The take is sent only to the user's chosen STT provider via the gate, which
 * labels the operation, PII-screens the resulting transcript, and fails closed on
 * a declined redaction or incomplete screening (R26.6 → R6); the translate-to-
 * English preference (R26.5) is forwarded. Returns an UNCONFIRMED {@link
 * Transcript} for the user to confirm/correct before any further processing
 * (R26.7) — never auto-fed into analysis.
 *
 * When NO STT provider is configured, it throws a {@link
 * SttProviderNotConfiguredError} carrying the recording, so the captured audio is
 * PRESERVED and the user can configure a provider and retry (R26.11).
 */
export const transcribeRecording = async (
  rec: RecordedAudio,
  options: TranscribeRecordingOptions,
): Promise<Transcript> => {
  const provider = options.provider;
  if (provider === undefined || provider.trim().length === 0) {
    throw new SttProviderNotConfiguredError(rec);
  }
  const audio: AudioBlob = {
    __brand: 'AudioBlob',
    format: rec.format,
    bytes: rec.bytes,
  };
  const result = await options.gate.transcribe({
    provider,
    audio,
    translateToEnglish: options.translateToEnglish,
  });
  return {
    text: result.text,
    format: rec.format,
    redactedCategories: result.redactedCategories,
    confirmed: false,
  };
};

/** Collaborators {@link collectAndSendTranscript} needs, supplied by the caller (DI). */
export interface SubmitTranscriptOptions {
  /** The single Egress Gate chokepoint used to reach the chat provider (R26.8). */
  readonly gate: EgressGate;
  /** The user's chosen chat provider — the only permitted destination (R7.4). */
  readonly chatProvider: ProviderId;
  /** The STAR element the confirmed text answers; defaults to the next outstanding one. */
  readonly element?: StarElement;
  /** Strongest no-training/no-retention posture preference for the chat call (R42.1). */
  readonly noTraining?: boolean;
}

/** The result of submitting a confirmed recording transcript (R26.8). */
export interface SubmitTranscriptResult {
  /** The coaching-loop turn produced by feeding the confirmed text in. */
  readonly turn: CoachTurn;
  /** The chat provider's response to the confirmed transcript. */
  readonly response: ProviderResponse;
}

/**
 * On confirmation of a recording transcript (R26.8), feed the confirmed text into
 * the guided STAR coaching loop AND send it to the user's chosen chat provider
 * through the Egress Gate. Requiring a {@link ConfirmedTranscript} (not a raw
 * {@link Transcript}) structurally guarantees the user confirmed/corrected the
 * transcription first (R26.7). The coaching-loop step is delegated to
 * {@link collectFromTranscript}, so the same open-follow-up loop and content
 * firewall apply whether the answer was typed, uploaded, or recorded.
 */
export const collectAndSendTranscript = async (
  answer: StarAnswer,
  confirmed: ConfirmedTranscript,
  options: SubmitTranscriptOptions,
): Promise<SubmitTranscriptResult> => {
  const turn = collectFromTranscript(answer, confirmed, options.element);
  const response = await options.gate.request({
    provider: options.chatProvider,
    text: confirmed.text,
    operation: 'llm-chat',
    noTraining: options.noTraining,
  });
  return { turn, response };
};
