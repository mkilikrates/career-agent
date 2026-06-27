// SendControlStore — browser-local persistence of per-file send choices (R57.9).
//
// During ingestion the user makes a per-file `SendControlDecision` before any
// staged file's content is sent to a provider (Requirement 57). Those choices are
// persisted here, keyed by a stable file fingerprint, so the same decision is
// reapplied when the same file is re-staged and the user is never asked twice for
// an unchanged file (R57.9).
//
// Privacy boundary (critical): this store records the user's SEND CHOICES ONLY —
// the send mode, the set of allowed detection ids, and the confirmed flag. It
// NEVER stores the staged file content or any detected secret value. It therefore
// lives in browser-local storage (like the Local Provider config), is NEVER part
// of the Memory Store, and never reaches a provider. The `SendControlDecision`
// shape itself carries no secret values (only detection ids), so persisting it
// cannot leak content.
//
// This mirrors the `local-config` adapter's browser-local storage pattern: a
// single JSON-encoded record under one storage key, guarded so it degrades to a
// no-op when `localStorage` is unavailable (tests / SSR).

import type { SendControlDecision } from '@core/egress';
import {
  asDetectionId,
  asFileFingerprint,
  asFileId,
  type FileFingerprint,
} from '@core/types';

/**
 * The persisted store: a map from a stable {@link FileFingerprint} to the user's
 * confirmed {@link SendControlDecision} for that file (R57.9). It holds choices
 * only — never file content or secret values.
 */
export type SendControlStore = Record<FileFingerprint, SendControlDecision>;

const STORAGE_KEY = 'career-agent.send-control';

/** Resolve a browser-local storage backend, if available (guarded for tests/SSR). */
const storage = (): Storage | null => {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
};

/**
 * Compute a stable fingerprint of a staged file's identity + content (R57.9).
 *
 * The fingerprint keys the persisted decision so re-staging the same file (same
 * name + same content) reproduces the same key and reapplies the saved choice. It
 * is a one-way hash: it records identity only and cannot be reversed to the
 * content. A name-qualified FNV-1a hash over the content keeps this synchronous
 * (no `crypto.subtle` async) and deterministic.
 */
export function computeFileFingerprint(name: string, content: string): FileFingerprint {
  const hash = (input: string): string => {
    // FNV-1a (32-bit), rendered as zero-padded hex. Deterministic and stable.
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      // h *= 16777619 with 32-bit overflow via Math.imul.
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  // Qualify by name and content length so distinct files are unlikely to collide,
  // while the same file (re-staged) yields an identical fingerprint.
  const fp = `${hash(name)}-${content.length.toString(16)}-${hash(content)}`;
  return asFileFingerprint(fp);
}

/** Normalise an unknown parsed value into a valid {@link SendControlDecision}, or drop it. */
function reviveDecision(value: unknown): SendControlDecision | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const mode = v.mode;
  if (mode !== 'whole-file' && mode !== 'per-detection') return null;
  if (typeof v.fileId !== 'string') return null;
  if (typeof v.confirmed !== 'boolean') return null;
  const ids = Array.isArray(v.allowedDetectionIds) ? v.allowedDetectionIds : [];
  return {
    fileId: asFileId(v.fileId),
    mode,
    allowedDetectionIds: ids.filter((x): x is string => typeof x === 'string').map(asDetectionId),
    confirmed: v.confirmed,
  };
}

/** Read the full persisted store (empty when none / unavailable / corrupt). */
export function getAllDecisions(): SendControlStore {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: SendControlStore = {};
    for (const [key, value] of Object.entries(parsed)) {
      const decision = reviveDecision(value);
      if (decision) out[asFileFingerprint(key)] = decision;
    }
    return out;
  } catch {
    return {};
  }
}

/** Read the persisted decision for a file fingerprint, if any (R57.9). */
export function getDecision(fingerprint: FileFingerprint): SendControlDecision | undefined {
  return getAllDecisions()[fingerprint];
}

/**
 * Persist the user's send choice for a file fingerprint (R57.9). Stores the
 * decision shape only (mode, allowed detection ids, confirmed) — never file
 * content or secret values. Degrades to a no-op when storage is unavailable.
 */
export function setDecision(
  fingerprint: FileFingerprint,
  decision: SendControlDecision,
): SendControlStore {
  const next = { ...getAllDecisions(), [fingerprint]: decision };
  storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

/** Remove the persisted decision for a file fingerprint. */
export function removeDecision(fingerprint: FileFingerprint): SendControlStore {
  const all = getAllDecisions();
  if (!(fingerprint in all)) return all;
  const { [fingerprint]: _removed, ...rest } = all;
  storage()?.setItem(STORAGE_KEY, JSON.stringify(rest));
  return rest;
}

/** Clear every persisted send choice. */
export function clearDecisions(): void {
  storage()?.removeItem(STORAGE_KEY);
}
