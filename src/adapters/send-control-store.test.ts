// Unit tests for the browser-local SendControlStore (R57.9).
//
// These verify the fingerprint stability, the persist/reapply round trip, and
// the privacy boundary (the store records send choices only — no content or
// secret values). A minimal in-memory localStorage stub stands in for the
// browser backend.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearDecisions,
  computeFileFingerprint,
  getAllDecisions,
  getDecision,
  removeDecision,
  setDecision,
} from './send-control-store';
import { asDetectionId, asFileId } from '@core/types';
import type { SendControlDecision } from '@core/egress';

/** A throwaway in-memory localStorage compatible enough for the store. */
class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  key(i: number) {
    return Array.from(this.map.keys())[i] ?? null;
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage;
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

const FILE = asFileId('cv.md');

const decision = (over: Partial<SendControlDecision> = {}): SendControlDecision => ({
  fileId: FILE,
  mode: 'per-detection',
  allowedDetectionIds: [asDetectionId('api_key_or_token-6-35')],
  confirmed: true,
  ...over,
});

describe('computeFileFingerprint (R57.9)', () => {
  it('is stable for the same name + content', () => {
    const a = computeFileFingerprint('cv.md', 'hello world');
    const b = computeFileFingerprint('cv.md', 'hello world');
    expect(a).toBe(b);
  });

  it('differs when the content differs', () => {
    const a = computeFileFingerprint('cv.md', 'hello world');
    const b = computeFileFingerprint('cv.md', 'hello WORLD');
    expect(a).not.toBe(b);
  });

  it('differs when the file name differs', () => {
    const a = computeFileFingerprint('cv.md', 'hello world');
    const b = computeFileFingerprint('other.md', 'hello world');
    expect(a).not.toBe(b);
  });
});

describe('persist + reapply round trip (R57.9)', () => {
  it('reproduces an identical decision (same mode + allowed set) on re-stage', () => {
    const fp = computeFileFingerprint('cv.md', 'contents');
    const d = decision();
    setDecision(fp, d);
    const reloaded = getDecision(fp);
    expect(reloaded).toBeDefined();
    expect(reloaded!.mode).toBe(d.mode);
    expect(reloaded!.allowedDetectionIds).toEqual(d.allowedDetectionIds);
    expect(reloaded!.confirmed).toBe(true);
    expect(reloaded!.fileId).toBe(d.fileId);
  });

  it('keeps decisions for distinct files independent', () => {
    const fp1 = computeFileFingerprint('a.md', 'one');
    const fp2 = computeFileFingerprint('b.md', 'two');
    setDecision(fp1, decision({ mode: 'whole-file', allowedDetectionIds: [] }));
    setDecision(fp2, decision({ mode: 'per-detection' }));
    expect(getDecision(fp1)!.mode).toBe('whole-file');
    expect(getDecision(fp2)!.mode).toBe('per-detection');
    expect(Object.keys(getAllDecisions())).toHaveLength(2);
  });

  it('removeDecision and clearDecisions drop persisted choices', () => {
    const fp = computeFileFingerprint('cv.md', 'contents');
    setDecision(fp, decision());
    removeDecision(fp);
    expect(getDecision(fp)).toBeUndefined();

    setDecision(fp, decision());
    clearDecisions();
    expect(getAllDecisions()).toEqual({});
  });
});

describe('privacy boundary (R57.9)', () => {
  it('persists choices only — no file content or secret values in storage', () => {
    const fp = computeFileFingerprint('cv.md', 'my secret sk-supersecrettoken1234567890');
    setDecision(fp, decision());
    const raw = (globalThis.localStorage as Storage).getItem('career-agent.send-control') ?? '';
    expect(raw).not.toContain('sk-supersecrettoken1234567890');
    expect(raw).not.toContain('my secret');
  });
});

describe('graceful degradation', () => {
  it('returns empty / no-ops when storage is unavailable', () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    expect(getAllDecisions()).toEqual({});
    const fp = computeFileFingerprint('cv.md', 'x');
    expect(() => setDecision(fp, decision())).not.toThrow();
    expect(getDecision(fp)).toBeUndefined();
  });
});
