import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  getCustomOpenaiConfig,
  setCustomOpenaiConfig,
  DEFAULT_CUSTOM_OPENAI_CONFIG,
} from './custom-openai-config';

/** A minimal in-memory localStorage stub. */
class MemoryStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
  get length(): number { return this.map.size; }
  key(_: number): string | null { return null; }
}

let previousLocalStorage: Storage | undefined;

beforeEach(() => {
  previousLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  (globalThis as { localStorage?: Storage }).localStorage =
    new MemoryStorage() as unknown as Storage;
});

afterEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = previousLocalStorage;
});

describe('custom-openai-config', () => {
  it('returns defaults when nothing is stored', () => {
    expect(getCustomOpenaiConfig()).toEqual(DEFAULT_CUSTOM_OPENAI_CONFIG);
  });

  it('persists and reads back a base URL and model', () => {
    setCustomOpenaiConfig({ baseUrl: 'https://my-server.example.com/v1', model: 'my-model' });
    const cfg = getCustomOpenaiConfig();
    expect(cfg.baseUrl).toBe('https://my-server.example.com/v1');
    expect(cfg.model).toBe('my-model');
  });

  it('merges partial patches over the existing config', () => {
    setCustomOpenaiConfig({ baseUrl: 'https://a.example.com/v1' });
    setCustomOpenaiConfig({ model: 'cool-model' });
    const cfg = getCustomOpenaiConfig();
    expect(cfg.baseUrl).toBe('https://a.example.com/v1');
    expect(cfg.model).toBe('cool-model');
  });

  it('returns defaults for corrupted JSON', () => {
    const store = (globalThis as { localStorage?: Storage }).localStorage as unknown as MemoryStorage;
    store.setItem('career-agent.custom-openai', 'not valid json{{');
    expect(getCustomOpenaiConfig()).toEqual(DEFAULT_CUSTOM_OPENAI_CONFIG);
  });
});
