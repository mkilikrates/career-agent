// Unit tests for the informed-consent model and gate (@core/privacy).
//
// Exercise the R42.1 invariants: data is excluded from training/improvement use
// by default and is permitted ONLY after an explicit grant.

import { describe, expect, it } from 'vitest';
import { asISODate } from '@core/types';
import {
  DEFAULT_CONSENT_STATE,
  defaultConsentState,
  grantTrainingConsent,
  hasDecided,
  mayUseForTraining,
  revokeTrainingConsent,
  type ConsentState,
} from './consent';

describe('consent default (R42.1)', () => {
  it('defaults to NOT consented', () => {
    expect(DEFAULT_CONSENT_STATE.trainingUse).toBe(false);
    expect(defaultConsentState().trainingUse).toBe(false);
  });

  it('excludes data from training/improvement by default', () => {
    expect(mayUseForTraining(defaultConsentState())).toBe(false);
  });

  it('treats the default as a never-decided state', () => {
    expect(hasDecided(defaultConsentState())).toBe(false);
  });
});

describe('mayUseForTraining gate (R42.1)', () => {
  it('permits use ONLY on explicit boolean-true consent', () => {
    expect(mayUseForTraining({ trainingUse: true })).toBe(true);
    expect(mayUseForTraining({ trainingUse: false })).toBe(false);
  });

  it('fails safe for undefined/null/malformed states', () => {
    expect(mayUseForTraining(undefined)).toBe(false);
    expect(mayUseForTraining(null)).toBe(false);
    // A truthy-but-not-true value must NOT enable training use.
    expect(mayUseForTraining({ trainingUse: 1 as unknown as boolean })).toBe(false);
  });
});

describe('explicit decisions (R42.1)', () => {
  const at = asISODate('2024-05-01T10:00:00.000Z');

  it('grant produces a consented, time-stamped state', () => {
    const state = grantTrainingConsent(at);
    expect(state.trainingUse).toBe(true);
    expect(state.decidedAt).toBe(at);
    expect(mayUseForTraining(state)).toBe(true);
    expect(hasDecided(state)).toBe(true);
  });

  it('revoke produces an excluded, time-stamped state distinct from default', () => {
    const state = revokeTrainingConsent(at);
    expect(state.trainingUse).toBe(false);
    expect(state.decidedAt).toBe(at);
    expect(mayUseForTraining(state)).toBe(false);
    // A deliberate "no" is distinguishable from the never-decided default.
    expect(hasDecided(state)).toBe(true);
  });

  it('does not mutate the shared default when deriving new states', () => {
    grantTrainingConsent(at);
    const after: ConsentState = DEFAULT_CONSENT_STATE;
    expect(after.trainingUse).toBe(false);
    expect(after.decidedAt).toBeUndefined();
  });
});
