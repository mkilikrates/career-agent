// Unit tests for the network-operation label channel (@core/privacy).
//
// Verify the channel relays labels the Egress Gate emits (R7.3): subscribers
// observe each label synchronously (before the call proceeds), history is
// retained, and unsubscribe / clear behave.

import { describe, expect, it, vi } from 'vitest';
import type { NetworkOperationLabel } from '@core/egress';
import { createNetworkLabelChannel } from './network-labels';

const label = (provider: string, operation: 'llm-chat' | 'stt-transcribe'): NetworkOperationLabel => ({
  operation,
  provider: provider as NetworkOperationLabel['provider'],
  thirdParty: true,
  description: `${operation} via ${provider}`,
});

describe('network label channel (R7.3)', () => {
  it('notifies subscribers synchronously with each label', () => {
    const channel = createNetworkLabelChannel();
    const seen: NetworkOperationLabel[] = [];
    channel.subscribe((l) => seen.push(l));

    const first = label('openai', 'llm-chat');
    channel.notify(first);
    // Synchronous: the subscriber has already seen it on the same tick (R7.3).
    expect(seen).toEqual([first]);
  });

  it('retains history in emission order for late-mounting screens', () => {
    const channel = createNetworkLabelChannel();
    const a = label('openai', 'llm-chat');
    const b = label('whisper', 'stt-transcribe');
    channel.notify(a);
    channel.notify(b);

    expect(channel.labels()).toEqual([a, b]);
    expect(channel.latest()).toEqual(b);
  });

  it('returns an immutable copy of history', () => {
    const channel = createNetworkLabelChannel();
    channel.notify(label('openai', 'llm-chat'));
    const snapshot = channel.labels() as NetworkOperationLabel[];
    snapshot.push(label('evil', 'llm-chat'));
    expect(channel.labels()).toHaveLength(1);
  });

  it('stops notifying after unsubscribe', () => {
    const channel = createNetworkLabelChannel();
    const listener = vi.fn();
    const off = channel.subscribe(listener);
    channel.notify(label('openai', 'llm-chat'));
    off();
    channel.notify(label('openai', 'llm-chat'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clear() forgets history but keeps subscribers', () => {
    const channel = createNetworkLabelChannel();
    const listener = vi.fn();
    channel.subscribe(listener);
    channel.notify(label('openai', 'llm-chat'));
    channel.clear();
    expect(channel.labels()).toEqual([]);
    expect(channel.latest()).toBeUndefined();
    channel.notify(label('openai', 'llm-chat'));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('can be wired as the Egress Gate notifyLabel callback', () => {
    const channel = createNetworkLabelChannel();
    // The gate calls notifyLabel(label) before each call; the channel is the
    // LabelNotifier. Passing it through a function typed as LabelNotifier
    // confirms structural compatibility.
    const notify: (l: NetworkOperationLabel) => void = channel.notify;
    notify(label('openai', 'llm-chat'));
    expect(channel.labels()).toHaveLength(1);
  });
});
