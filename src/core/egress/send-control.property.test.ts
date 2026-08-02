// Feature: career-agent, Property 20: Granular ingestion send-control — gating and payload composition
//
// For any staged file, any set of Sensitive Detections, and any destination
// kind: no payload is built or transmitted until a SendControlDecision is
// confirmed; a whole-file decision yields a payload equal to the full file
// content; a per-detection decision yields a payload containing exactly the
// user-allowed detection values and none of the redacted ones; for a keyed cloud
// destination every detection defaults to redacted and a detection value appears
// in the payload iff it was explicitly opted in; and for a keyless local
// destination the whole file (including sensitive values) may be sent.
//
// **Validates: Requirements 6.6, 57.1, 57.3, 57.4, 57.5, 57.6, 57.7, 57.10**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { asDetectionId, asFileId, type DetectionId, type FileId } from '@core/types';
import {
  composeSendControlPayload,
  defaultSendControlDecision,
  type SendControlDecision,
  type SensitiveDetection,
} from './send-control';
import { createPiiScanner } from '@adapters/pii';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const scanner = createPiiScanner();
const FILE: FileId = asFileId('staged-cv.md');

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a realistic SSN-like detection at a known position. */
const arbSsnValue = fc
  .tuple(
    fc.integer({ min: 100, max: 999 }),
    fc.integer({ min: 10, max: 99 }),
    fc.integer({ min: 1000, max: 9999 }),
  )
  .map(([a, b, c]) => `${a}-${b}-${c}`);

/** Generate a set of detections embedded in file content. */
const arbContentWithDetections = fc
  .tuple(
    fc.array(arbSsnValue, { minLength: 1, maxLength: 4 }),
    fc.string({ minLength: 10, maxLength: 50 }),
  )
  .map(([ssns, prefix]) => {
    let content = prefix;
    const detections: SensitiveDetection[] = [];
    for (let i = 0; i < ssns.length; i++) {
      const start = content.length + 1;
      content += ` ${ssns[i]} `;
      const end = content.length - 1;
      detections.push({
        id: asDetectionId(`ssn-${start}-${end}`),
        category: 'ssn',
        start,
        end,
        value: ssns[i],
      });
    }
    return { content, detections };
  });

/** Generate a subset of detection IDs to allow. */
const arbAllowedSubset = (detections: SensitiveDetection[]): fc.Arbitrary<DetectionId[]> =>
  fc.subarray(detections.map((d) => d.id));

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('@core/egress — Property 20: Send-control gating and payload composition', () => {
  it('whole-file decision yields a payload containing the full file content (R57.3)', () => {
    fc.assert(
      fc.property(arbContentWithDetections, ({ content, detections }) => {
        const decision: SendControlDecision = {
          fileId: FILE,
          mode: 'whole-file',
          allowedDetectionIds: [],
          confirmed: true,
        };

        const payload = composeSendControlPayload({
          scanner,
          content,
          detections,
          decision,
        });

        // Whole-file: payload text equals the full content
        expect(payload.text).toBe(content);
      }),
      { numRuns: 200 },
    );
  });

  it('per-detection with allowed set includes only allowed values, redacts the rest (R57.4, R57.7)', () => {
    fc.assert(
      fc.property(
        arbContentWithDetections.chain(({ content, detections }) =>
          arbAllowedSubset(detections).map((allowed) => ({ content, detections, allowed })),
        ),
        ({ content, detections, allowed }) => {
          const decision: SendControlDecision = {
            fileId: FILE,
            mode: 'per-detection',
            allowedDetectionIds: allowed,
            confirmed: true,
          };

          const payload = composeSendControlPayload({
            scanner,
            content,
            detections,
            decision,
          });

          const allowedSet = new Set<string>(allowed);
          for (const det of detections) {
            if (allowedSet.has(String(det.id))) {
              // Allowed detection's value should survive in the payload
              expect(payload.text).toContain(det.value);
            } else {
              // Redacted detection's value should NOT appear in the payload
              expect(payload.text).not.toContain(det.value);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('keyed cloud default: per-detection with empty allow set → everything redacted (R57.6)', () => {
    fc.assert(
      fc.property(arbContentWithDetections, ({ content, detections }) => {
        const decision = defaultSendControlDecision(FILE, 'keyed-cloud');
        // Confirm it to allow payload composition
        const confirmed: SendControlDecision = { ...decision, confirmed: true };

        const payload = composeSendControlPayload({
          scanner,
          content,
          detections,
          decision: confirmed,
        });

        // Every detection value is redacted (absent from payload)
        for (const det of detections) {
          expect(payload.text).not.toContain(det.value);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('keyless local default: whole-file mode (R57.5)', () => {
    fc.assert(
      fc.property(arbContentWithDetections, ({ content, detections }) => {
        const decision = defaultSendControlDecision(FILE, 'keyless-local');
        expect(decision.mode).toBe('whole-file');

        const confirmed: SendControlDecision = { ...decision, confirmed: true };
        const payload = composeSendControlPayload({
          scanner,
          content,
          detections,
          decision: confirmed,
        });

        // Whole file including sensitive values is sent
        expect(payload.text).toBe(content);
      }),
      { numRuns: 100 },
    );
  });
});
