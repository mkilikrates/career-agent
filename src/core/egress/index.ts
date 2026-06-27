// @core/egress — the single Egress Gate chokepoint for outbound provider calls.
//
// Every outbound LLM/STT request flows through the Egress Gate, which labels the
// third-party network operation (R7.3), runs local PII pre-screening (R6.1),
// offers redact-and-proceed on detection (R6.3), builds the minimised Redacted
// Payload (R6.4, R7.2), and hands off to the Provider_Manager for transmission
// to the user's chosen provider only (R7.4) — failing closed if screening
// cannot complete. The gate has no Storage_Adapter access, so Memory Store file
// contents are never transmitted (R7.1).
//
//   import { createEgressGate, DefaultEgressGate } from '@core/egress';

export {
  DefaultEgressGate,
  createEgressGate,
  EgressScreeningError,
  EgressDeclinedError,
  EgressPreviewCancelledError,
  EgressMisconfiguredError,
  EgressSendControlNotConfirmedError,
} from './egress-gate';

export type {
  EgressGate,
  EgressGateOptions,
  EgressIntent,
  EgressSttIntent,
  EgressTranscript,
  EgressIngestionIntent,
  EgressOperationKind,
  NetworkOperationLabel,
  LabelNotifier,
  RedactProposal,
  RedactAndProceedPrompt,
  PayloadPreview,
  PayloadPreviewPrompt,
} from './egress-gate';

export {
  detectionIdFor,
  toSensitiveDetections,
  defaultSendControlDecision,
  buildSendControlPanelModel,
  composeSendControlPayload,
} from './send-control';

export type {
  DestinationKind,
  SendControlMode,
  SensitiveDetection,
  SendControlDecision,
  SendControlPanelModel,
} from './send-control';
