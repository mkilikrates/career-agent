// Unit tests for the Egress Gate chokepoint (@core/egress).
//
// These exercise the trust-critical sequence and fail-closed posture described
// in the design "Egress Gate" section against Requirements 6.1, 6.3, 6.4, 7.1,
// 7.2, 7.3, 7.4. External collaborators (PII_Scanner, Provider_Manager, label
// notifier, redact-and-proceed prompt) are simple spies/mocks — no real network
// or crypto is involved.

import { describe, expect, it, vi } from 'vitest';

import {
  DefaultEgressGate,
  EgressDeclinedError,
  EgressMisconfiguredError,
  EgressScreeningError,
  EgressSendControlNotConfirmedError,
  createEgressGate,
  type EgressIntent,
  type LabelNotifier,
  type NetworkOperationLabel,
  type RedactAndProceedPrompt,
} from './egress-gate';
import { toSensitiveDetections, type SendControlDecision } from './send-control';
import { asFileId } from '@core/types';
import type { Detection, PiiScanner } from '@adapters/pii';
import type {
  AudioBlob,
  ProviderId,
  ProviderManager,
  ProviderResponse,
  RedactedPayload,
  Transcript,
} from '@adapters/provider';

const PROVIDER: ProviderId = 'openai';
const RESPONSE = { __brand: 'ProviderResponse' } as ProviderResponse;

/** A stub PII_Scanner with controllable scan output and a real redact pass. */
function makeScanner(
  scanImpl: (text: string) => Detection[],
): PiiScanner & {
  redact: ReturnType<typeof vi.fn>;
  scan: ReturnType<typeof vi.fn>;
} {
  const redact = vi.fn((text: string, detections: Detection[]): RedactedPayload => {
    // Minimal but faithful redaction: replace each detected span with a marker
    // so tests can assert the secret never survives into the payload.
    if (detections.length === 0) return { __brand: 'RedactedPayload', text };
    const sorted = [...detections].sort((a, b) => a.start - b.start);
    let out = '';
    let cursor = 0;
    for (const d of sorted) {
      out += text.slice(cursor, d.start);
      out += `[REDACTED:${d.category}]`;
      cursor = d.end;
    }
    out += text.slice(cursor);
    return { __brand: 'RedactedPayload', text: out };
  });
  const scan = vi.fn(scanImpl);
  return { scan, redact } as unknown as PiiScanner & {
    redact: ReturnType<typeof vi.fn>;
    scan: ReturnType<typeof vi.fn>;
  };
}

/** A Provider_Manager whose `send` is a spy returning a fixed response. */
function makeProviderManager(): ProviderManager & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => RESPONSE);
  return { send } as unknown as ProviderManager & { send: ReturnType<typeof vi.fn> };
}

/**
 * A Provider_Manager that also implements `listProviders` so the gate can read
 * the `keyless` flag for a destination (R7.6). `send`/`transcribe` are spies.
 */
function makeRegistryProviderManager(
  descriptors: { id: string; displayName?: string; keyless?: boolean }[],
): ProviderManager & {
  send: ReturnType<typeof vi.fn>;
  transcribe: ReturnType<typeof vi.fn>;
  listProviders: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => RESPONSE);
  const transcribe = vi.fn(
    async (): Promise<Transcript> => ({ __brand: 'Transcript', text: 'transcript' }),
  );
  const listProviders = vi.fn(() =>
    descriptors.map((d) => ({ displayName: d.id, ...d })),
  );
  return { send, transcribe, listProviders } as unknown as ProviderManager & {
    send: ReturnType<typeof vi.fn>;
    transcribe: ReturnType<typeof vi.fn>;
    listProviders: ReturnType<typeof vi.fn>;
  };
}

/** A Provider_Manager whose `transcribe` returns a fixed transcript text. */
function makeSttProviderManager(
  transcriptText: string,
): ProviderManager & { transcribe: ReturnType<typeof vi.fn> } {
  const transcribe = vi.fn(
    async (): Promise<Transcript> => ({ __brand: 'Transcript', text: transcriptText }),
  );
  return { transcribe } as unknown as ProviderManager & {
    transcribe: ReturnType<typeof vi.fn>;
  };
}

