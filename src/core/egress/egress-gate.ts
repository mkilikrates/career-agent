// Egress Gate — the single chokepoint through which every outbound provider
// request must pass (design "Egress Gate"; Requirements 6, 7).
//
// No @core domain component is permitted to import a provider client directly.
// Instead, components hand a minimal {@link EgressIntent} (the user's chosen
// provider, the plaintext to send, and an operation label) to this gate, which
// performs the trust-critical sequence — in this exact order — before anything
// leaves the device:
//
//   1. Attach/emit a third-party network-operation label BEFORE the call runs
//      so the UI can render it (R7.3).
//   2. Run local PII pre-screening via the injected PII_Scanner (R6.1).
//   3. If high-risk values are detected, notify the user of the detected
//      categories and offer redact-and-proceed; if the user declines, do NOT
//      transmit (fail closed) (R6.3).
//   4. Build the minimised Redacted Payload via the scanner (R6.4, R7.2). Even
//      when there are no detections, the transmitted form is the minimised
//      redacted payload — never some larger object.
//   5. Hand the Redacted Payload to the Provider_Manager, which transmits it
//      only to the user's chosen provider (R7.4) and decrypts that provider's
//      key just-in-time (R5.3).
//
// Fail-closed posture (design cross-cutting rules): whenever PII screening
// cannot complete (the scanner throws) or a required collaborator is missing,
// the gate raises an error and performs NO transmission.
//
// STT (audio-in) path: `transcribe` follows the same trust-critical contract for
// the speech-to-text case (R26.2). Because audio cannot be screened by the
// text-based PII_Scanner, the gate labels the operation, transmits the audio to
// the chosen provider, then PII-screens the *resulting transcript* and offers
// redact-and-proceed before releasing it for any further processing — failing
// closed on a declined redaction or incomplete screening (R26.2 → Requirement 6).
//
// Memory Store boundary (R7.1): this gate has NO reference to the
// Storage_Adapter and accepts only the explicit, minimal `text` carried by the
// intent. No domain component passes raw Memory Store file contents through
// here, and the gate has no means of reading them, so Memory Store files are
// never transmitted to a third party.
//
// Requirements: 6.1, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4.

import type {
  AudioBlob,
  ProviderId,
  ProviderManager,
  ProviderResponse,
  RedactedPayload,
  Transcript,
} from '@adapters/provider';
import type { Detection, DetectionCategory, PiiScanner } from '@adapters/pii';
import {
  composeSendControlPayload,
  type SendControlDecision,
  type SensitiveDetection,
} from './send-control';

/**
 * The kind of outbound provider operation a payload represents. Used to build
 * the human-readable network-operation label (R7.3) and to describe the
 * redact-and-proceed proposal (R6.3).
 */
export type EgressOperationKind = 'llm-chat' | 'stt-transcribe';

/**
 * The minimal, explicit request a core component hands to the gate. It carries
 * ONLY what an operation needs (R7.2):
 *   - `provider`: the user's chosen provider id — the sole permitted
 *     destination (R7.4);
 *   - `text`: the plaintext to be screened and (after redaction) transmitted;
 *   - `operation`: the operation kind/label for UI surfacing (R7.3).
 *
 * There is deliberately no field for Memory Store handles or file contents: the
 * gate cannot transmit what it is never given (R7.1).
 */
export interface EgressIntent {
  /** The user's chosen provider — the only permitted destination (R7.4). */
  readonly provider: ProviderId;
  /** The plaintext to screen and (after redaction) transmit. */
  readonly text: string;
  /** Operation kind used for the network label and redact proposal. */
  readonly operation: EgressOperationKind;
  /**
   * When `true`, request the strongest no-training/no-retention posture from the
   * provider (R42.1). The shell sets this from the session consent state — it is
   * `true` unless the user has explicitly consented to training/improvement use.
   * (Private Memory Store items are never placed in `text` at all, so they are
   * never transmitted regardless of this flag.)
   */
  readonly noTraining?: boolean;
}

