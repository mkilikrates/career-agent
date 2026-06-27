// Informed-consent model and gating for model training / improvement use
// (R42.1).
//
// Requirement 42.1: "THE Career_Agent SHALL exclude user data from any model
// training or improvement use without explicit informed consent." This module
// is the framework-agnostic source of truth for that gate. Two invariants are
// encoded directly in the helpers below:
//
//   1. The default state is NOT consented — {@link DEFAULT_CONSENT_STATE} has
//      `trainingUse: false`. A profile that has never made a decision is always
//      treated as withholding consent, so user data is excluded by default.
//   2. Training/improvement use is permitted ONLY when an explicit, informed
//      consent decision has set `trainingUse` to `true` — see
//      {@link mayUseForTraining}. Any other state (default, revoked, or an
//      unparseable persisted value) excludes the data.
//
// The state is deliberately tiny and serialisable so it round-trips through the
// Memory Store (`config/consent.md`, see ./consent-document) like every other
// piece of canonical state (R34.1, R34.2).

import type { ISODate } from '@core/types';

/**
 * The user's recorded consent decision for model training / improvement use
 * (R42.1). Defaults to NOT consented; see {@link DEFAULT_CONSENT_STATE}.
 */
export interface ConsentState {
  /**
   * Whether the user has given explicit, informed consent to use their data for
   * model training or improvement. `false` (the default) means the data is
   * EXCLUDED from any such use (R42.1).
   */
  readonly trainingUse: boolean;
  /**
   * When the user last made an explicit decision (granted or revoked), if ever.
   * Absent on the default, never-decided state so callers can distinguish a
   * deliberate "no" from a first-use default.
   */
  readonly decidedAt?: ISODate;
}

/**
 * The canonical default: user data is EXCLUDED from training/improvement until
 * the user explicitly opts in (R42.1). Frozen so it can be shared safely.
 */
export const DEFAULT_CONSENT_STATE: ConsentState = Object.freeze({ trainingUse: false });

/** A fresh, never-decided consent state (alias of {@link DEFAULT_CONSENT_STATE}). */
export const defaultConsentState = (): ConsentState => DEFAULT_CONSENT_STATE;

/**
 * The gate (R42.1): may the user's data be used for model training/improvement?
 * Returns `true` ONLY when explicit consent has been recorded (`trainingUse`
 * strictly equals `true`). Every other state — default, revoked, or a
 * malformed/partial object — returns `false`, so the data is excluded by
 * default and the gate fails safe.
 */
export const mayUseForTraining = (state: ConsentState | undefined | null): boolean =>
  state?.trainingUse === true;

/**
 * Record an explicit grant of training/improvement consent (R42.1). Produces a
 * new state (the inputs are never mutated) stamped with the decision time.
 */
export const grantTrainingConsent = (at: ISODate): ConsentState => ({
  trainingUse: true,
  decidedAt: at,
});

/**
 * Record an explicit withdrawal of consent (R42.1). Produces a new state with
 * `trainingUse: false`, stamped with the decision time, so a deliberate "no" is
 * distinguishable from the never-decided default.
 */
export const revokeTrainingConsent = (at: ISODate): ConsentState => ({
  trainingUse: false,
  decidedAt: at,
});

/** Whether the user has ever made an explicit consent decision (grant or revoke). */
export const hasDecided = (state: ConsentState | undefined | null): boolean =>
  state?.decidedAt !== undefined;
