// Unit tests for the clarify-on-ambiguity guard (@core/privacy).
//
// Verify R42.3: incomplete or ambiguous fields produce a clarification request
// and the guard NEVER assumes a value when more than one distinct candidate
// exists.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CLARIFICATION_MESSAGE_KEYS,
  buildClarificationRequest,
  clarifyOrResolve,
  needsClarification,
} from './clarification';

describe('clarifyOrResolve (R42.3)', () => {
  it('resolves a single distinct candidate', () => {
    const outcome = clarifyOrResolve('jobTitle', ['Engineer']);
    expect(outcome).toEqual({ kind: 'resolved', value: 'Engineer' });
  });

  it('collapses repeated agreement to a single resolution', () => {
    const outcome = clarifyOrResolve('jobTitle', ['Engineer', 'Engineer', 'Engineer']);
    expect(outcome).toEqual({ kind: 'resolved', value: 'Engineer' });
  });

  it('requests clarification when incomplete (no candidates)', () => {
    const outcome = clarifyOrResolve('startDate', []);
    expect(outcome.kind).toBe('clarify');
    if (outcome.kind === 'clarify') {
      expect(outcome.request.reason).toBe('incomplete');
      expect(outcome.request.candidates).toEqual([]);
      expect(outcome.request.messageKey).toBe(CLARIFICATION_MESSAGE_KEYS.incomplete);
    }
  });

  it('requests clarification when ambiguous (multiple distinct values)', () => {
    const outcome = clarifyOrResolve('employer', ['Acme', 'Acme Corp']);
    expect(outcome.kind).toBe('clarify');
    if (outcome.kind === 'clarify') {
      expect(outcome.request.reason).toBe('ambiguous');
      expect(outcome.request.candidates).toEqual(['Acme', 'Acme Corp']);
      expect(outcome.request.messageKey).toBe(CLARIFICATION_MESSAGE_KEYS.ambiguous);
    }
  });

  it('never assumes a value among conflicting candidates (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { minLength: 0, maxLength: 8 }), (candidates) => {
        const outcome = clarifyOrResolve('field', candidates);
        const distinctCount = new Set(candidates).size;
        if (distinctCount <= 1) {
          // 0 → clarify(incomplete); 1 → resolved. Never an assumption.
          if (distinctCount === 1) {
            expect(outcome.kind).toBe('resolved');
          } else {
            expect(outcome.kind).toBe('clarify');
          }
        } else {
          // 2+ distinct: must clarify, must NOT pick a value.
          expect(outcome.kind).toBe('clarify');
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('needsClarification (R42.3)', () => {
  it('is false only for exactly one distinct candidate', () => {
    expect(needsClarification(['x'])).toBe(false);
    expect(needsClarification([])).toBe(true);
    expect(needsClarification(['x', 'y'])).toBe(true);
  });
});

describe('buildClarificationRequest', () => {
  it('maps each reason to its i18n key and copies candidates', () => {
    const req = buildClarificationRequest('skill', 'ambiguous', ['a', 'b']);
    expect(req).toEqual({
      field: 'skill',
      reason: 'ambiguous',
      candidates: ['a', 'b'],
      messageKey: 'privacy.clarification.ambiguous',
    });
  });
});
