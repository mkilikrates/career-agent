// Unit tests for in-browser audio recording and recording transcription (R26.4,
// R26.6–R26.11). The MediaRecorder is replaced by a fake {@link AudioRecorderPort}
// and the Egress Gate / STT provider are mocked — no real DOM or network.

import { describe, expect, it, vi } from 'vitest';
import { asQuestionId } from '@core/types';
import type { StarAnswer } from '@core/types';
import type { EgressGate, EgressSttIntent, EgressTranscript } from '@core/egress';
import type { ProviderResponse } from '@adapters/provider';
import {
  createRecordingController,
  transcribeRecording,
  collectAndSendTranscript,
  MicrophonePermissionDeniedError,
  RecordingRejectedError,
  RecordingStateError,
  SttProviderNotConfiguredError,
  MAX_RECORDING_SECONDS,
  MAX_RECORDING_BYTES,
  confirmTranscript,
  newAnswer,
  type AudioRecorderPort,
  type MicPermissionState,
  type RawTake,
  type RecordedAudio,
} from './index';

const QID = asQuestionId('Q-01');
const PROVIDER = 'openai';

/** A fake recorder port that records action calls and returns a fixed take. */
function fakePort(opts: {
  permission?: MicPermissionState;
  take?: RawTake;
}): AudioRecorderPort & {
  calls: string[];
} {
  const calls: string[] = [];
  const take: RawTake = opts.take ?? {
    format: 'webm',
    bytes: new Uint8Array([1, 2, 3]),
    durationSec: 12,
  };
  return {
    calls,
    requestMicPermission: vi.fn(async () => {
      calls.push('requestMicPermission');
      return opts.permission ?? 'granted';
    }),
    start: vi.fn(() => {
      calls.push('start');
    }),
    stop: vi.fn(() => {
      calls.push('stop');
      return take;
    }),
    cancel: vi.fn(() => {
      calls.push('cancel');
    }),
  };
}

function makeGate(
  result: EgressTranscript,
): EgressGate & {
  transcribe: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
} {
  const transcribe = vi.fn(async (_intent: EgressSttIntent) => result);
  const request = vi.fn(
    async () => ({ __brand: 'ProviderResponse' }) as ProviderResponse,
  );
  return { transcribe, request } as unknown as EgressGate & {
    transcribe: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
  };
}

const recording = (over: Partial<RecordedAudio> = {}): RecordedAudio => ({
  __brand: 'RecordedAudio',
  format: 'webm',
  bytes: new Uint8Array([1, 2, 3]),
  durationSec: 30,
  ...over,
});

