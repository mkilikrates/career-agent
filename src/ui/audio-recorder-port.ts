// Shell-side AudioRecorderPort over the browser MediaRecorder API (@ui) — R26.4.
//
// This is the single DOM seam behind the @core in-browser recording controller
// (`createRecordingController`, src/core/interview/recording.ts). @core stays
// framework-agnostic by depending only on the {@link AudioRecorderPort}
// abstraction; this module is the concrete implementation over
// `navigator.mediaDevices.getUserMedia({ audio: true })` + `MediaRecorder`.
//
// It captures AUDIO ONLY — it requests an audio-only media stream and never a
// video track (R26.4) — requests MICROPHONE permission before any capture
// (R26.4), measures the take duration, reports the container as `webm` or `wav`,
// and RELEASES the microphone stream tracks when capture ends or is cancelled
// so the OS mic indicator turns off and nothing keeps the mic live.
//
// `MediaRecorder` finalises a take asynchronously (the final `dataavailable` and
// `stop` events fire after `stop()`), but the @core port contract exposes a
// SYNCHRONOUS `stop(): RawTake`. To bridge this without changing @core, the port
// adds an async {@link BrowserAudioRecorderPort.finalize} step: the UI awaits
// `finalize()` (which stops the recorder, drains its data, and prepares the
// take), then calls the synchronous controller `stop()` which reads the prepared
// take. The port is the only place that touches the DOM, keeping the controller
// and everything above it testable under Node with a fake recorder.

import type {
  AudioRecorderPort,
  MicPermissionState,
  RawTake,
  RecordingFormat,
} from '@core/interview';

/**
 * The concrete browser {@link AudioRecorderPort}. It adds {@link finalize} and
 * {@link release} to the @core contract: `finalize()` drains the asynchronous
 * `MediaRecorder` data so the controller's synchronous `stop()` can return the
 * prepared {@link RawTake}, and `release()` stops the microphone stream tracks
 * to free the mic between sessions.
 */
export interface BrowserAudioRecorderPort extends AudioRecorderPort {
  /**
   * Stop the underlying `MediaRecorder` and asynchronously drain its captured
   * data so a subsequent synchronous {@link AudioRecorderPort.stop} can return
   * the prepared take. Resolves once the bytes are ready. A no-op when not
   * recording.
   */
  finalize(): Promise<void>;
  /**
   * Release the microphone: stop and drop all media-stream tracks so the OS mic
   * indicator turns off. The next recording requires {@link requestMicPermission}
   * again. Safe to call repeatedly.
   */
  release(): void;
}

/**
 * Feature-detect whether in-browser audio recording is even possible in this
 * environment (R26.12 — the record path is offered only WHERE microphone access
 * is available). Returns `false` under Node/SSR or in browsers without
 * `mediaDevices.getUserMedia` / `MediaRecorder`, so the UI can fall back to the
 * always-available upload and text paths.
 */
export const isBrowserAudioRecordingSupported = (): boolean =>
  typeof navigator !== 'undefined' &&
  typeof navigator.mediaDevices !== 'undefined' &&
  typeof navigator.mediaDevices.getUserMedia === 'function' &&
  typeof MediaRecorder !== 'undefined';

/**
 * Pick a supported AUDIO-ONLY `MediaRecorder` mime type and map it to a @core
 * {@link RecordingFormat}. Prefers WebM (the broadly supported container); falls
 * back to WAV, then to the browser default. Returns the chosen mime (possibly
 * empty to let the browser decide) and the canonical format the take reports.
 */
const pickAudioMime = (): { mimeType: string; format: RecordingFormat } => {
  const supported =
    typeof MediaRecorder !== 'undefined' &&
    typeof MediaRecorder.isTypeSupported === 'function';
  if (supported && MediaRecorder.isTypeSupported('audio/webm')) {
    return { mimeType: 'audio/webm', format: 'webm' };
  }
  if (supported && MediaRecorder.isTypeSupported('audio/wav')) {
    return { mimeType: 'audio/wav', format: 'wav' };
  }
  // No explicit type: the browser chooses; we report WebM, the common default.
  return { mimeType: '', format: 'webm' };
};

/** Classify a `MediaRecorder` mime string into a @core {@link RecordingFormat}. */
const formatFromMime = (mime: string, fallback: RecordingFormat): RecordingFormat => {
  const normalized = mime.split(';')[0].trim().toLowerCase();
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('webm')) return 'webm';
  return fallback;
};

/** Default {@link BrowserAudioRecorderPort} over `MediaRecorder` (audio only). */
class MediaRecorderAudioPort implements BrowserAudioRecorderPort {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private durationSec = 0;
  private pendingTake: RawTake | null = null;

  async requestMicPermission(): Promise<MicPermissionState> {
    if (!isBrowserAudioRecordingSupported()) return 'denied';
    try {
      // Audio ONLY — never request a video track (R26.4).
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Reuse one granted stream across takes; release() frees it when done.
      this.release();
      this.stream = stream;
      return 'granted';
    } catch (error) {
      // A denied permission throws NotAllowedError / SecurityError; anything else
      // (no device, abort) is treated as unavailable so the UI offers fallbacks.
      const name = error instanceof DOMException ? error.name : '';
      return name === 'NotAllowedError' || name === 'SecurityError'
        ? 'denied'
        : 'denied';
    }
  }

  start(): void {
    if (!this.stream) {
      throw new Error('Microphone is not ready; request permission before recording.');
    }
    const { mimeType } = pickAudioMime();
    this.chunks = [];
    this.pendingTake = null;
    this.recorder = mimeType
      ? new MediaRecorder(this.stream, { mimeType })
      : new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    this.startedAt = performance.now();
    // Timeslice so data is emitted periodically and is ready promptly on stop.
    this.recorder.start(1000);
  }

  finalize(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') return Promise.resolve();
    return new Promise<void>((resolve) => {
      recorder.onstop = () => {
        this.durationSec = Math.max(0, (performance.now() - this.startedAt) / 1000);
        const fallback = pickAudioMime().format;
        const format = formatFromMime(recorder.mimeType ?? '', fallback);
        const blob = new Blob(this.chunks, {
          type: recorder.mimeType || `audio/${format}`,
        });
        void blob.arrayBuffer().then((buffer) => {
          this.pendingTake = {
            format,
            bytes: new Uint8Array(buffer),
            durationSec: this.durationSec,
          };
          resolve();
        });
      };
      recorder.stop();
    });
  }

  stop(): RawTake {
    if (!this.pendingTake) {
      throw new Error('No finalised recording is available; call finalize() first.');
    }
    const take = this.pendingTake;
    this.pendingTake = null;
    this.recorder = null;
    this.chunks = [];
    return take;
  }

  cancel(): void {
    // Abort an in-progress capture WITHOUT producing a take, but keep the granted
    // stream so an immediate re-record can start() again (R26.4 re-record).
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.ondataavailable = null;
      try {
        this.recorder.stop();
      } catch {
        // Already stopping/stopped; nothing to do.
      }
    }
    this.recorder = null;
    this.chunks = [];
    this.pendingTake = null;
  }

  release(): void {
    this.cancel();
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }
}

/**
 * Construct the browser {@link BrowserAudioRecorderPort} the coaching shell wraps
 * with the @core `createRecordingController`. The port captures audio only and
 * never video (R26.4); the controller layered on top enforces the ≤600 s / ≤25 MB
 * guards and the start / stop / re-record / discard lifecycle.
 */
export const createBrowserAudioRecorderPort = (): BrowserAudioRecorderPort =>
  new MediaRecorderAudioPort();