/**
 * The minimal, explicit request a core component hands to the gate to transcribe
 * audio (R26.1, R26.2). It carries ONLY the user's chosen STT provider — the
 * sole permitted destination (R7.4) — and the audio payload to transmit (R7.2).
 *
 * Audio cannot be screened by the text-based PII_Scanner, so unlike
 * {@link EgressIntent} there is no outbound `text` to pre-screen here. Instead
 * the gate screens the *resulting* transcript before returning it, so the PII
 * pre-screening of Requirement 6 runs before the transcript is fed onward into
 * any coaching / skill-map / CV path (R26.2). The operation is always
 * `stt-transcribe`.
 */
export interface EgressSttIntent {
  /** The user's chosen STT provider — the only permitted destination (R7.4). */
  readonly provider: ProviderId;
  /** The audio payload to transcribe and transmit (R7.2). */
  readonly audio: AudioBlob;
  /**
   * When `true`, request a translate-to-English transcription rather than a
   * same-language transcript (R26.5). Forwarded to the STT client, which targets
   * the provider's translate-to-English endpoint. Defaults to `false` (normal
   * same-language transcription) when omitted.
   */
  readonly translateToEnglish?: boolean;
}

/**
 * The result of a gated transcription (R26.2, R26.3). The `text` is the
 * minimised, PII-screened transcript — every detected high-risk value has been
 * removed (R6.4) — ready to surface to the user for confirmation/correction
 * before any further processing (R26.3). `redactedCategories` names the
 * high-risk categories that were redacted (never the values themselves, R6.5)
 * so the UI can explain what changed; it is empty when nothing was detected.
 */
export interface EgressTranscript {
  /** The minimised, PII-screened transcript text (R6.4). */
  readonly text: string;
  /** Distinct high-risk categories that were redacted, if any (R6.3, R6.5). */
  readonly redactedCategories: readonly DetectionCategory[];
}

/**
 * The minimal request a core/UI component hands to the gate to transmit
 * **ingestion file content** under the user's per-file send-control decision
 * (Requirements 6.6, 57). Unlike {@link EgressIntent}, which pre-screens and
 * offers a whole-payload redact-and-proceed, this path consults the file's
 * confirmed {@link SendControlDecision} and composes the payload per the user's
 * per-file / per-detection choice.
 *
 * The gate refuses to build or transmit anything until `decision.confirmed` is
 * `true` (R57.1, R57.10). It carries ONLY the file `content`, the Sensitive
 * Detections found in it, and the decision — no Memory Store handles (R7.1).
 */
export interface EgressIngestionIntent {
  /** The user's chosen provider — the only permitted destination (R7.4). */
  readonly provider: ProviderId;
  /** The full staged file content the decision is built against. */
  readonly content: string;
  /** The Sensitive Detections the scanner found in `content` (R57.2). */
  readonly detections: readonly SensitiveDetection[];
  /** The user's per-file send choice; must be `confirmed` before any build (R57.1). */
  readonly decision: SendControlDecision;
  /** Operation kind for the network label; defaults to `llm-chat` when omitted. */
  readonly operation?: EgressOperationKind;
  /** Strongest no-training/no-retention posture preference (R42.1). */
  readonly noTraining?: boolean;
}

/**
 * The third-party network-operation label emitted BEFORE the call runs (R7.3).
 * The UI renders this so the user always knows when data is about to leave the
 * device and to which provider.
 */
export interface NetworkOperationLabel {
  readonly operation: EgressOperationKind;
  /** The provider the payload will be transmitted to (R7.4). */
  readonly provider: ProviderId;
  /**
   * Whether this operation crosses the device boundary to a third party. It is
   * `true` for a keyed cloud provider (the payload leaves the device, R7.3) and
   * `false` for a keyless Local Provider, whose endpoint runs on the user's own
   * machine, so the call is local on-device with no third-party egress (R7.6).
   */
  readonly thirdParty: boolean;
  /** Human-readable description suitable for direct display. */
  readonly description: string;
}

/**
 * Notifier invoked with the {@link NetworkOperationLabel} before transmission
 * (R7.3). Injected so the UI shell controls rendering; the gate stays
 * framework-agnostic. It is called for the side effect only.
 */