const AUDIO: AudioBlob = {
  __brand: 'AudioBlob',
  format: 'mp3',
  bytes: new Uint8Array([1, 2, 3]),
};

function intent(text: string, operation: EgressIntent['operation'] = 'llm-chat'): EgressIntent {
  return { provider: PROVIDER, text, operation };
}

describe('DefaultEgressGate', () => {
  it('emits the third-party network label before sending (R7.3)', async () => {
    const order: string[] = [];
    const scanner = makeScanner(() => []);
    scanner.scan.mockImplementation(() => {
      order.push('scan');
      return [];
    });
    const provider = makeProviderManager();
    provider.send.mockImplementation(async () => {
      order.push('send');
      return RESPONSE;
    });
    const notifyLabel: LabelNotifier = vi.fn((label) => {
      order.push('label');
      expect(label.thirdParty).toBe(true);
      expect(label.provider).toBe(PROVIDER);
      expect(label.operation).toBe('llm-chat');
      expect(label.description).toMatch(/third-party network call/i);
    });
    const confirm: RedactAndProceedPrompt = vi.fn(async () => true);

    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel,
      confirmRedactAndProceed: confirm,
    });

    await gate.request(intent('hello world'));

    expect(notifyLabel).toHaveBeenCalledTimes(1);
    // Label precedes scanning, which precedes sending.
    expect(order).toEqual(['label', 'scan', 'send']);
  });

  it('clean text produces a redacted payload and sends to the chosen provider (R6.4, R7.2, R7.4)', async () => {
    const scanner = makeScanner(() => []);
    const provider = makeProviderManager();
    const confirm: RedactAndProceedPrompt = vi.fn(async () => true);

    const gate = createEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: confirm,
    });

    const res = await gate.request(intent('a perfectly clean sentence'));

    expect(res).toBe(RESPONSE);
    // No detections → no confirmation prompt.
    expect(confirm).not.toHaveBeenCalled();
    // The minimised redacted payload (branded) is what gets transmitted.
    expect(provider.send).toHaveBeenCalledTimes(1);
    const [sentProvider, sentPayload] = provider.send.mock.calls[0];
    expect(sentProvider).toBe(PROVIDER);
    expect(sentPayload.__brand).toBe('RedactedPayload');
    expect(sentPayload.text).toBe('a perfectly clean sentence');
  });

  it('detections trigger the redact-and-proceed prompt with the detected categories (R6.3)', async () => {
    const detection: Detection = {
      category: 'api_key_or_token',
      start: 8,
      end: 28,
      value: 'sk-secretsecret12345',
    };
    const scanner = makeScanner(() => [detection]);
    const provider = makeProviderManager();
    const confirm: RedactAndProceedPrompt = vi.fn(async () => true);

    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: confirm,
    });

    await gate.request(intent('my key sk-secretsecret12345 end'));

    expect(confirm).toHaveBeenCalledTimes(1);
    const proposal = vi.mocked(confirm).mock.calls[0][0];
    expect(proposal.provider).toBe(PROVIDER);
    expect(proposal.categories).toEqual(['api_key_or_token']);
    expect(proposal.detectionCount).toBe(1);
  });

  it('aborts without transmitting when the user declines (fail closed, R6.3)', async () => {
    const detection: Detection = {
      category: 'ssn',
      start: 0,
      end: 11,
      value: '123-45-6789',
    };
    const scanner = makeScanner(() => [detection]);
    const provider = makeProviderManager();
    const confirm: RedactAndProceedPrompt = vi.fn(async () => false);

    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: confirm,
    });

    await expect(gate.request(intent('123-45-6789'))).rejects.toBeInstanceOf(
      EgressDeclinedError,
    );
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('fails closed when PII screening cannot complete (scanner throws, R6.1)', async () => {
    const scanner = makeScanner(() => {
      throw new Error('scanner exploded');
    });
    const provider = makeProviderManager();
    const confirm: RedactAndProceedPrompt = vi.fn(async () => true);

    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: confirm,
    });

    await expect(gate.request(intent('anything'))).rejects.toBeInstanceOf(
      EgressScreeningError,
    );
    expect(provider.send).not.toHaveBeenCalled();
    // Confirmation is never reached when screening itself fails.
    expect(confirm).not.toHaveBeenCalled();
  });

  it('no detected secret survives in the transmitted payload (R6.4, R6.5)', async () => {
    const secret = 'sk-supersecrettoken1234567890';
    const text = `please use ${secret} now`;
    const detection: Detection = {
      category: 'api_key_or_token',
      start: text.indexOf(secret),
      end: text.indexOf(secret) + secret.length,
      value: secret,
    };
    const scanner = makeScanner(() => [detection]);
    const provider = makeProviderManager();

    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: vi.fn(async () => true),
    });

    await gate.request(intent(text));

    const sentPayload = provider.send.mock.calls[0][1] as RedactedPayload;
    expect(sentPayload.text).not.toContain(secret);
    expect(sentPayload.text).toContain('[REDACTED:api_key_or_token]');
  });

  it('transmits only to the user-chosen provider id (R7.4)', async () => {
    const scanner = makeScanner(() => []);
    const provider = makeProviderManager();
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: vi.fn(async () => true),
    });

    await gate.request({ provider: 'anthropic', text: 'hi', operation: 'llm-chat' });

    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(provider.send.mock.calls[0][0]).toBe('anthropic');
  });

  it('treats a rejected confirmation as a decline and fails closed (R6.3)', async () => {
    const detection: Detection = {
      category: 'credit_card',
      start: 0,
      end: 19,
      value: '4111 1111 1111 1111',
    };
    const scanner = makeScanner(() => [detection]);
    const provider = makeProviderManager();
    const confirm: RedactAndProceedPrompt = vi.fn(async () => {
      throw new Error('prompt dismissed');
    });

    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: confirm,
    });

    await expect(gate.request(intent('4111 1111 1111 1111'))).rejects.toBeInstanceOf(
      EgressDeclinedError,
    );
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('throws at construction when a required collaborator is missing (fail closed)', () => {
    const scanner = makeScanner(() => []);
    const provider = makeProviderManager();
    expect(
      () =>
        new DefaultEgressGate({
          // @ts-expect-error intentionally missing scanner
          scanner: undefined,
          providerManager: provider,
          notifyLabel: vi.fn(),
          confirmRedactAndProceed: vi.fn(async () => true),
        }),
    ).toThrow(EgressMisconfiguredError);

    expect(
      () =>
        new DefaultEgressGate({
          scanner,
          // @ts-expect-error intentionally missing providerManager
          providerManager: undefined,
          notifyLabel: vi.fn(),
          confirmRedactAndProceed: vi.fn(async () => true),
        }),
    ).toThrow(EgressMisconfiguredError);
  });
});

