// Unit tests for the real BYOK LLM HTTP clients (OpenAI + Anthropic).
//
// `fetch` is injected so these run offline and deterministically. They pin the
// two boundary behaviours the Provider_Manager relies on:
//   * a no-prompt validation probe issues a cheap auth check and surfaces the
//     provider's failure reason on rejection (R4.3, R4.4);
//   * a real prompt issues the completion request and returns the text.
// They also pin the Anthropic browser-CORS opt-in header and the just-in-time
// key handling (the key is sent to the provider, never mutated/stored here).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioBlob, ChatRequest } from './provider';
import {
  createAnthropicLlmProvider,
  createLocalLlmProvider,
  createLocalSttProvider,
  createOpenAiLlmProvider,
  createOpenAiSttProvider,
  readChatResponseText,
} from './llm-http';
import { DEFAULT_LOCAL_CONFIG, setLocalConfig } from './local-config';

/** A validation probe: the branded request with NO prompt text. */
const PROBE = { __brand: 'ChatRequest' } as ChatRequest;
/** A real request carries `text` (as the Egress Gate's RedactedPayload does). */
const prompt = (text: string): ChatRequest => ({ __brand: 'ChatRequest', text } as ChatRequest);
/** A real request that also carries the no-training preference (R42.1). */
const promptNoTrain = (text: string): ChatRequest =>
  ({ __brand: 'ChatRequest', text, noTraining: true } as ChatRequest);

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

describe('OpenAI LLM client', () => {
  it('validation probe issues a no-token GET /models auth check with the bearer key', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: [] })) as unknown as typeof fetch;
    const client = createOpenAiLlmProvider({ fetchImpl });

    const resp = await client.chat(PROBE, 'sk-test-123');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect((init as RequestInit).method ?? 'GET').toBe('GET');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer sk-test-123' });
    expect(readChatResponseText(resp)).toBe('');
  });

  it('rejects an invalid key with the provider failure reason (R4.4)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { error: { message: 'Incorrect API key provided' } }),
    ) as unknown as typeof fetch;
    const client = createOpenAiLlmProvider({ fetchImpl });

    await expect(client.chat(PROBE, 'bad')).rejects.toThrow(/401: Incorrect API key provided/);
  });

  it('sends a real prompt to chat/completions and returns the completion text', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { choices: [{ message: { content: 'Hello there.' } }] }),
    ) as unknown as typeof fetch;
    const client = createOpenAiLlmProvider({ fetchImpl, model: 'gpt-4o-mini' });

    const resp = await client.chat(prompt('Summarise my experience.'), 'sk-test');

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toEqual([{ role: 'user', content: 'Summarise my experience.' }]);
    expect(readChatResponseText(resp)).toBe('Hello there.');
  });

  it('requests no retention/training (store: false) when noTraining is set (R42.1)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    ) as unknown as typeof fetch;
    const client = createOpenAiLlmProvider({ fetchImpl });

    await client.chat(promptNoTrain('Hello'), 'sk-test');

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.store).toBe(false);
  });

  it('omits store when noTraining is not set (consent granted path)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    ) as unknown as typeof fetch;
    const client = createOpenAiLlmProvider({ fetchImpl });

    await client.chat(prompt('Hello'), 'sk-test');

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(String((init as RequestInit).body));
    expect('store' in body).toBe(false);
  });
});

describe('Anthropic LLM client', () => {
  it('validation probe sends the required version + browser-CORS opt-in headers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: [] })) as unknown as typeof fetch;
    const client = createAnthropicLlmProvider({ fetchImpl });

    await client.chat(PROBE, 'sk-ant-123');

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect((init as RequestInit).headers).toMatchObject({
      'x-api-key': 'sk-ant-123',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
  });

  it('sends a real prompt to /messages and joins the content blocks', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { content: [{ type: 'text', text: 'Part one. ' }, { type: 'text', text: 'Part two.' }] }),
    ) as unknown as typeof fetch;
    const client = createAnthropicLlmProvider({ fetchImpl });

    const resp = await client.chat(prompt('Hi'), 'sk-ant');

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init as RequestInit).method).toBe('POST');
    expect(readChatResponseText(resp)).toBe('Part one. Part two.');
  });

  it('reports a useful reason when the key is rejected', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { error: { message: 'invalid x-api-key' } }),
    ) as unknown as typeof fetch;
    const client = createAnthropicLlmProvider({ fetchImpl });

    await expect(client.chat(PROBE, 'bad')).rejects.toThrow(/401: invalid x-api-key/);
  });
});