export type LabelNotifier = (label: NetworkOperationLabel) => void;

/**
 * The proposal presented to the user when high-risk values are detected (R6.3).
 * It names the detected categories (never the secret values themselves, per
 * R6.5) so the user can make an informed redact-and-proceed decision.
 */
export interface RedactProposal {
  readonly provider: ProviderId;
  readonly operation: EgressOperationKind;
  /** Distinct detected high-risk categories, in first-seen order. */
  readonly categories: readonly DetectionCategory[];
  /** Total number of detected high-risk spans. */
  readonly detectionCount: number;
}

/**
 * Confirmation callback offering redact-and-proceed (R6.3). Resolving `true`
 * means "redact and proceed"; resolving `false` (or rejecting) means the user
 * declined, so the gate fails closed and transmits nothing. Injected so the UI
 * owns the interaction.
 */
export type RedactAndProceedPrompt = (
  proposal: RedactProposal,
) => boolean | Promise<boolean>;

/**
 * The exact outbound text payload the gate is about to transmit, surfaced to the
 * user for review BEFORE a third-party send (R65.1). It carries only the chosen
 * `provider` (the sole permitted destination, R7.4), the `operation` kind for
 * context, and the verbatim `text` so the user can edit or remove any wording.
 */
export interface PayloadPreview {
  readonly provider: ProviderId;
  readonly operation: EgressOperationKind;
  /** The exact text that would be transmitted, presented for review/editing. */
  readonly text: string;
}

/**
 * Payload Preview callback offering pre-transmission review and free editing of
 * the exact outbound text before a third-party send (R65.1, R65.2). It is
 * injected so the UI shell owns the modal interaction and the gate stays
 * framework-agnostic (mirroring {@link RedactAndProceedPrompt} and
 * {@link LabelNotifier}).
 *
 * Resolving a string means "transmit THIS user-approved (possibly edited) text"
 * — the resolved value becomes the basis for the rest of the egress pipeline
 * (PII pre-screening, redact-and-proceed, minimised-payload build), so the
 * preview supplements rather than bypasses PII pre-screening (R65.3). Resolving
 * `null` means the user cancelled: the gate fails closed, transmits nothing, and
 * the caller may treat it as preserving prior state (R65.4).
 */
export type PayloadPreviewPrompt = (
  preview: PayloadPreview,
) => Promise<string | null>;

/** The collaborators the gate depends on, supplied via constructor DI. */
export interface EgressGateOptions {
  /** Local PII pre-screening (R6.1) — runs before any transmission. */
  readonly scanner: PiiScanner;
  /** Transmits the Redacted Payload to the chosen provider only (R7.4). */
  readonly providerManager: ProviderManager;
  /** Emits the third-party network-operation label before the call (R7.3). */
  readonly notifyLabel: LabelNotifier;
  /** Offers redact-and-proceed when high-risk values are detected (R6.3). */
  readonly confirmRedactAndProceed: RedactAndProceedPrompt;
  /**
   * OPTIONAL Payload Preview callback (R65). When present, the gate surfaces the
   * exact outbound text of a third-party `llm-chat` send for the user to review,
   * edit, or cancel BEFORE PII pre-screening (R65.1, R65.2, R65.6). It is
   * deliberately optional: when absent the gate behaves exactly as before (no
   * preview), so existing callers/tests that do not supply it keep working. It
   * never applies to a keyless Local Provider (nothing leaves the device, R65.5),
   * to ingestion send-control (R57), or to STT audio (R65.7).
   */
  readonly previewPayload?: PayloadPreviewPrompt;
}

