// Unit tests for audio answer upload and transcription via the Egress Gate
// (R26). The Egress Gate / STT provider are mocked — no real network is
// involved. These cover: MP3 and WAV accepted; unsupported formats rejected
// (R26.1, R26.4); transcription routed through the gate with PII pre-screening
// and fail-closed on decline (R26.2); the transcript surfaced UNCONFIRMED for
// confirmation/correction before any further processing (R26.3); and confirmed
// text feeding the coaching loop (R24).

import { describe, expect, it, vi } from 'vitest';
import { asQuestionId } from '@core/types';
import type { StarAnswer } from '@core/types';
import type { EgressGate, EgressSttIntent, EgressTranscript } from '@core/egress';
import type { ProviderResponse } from '@adapters/provider';
import {
  ACCEPTED_AUDIO_FORMATS,
  UnsupportedAudioFormatError,
  detectAudioFormat,
  isSupportedAudio,
  uploadAudio,
  confirmTranscript,
  collectFromTranscript,
  newAnswer,
  type AudioUpload,
  type Transcript,
} from './index';

const PROVIDER = 'openai';
const QID = asQuestionId('Q-01');

/** Build an in-memory audio upload over fixed bytes. */
function audioUpload(
  name: string,
  mimeType?: string,
  data: Uint8Array = new Uint8Array([1, 2, 3, 4]),
): AudioUpload {
  return { name, mimeType, bytes: async () => data };
}

/**
 * A mocked Egress Gate whose `transcribe` returns a fixed screened result and
 * records the intent it received. `request` is present to satisfy the interface
 * but is never used by the audio path.
 */
function makeGate(
  result: EgressTranscript,
): EgressGate & { transcribe: ReturnType<typeof vi.fn> } {
  const transcribe = vi.fn(async (_intent: EgressSttIntent) => result);
  const request = vi.fn(async () => ({ __brand: 'ProviderResponse' }) as ProviderResponse);
  return { transcribe, request } as unknown as EgressGate & {
    transcribe: ReturnType<typeof vi.fn>;
  };
}

const cleanResult: EgressTranscript = {
  text: 'I led a database migration that cut query times in half',
  redactedCategories: [],
};

describe('audio format validation (R26.1, R26.4)', () => {
  it('accepts exactly MP3 and WAV', () => {
    expect(ACCEPTED_AUDIO_FORMATS).toEqual(['mp3', 'wav']);
  });

  it('detects MP3 by extension and by MIME type', () => {
    expect(detectAudioFormat(audioUpload('answer.mp3'))).toBe('mp3');
    expect(detectAudioFormat(audioUpload('answer', 'audio/mpeg'))).toBe('mp3');
    expect(detectAudioFormat(audioUpload('ANSWER.MP3'))).toBe('mp3');
  });

  it('detects WAV by extension and by MIME type', () => {
    expect(detectAudioFormat(audioUpload('answer.wav'))).toBe('wav');
    expect(detectAudioFormat(audioUpload('answer', 'audio/wav'))).toBe('wav');
    expect(detectAudioFormat(audioUpload('answer', 'audio/x-wav'))).toBe('wav');
  });

  it('rejects unsupported formats (e.g. m4a, ogg, flac, mp4)', () => {
    expect(detectAudioFormat(audioUpload('answer.m4a'))).toBeUndefined();
    expect(detectAudioFormat(audioUpload('answer.ogg'))).toBeUndefined();
    expect(detectAudioFormat(audioUpload('answer.flac'))).toBeUndefined();
    expect(detectAudioFormat(audioUpload('answer', 'video/mp4'))).toBeUndefined();
    expect(isSupportedAudio(audioUpload('answer.m4a'))).toBe(false);
  });
});