/** A minimal in-memory localStorage stub for exercising `local-config` reads. */
class MemoryStorage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

const AUDIO = (format: 'mp3' | 'wav' = 'wav'): AudioBlob => ({
  __brand: 'AudioBlob',
  format,
  bytes: new Uint8Array([1, 2, 3]),
});

describe('Local (self-hosted) LLM client (R43)', () => {
  let previous: Storage | undefined;

  beforeEach(() => {
    previous = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage;
  });

  afterEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = previous;
  });

  it('validation probe issues a keyless GET /models against the configured base URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: [] })) as unknown as typeof fetch;
    const client = createLocalLlmProvider({ fetchImpl });

    const resp = await client.chat(PROBE, '');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${DEFAULT_LOCAL_CONFIG.baseUrl}/models`);
    // Keyless server: no authorization header is sent.
    expect((init as RequestInit).headers).not.toHaveProperty('authorization');
    expect(readChatResponseText(resp)).toBe('');
  });

  it('sends a real prompt to chat/completions with the configured model and no auth header', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { choices: [{ message: { content: 'Local reply.' } }] }),
    ) as unknown as typeof fetch;
    const client = createLocalLlmProvider({ fetchImpl });

    const resp = await client.chat(prompt('Hello local model.'), '');

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${DEFAULT_LOCAL_CONFIG.baseUrl}/chat/completions`);
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).not.toHaveProperty('authorization');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.model).toBe(DEFAULT_LOCAL_CONFIG.model);
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello local model.' }]);
    // Defaults to the local token limit (2048), not the cloud 512 (R43.6).
    expect(body.max_tokens).toBe(DEFAULT_LOCAL_CONFIG.maxTokens);
    expect(readChatResponseText(resp)).toBe('Local reply.');
  });

  it('sends the user-configured max_tokens on every call (R43.6)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    ) as unknown as typeof fetch;
    const client = createLocalLlmProvider({ fetchImpl });

    setLocalConfig({ baseUrl: 'http://localhost:11434/v1', model: 'llama3', maxTokens: 4096 });
    await client.chat(prompt('first'), '');

    // An invalid edit is dropped, so the previous 4096 limit is preserved.
    setLocalConfig({ maxTokens: 0 });
    await client.chat(prompt('second'), '');

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(JSON.parse(String((calls[0][1] as RequestInit).body)).max_tokens).toBe(4096);
    expect(JSON.parse(String((calls[1][1] as RequestInit).body)).max_tokens).toBe(4096);
  });

  it('reads base URL and model from local-config on every call (edits apply immediately)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    ) as unknown as typeof fetch;
    const client = createLocalLlmProvider({ fetchImpl });

    setLocalConfig({ baseUrl: 'http://localhost:11434/v1', model: 'llama3' });
    await client.chat(prompt('first'), '');

    setLocalConfig({ baseUrl: 'http://localhost:1234/v1', model: 'mistral' });
    await client.chat(prompt('second'), '');

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
    expect(JSON.parse(String((calls[0][1] as RequestInit).body)).model).toBe('llama3');
    expect(calls[1][0]).toBe('http://localhost:1234/v1/chat/completions');
    expect(JSON.parse(String((calls[1][1] as RequestInit).body)).model).toBe('mistral');
  });

  it('surfaces the server failure reason when a keyless probe is rejected (R4.4)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(500, { error: { message: 'model not loaded' } }),
    ) as unknown as typeof fetch;
    const client = createLocalLlmProvider({ fetchImpl });

    await expect(client.chat(PROBE, '')).rejects.toThrow(/500: model not loaded/);
  });

  it('maps a connection failure on a real chat to an operation-scoped unreachable error (R53.6)', async () => {
    // A server that is down/refused surfaces as a thrown TypeError, not a non-ok
    // HTTP response. The Local Provider maps it to a clear "unreachable" error.
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const client = createLocalLlmProvider({ fetchImpl });

    setLocalConfig({ baseUrl: 'http://localhost:11434/v1' });
    await expect(client.chat(prompt('Hello local model.'), '')).rejects.toMatchObject({
      name: 'LocalProviderUnreachableError',
      baseUrl: 'http://localhost:11434/v1',
    });
    await expect(client.chat(prompt('Hello local model.'), '')).rejects.toThrow(
      /could not be reached/i,
    );
  });

  it('leaves the validation probe failure RAW so the setup/CORS path is unchanged (R54.5)', async () => {
    // The no-prompt probe must keep surfacing the raw network reason so the
    // provider-setup path can still classify allowed-origins/CORS rejections.
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const client = createLocalLlmProvider({ fetchImpl });

    await expect(client.chat(PROBE, '')).rejects.toThrow(/Failed to fetch/);
    await expect(client.chat(PROBE, '')).rejects.not.toThrow(/could not be reached/i);
  });

  it('re-throws a non-ok HTTP response on a real chat unchanged (not "unreachable")', async () => {
    // A reachable server that returns an error status is NOT a connection
    // failure; its own status/message must still surface.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: { message: 'bad request' } }),
    ) as unknown as typeof fetch;
    const client = createLocalLlmProvider({ fetchImpl });

    await expect(client.chat(prompt('Hi'), '')).rejects.toThrow(/400: bad request/);
  });
});