/** The Egress Gate contract: the single way a core component reaches a provider. */
export interface EgressGate {
  /**
   * Run the full egress sequence for `intent` and return the provider response.
   * Performs no transmission and throws if screening cannot complete or the
   * user declines redaction (fail-closed).
   */
  request(intent: EgressIntent): Promise<ProviderResponse>;
  /**
   * Transcribe audio through the user's chosen STT provider (R26.1, R26.2). The
   * gate labels the third-party operation before the call (R7.3), transmits the
   * audio only to the chosen provider (R7.4), then PII-screens the resulting
   * transcript (R6.1) and offers redact-and-proceed on detection (R6.3) before
   * returning the minimised, screened transcript for user confirmation (R26.3).
   * Fails closed — returning nothing — if screening cannot complete or the user
   * declines redaction.
   */
  transcribe(intent: EgressSttIntent): Promise<EgressTranscript>;
  /**
   * Transmit **ingestion file content** under the file's confirmed
   * {@link SendControlDecision} (Requirements 6.6, 57). The gate refuses to build
   * or transmit any payload until `intent.decision.confirmed` is `true` (R57.1,
   * R57.10): a `whole-file` decision builds the payload from the full content
   * (R57.3); a `per-detection` decision builds the Redacted Payload retaining
   * exactly the allowed detection values and removing every redacted one (R57.4).
   * Fails closed — transmitting nothing — when the decision is not confirmed or
   * payload composition cannot complete.
   */
  requestIngestion(intent: EgressIngestionIntent): Promise<ProviderResponse>;
}

/**
 * Raised when PII screening cannot complete (the scanner threw). The gate fails
 * closed: no payload is transmitted (R6.1 enforcement / design fail-closed).
 */
export class EgressScreeningError extends Error {
  constructor(
    public readonly provider: ProviderId,
    public readonly cause: unknown,
  ) {
    super(
      `PII pre-screening failed for provider "${provider}"; nothing was ` +
        `transmitted (fail-closed).`,
    );
    this.name = 'EgressScreeningError';
  }
}

/**
 * Raised when the user declines the redact-and-proceed offer (R6.3). The gate
 * fails closed and transmits nothing.
 */
export class EgressDeclinedError extends Error {
  constructor(
    public readonly provider: ProviderId,
    public readonly categories: readonly DetectionCategory[],
  ) {
    super(
      `User declined redact-and-proceed for provider "${provider}"; nothing ` +
        `was transmitted.`,
    );
    this.name = 'EgressDeclinedError';
  }
}

/**
 * Raised when the user cancels the Payload Preview before a third-party send
 * (R65.4). The gate fails closed: nothing is transmitted, and the caller may
 * catch this to preserve the user's prior state (no payload left the device).
 */
export class EgressPreviewCancelledError extends Error {
  constructor(public readonly provider: ProviderId) {
    super(
      `User cancelled the Payload Preview for provider "${provider}"; nothing ` +
        `was transmitted (fail-closed, R65.4).`,
    );
    this.name = 'EgressPreviewCancelledError';
  }
}

/**
 * Raised when ingestion file content is presented for egress before the user has
 * confirmed a {@link SendControlDecision} for that file (R57.1, R57.10). The gate
 * refuses to build or transmit any payload until the decision is `confirmed`, so
 * it fails closed and transmits nothing.
 */
export class EgressSendControlNotConfirmedError extends Error {
  constructor(public readonly provider: ProviderId) {
    super(
      `No confirmed send-control decision for the staged file; nothing was ` +
        `built or transmitted to provider "${provider}" (fail-closed, R57.1).`,
    );
    this.name = 'EgressSendControlNotConfirmedError';
  }
}

/**
 * Raised at construction when a required collaborator is missing. Surfacing
 * this early guarantees the gate can never silently transmit without its
 * screening/labelling collaborators in place (fail-closed).
 */
export class EgressMisconfiguredError extends Error {
  constructor(public readonly missing: string) {
    super(`Egress Gate is misconfigured: missing required collaborator "${missing}".`);
    this.name = 'EgressMisconfiguredError';
  }
}

/** Build the user-facing description for the network-operation label (R7.3, R7.6). */
function describeOperation(
  operation: EgressOperationKind,
  provider: ProviderId,
  thirdParty: boolean,
): string {
  const action =
    operation === 'stt-transcribe'
      ? 'Transcribing audio via your speech-to-text provider'
      : 'Sending a chat request to your language-model provider';
  if (!thirdParty) {
    // Local Provider: the endpoint runs on the user's own machine, so this is a
    // local on-device call with no third-party egress (R7.6).
    return `${action} (${provider}). This is a local on-device call with no ` +
      `third-party egress; the minimised, PII-screened payload stays on your device.`;
  }
  return `${action} (${provider}). This is a third-party network call; only the ` +
    `minimised, PII-screened payload is transmitted.`;
}

