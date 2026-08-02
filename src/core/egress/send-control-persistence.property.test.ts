// Feature: career-agent, Property 21: Send-control decision persistence round trip
//
// For any SendControlDecision, persisting the decision and then re-staging the
// same file reproduces an identical decision (same mode and same allowed-
// detection set), so the user's per-file and per-detection choices are reapplied
// without change.
//
// **Validates: Requirements 57.9**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { asDetectionId, asFileFingerprint, asFileId, type DetectionId, type FileFingerprint } from '@core/types';
import type { SendControlDecision } from './send-control';
import {
  setDecision,
  getDecision,
  removeDecision,
} from '@adapters/send-control-store';

// ---------------------------------------------------------------------------
// In-memory localStorage mock
// ---------------------------------------------------------------------------

let store: Record<string, string> = {};

const mockStorage: Storage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { store = {}; },
  get length() { return Object.keys(store).length; },
  key: (index: number) => Object.keys(store)[index] ?? null,
};

// Patch globalThis for the store module
beforeEach(() => {
  store = {};
  (globalThis as unknown as Record<string, unknown>).localStorage = mockStorage;
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).localStorage;
});

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const arbFingerprint: fc.Arbitrary<FileFingerprint> = fc
  .stringMatching(/^[a-f0-9]{16,32}$/)
  .map((s) => asFileFingerprint(s));

const arbDetectionIds: fc.Arbitrary<DetectionId[]> = fc
  .array(
    fc.tuple(
      fc.constantFrom('ssn', 'credit_card', 'api_key_or_token'),
      fc.integer({ min: 0, max: 200 }),
      fc.integer({ min: 5, max: 220 }),
    ).map(([cat, start, end]) => asDetectionId(`${cat}-${start}-${end}`)),
    { minLength: 0, maxLength: 5 },
  );

const arbDecision: fc.Arbitrary<SendControlDecision> = fc
  .tuple(
    fc.constantFrom('whole-file', 'per-detection') as fc.Arbitrary<'whole-file' | 'per-detection'>,
    arbDetectionIds,
  )
  .map(([mode, allowed]) => ({
    fileId: asFileId('staged.md'),
    mode,
    allowedDetectionIds: mode === 'per-detection' ? allowed : [],
    confirmed: true,
  }));

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('@core/egress — Property 21: Send-control decision persistence round trip', () => {
  it('persisting and retrieving a decision yields an identical decision (R57.9)', () => {
    fc.assert(
      fc.property(arbFingerprint, arbDecision, (fingerprint, decision) => {
        setDecision(fingerprint, decision);
        const retrieved = getDecision(fingerprint);

        expect(retrieved).toBeDefined();
        expect(retrieved!.mode).toBe(decision.mode);
        expect(retrieved!.confirmed).toBe(decision.confirmed);
        expect([...retrieved!.allowedDetectionIds].sort()).toEqual(
          [...decision.allowedDetectionIds].sort(),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('a removed decision no longer resolves (R57.9)', () => {
    fc.assert(
      fc.property(arbFingerprint, arbDecision, (fingerprint, decision) => {
        setDecision(fingerprint, decision);
        removeDecision(fingerprint);
        const retrieved = getDecision(fingerprint);
        expect(retrieved).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it('multiple decisions for different fingerprints are independent', () => {
    fc.assert(
      fc.property(
        arbFingerprint,
        arbFingerprint,
        arbDecision,
        arbDecision,
        (fp1, fp2, d1, d2) => {
          if (fp1 === fp2) return;
          setDecision(fp1, d1);
          setDecision(fp2, d2);

          const r1 = getDecision(fp1);
          const r2 = getDecision(fp2);

          expect(r1!.mode).toBe(d1.mode);
          expect(r2!.mode).toBe(d2.mode);
        },
      ),
      { numRuns: 100 },
    );
  });
});