describe('DefaultEgressGate — local on-device labelling (R7.6)', () => {
  it('marks a keyless Local Provider as a local on-device call with no third-party egress', async () => {
    const scanner = makeScanner(() => []);
    const provider = makeRegistryProviderManager([
      { id: 'local', keyless: true },
      { id: 'openai' },
    ]);
    let captured: NetworkOperationLabel | undefined;
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: (label) => {
        captured = label;
      },
      confirmRedactAndProceed: vi.fn(async () => true),
    });

    await gate.request({ provider: 'local', text: 'hello', operation: 'llm-chat' });

    expect(captured?.thirdParty).toBe(false);
    expect(captured?.description).toMatch(/local on-device call with no third-party egress/i);
  });

  it('keeps a keyed cloud provider labelled as a third-party network call', async () => {
    const scanner = makeScanner(() => []);
    const provider = makeRegistryProviderManager([
      { id: 'local', keyless: true },
      { id: 'openai' },
    ]);
    let captured: NetworkOperationLabel | undefined;
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: (label) => {
        captured = label;
      },
      confirmRedactAndProceed: vi.fn(async () => true),
    });

    await gate.request({ provider: 'openai', text: 'hello', operation: 'llm-chat' });

    expect(captured?.thirdParty).toBe(true);
    expect(captured?.description).toMatch(/third-party network call/i);
  });

  it('skips PII screening entirely for a local provider and sends the full text (R7.6)', async () => {
    const scanner = makeScanner(() => {
      throw new Error('scan must not be called for a local provider');
    });
    const provider = makeRegistryProviderManager([{ id: 'local', keyless: true }]);
    const confirm: RedactAndProceedPrompt = vi.fn(async () => true);
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: confirm,
    });

    const secret = 'my SSN is 123-45-6789';
    await gate.request({ provider: 'local', text: secret, operation: 'llm-chat' });

    // No scan, no redact-and-proceed prompt for a local on-device call.
    expect(scanner.scan).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    // The FULL text is sent as-is to the local provider.
    expect(provider.send).toHaveBeenCalledTimes(1);
    const sent = provider.send.mock.calls[0][1] as RedactedPayload;
    expect(sent.text).toBe(secret);
  });

  it('skips transcript PII screening for a local STT provider (R7.6)', async () => {
    const scanner = makeScanner(() => {
      throw new Error('scan must not be called for a local provider');
    });
    const provider = makeRegistryProviderManager([{ id: 'local', keyless: true }]);
    // Give the local registry manager a transcribe spy returning a fixed text.
    (provider.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue({
      __brand: 'Transcript',
      text: 'my card 4111 1111 1111 1111',
    });
    const confirm: RedactAndProceedPrompt = vi.fn(async () => true);
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: confirm,
    });

    const result = await gate.transcribe({ provider: 'local', audio: AUDIO });

    expect(scanner.scan).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(result.text).toBe('my card 4111 1111 1111 1111');
    expect(result.redactedCategories).toEqual([]);
  });

  it('labels a keyless Local STT provider as a local on-device transcription (R7.6)', async () => {
    const scanner = makeScanner(() => []);
    const provider = makeRegistryProviderManager([{ id: 'local', keyless: true }]);
    let captured: NetworkOperationLabel | undefined;
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: (label) => {
        captured = label;
      },
      confirmRedactAndProceed: vi.fn(async () => true),
    });

    await gate.transcribe({ provider: 'local', audio: AUDIO });

    expect(captured?.thirdParty).toBe(false);
    expect(captured?.description).toMatch(/local on-device call with no third-party egress/i);
  });

  it('fails safe to third-party when the registry has no descriptor for the provider', async () => {
    const scanner = makeScanner(() => []);
    // Registry lists only a different provider, so the target is unknown.
    const provider = makeRegistryProviderManager([{ id: 'someone-else', keyless: true }]);
    let captured: NetworkOperationLabel | undefined;
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: (label) => {
        captured = label;
      },
      confirmRedactAndProceed: vi.fn(async () => true),
    });

    await gate.request({ provider: 'unknown', text: 'hi', operation: 'llm-chat' });

    expect(captured?.thirdParty).toBe(true);
  });
});