/** Distinct detection categories in first-seen order (for the proposal, R6.3). */
function distinctCategories(detections: readonly Detection[]): DetectionCategory[] {
  const seen = new Set<DetectionCategory>();
  const ordered: DetectionCategory[] = [];
  for (const d of detections) {
    if (!seen.has(d.category)) {
      seen.add(d.category);
      ordered.push(d.category);
    }
  }
  return ordered;
}

/**
 * Default {@link EgressGate}. Holds only the injected collaborators; it keeps no
 * provider keys, no Memory Store access, and no mutable state between calls.
 */
export class DefaultEgressGate implements EgressGate {
  private readonly scanner: PiiScanner;
  private readonly providerManager: ProviderManager;
  private readonly notifyLabel: LabelNotifier;
  private readonly confirmRedactAndProceed: RedactAndProceedPrompt;
  private readonly previewPayload?: PayloadPreviewPrompt;

  constructor(options: EgressGateOptions) {
    // Fail closed on misconfiguration: a missing collaborator must never allow
    // an unscreened/unlabelled transmission to slip through.
    if (!options || typeof options !== 'object') {
      throw new EgressMisconfiguredError('options');
    }
    if (!options.scanner) throw new EgressMisconfiguredError('scanner');
    if (!options.providerManager) throw new EgressMisconfiguredError('providerManager');
    if (!options.notifyLabel) throw new EgressMisconfiguredError('notifyLabel');
    if (!options.confirmRedactAndProceed) {
      throw new EgressMisconfiguredError('confirmRedactAndProceed');
    }
    this.scanner = options.scanner;
    this.providerManager = options.providerManager;
    this.notifyLabel = options.notifyLabel;
    this.confirmRedactAndProceed = options.confirmRedactAndProceed;
    // OPTIONAL (R65): no misconfiguration error when absent — the gate simply
    // skips the Payload Preview and behaves exactly as before.
    this.previewPayload = options.previewPayload;
  }

  /**
   * Decide whether transmitting to `provider` crosses the device boundary to a
   * third party (R7.6). A keyless Local Provider targets an OpenAI-Compatible
   * Endpoint on the user's own machine, so its call is local on-device with no
   * third-party egress; any keyed cloud provider is third-party.
   *
   * The keyless flag is read from the Provider_Manager's registry descriptor
   * rather than hardcoded. If the registry cannot be queried or the descriptor
   * is absent (e.g. a test stub that does not implement `listProviders`), the
   * gate FAILS SAFE by assuming a third-party cloud call (`thirdParty = true`):
   * over-labelling a local call as third-party is harmless, whereas the reverse
   * would understate egress, so the safe default is the cloud assumption.
   */
  private isThirdParty(provider: ProviderId): boolean {
    try {
      const descriptors = this.providerManager.listProviders?.();
      if (!descriptors) return true;
      const descriptor = descriptors.find((d) => d.id === provider);
      if (!descriptor) return true;
      return !descriptor.keyless;
    } catch {
      // A registry that throws must not block egress labelling; fail safe to
      // the third-party assumption so the call is never under-labelled.
      return true;
    }
  }

