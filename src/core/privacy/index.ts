// @core/privacy — the privacy statement, informed-consent gating, third-party
// network-operation labels, and clarify-on-ambiguity guard (R1.3, R1.4, R7.3,
// R42.1, R42.2, R42.3).
//
// This module is framework-agnostic: it owns the data models and decision logic
// the UI renders, never any prose (all user-facing strings are externalised via
// `@core/locale`, R41.8). Consumers import from a single stable path:
//
//   import {
//     PRIVACY_STATEMENT_DECLARATIONS,
//     defaultConsentState, mayUseForTraining,
//     createNetworkLabelChannel,
//     clarifyOrResolve,
//   } from '@core/privacy';

export {
  PRIVACY_STATEMENT_HEADING_KEY,
  PRIVACY_STATEMENT_DECLARATIONS,
  privacyDeclarations,
} from './privacy-statement';
export type { PrivacyDeclaration, PrivacyDeclarationId } from './privacy-statement';

export {
  DEFAULT_CONSENT_STATE,
  defaultConsentState,
  mayUseForTraining,
  grantTrainingConsent,
  revokeTrainingConsent,
  hasDecided,
} from './consent';
export type { ConsentState } from './consent';

export {
  CONSENT_PATH,
  CONSENT_HEADING,
  serializeConsentState,
  parseConsentState,
  saveConsentState,
  loadConsentState,
} from './consent-document';
export type { ConsentWriter, ConsentReader } from './consent-document';

export { createNetworkLabelChannel } from './network-labels';
export type {
  NetworkLabelChannel,
  NetworkLabelListener,
  Unsubscribe,
} from './network-labels';

export {
  CLARIFICATION_MESSAGE_KEYS,
  buildClarificationRequest,
  clarifyOrResolve,
  needsClarification,
} from './clarification';
export type {
  ClarificationReason,
  ClarificationRequest,
  ClarificationOutcome,
} from './clarification';