describe('Local (self-hosted) STT client (R43, R26.2)', () => {
  let previous: Storage | undefined;

  beforeEach(() => {
    previous = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage;
  });

  afterEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = previous;
  });

  it('posts audio to the configured base URL with the configured STT model and no auth header', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { text: 'local transcript' }),
    ) as unknown as typeof fetch;
    const client = createLocalSttProvider({ fetchImpl });

    setLocalConfig({ baseUrl: 'http://localhost:11434/v1', sttModel: 'whisper-local' });
    const transcript = await client.transcribe(AUDIO('wav'), '');

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/audio/transcriptions');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).not.toHaveProperty('authorization');
    const form = (init as RequestInit).body as FormData;
    expect(form.get('model')).toBe('whisper-local');
    expect(transcript.text).toBe('local transcript');
  });

  it('posts to /audio/translations when translateToEnglish is set (R26.5)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { text: 'translated transcript' }),
    ) as unknown as typeof fetch;
    const client = createLocalSttProvider({ fetchImpl });

    setLocalConfig({ baseUrl: 'http://localhost:11434/v1', sttModel: 'whisper-local' });
    await client.transcribe(AUDIO('wav'), '', { translateToEnglish: true });

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/audio/translations');
  });

  it('maps a connection failure to an operation-scoped unreachable error (R53.6)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const client = createLocalSttProvider({ fetchImpl });

    setLocalConfig({ baseUrl: 'http://localhost:8081/v1', sttModel: 'whisper-local' });
    await expect(client.transcribe(AUDIO('wav'), '')).rejects.toMatchObject({
      name: 'LocalProviderUnreachableError',
      baseUrl: 'http://localhost:8081/v1',
    });
    await expect(client.transcribe(AUDIO('wav'), '')).rejects.toThrow(/could not be reached/i);
  });

  it('re-throws a non-ok HTTP transcription response unchanged (not "unreachable")', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(422, { error: { message: 'unsupported audio' } }),
    ) as unknown as typeof fetch;
    const client = createLocalSttProvider({ fetchImpl });

    setLocalConfig({ baseUrl: 'http://localhost:8081/v1', sttModel: 'whisper-local' });
    await expect(client.transcribe(AUDIO('wav'), '')).rejects.toThrow(/422: unsupported audio/);
  });
});

describe('OpenAI STT client (R26.2, R26.5)', () => {
  it('posts audio to /audio/transcriptions by default with the bearer key', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { text: 'openai transcript' }),
    ) as unknown as typeof fetch;
    const client = createOpenAiSttProvider({ fetchImpl });

    const transcript = await client.transcribe(AUDIO('mp3'), 'sk-test-123');

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer sk-test-123' });
    const form = (init as RequestInit).body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(transcript.text).toBe('openai transcript');
  });

  it('posts to /audio/translations when translateToEnglish is true (R26.5)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { text: 'translated to english' }),
    ) as unknown as typeof fetch;
    const client = createOpenAiSttProvider({ fetchImpl });

    const transcript = await client.transcribe(AUDIO('wav'), 'sk-test-123', {
      translateToEnglish: true,
    });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/translations');
    expect((init as RequestInit).method).toBe('POST');
    expect(transcript.text).toBe('translated to english');
  });

  it('posts to /audio/transcriptions when translateToEnglish is false (R26.5)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { text: 'same language' }),
    ) as unknown as typeof fetch;
    const client = createOpenAiSttProvider({ fetchImpl });

    await client.transcribe(AUDIO('mp3'), 'sk-test-123', { translateToEnglish: false });

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
  });
});
