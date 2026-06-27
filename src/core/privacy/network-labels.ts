// Network-operation label channel (R7.3).
//
// Requirement 7.3: "THE Career_Agent SHALL label each operation that involves a
// third-party API, including speech-to-text transcription, BEFORE the operation
// runs." The Egress Gate already emits a {@link NetworkOperationLabel} via its
// injected {@link LabelNotifier} immediately before each call (see
// `@core/egress`). What was missing is a framework-agnostic place for the UI to
// SUBSCRIBE to those labels so they can surface in the shell.
//
// This channel is that mechanism. It is a tiny synchronous pub/sub:
//   * `notify` is the {@link LabelNotifier} you wire into the Egress Gate's
//     `notifyLabel` option, so every gated call publishes its label here.
//   * `subscribe` lets the UI react to each label the instant it is published
//     — i.e. before the network call proceeds (R7.3).
//   * `labels()` returns the labels seen so far (most recent last) so a screen
//     mounting after a call can still render the history.
//
// It holds no provider keys, no Memory Store access, and no network client — it
// only relays the labels the Egress Gate hands it. Notification is synchronous
// so a subscriber observes the label within the same tick the gate emits it,
// preserving the "before the operation runs" guarantee.

import type { LabelNotifier, NetworkOperationLabel } from '@core/egress';

/** A subscriber notified for each {@link NetworkOperationLabel} published. */
export type NetworkLabelListener = (label: NetworkOperationLabel) => void;

/** Unsubscribe handle returned by {@link NetworkLabelChannel.subscribe}. */
export type Unsubscribe = () => void;

/**
 * The framework-agnostic pub/sub the UI subscribes to for third-party
 * network-operation labels (R7.3). Wire {@link NetworkLabelChannel.notify} into
 * the Egress Gate's `notifyLabel`; subscribe from the shell.
 */
export interface NetworkLabelChannel {
  /**
   * The {@link LabelNotifier} to pass to the Egress Gate. Publishing is
   * synchronous, so subscribers see the label before the gated call proceeds
   * (R7.3).
   */
  readonly notify: LabelNotifier;
  /** Subscribe to every future label; returns an unsubscribe handle. */
  subscribe(listener: NetworkLabelListener): Unsubscribe;
  /** All labels published so far, in emission order (most recent last). */
  labels(): readonly NetworkOperationLabel[];
  /** The most recently published label, or `undefined` if none yet. */
  latest(): NetworkOperationLabel | undefined;
  /** Forget the recorded history (subscribers are kept). */
  clear(): void;
}

/**
 * Create a {@link NetworkLabelChannel}. Each channel is independent: its history
 * and subscribers are isolated, so tests and multiple shells never interfere.
 */
export function createNetworkLabelChannel(): NetworkLabelChannel {
  const history: NetworkOperationLabel[] = [];
  const listeners = new Set<NetworkLabelListener>();

  const notify: LabelNotifier = (label) => {
    history.push(label);
    // Synchronous fan-out: every subscriber observes the label before the
    // Egress Gate continues to the actual network call (R7.3).
    for (const listener of listeners) {
      listener(label);
    }
  };

  return {
    notify,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    labels() {
      return [...history];
    },
    latest() {
      return history.at(-1);
    },
    clear() {
      history.length = 0;
    },
  };
}
