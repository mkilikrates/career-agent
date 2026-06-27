// Unit tests for the Granular Ingestion Send-Control models and helpers (R57).
//
// These cover the destination-scoped defaults, the per-file panel model
// (including the no-detections notice), and payload composition for both
// whole-file and per-detection modes, using the real DefaultPiiScanner so the
// redaction/minimisation matches the live egress path.

import { describe, expect, it } from 'vitest';

import {
  buildSendControlPanelModel,
  composeSendControlPayload,
  defaultSendControlDecision,
  detectionIdFor,
  toSensitiveDetections,
  type SendControlDecision,
} from './send-control';
import { DefaultPiiScanner } from '@adapters/pii';
import { asFileId } from '@core/types';

const scanner = new DefaultPiiScanner();
const FILE = asFileId('cv.md');

describe('defaultSendControlDecision — destination scoping (R57.5, R57.6)', () => {
  it('defaults a keyed cloud destination to per-detection with an empty allow set (R57.6)', () => {
    const d = defaultSendControlDecision(FILE, 'keyed-cloud');
    expect(d.mode).toBe('per-detection');
    expect(d.allowedDetectionIds).toEqual([]);
    expect(d.confirmed).toBe(false);
  });

  it('defaults a keyless local destination to whole-file (R57.5)', () => {
    const d = defaultSendControlDecision(FILE, 'keyless-local');
    expect(d.mode).toBe('whole-file');
    expect(d.confirmed).toBe(false);
  });
});

describe('buildSendControlPanelModel (R57.2, R57.8, R57.9)', () => {
  it('flags the no-detections notice when the file is clean (R57.8)', () => {
    const model = buildSendControlPanelModel({
      fileId: FILE,
      detections: [],
      destinationKind: 'keyed-cloud',
    });
    expect(model.noDetectionsNotice).toBe(true);
    // The whole-file option is still offered via the default decision.
    expect(model.defaultDecision.mode).toBe('per-detection');
  });

  it('presents detections individually and reapplies a persisted decision (R57.2, R57.9)', () => {
    const detections = toSensitiveDetections(scanner.scan('SSN 123-45-6789 here'));
    expect(detections.length).toBeGreaterThan(0);
    const existing: SendControlDecision = {
      fileId: FILE,
      mode: 'per-detection',
      allowedDetectionIds: [detections[0].id],
      confirmed: true,
    };
    const model = buildSendControlPanelModel({
      fileId: FILE,
      detections,
      destinationKind: 'keyed-cloud',
      existingDecision: existing,
    });
    expect(model.noDetectionsNotice).toBe(false);
    expect(model.defaultDecision).toBe(existing);
  });
});

describe('detectionIdFor — stable across re-scans (R57.9)', () => {
  it('produces an identical id for the same category + span', () => {
    const text = 'card 4242 4242 4242 4242';
    const a = toSensitiveDetections(scanner.scan(text));
    const b = toSensitiveDetections(scanner.scan(text));
    expect(a.map((d) => d.id)).toEqual(b.map((d) => d.id));
    expect(detectionIdFor(a[0])).toBe(a[0].id);
  });
});

describe('composeSendControlPayload (R57.3, R57.4, R57.6, R57.7)', () => {
  const secret = 'sk-supersecrettoken1234567890';
  const content = `intro ${secret} and SSN 123-45-6789 end`;
  const detections = toSensitiveDetections(scanner.scan(content));

  it('whole-file builds the payload from the full content (R57.3)', () => {
    const decision: SendControlDecision = {
      fileId: FILE,
      mode: 'whole-file',
      allowedDetectionIds: [],
      confirmed: true,
    };
    const payload = composeSendControlPayload({ scanner, content, detections, decision });
    expect(payload.text).toBe(content);
    expect(payload.text).toContain(secret);
  });

  it('per-detection with an empty allow set redacts every detection (cloud default, R57.6)', () => {
    const decision: SendControlDecision = {
      fileId: FILE,
      mode: 'per-detection',
      allowedDetectionIds: [],
      confirmed: true,
    };
    const payload = composeSendControlPayload({ scanner, content, detections, decision });
    expect(payload.text).not.toContain(secret);
    expect(payload.text).not.toContain('123-45-6789');
  });

  it('per-detection retains exactly the allowed detection and removes the rest (R57.4, R57.7)', () => {
    const apiKeyDetection = detections.find((d) => d.category === 'api_key_or_token');
    expect(apiKeyDetection).toBeDefined();
    const decision: SendControlDecision = {
      fileId: FILE,
      mode: 'per-detection',
      allowedDetectionIds: [apiKeyDetection!.id],
      confirmed: true,
    };
    const payload = composeSendControlPayload({ scanner, content, detections, decision });
    // The opted-in API key value is retained...
    expect(payload.text).toContain(secret);
    // ...while the non-allowed SSN is removed.
    expect(payload.text).not.toContain('123-45-6789');
  });
});
