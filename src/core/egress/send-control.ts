// Granular Ingestion Send-Control models and payload composition (R57).
//
// For ordinary operations the PII_Scanner's redact-and-proceed (R6.3/R6.4) is a
// whole-payload shortcut. **Ingestion file content** gets a finer-grained model:
// before any staged file's content is sent to an external provider, the user
// makes a per-file `SendControlDecision` (Requirements 6.6, 57). Each Sensitive
// Detection — an individual high-risk PII/secret match the scanner found in that
// file — can be allowed or redacted one at a time, or the user can choose to send
// the whole file.
//
// This module is framework-agnostic core domain logic: pure data shapes plus the
// helpers that derive the per-file panel model and compose the outbound payload
// from a confirmed decision. The Egress Gate (egress-gate.ts) is the single
// chokepoint that consults a decision before transmitting; the browser-local
// SendControlStore (adapters/send-control-store.ts) persists the user's choices.
//
// Requirements: 6.6, 57.1, 57.2, 57.3, 57.4, 57.5, 57.6, 57.7, 57.8, 57.9, 57.10.

import type { Detection, DetectionCategory, PiiScanner } from '@adapters/pii';
import type { RedactedPayload } from '@adapters/provider';
import type { DetectionId, FileId } from '@core/types';
import { asDetectionId } from '@core/types';

/**
 * Where a staged file's content is bound for, which scopes the send-control
 * defaults and affordances:
 *   - `keyed-cloud`  — a keyed cloud (third-party) provider; the payload leaves
 *     the device, so every detection defaults to redacted (R57.6) and is sent
 *     only on explicit per-detection opt-in (R57.7).
 *   - `keyless-local` — a keyless Local Provider on the user's own device; the
 *     payload never leaves the device, so the whole file (including sensitive
 *     values) may be sent (R57.5).
 */
export type DestinationKind = 'keyed-cloud' | 'keyless-local';

/** The two send choices a user can make for a staged file (R57.1). */
export type SendControlMode = 'whole-file' | 'per-detection';

/**
 * A Sensitive Detection (glossary): one individual high-risk PII/secret match the
 * PII_Scanner found within a staged file, presented to the user with its category
 * so it can be allowed or redacted one at a time (R57.2). The matched `value` is
 * carried for payload composition only — it is never echoed into generated output
 * (R6.5) and never persisted by the SendControlStore (R57.9 records choices only).
 */
export interface SensitiveDetection {
  /** Stable id for this detection within the file (stable across re-stages, R57.9). */
  readonly id: DetectionId;
  /** The high-risk category (ssn | nino | credit_card | api_key_or_token) (R6.2). */
  readonly category: DetectionCategory;
  /** Inclusive start index of the match within the file content. */
  readonly start: number;
  /** Exclusive end index of the match within the file content. */
  readonly end: number;
  /** The exact matched value (used only to compose the payload; never persisted). */
  readonly value: string;
}

/**
 * The user's per-file send choice. The Egress Gate refuses to build or transmit
 * any payload for the file until this decision is `confirmed` (R57.1, R57.10).
 *
 * For `per-detection` mode, `allowedDetectionIds` is the set of detection ids the
 * user explicitly ALLOWS (sent in clear). Every detection NOT listed here is
 * redacted. For a keyed cloud destination this set starts EMPTY, so every
 * detection defaults to redacted (R57.6) and appears in the payload only on
 * explicit opt-in (R57.7).
 */
export interface SendControlDecision {
  readonly fileId: FileId;
  /** The chosen send mode (R57.1). */
  readonly mode: SendControlMode;
  /** Detection ids the user explicitly allows in clear (per-detection mode). */
  readonly allowedDetectionIds: readonly DetectionId[];
  /** `false` until the user confirms; the gate refuses to build while `false` (R57.1). */
  readonly confirmed: boolean;
}

/**
 * What the Ingest screen renders for a single staged file (R57.2, R57.8): each
 * Sensitive Detection presented individually, the destination scoping, the
 * scoped default decision, and a flag marking the explicit "no Sensitive
 * Detections were found" notice when the file is clean (R57.8).
 */
export interface SendControlPanelModel {
  readonly fileId: FileId;
  /** Each detection presented individually with its category (R57.2). */
  readonly detections: readonly SensitiveDetection[];
  /** Scopes the defaults and the whole-file affordance. */
  readonly destinationKind: DestinationKind;
  /** The decision the panel starts from — a persisted choice or the scoped default. */
  readonly defaultDecision: SendControlDecision;
  /** `true` when `detections` is empty; the whole-file option is still offered (R57.8). */
  readonly noDetectionsNotice: boolean;
}