describe('DefaultEgressGate.transcribe — STT audio path (R26.2)', () => {
  it('labels the third-party STT operation before transmitting the audio (R7.3)', async () => {
    const order: string[] = [];
    const scanner = makeScanner(() => []);
    scanner.scan.mockImplementation(() => {
      order.push('scan');
      return [];
    });
    const provider = makeSttProviderManager('clean transcript');
    provider.transcribe.mockImplementation(async () => {
      order.push('transcribe');
      return { __brand: 'Transcript', text: 'clean transcript' };
    });
    const notifyLabel: LabelNotifier = vi.fn((label) => {
      order.push('label');
      expect(label.thirdParty).toBe(true);
      expect(label.provider).toBe(PROVIDER);
      expect(label.operation).toBe('stt-transcribe');
      expect(label.description).toMatch(/transcrib/i);
    });

    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel,
      confirmRedactAndProceed: vi.fn(async () => true),
    });

    await gate.transcribe({ provider: PROVIDER, audio: AUDIO });

    // Label precedes the transcription call, which precedes screening.
    expect(order).toEqual(['label', 'transcribe', 'scan']);
  });

  it('transmits the audio only to the user-chosen STT provider (R7.4)', async () => {
    const scanner = makeScanner(() => []);
    const provider = makeSttProviderManager('hello');
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: vi.fn(async () => true),
    });

    await gate.transcribe({ provider: 'anthropic', audio: AUDIO });

    expect(provider.transcribe).toHaveBeenCalledTimes(1);
    expect(provider.transcribe.mock.calls[0][0]).toBe('anthropic');
    expect(provider.transcribe.mock.calls[0][1]).toBe(AUDIO);
  });

  it('forwards translateToEnglish to the provider STT client (R26.5)', async () => {
    const scanner = makeScanner(() => []);
    const provider = makeSttProviderManager('translated');
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: vi.fn(async () => true),
    });

    await gate.transcribe({ provider: PROVIDER, audio: AUDIO, translateToEnglish: true });

    expect(provider.transcribe).toHaveBeenCalledTimes(1);
    expect(provider.transcribe.mock.calls[0][2]).toEqual({ translateToEnglish: true });
  });

  it('defaults to same-language transcription when translateToEnglish is omitted (R26.5)', async () => {
    const scanner = makeScanner(() => []);
    const provider = makeSttProviderManager('same language');
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: vi.fn(async () => true),
    });

    await gate.transcribe({ provider: PROVIDER, audio: AUDIO });

    expect(provider.transcribe.mock.calls[0][2]).toEqual({ translateToEnglish: undefined });
  });

  it('PII-screens a clean transcript and returns it for confirmation (R26.2, R26.3)', async () => {
    const scanner = makeScanner(() => []);
    const provider = makeSttProviderManager('I led a migration that cut costs');
    const confirm: RedactAndProceedPrompt = vi.fn(async () => true);
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: confirm,
    });

    const result = await gate.transcribe({ provider: PROVIDER, audio: AUDIO });

    expect(scanner.scan).toHaveBeenCalledWith('I led a migration that cut costs');
    // Clean transcript → no redaction prompt and nothing redacted.
    expect(confirm).not.toHaveBeenCalled();
    expect(result.text).toBe('I led a migration that cut costs');
    expect(result.redactedCategories).toEqual([]);
  });

  it('offers redact-and-proceed and removes detected secrets from the transcript (R6.3, R6.4, R6.5)', async () => {
    const secret = 'sk-supersecrettoken1234567890';
    const transcriptText = `my key is ${secret} thanks`;
    const detection: Detection = {
      category: 'api_key_or_token',
      start: transcriptText.indexOf(secret),
      end: transcriptText.indexOf(secret) + secret.length,
      value: secret,
    };
    const scanner = makeScanner(() => [detection]);
    const provider = makeSttProviderManager(transcriptText);
    const confirm: RedactAndProceedPrompt = vi.fn(async () => true);
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: confirm,
    });

    const result = await gate.transcribe({ provider: PROVIDER, audio: AUDIO });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(confirm).mock.calls[0][0].operation).toBe('stt-transcribe');
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain('[REDACTED:api_key_or_token]');
    expect(result.redactedCategories).toEqual(['api_key_or_token']);
  });

  it('fails closed without returning a transcript when the user declines (R26.2 → R6.3)', async () => {
    const transcriptText = '123-45-6789 is my number';
    const detection: Detection = {
      category: 'ssn',
      start: 0,
      end: 11,
      value: '123-45-6789',
    };
    const scanner = makeScanner(() => [detection]);
    const provider = makeSttProviderManager(transcriptText);
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: vi.fn(async () => false),
    });

    await expect(
      gate.transcribe({ provider: PROVIDER, audio: AUDIO }),
    ).rejects.toBeInstanceOf(EgressDeclinedError);
  });

  it('fails closed when transcript screening cannot complete (scanner throws, R6.1)', async () => {
    const scanner = makeScanner(() => {
      throw new Error('scanner exploded');
    });
    const provider = makeSttProviderManager('whatever');
    const confirm: RedactAndProceedPrompt = vi.fn(async () => true);
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: confirm,
    });

    await expect(
      gate.transcribe({ provider: PROVIDER, audio: AUDIO }),
    ).rejects.toBeInstanceOf(EgressScreeningError);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('DefaultEgressGate.requestIngestion — Granular Send-Control (R57)', () => {
  const FILE = asFileId('cv.md');

  function gateWith(provider = makeProviderManager()) {
    const scanner = makeScanner(() => []);
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: vi.fn(),
      confirmRedactAndProceed: vi.fn(async () => true),
    });
    return { gate, provider };
  }

  const detections = toSensitiveDetections([
    { category: 'api_key_or_token', start: 6, end: 12, value: 'SECRET' },
    { category: 'ssn', start: 17, end: 28, value: '123-45-6789' },
  ]);
  // content where [6,12)='SECRET' and [17,28)='123-45-6789'
  const content = 'intro SECRET ssn 123-45-6789 end';

  it('refuses to build or transmit until the decision is confirmed (R57.1)', async () => {
    const { gate, provider } = gateWith();
    const decision: SendControlDecision = {
      fileId: FILE,
      mode: 'whole-file',
      allowedDetectionIds: [],
      confirmed: false,
    };
    await expect(
      gate.requestIngestion({ provider: PROVIDER, content, detections, decision }),
    ).rejects.toBeInstanceOf(EgressSendControlNotConfirmedError);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('whole-file builds the payload from the full content and transmits (R57.3)', async () => {
    const { gate, provider } = gateWith();
    const decision: SendControlDecision = {
      fileId: FILE,
      mode: 'whole-file',
      allowedDetectionIds: [],
      confirmed: true,
    };
    await gate.requestIngestion({ provider: PROVIDER, content, detections, decision });
    expect(provider.send).toHaveBeenCalledTimes(1);
    const sent = provider.send.mock.calls[0][1] as RedactedPayload;
    expect(sent.text).toBe(content);
  });

  it('per-detection retains allowed values and removes redacted ones (R57.4)', async () => {
    const { gate, provider } = gateWith();
    const allowApiKey = detections.find((d) => d.category === 'api_key_or_token')!;
    const decision: SendControlDecision = {
      fileId: FILE,
      mode: 'per-detection',
      allowedDetectionIds: [allowApiKey.id],
      confirmed: true,
    };
    await gate.requestIngestion({ provider: PROVIDER, content, detections, decision });
    const sent = provider.send.mock.calls[0][1] as RedactedPayload;
    // Allowed API key retained, non-allowed SSN removed.
    expect(sent.text).toContain('SECRET');
    expect(sent.text).not.toContain('123-45-6789');
    expect(sent.text).toContain('[REDACTED:ssn]');
  });

  it('cloud default (per-detection, empty allow set) redacts every detection (R57.6)', async () => {
    const { gate, provider } = gateWith();
    const decision: SendControlDecision = {
      fileId: FILE,
      mode: 'per-detection',
      allowedDetectionIds: [],
      confirmed: true,
    };
    await gate.requestIngestion({ provider: PROVIDER, content, detections, decision });
    const sent = provider.send.mock.calls[0][1] as RedactedPayload;
    expect(sent.text).not.toContain('SECRET');
    expect(sent.text).not.toContain('123-45-6789');
  });

  it('transmits only to the user-chosen provider and labels before sending (R7.3, R7.4)', async () => {
    const provider = makeProviderManager();
    const scanner = makeScanner(() => []);
    const order: string[] = [];
    provider.send.mockImplementation(async () => {
      order.push('send');
      return RESPONSE;
    });
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel: () => order.push('label'),
      confirmRedactAndProceed: vi.fn(async () => true),
    });
    const decision: SendControlDecision = {
      fileId: FILE,
      mode: 'whole-file',
      allowedDetectionIds: [],
      confirmed: true,
    };
    await gate.requestIngestion({ provider: 'anthropic', content, detections, decision });
    expect(provider.send.mock.calls[0][0]).toBe('anthropic');
    expect(order).toEqual(['label', 'send']);
  });

  it('does not label or transmit when the decision is unconfirmed (fail closed before side effects)', async () => {
    const provider = makeProviderManager();
    const scanner = makeScanner(() => []);
    const notifyLabel = vi.fn();
    const gate = new DefaultEgressGate({
      scanner,
      providerManager: provider,
      notifyLabel,
      confirmRedactAndProceed: vi.fn(async () => true),
    });
    const decision: SendControlDecision = {
      fileId: FILE,
      mode: 'whole-file',
      allowedDetectionIds: [],
      confirmed: false,
    };
    await expect(
      gate.requestIngestion({ provider: PROVIDER, content, detections, decision }),
    ).rejects.toBeInstanceOf(EgressSendControlNotConfirmedError);
    expect(notifyLabel).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });
});