describe('uploadAudio — format gating (R26.1, R26.4)', () => {
  it('rejects a non-MP3/WAV upload without contacting the gate', async () => {
    const gate = makeGate(cleanResult);

    await expect(
      uploadAudio(audioUpload('answer.m4a', 'audio/mp4'), { gate, provider: PROVIDER }),
    ).rejects.toBeInstanceOf(UnsupportedAudioFormatError);

    expect(gate.transcribe).not.toHaveBeenCalled();
  });

  it('the rejection message states only uploads are supported (no live capture)', async () => {
    const gate = makeGate(cleanResult);
    await expect(
      uploadAudio(audioUpload('answer.webm'), { gate, provider: PROVIDER }),
    ).rejects.toThrow(/upload an MP3 or WAV file/i);
  });

  it.each(['mp3', 'wav'] as const)('accepts a .%s upload and routes it through the gate', async (ext) => {
    const gate = makeGate(cleanResult);
    const bytes = new Uint8Array([9, 8, 7]);

    const transcript = await uploadAudio(audioUpload(`answer.${ext}`, undefined, bytes), {
      gate,
      provider: PROVIDER,
    });

    expect(gate.transcribe).toHaveBeenCalledTimes(1);
    const intent = gate.transcribe.mock.calls[0][0] as EgressSttIntent;
    expect(intent.provider).toBe(PROVIDER);
    expect(intent.audio.format).toBe(ext);
    expect(intent.audio.bytes).toBe(bytes);
    expect(transcript.format).toBe(ext);
  });
});

describe('uploadAudio — transcription via the gate (R26.2, R26.3)', () => {
  it('returns the screened transcript UNCONFIRMED for confirmation/correction', async () => {
    const gate = makeGate(cleanResult);

    const transcript = await uploadAudio(audioUpload('answer.mp3'), {
      gate,
      provider: PROVIDER,
    });

    expect(transcript.text).toBe(cleanResult.text);
    expect(transcript.confirmed).toBe(false);
    expect(transcript.redactedCategories).toEqual([]);
  });

  it('surfaces the categories the gate redacted from the transcript (R6.3, R6.5)', async () => {
    const gate = makeGate({
      text: 'my number is [REDACTED:ssn] thanks',
      redactedCategories: ['ssn'],
    });

    const transcript = await uploadAudio(audioUpload('answer.wav'), {
      gate,
      provider: PROVIDER,
    });

    expect(transcript.text).not.toMatch(/\d{3}-\d{2}-\d{4}/);
    expect(transcript.redactedCategories).toEqual(['ssn']);
  });

  it('propagates a fail-closed gate rejection (declined redaction) (R26.2)', async () => {
    const transcribe = vi.fn(async () => {
      throw new Error('user declined redact-and-proceed');
    });
    const gate = { transcribe, request: vi.fn() } as unknown as EgressGate;

    await expect(
      uploadAudio(audioUpload('answer.mp3'), { gate, provider: PROVIDER }),
    ).rejects.toThrow(/declined/i);
  });
});

describe('confirm/correct before further processing (R26.3, R24)', () => {
  it('confirmTranscript accepts the transcribed text as-is', () => {
    const transcript: Transcript = {
      text: 'the transcribed answer text here',
      format: 'mp3',
      redactedCategories: [],
      confirmed: false,
    };

    const confirmed = confirmTranscript(transcript);

    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.text).toBe('the transcribed answer text here');
    expect(confirmed.corrected).toBe(false);
  });

  it('confirmTranscript records a user correction', () => {
    const transcript: Transcript = {
      text: 'i lead a migration',
      format: 'wav',
      redactedCategories: [],
      confirmed: false,
    };

    const confirmed = confirmTranscript(transcript, 'I led a migration that cut costs');

    expect(confirmed.text).toBe('I led a migration that cut costs');
    expect(confirmed.corrected).toBe(true);
  });

  it('only a confirmed transcript feeds the coaching loop (R26.3 → R24)', async () => {
    const gate = makeGate(cleanResult);
    const transcript = await uploadAudio(audioUpload('answer.mp3'), {
      gate,
      provider: PROVIDER,
    });

    const confirmed = confirmTranscript(transcript);
    const answer: StarAnswer = newAnswer(QID);

    const turn = collectFromTranscript(answer, confirmed);

    // The confirmed text was recorded as the first STAR element (situation),
    // exactly as a typed answer would be, then the loop asks the next follow-up.
    expect(turn.answer.situation).toBe(cleanResult.text);
    expect(turn.status).toBe('incomplete');
    expect(turn.next).toBe('task');
    expect(turn.followUp).toBeDefined();
  });
});