/**
 * Mint a stable {@link DetectionId} for a raw scanner {@link Detection}. The id is
 * derived from the category and span so it is identical whenever the same file
 * content is re-scanned, which lets a persisted per-detection choice be reapplied
 * unchanged when the same file is re-staged (R57.9).
 */
export function detectionIdFor(detection: Pick<Detection, 'category' | 'start' | 'end'>): DetectionId {
  return asDetectionId(`${detection.category}-${detection.start}-${detection.end}`);
}

/**
 * Convert raw scanner detections into individually-addressable Sensitive
 * Detections with stable ids (R57.2, R57.9).
 */
export function toSensitiveDetections(
  detections: readonly Detection[],
): SensitiveDetection[] {
  return detections.map((d) => ({
    id: detectionIdFor(d),
    category: d.category,
    start: d.start,
    end: d.end,
    value: d.value,
  }));
}

/**
 * The destination-scoped default decision for a staged file (before the user
 * confirms):
 *   - `keyless-local` → `whole-file`: the payload never leaves the device, so the
 *     whole file (including sensitive values) may be sent (R57.5).
 *   - `keyed-cloud`  → `per-detection` with an EMPTY allow set: every detection
 *     defaults to redacted (R57.6) and is sent only on explicit opt-in (R57.7).
 * In both cases `confirmed` is `false`, so the gate refuses to build until the
 * user confirms a choice (R57.1).
 */
export function defaultSendControlDecision(
  fileId: FileId,
  destinationKind: DestinationKind,
): SendControlDecision {
  return {
    fileId,
    mode: destinationKind === 'keyless-local' ? 'whole-file' : 'per-detection',
    allowedDetectionIds: [],
    confirmed: false,
  };
}

/**
 * Build the per-file {@link SendControlPanelModel} the Ingest screen renders. When
 * a previously-confirmed decision exists for this file it is reapplied as the
 * starting decision (R57.9); otherwise the destination-scoped default is used. The
 * `noDetectionsNotice` flag is set when the file is clean so the whole-file option
 * is still offered with the explicit notice (R57.8).
 */
export function buildSendControlPanelModel(args: {
  readonly fileId: FileId;
  readonly detections: readonly SensitiveDetection[];
  readonly destinationKind: DestinationKind;
  /** A persisted decision to reapply for this file, if any (R57.9). */
  readonly existingDecision?: SendControlDecision;
}): SendControlPanelModel {
  const { fileId, detections, destinationKind, existingDecision } = args;
  const defaultDecision =
    existingDecision ?? defaultSendControlDecision(fileId, destinationKind);
  return {
    fileId,
    detections,
    destinationKind,
    defaultDecision,
    noDetectionsNotice: detections.length === 0,
  };
}

/**
 * Compose the outbound payload from a confirmed {@link SendControlDecision}
 * (R57.3, R57.4):
 *   - `whole-file` → the payload is built from the FULL file content (R57.3).
 *   - `per-detection` → the Redacted Payload retains exactly the user-allowed
 *     detection values and removes every redacted (non-allowed) one (R57.4). For a
 *     keyed cloud destination the allow set starts empty, so an unmodified
 *     per-detection decision redacts everything (R57.6) and a value appears only
 *     when its id was explicitly added to the allow set (R57.7).
 *
 * Redaction reuses the PII_Scanner so the redaction markers and minimisation match
 * the rest of the egress path, and no detected secret survives verbatim (R6.5).
 */
export function composeSendControlPayload(args: {
  readonly scanner: PiiScanner;
  readonly content: string;
  readonly detections: readonly SensitiveDetection[];
  readonly decision: SendControlDecision;
}): RedactedPayload {
  const { scanner, content, detections, decision } = args;
  if (decision.mode === 'whole-file') {
    // Full content (R57.3). Redacting with no spans yields the branded full text.
    return scanner.redact(content, []);
  }
  // per-detection: redact every detection NOT explicitly allowed (R57.4/6/7).
  const allowed = new Set<DetectionId>(decision.allowedDetectionIds);
  const toRedact: Detection[] = detections
    .filter((d) => !allowed.has(d.id))
    .map((d) => ({ category: d.category, start: d.start, end: d.end, value: d.value }));
  return scanner.redact(content, toRedact);
}