  async request(intent: EgressIntent): Promise<ProviderResponse> {
    const { provider, operation } = intent;
    // The text that will be screened and transmitted. For a third-party
    // `llm-chat` send this may be replaced by the user-approved Payload Preview
    // text below (R65.2); otherwise it is the intent's text unchanged.
    let text = intent.text;

    // 1. Label the network operation BEFORE anything runs (R7.3). A keyless
    //    Local Provider is a local on-device call with no third-party egress
    //    (R7.6); a keyed cloud provider is third-party.
    const thirdParty = this.isThirdParty(provider);
    this.notifyLabel({
      operation,
      provider,
      thirdParty,
      description: describeOperation(operation, provider, thirdParty),
    });

    let payload: RedactedPayload;
    if (!thirdParty) {
      // Local on-device provider (R7.6): the model runs on the user's own
      // machine and nothing crosses to a third party, so there is nothing to
      // protect against — PII pre-screening is skipped entirely and the FULL
      // content is sent as-is (user-confirmed design decision). The Payload
      // Preview is likewise skipped because no payload leaves the device (R65.5).
      // The scanner's redact with no detections is used only to mint the
      // minimal, correctly branded payload; it performs no scanning.
      payload = this.scanner.redact(text, []);
    } else {
      // 1a. Payload Preview (R65): for a third-party `llm-chat` text send, when a
      //     preview callback is injected, surface the EXACT outbound text for the
      //     user to review/edit/cancel — AFTER the network label (R65.6) and
      //     BEFORE PII pre-screening (R65.3 defense in depth). Cancelling
      //     (`null`) fails closed: transmit nothing and let the caller preserve
      //     prior state (R65.4). Scoped strictly to `llm-chat` (R65.7); STT and
      //     ingestion paths are untouched.
      if (this.previewPayload && operation === 'llm-chat') {
        const approved = await this.previewPayload({ provider, operation, text });
        if (approved === null) {
          throw new EgressPreviewCancelledError(provider);
        }
        // The user-approved (possibly edited) text becomes the basis for the
        // rest of the pipeline (R65.2).
        text = approved;
      }

      // 2. Local PII pre-screening (R6.1) on the user-approved text. Fail closed
      //    if it cannot complete.
      let detections: Detection[];
      try {
        detections = this.scanner.scan(text);
      } catch (cause) {
        throw new EgressScreeningError(provider, cause);
      }

      // 3. High-risk values present → notify categories + offer redact-and-proceed
      //    (R6.3). Declining transmits nothing (fail closed). Categories only are
      //    surfaced — never the secret values (R6.5).
      if (detections.length > 0) {
        const categories = distinctCategories(detections);
        let proceed: boolean;
        try {
          proceed = await this.confirmRedactAndProceed({
            provider,
            operation,
            categories,
            detectionCount: detections.length,
          });
        } catch (cause) {
          // A rejected/failed confirmation is treated as a decline: fail closed.
          throw new EgressDeclinedError(provider, categories);
        }
        if (!proceed) {
          throw new EgressDeclinedError(provider, categories);
        }
      }

      // 4. Build the minimised Redacted Payload (R6.4, R7.2). With no detections
      //    `redact` returns the minimised pass-through form; with detections it
      //    removes every detected high-risk value.
      payload = this.scanner.redact(text, detections);
    }

    // The user's no-training preference (R42.1) is attached so the provider
    // client can request the strongest no-retention/no-training posture.
    const finalPayload: RedactedPayload =
      intent.noTraining === undefined ? payload : { ...payload, noTraining: intent.noTraining };

    // 5. Hand off to the Provider_Manager, which transmits only to the user's
    //    chosen provider (R7.4) and decrypts that provider's key just-in-time.
    return this.providerManager.send(provider, finalPayload);
  }

