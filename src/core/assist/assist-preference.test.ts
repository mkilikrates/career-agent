// Unit tests for the persisted, pipeline-wide AI-assist preference
// (config/assist_preference.md). Pins the lossless round trip (R34.2) and the
// fail-safe default (a corrupt/absent document never silently enables AI).

import { describe, it, expect } from 'vitest';
import { MemoryTree } from '@core/storage';
import type { AssistMode } from './assist';
import {
  ASSIST_PREFERENCE_PATH,
  DEFAULT_ASSIST_MODE,
  loadAssistMode,
  parseAssistMode,
  saveAssistMode,
  serializeAssistMode,
} from './assist-preference';

const MODES: readonly AssistMode[] = ['script-only', 'ai-assisted', 'ai-only'];

describe('assist-preference — round trip (R34.2)', () => {
  it('recovers every mode through serialise → parse', () => {
    for (const mode of MODES) {
      expect(parseAssistMode(serializeAssistMode(mode))).toBe(mode);
    }
  });
});

describe('assist-preference — fail-safe parsing', () => {
  it('parses an empty document as the script-only default', () => {
    expect(parseAssistMode('')).toBe(DEFAULT_ASSIST_MODE);
    expect(DEFAULT_ASSIST_MODE).toBe('script-only');
  });

  it('falls back to script-only on an unknown mode value', () => {
    expect(parseAssistMode('---\nassistMode: bogus\n---\n')).toBe('script-only');
  });
});

describe('assist-preference — persistence (Memory Store)', () => {
  it('loads the script-only default when nothing is stored', () => {
    const store = new MemoryTree();
    expect(loadAssistMode(store)).toBe('script-only');
    expect(store.has(ASSIST_PREFERENCE_PATH)).toBe(false);
  });

  it('persists and reloads a chosen mode', async () => {
    const store = new MemoryTree();
    const path = await saveAssistMode(store, 'ai-only');
    expect(path).toBe(ASSIST_PREFERENCE_PATH);
    expect(loadAssistMode(store)).toBe('ai-only');
  });
});
