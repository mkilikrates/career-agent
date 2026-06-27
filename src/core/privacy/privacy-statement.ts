// Privacy statement model (R1.3, R1.4, R42.1).
//
// Requirement 1.4: "THE Career_Agent SHALL present a privacy statement
// declaring that user files remain on the device AND that the application is
// not fully offline because it sends a Redacted Payload to user-chosen external
// providers." Requirement 1.3 frames the same boundary (the app works offline
// except for explicitly user-initiated provider calls), and Requirement 42.1
// adds that user data is excluded from any model training/improvement use
// without explicit, informed consent.
//
// This module owns the STRUCTURE of that statement — the ordered set of
// declarations it must contain — while the actual prose lives in the
// externalised locale resources keyed below, so there are no hardcoded
// user-facing strings (R41.8). The UI renders each declaration by resolving its
// `i18nKey`. Keeping the structure in @core means the required declarations are
// verifiable in a framework-agnostic test (one per mandated clause).

/** Identifies each mandated clause of the privacy statement (R1.4, R1.5, R42.1). */
export type PrivacyDeclarationId =
  /** User files remain on the device (R1.3, R1.4, R1.5). */
  | 'filesOnDevice'
  /** Not fully offline: a Redacted Payload goes to user-chosen providers (R1.4). */
  | 'notFullyOffline'
  /**
   * Fully offline: every selected provider is a Local Provider, so NO Redacted
   * Payload leaves the device and the app is fully offline (R1.5, R43.5).
   */
  | 'fullyOffline'
  /** Data excluded from training/improvement without explicit consent (R42.1). */
  | 'trainingExclusion';

/**
 * A single declaration of the privacy statement: its stable id plus the i18n
 * key whose externalised string the UI renders (R41.8). No prose lives here.
 */
export interface PrivacyDeclaration {
  readonly id: PrivacyDeclarationId;
  /** i18n key resolved + rendered by the UI (R41.8). */
  readonly i18nKey: string;
}

/** i18n key for the privacy statement heading (R41.8). */
export const PRIVACY_STATEMENT_HEADING_KEY = 'privacy.statement.heading';

/**
 * The ordered declarations the privacy statement MUST present when a cloud
 * provider is in use (R1.4, R42.1) — the cloud/default set. Each maps to an
 * externalised locale string. The set is frozen so callers cannot mutate the
 * mandated structure.
 *
 * For the all-local variant (R1.5), call {@link privacyDeclarations} with
 * `allLocal = true`, which swaps the "not fully offline" clause for the
 * "fully offline" one.
 */
export const PRIVACY_STATEMENT_DECLARATIONS: readonly PrivacyDeclaration[] = Object.freeze([
  Object.freeze({ id: 'filesOnDevice', i18nKey: 'privacy.statement.filesOnDevice' }),
  Object.freeze({ id: 'notFullyOffline', i18nKey: 'privacy.statement.notFullyOffline' }),
  Object.freeze({ id: 'trainingExclusion', i18nKey: 'privacy.statement.trainingExclusion' }),
]);

/** The "fully offline" declaration presented when every provider is local (R1.5). */
const FULLY_OFFLINE_DECLARATION: PrivacyDeclaration = Object.freeze({
  id: 'fullyOffline',
  i18nKey: 'privacy.statement.fullyOffline',
});

/**
 * Select the ordered declarations the privacy statement must present given
 * whether every selected provider is a Local Provider (R1.4, R1.5, R42.1).
 *
 * Both variants keep the same outer structure — files stay on the device first,
 * the offline-boundary clause second, and the training-exclusion clause last —
 * differing only in the middle clause:
 *   - `allLocal = false` (a cloud provider is selected): declares the app is NOT
 *     fully offline because a Redacted Payload is sent to a chosen provider
 *     (R1.4);
 *   - `allLocal = true` (every selected provider is local): declares that NO
 *     Redacted Payload leaves the device and the app is fully offline (R1.5,
 *     R43.5).
 */
export function privacyDeclarations(allLocal: boolean): readonly PrivacyDeclaration[] {
  return Object.freeze([
    PRIVACY_STATEMENT_DECLARATIONS[0], // filesOnDevice
    allLocal ? FULLY_OFFLINE_DECLARATION : PRIVACY_STATEMENT_DECLARATIONS[1],
    PRIVACY_STATEMENT_DECLARATIONS[2], // trainingExclusion
  ]);
}