describe('RecordingController — permission gating (R26.4, R26.10)', () => {
  it('requests microphone permission before recording', async () => {
    const port = fakePort({ permission: 'granted' });
    const controller = createRecordingController(port);

    expect(await controller.requestMicPermission()).toBe('granted');
    controller.start();

    expect(port.calls).toEqual(['requestMicPermission', 'start']);
  });

  it('refuses to start without granted permission and names the fallback paths (R26.10)', async () => {
    const port = fakePort({ permission: 'denied' });
    const controller = createRecordingController(port);

    await controller.requestMicPermission();

    try {
      controller.start();
      throw new Error('expected start to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MicrophonePermissionDeniedError);
      expect((err as MicrophonePermissionDeniedError).alternatives).toEqual([
        'upload',
        'text',
      ]);
      expect((err as MicrophonePermissionDeniedError).message).toMatch(
        /uploading an MP3 or WAV|typing your answer/i,
      );
    }
    expect(port.start).not.toHaveBeenCalled();
  });

  it('throws when stopping while not recording', () => {
    const controller = createRecordingController(fakePort({}));
    expect(() => controller.stop()).toThrow(RecordingStateError);
  });
});

describe('RecordingController — capture lifecycle (R26.4)', () => {
  it('produces a RecordedAudio (audio only) on stop within the guards', async () => {
    const port = fakePort({
      take: { format: 'webm', bytes: new Uint8Array([4, 5]), durationSec: 42 },
    });
    const controller = createRecordingController(port);

    await controller.requestMicPermission();
    controller.start();
    const rec = controller.stop();

    expect(rec.__brand).toBe('RecordedAudio');
    expect(rec.format).toBe('webm');
    expect(rec.durationSec).toBe(42);
    expect('video' in rec).toBe(false);
  });

  it('reRecord discards the current take and starts a new capture', async () => {
    const port = fakePort({});
    const controller = createRecordingController(port);

    await controller.requestMicPermission();
    controller.start();
    controller.reRecord();

    expect(port.calls).toEqual(['requestMicPermission', 'start', 'cancel', 'start']);
  });

  it('discard drops an in-progress capture', async () => {
    const port = fakePort({});
    const controller = createRecordingController(port);

    await controller.requestMicPermission();
    controller.start();
    controller.discard();

    expect(port.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('RecordingController — duration/size guards (R26.9 parity)', () => {
  it('rejects a take over 600s with the reason, leaving prior state intact', async () => {
    const port = fakePort({
      take: {
        format: 'webm',
        bytes: new Uint8Array([1]),
        durationSec: MAX_RECORDING_SECONDS + 1,
      },
    });
    const controller = createRecordingController(port);
    await controller.requestMicPermission();
    controller.start();

    try {
      controller.stop();
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(RecordingRejectedError);
      expect((err as RecordingRejectedError).reason).toBe('too-long');
    }
  });

  it('rejects a take over 25MB with the reason', async () => {
    const port = fakePort({
      take: {
        format: 'webm',
        bytes: new Uint8Array(MAX_RECORDING_BYTES + 1),
        durationSec: 10,
      },
    });
    const controller = createRecordingController(port);
    await controller.requestMicPermission();
    controller.start();

    try {
      controller.stop();
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as RecordingRejectedError).reason).toBe('too-large');
    }
  });

  it('rejects an unsupported container format', async () => {
    const port = fakePort({
      take: {
        format: 'mp4' as unknown as RawTake['format'],
        bytes: new Uint8Array([1]),
        durationSec: 5,
      },
    });
    const controller = createRecordingController(port);
    await controller.requestMicPermission();
    controller.start();

    try {
      controller.stop();
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as RecordingRejectedError).reason).toBe('unsupported-format');
    }
  });
});

describe('transcribeRecording — gated STT (R26.6, R26.7, R26.11)', () => {
  const clean: EgressTranscript = {
    text: 'I led a migration that cut query times in half',
    redactedCategories: [],
  };

  it('routes the take through the gate and returns an UNCONFIRMED transcript', async () => {
    const gate = makeGate(clean);

    const transcript = await transcribeRecording(recording({ format: 'webm' }), {
      gate,
      provider: PROVIDER,
      translateToEnglish: true,
    });

    expect(gate.transcribe).toHaveBeenCalledTimes(1);
    const intent = gate.transcribe.mock.calls[0][0] as EgressSttIntent;
    expect(intent.provider).toBe(PROVIDER);
    expect(intent.audio.format).toBe('webm');
    expect(intent.translateToEnglish).toBe(true);
    expect(transcript.confirmed).toBe(false);
    expect(transcript.text).toBe(clean.text);
  });

  it('preserves the captured audio when no STT provider is configured (R26.11)', async () => {
    const gate = makeGate(clean);
    const rec = recording();

    try {
      await transcribeRecording(rec, { gate, provider: '' });
      throw new Error('expected SttProviderNotConfiguredError');
    } catch (err) {
      expect(err).toBeInstanceOf(SttProviderNotConfiguredError);
      expect((err as SttProviderNotConfiguredError).recording).toBe(rec);
    }
    expect(gate.transcribe).not.toHaveBeenCalled();
  });
});

describe('collectAndSendTranscript — confirmed feed + chat send (R26.8)', () => {
  it('feeds the confirmed transcript into the loop AND sends it via the gate', async () => {
    const gate = makeGate({ text: 'irrelevant', redactedCategories: [] });
    const answer: StarAnswer = newAnswer(QID);
    const confirmed = confirmTranscript({
      text: 'I scoped and shipped a reliability fix under deadline',
      format: 'webm',
      redactedCategories: [],
      confirmed: false,
    });

    const { turn, response } = await collectAndSendTranscript(answer, confirmed, {
      gate,
      chatProvider: PROVIDER,
    });

    // Fed into the coaching loop (first element captured) ...
    expect(turn.answer.situation).toBe(confirmed.text);
    expect(turn.next).toBe('task');
    // ... and sent to the chat provider through the Egress Gate (R26.8).
    expect(gate.request).toHaveBeenCalledTimes(1);
    const intent = gate.request.mock.calls[0][0];
    expect(intent.provider).toBe(PROVIDER);
    expect(intent.text).toBe(confirmed.text);
    expect(intent.operation).toBe('llm-chat');
    expect(response.__brand).toBe('ProviderResponse');
  });
});