  async transcribe(intent: EgressSttIntent): Promise<EgressTranscript> {
    const { provider, audio, translateToEnglish } = intent;
    const operation: EgressOperationKind = 'stt-transcribe';

    // 1. Label the network operation BEFORE the call runs (R7.3). Audio is
    //    about to leave the device for the chosen STT provider — unless that
    //    provider is a keyless Local Provider, in which case the call is local
    //    on-device with no third-party egress (R7.6).
    const thirdParty = this.isThirdParty(provider);
    this.notifyLabel({
      operation,
      provider,
      thirdParty,
      description: describeOperation(operation, provider, thirdParty),
    });

    // 2. Transmit the audio to the user's chosen provider only (R7.4) and get
    //    the transcript back. The audio is the minimal payload (R7.2); the gate
    //    holds no Memory Store access, so nothing else can be sent (R7.1). The
    //    translate-to-English preference (R26.5) is forwarded to the STT client.
    const transcript: Transcript = await this.providerManager.transcribe(provider, audio, {
      translateToEnglish,
    });
    const text = transcript.text;

    // Local on-device STT provider (R7.6): no third-party egress, so skip the
    // transcript PII screening entirely and release it as-is (user-confirmed
    // design). Cloud providers still go through the screening below.
    if (!thirdParty) {
      return { text, redactedCategories: [] };
    }

    // 3. PII pre-screen the *resulting* transcript before it is fed onward into
    //    any coaching / skill-map / CV path (R26.2 → R6.1). Audio itself cannot
    //    be screened by the text-based scanner, so the transcript is the first
    //    screenable text. Fail closed if screening cannot complete.
    let detections: Detection[];
    try {
      detections = this.scanner.scan(text);
    } catch (cause) {
      throw new EgressScreeningError(provider, cause);
    }

    // 4. High-risk values present → notify categories + offer redact-and-proceed
    //    (R6.3). Declining means the transcript is NOT released for further
    //    processing (fail closed). Categories only are surfaced — never the
    //    secret values (R6.5).
    let categories: DetectionCategory[] = [];
    if (detections.length > 0) {
      categories = distinctCategories(detections);
      let proceed: boolean;
      try {
        proceed = await this.confirmRedactAndProceed({
          provider,
          operation,
          categories,
          detectionCount: detections.length,
        });
      } catch (cause) {
        // A rejected/failed confirmation is treated as a decline: fail closed.
        throw new EgressDeclinedError(provider, categories);
      }
      if (!proceed) {
        throw new EgressDeclinedError(provider, categories);
      }
    }

    // 5. Build the minimised, redacted transcript (R6.4). With no detections
    //    `redact` returns the minimised pass-through form; with detections every
    //    detected high-risk value is removed. The screened transcript is what
    //    surfaces to the user for confirmation/correction (R26.3).
    const payload: RedactedPayload = this.scanner.redact(text, detections);
    return { text: payload.text, redactedCategories: categories };
  }

  async requestIngestion(intent: EgressIngestionIntent): Promise<ProviderResponse> {
    const { provider, content, detections, decision } = intent;
    const operation: EgressOperationKind = intent.operation ?? 'llm-chat';

    // 0. Gate FIRST, before any side effect: refuse to build or transmit any
    //    payload until the user has confirmed a send-control decision for this
    //    file (R57.1, R57.10). Fail closed — nothing is labelled or sent.
    if (!decision || decision.confirmed !== true) {
      throw new EgressSendControlNotConfirmedError(provider);
    }

    // 1. Label the network operation BEFORE the call runs (R7.3). A keyless Local
    //    Provider is a local on-device call with no third-party egress (R7.6); a
    //    keyed cloud provider is third-party.
    const thirdParty = this.isThirdParty(provider);
    this.notifyLabel({
      operation,
      provider,
      thirdParty,
      description: describeOperation(operation, provider, thirdParty),
    });

    // 2. Compose the payload honouring the per-file/per-detection choice (R57.3,
    //    R57.4). whole-file → full content; per-detection → retain exactly the
    //    allowed detection values, remove every redacted one. Composition uses the
    //    PII_Scanner's redact, so no detected secret survives verbatim (R6.5).
    //    Fail closed if composition cannot complete.
    let composed: RedactedPayload;
    try {
      composed = composeSendControlPayload({
        scanner: this.scanner,
        content,
        detections,
        decision,
      });
    } catch (cause) {
      throw new EgressScreeningError(provider, cause);
    }
    const payload: RedactedPayload =
      intent.noTraining === undefined
        ? composed
        : { ...composed, noTraining: intent.noTraining };

    // 3. Hand off to the Provider_Manager, which transmits only to the user's
    //    chosen provider (R7.4) and decrypts that provider's key just-in-time.
    return this.providerManager.send(provider, payload);
  }
}

/** Convenience factory mirroring the adapters' DI-friendly `create*` style. */
export function createEgressGate(options: EgressGateOptions): EgressGate {
  return new DefaultEgressGate(options);
}
