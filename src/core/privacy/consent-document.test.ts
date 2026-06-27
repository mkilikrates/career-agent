// Unit tests for consent persistence (@core/privacy).
//
// Verify the `config/consent.md` round trip (R34.2) and the fail-safe parsing
// posture (R42.1): anything but an explicit grant loads as NOT consented.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MemoryTree } from '@core/storage';
import { asISODate } from '@core/types';
import { grantTrainingConsent, revokeTrainingConsent, type ConsentState } from './consent';
import {
  CONSENT_PATH,
  loadConsentState,
  parseConsentState,
  saveConsentState,
  serializeConsentState,
} from './consent-document';

describe('consent serialization round trip (R34.2)', () => {
  it('recovers a granted state', () => {
    const state = grantTrainingConsent(asISODate('2024-06-01T00:00:00.000Z'));
    expect(parseConsentState(serializeConsentState(state))).toEqual(state);
  });

  it('recovers a revoked state', () => {
    const state = revokeTrainingConsent(asISODate('2024-06-02T00:00:00.000Z'));
    expect(parseConsentState(serializeConsentState(state))).toEqual(state);
  });

  it('round-trips for any decision (property)', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(fc.date({ min: new Date('2000-01-01'), max: new Date('2100-01-01') }), {
          nil: undefined,
        }),
        (trainingUse, when) => {
          const state: ConsentState =
            when === undefined
              ? { trainingUse }
              : { trainingUse, decidedAt: asISODate(when.toISOString()) };
          expect(parseConsentState(serializeConsentState(state))).toEqual(state);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('fail-safe parsing (R42.1)', () => {
  it('parses an empty document as NOT consented', () => {
    expect(parseConsentState('')).toEqual({ trainingUse: false });
  });

  it('never enables training use from a non-true value', () => {
    const sneaky = '---\ntrainingUse: "true"\n---\n';
    expect(parseConsentState(sneaky).trainingUse).toBe(false);
  });
});

describe('persistence via MemoryTree (R42.1)', () => {
  it('loads NOT consented when nothing is stored', () => {
    const store = new MemoryTree();
    expect(loadConsentState(store).trainingUse).toBe(false);
    expect(store.has(CONSENT_PATH)).toBe(false);
  });

  it('saves and reloads an explicit grant', async () => {
    const store = new MemoryTree();
    const state = grantTrainingConsent(asISODate('2024-07-01T00:00:00.000Z'));
    const path = await saveConsentState(store, state);
    expect(path).toBe(CONSENT_PATH);
    expect(loadConsentState(store)).toEqual(state);
  });
});
