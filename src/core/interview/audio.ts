// Audio answer upload and transcription via the Egress Gate (R26).
//
// In this phase the Interview_Coach lets the user practise by *uploading* a
// recorded answer rather than typing it. There is deliberately NO live or
// in-app audio capture (R26.4): the only entry point is an uploaded file, and
// only the two launch audio formats — MP3 and WAV — are accepted (R26.1).
// Anything else is rejected with a clear, upload-only message.
//
// Transcription never touches a provider directly. The audio is handed to the
// single {@link EgressGate} chokepoint, which labels the third-party STT
// operation before it runs (R7.3), transmits the audio only to the user's
// chosen provider (R7.4), and — because audio cannot be screened by the
// text-based PII_Scanner — PII-screens the *resulting* transcript before it is
// fed onward, applying the redact-and-proceed flow of Requirement 6 and failing
// closed if screening cannot complete or the user declines (R26.2 → R6).
//
// The screened transcript is returned as an UNCONFIRMED {@link Transcript}: it
// is never auto-fed into analysis. It must first be confirmed (and optionally
// corrected) by the user (R26.3); only a {@link ConfirmedTranscript} can flow
// into the guided coaching loop via {@link collectFromTranscript}. This makes
// "confirm before any further processing" a structural property, not a
// convention.

import type { AudioBlob, AudioFormat, ProviderId } from '@adapters/provider';
import type { DetectionCategory } from '@adapters/pii';
import type { EgressGate } from '@core/egress';
import type { StarAnswer, StarElement } from '@core/types';
import { collectText } from './coach';
import type { CoachTurn } from './coach';

/** The audio answer formats accepted in this phase (R26.1). */
export const ACCEPTED_AUDIO_FORMATS: readonly AudioFormat[] = ['mp3', 'wav'] as const;

/**
 * A minimal, framework-agnostic abstraction over an uploaded audio file. Mirrors
 * the ingestion `FileBlob`: the Interview_Coach must run in the browser (over a
 * real `File`) and under Node (over fixtures), so it never depends on the DOM
 * `File` type. A browser `File` already satisfies this shape.
 */
export interface AudioUpload {
  /** Original file name (drives format detection). */
  readonly name: string;
  /** Optional MIME type, when the host provides one. */
  readonly mimeType?: string;
  /** The raw audio bytes to transmit to the chosen STT provider. */
  bytes(): Promise<Uint8Array>;
}

/**
 * A transcribed audio answer awaiting user confirmation/correction (R26.3). The
 * `text` is already minimised and PII-screened by the Egress Gate (R6.4); it is
 * NOT yet released for further processing — {@link confirmTranscript} must be
 * called first. `confirmed` is always `false`, distinguishing it at the type
 * level from a {@link ConfirmedTranscript}.
 */
export interface Transcript {
  /** The minimised, PII-screened transcript text (R6.4), awaiting confirmation. */
  readonly text: string;
  /** The validated source audio format (R26.1). */
  readonly format: AudioFormat;
  /** High-risk PII categories redacted from the transcript, if any (R6.3, R6.5). */
  readonly redactedCategories: readonly DetectionCategory[];
  /** Always `false`: a transcript must be confirmed before further processing. */
  readonly confirmed: false;
}

/**
 * A user-confirmed (and optionally corrected) transcript (R26.3). Only this type
 * can be fed into the coaching loop, so unconfirmed transcripts can never flow
 * into analysis or the skill-map / CV path by accident.
 */
export interface ConfirmedTranscript {
  /** The confirmed transcript text the user accepted (or edited) (R26.3). */
  readonly text: string;
  /** The validated source audio format (R26.1). */
  readonly format: AudioFormat;
  /** Always `true`: this text has been confirmed and may be processed. */
  readonly confirmed: true;
  /** True when the user edited the transcribed text before confirming. */
  readonly corrected: boolean;
}

/** Collaborators {@link uploadAudio} needs, supplied by the caller (DI). */
export interface UploadAudioOptions {
  /** The single Egress Gate chokepoint used for STT transcription (R26.2). */
  readonly gate: EgressGate;
  /** The user's chosen STT provider — the only permitted destination (R7.4). */
  readonly provider: ProviderId;
  /**
   * When `true`, request a translate-to-English transcription rather than a
   * same-language transcript (R26.5). Defaults to `false` when omitted.
   */
  readonly translateToEnglish?: boolean;
}

/**
 * Raised when an uploaded file is not one of the accepted audio formats (R26.1).
 * The message reinforces that only MP3/WAV uploads are supported and that there
 * is no live/in-app capture in this phase (R26.4).
 */
