// In-browser record-audio answer control (@ui) — R26.4, R26.6–R26.8, R26.10, R26.11.
//
// The shell-side UI for capturing a spoken interview answer with the browser
// microphone. It wraps the @core `createRecordingController` over the browser
// {@link BrowserAudioRecorderPort} (the only DOM seam) and reuses the SAME gated
// transcription + confirm path as the upload flow: `transcribeRecording` routes
// the take through the Egress Gate (R26.6) and `confirmTranscript` produces the
// confirmed transcript fed back to the caller via {@link onConfirmed} (R26.7,
// R26.8). It never captures video and always requests microphone permission
// before recording (R26.4); on denial it surfaces a clear message and calls
// {@link onUnavailable} so the screen falls back to upload/text (R26.10). When no
// STT provider is configured the captured audio is preserved for retry (R26.11).

import { useEffect, useRef, useState } from 'react';
import type { EgressGate } from '@core/egress';
import {
  createRecordingController,
  transcribeRecording,
  confirmTranscript,
  RecordingRejectedError,
  SttProviderNotConfiguredError,
  MAX_RECORDING_SECONDS,
  type RecordingController,
  type RecordedAudio,
  type Transcript,
  type ConfirmedTranscript,
} from '@core/interview';
import {
  Banner,
  Button,
  LoadingIndicator,
  Row,
  TextArea,
  tokens,
} from './design-system';
import type { BrowserAudioRecorderPort } from './audio-recorder-port';

export interface RecordAnswerProps {
  /** Factory for the browser MediaRecorder port (injected for testability). */
  readonly createRecorder: () => BrowserAudioRecorderPort;
  /** The single Egress Gate chokepoint for STT transcription (R26.6). */
  readonly egressGate: EgressGate;
  /** The chosen STT provider id, or null when none is configured (R26.11). */
  readonly sttProvider: string | null;
  /** Reuse the screen's translate-to-English preference for recordings (R26.5 parity). */
  readonly translateToEnglish: boolean;
  /** Called with the confirmed transcript to converge with the typed/upload paths (R26.8). */
  readonly onConfirmed: (confirmed: ConfirmedTranscript) => void;
  /** Called when microphone permission is denied so the screen can fall back (R26.10). */
  readonly onUnavailable?: () => void;
  /** Disable the controls while another operation is in flight. */
  readonly disabled?: boolean;
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}

type RecordPhase = 'ready' | 'recording' | 'recorded' | 'transcribing' | 'confirm';

/**
 * The record-audio answer control. Drives the @core recording controller
 * (start / stop / re-record / discard with the ≤600 s / ≤25 MB guards) and the
 * gated transcribe → confirm flow, handing the confirmed transcript to the
 * caller so recorded answers converge with typed and uploaded ones.
 */