export class UnsupportedAudioFormatError extends Error {
  constructor(public readonly fileName: string) {
    super(
      `Audio answer "${fileName}" is not a supported format. Only MP3 and WAV ` +
        `audio files can be uploaded as interview answers; live or in-app audio ` +
        `capture is not available in this phase. Please upload an MP3 or WAV file.`,
    );
    this.name = 'UnsupportedAudioFormatError';
  }
}

/** Lower-cased file extension (without the dot), or `''` when there is none. */
const extensionOf = (name: string): string => {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

/** Supported audio extensions → canonical {@link AudioFormat} (R26.1). */
const EXTENSION_FORMATS: Readonly<Record<string, AudioFormat>> = {
  mp3: 'mp3',
  wav: 'wav',
};

/** Supported audio MIME types → canonical {@link AudioFormat} (R26.1). */
const MIME_FORMATS: Readonly<Record<string, AudioFormat>> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
};

/** Classify a MIME type, if any, to a supported {@link AudioFormat}. */
const formatFromMime = (mimeType?: string): AudioFormat | undefined => {
  if (!mimeType) return undefined;
  const normalized = mimeType.split(';')[0].trim().toLowerCase();
  return MIME_FORMATS[normalized];
};

/**
 * Detect the {@link AudioFormat} of an uploaded file, or `undefined` when it is
 * not a supported MP3/WAV file (R26.1). MIME type takes precedence when it maps
 * to a supported format; otherwise the extension is consulted. Live capture has
 * no entry point here — detection only ever runs over an uploaded file (R26.4).
 */
export const detectAudioFormat = (upload: AudioUpload): AudioFormat | undefined =>
  formatFromMime(upload.mimeType) ?? EXTENSION_FORMATS[extensionOf(upload.name)];

/** True when the uploaded file is an accepted MP3/WAV audio answer (R26.1). */
export const isSupportedAudio = (upload: AudioUpload): boolean =>
  detectAudioFormat(upload) !== undefined;

/**
 * Upload an audio answer and transcribe it through the Egress Gate (R26.1,
 * R26.2). Validates that the file is MP3 or WAV, rejecting anything else with an
 * {@link UnsupportedAudioFormatError} (R26.1, R26.4). The audio is sent only to
 * the user's chosen STT provider via the gate, which labels the operation,
 * PII-screens the resulting transcript, and fails closed on a declined
 * redaction or incomplete screening (R26.2 → R6). Returns an UNCONFIRMED
 * {@link Transcript} for the user to confirm/correct before any further
 * processing (R26.3) — it is never auto-fed into analysis.
 */
export const uploadAudio = async (
  upload: AudioUpload,
  options: UploadAudioOptions,
): Promise<Transcript> => {
  const format = detectAudioFormat(upload);
  if (format === undefined) {
    throw new UnsupportedAudioFormatError(upload.name);
  }
  const bytes = await upload.bytes();
  const audio: AudioBlob = { __brand: 'AudioBlob', format, bytes };

  // Route transcription through the single Egress Gate chokepoint (R26.2). The
  // gate screens the resulting transcript and fails closed on decline/error.
  // The translate-to-English preference (R26.5) is forwarded to the gate.
  const result = await options.gate.transcribe({
    provider: options.provider,
    audio,
    translateToEnglish: options.translateToEnglish,
  });

  return {
    text: result.text,
    format,
    redactedCategories: result.redactedCategories,
    confirmed: false,
  };
};

/**
 * Confirm a transcript before any further processing (R26.3). Pass
 * `correctedText` to record a user correction; omit it to accept the transcript
 * as transcribed. Returns a {@link ConfirmedTranscript} — the only form that may
 * flow into the coaching loop. Pure: it never mutates the input.
 */
export const confirmTranscript = (
  transcript: Transcript,
  correctedText?: string,
): ConfirmedTranscript => {
  const text = correctedText ?? transcript.text;
  return {
    text,
    format: transcript.format,
    confirmed: true,
    corrected: correctedText !== undefined && correctedText !== transcript.text,
  };
};

/**
 * Feed a CONFIRMED transcript's text into the guided STAR loop (R26.3, R24).
 * Requiring a {@link ConfirmedTranscript} (not a raw {@link Transcript}) is what
 * structurally guarantees the user confirmed/corrected the transcription before
 * it is processed. Delegates to {@link collectText}, so the same open-follow-up
 * loop and content firewall apply whether the answer was typed or spoken. Pure.
 */
export const collectFromTranscript = (
  answer: StarAnswer,
  transcript: ConfirmedTranscript,
  element?: StarElement,
): CoachTurn => collectText(answer, transcript.text, element);