export function RecordAnswer({
  createRecorder,
  egressGate,
  sttProvider,
  translateToEnglish,
  onConfirmed,
  onUnavailable,
  disabled = false,
  t,
}: RecordAnswerProps) {
  const portRef = useRef<BrowserAudioRecorderPort | null>(null);
  const controllerRef = useRef<RecordingController | null>(null);
  const capTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [granted, setGranted] = useState(false);
  const [phase, setPhase] = useState<RecordPhase>('ready');
  const [recorded, setRecorded] = useState<RecordedAudio | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [transcriptEdit, setTranscriptEdit] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Build the port + controller once; release the microphone on unmount.
  const ensure = (): { port: BrowserAudioRecorderPort; controller: RecordingController } => {
    if (!portRef.current) {
      portRef.current = createRecorder();
      controllerRef.current = createRecordingController(portRef.current);
    }
    return { port: portRef.current, controller: controllerRef.current! };
  };

  const clearCapTimer = () => {
    if (capTimerRef.current) {
      clearTimeout(capTimerRef.current);
      capTimerRef.current = null;
    }
  };

  useEffect(
    () => () => {
      clearCapTimer();
      portRef.current?.release();
    },
    [],
  );

  const transcribe = async (rec: RecordedAudio) => {
    if (!sttProvider) {
      // No STT provider configured: preserve the audio and prompt to configure (R26.11).
      setError(t('coaching.audio.noProvider'));
      setPhase('recorded');
      return;
    }
    setPhase('transcribing');
    setError('');
    try {
      const tr = await transcribeRecording(rec, {
        gate: egressGate,
        provider: sttProvider,
        translateToEnglish,
      });
      setTranscript(tr);
      setTranscriptEdit(tr.text);
      setPhase('confirm');
    } catch (err) {
      if (err instanceof SttProviderNotConfiguredError) {
        // Audio preserved on the controller's RecordedAudio for a later retry (R26.11).
        setError(t('coaching.audio.noProvider'));
        setPhase('recorded');
        return;
      }
      setError(t('coaching.audio.failed', { reason: err instanceof Error ? err.message : String(err) }));
      setPhase('recorded');
    }
  };

  const handleStart = async () => {
    setError('');
    const { controller } = ensure();
    if (!granted) {
      // Request microphone permission BEFORE recording (R26.4).
      const state = await controller.requestMicPermission();
      if (state !== 'granted') {
        setGranted(false);
        setError(t('coaching.audio.record.denied'));
        onUnavailable?.();
        return;
      }
      setGranted(true);
    }
    try {
      controller.start();
      setRecorded(null);
      setTranscript(null);
      setPhase('recording');
      clearCapTimer();
      // Auto-stop at the duration cap so a take never exceeds it (R26.4).
      capTimerRef.current = setTimeout(() => void handleStop(), MAX_RECORDING_SECONDS * 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStop = async () => {
    const { port, controller } = ensure();
    if (phase !== 'recording') return;
    clearCapTimer();
    setBusy(true);
    try {
      await port.finalize();
      // The controller enforces the ≤600 s / ≤25 MB guards here (R26.4); a
      // rejected take leaves the prior answer state untouched.
      const rec = controller.stop();
      setRecorded(rec);
      setPhase('recorded');
      await transcribe(rec);
    } catch (err) {
      if (err instanceof RecordingRejectedError) {
        setError(t('coaching.audio.record.rejected', { reason: err.message }));
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setRecorded(null);
      setPhase('ready');
    } finally {
      setBusy(false);
    }
  };

  const handleReRecord = () => {
    const { controller } = ensure();
    setError('');
    try {
      controller.reRecord();
      setRecorded(null);
      setTranscript(null);
      setPhase('recording');
      clearCapTimer();
      capTimerRef.current = setTimeout(() => void handleStop(), MAX_RECORDING_SECONDS * 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const reset = () => {
    clearCapTimer();
    portRef.current?.release();
    setGranted(false);
    setRecorded(null);
    setTranscript(null);
    setTranscriptEdit('');
    setPhase('ready');
  };

  const handleDiscard = () => {
    const { controller } = ensure();
    try {
      controller.discard();
    } catch {
      // Ignore: discard is best-effort cleanup.
    }
    setError('');
    reset();
  };

  const handleUse = () => {
    if (!transcript) return;
    const confirmed = confirmTranscript(
      transcript,
      transcriptEdit !== transcript.text ? transcriptEdit : undefined,
    );
    onConfirmed(confirmed);
    setError('');
    reset();
  };

  return (
    <div data-record-answer>
      <p>
        <small>{t('coaching.audio.record.intro')}</small>
      </p>

      {phase === 'ready' ? (
        <Button onClick={() => void handleStart()} disabled={disabled || busy}>
          {t('coaching.audio.record.start')}
        </Button>
      ) : null}

      {phase === 'recording' ? (
        <>
          <p aria-live="polite">
            <small>{t('coaching.audio.record.recording')}</small>
          </p>
          <Row>
            <Button onClick={() => void handleStop()} disabled={disabled || busy}>
              {t('coaching.audio.record.stop')}
            </Button>
            <Button variant="secondary" onClick={handleDiscard} disabled={disabled || busy}>
              {t('coaching.audio.record.discard')}
            </Button>
          </Row>
        </>
      ) : null}

      {busy || phase === 'transcribing' ? (
        <LoadingIndicator message={t('coaching.audio.transcribing')} />
      ) : null}

      {/* A captured take that is not (yet) transcribed: offer retry + re-record. */}
      {phase === 'recorded' && recorded ? (
        <Row>
          {sttProvider ? (
            <Button onClick={() => void transcribe(recorded)} disabled={disabled || busy}>
              {t('coaching.audio.record.transcribe')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={handleReRecord} disabled={disabled || busy}>
            {t('coaching.audio.record.reRecord')}
          </Button>
          <Button variant="secondary" onClick={handleDiscard} disabled={disabled || busy}>
            {t('coaching.audio.record.discard')}
          </Button>
        </Row>
      ) : null}

      {/* Confirm/correct the transcript before it feeds the coaching loop (R26.7). */}
      {phase === 'confirm' && transcript ? (
        <div style={{ marginTop: tokens.spacing.sm }}>
          <p>
            <small>{t('coaching.audio.confirm')}</small>
          </p>
          <TextArea
            label={t('coaching.audio.confirm')}
            hideLabel
            rows={3}
            value={transcriptEdit}
            onChange={(e) => setTranscriptEdit(e.target.value)}
          />
          <Row>
            <Button onClick={handleUse} disabled={disabled || busy}>
              {t('coaching.audio.use')}
            </Button>
            <Button variant="secondary" onClick={handleReRecord} disabled={disabled || busy}>
              {t('coaching.audio.record.reRecord')}
            </Button>
            <Button variant="secondary" onClick={handleDiscard} disabled={disabled || busy}>
              {t('coaching.audio.record.discard')}
            </Button>
          </Row>
        </div>
      ) : null}

      {error ? (
        <Banner role="status">
          <small>{error}</small>
        </Banner>
      ) : null}
    </div>
  );
}
