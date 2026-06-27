// Per-capability provider availability (@ui) — Requirement 44.
//
// The user chooses the chat/LLM provider and the speech-to-text provider
// INDEPENDENTLY (R44.1). This helper computes, for a given capability, which
// registered providers are actually available to select right now:
//
//   - a keyed cloud provider is available once its key is stored in the vault;
//   - the keyless Local Provider is available once its local config has been
//     tested/configured (`isLocalConfigured()`), R43.2.
//
// Boundary note: this module talks ONLY to the Provider_Manager registry
// (read-only `listProviders`) and the key vault (`has`). It never imports a
// provider client and makes no network call — the Egress-Gate-only boundary is
// untouched. It deliberately type-imports `ProviderManager`/`KeyVault` so it
// adds no runtime path to the Provider_Manager adapter (see the architectural
// guard in `end-to-end-smoke.test.tsx`).
//
// STT capability: the provider descriptor does not (yet) surface whether a
// provider wired a speech-to-text client. As wired in the runtime today, OpenAI
// and the Local Provider have STT clients while Anthropic does not. So STT
// capability is derived from a small known-capable id set below. Task 22.6
// ("local provider availability detection") builds on this helper; a future
// descriptor capability flag could replace the id set without changing callers.

import type { ProviderManager } from '@adapters/provider';
import type { KeyVault } from '@adapters/vault';
import { isLocalConfigured } from '@adapters/local-config';

/** The two independently-selectable provider capabilities (R44). */
export type ProviderCapability = 'chat' | 'stt';

/** A provider the user may currently select for a capability. */
export interface AvailableProvider {
  readonly id: string;
  readonly displayName: string;
}

/**
 * Provider ids that ship a speech-to-text client today. OpenAI has STT; the
 * keyless Local Provider has STT; Anthropic wires no `stt` client, so it is
 * excluded from STT selection. Kept here (rather than imported from the
 * Provider_Manager adapter) so this module adds no runtime dependency on that
 * adapter's value module.
 */
const STT_CAPABLE_IDS: ReadonlySet<string> = new Set(['openai', 'local']);

/** Whether a provider id can perform speech-to-text transcription. */
export function supportsStt(providerId: string): boolean {
  return STT_CAPABLE_IDS.has(providerId);
}

/**
 * Whether a single registered provider is available for a capability right now.
 *
 * Availability is keyed off the descriptor's `keyless` flag — never a literal
 * provider id — so any keyless provider (not just the id 'local') is handled by
 * the same rule (Task 22.6):
 *   - a keyless provider's availability comes SOLELY from `isLocalConfigured()`
 *     (local-config, R43.2); the key vault is never consulted for it, because a
 *     keyless provider stores no key (R43.2);
 *   - a keyed provider's availability comes SOLELY from the vault, i.e. it is
 *     available once its key has been stored (R5.1).
 */
async function isAvailable(
  provider: { readonly id: string; readonly keyless?: boolean },
  keyVault: KeyVault,
): Promise<boolean> {
  // Keyless providers (e.g. the self-hosted Local Provider) never touch the
  // vault: their readiness is the saved local-config (base URL/model), R43.2.
  if (provider.keyless) {
    return isLocalConfigured();
  }
  return keyVault.has(provider.id);
}

/**
 * List the providers the user may currently select for a capability (R44.1).
 *
 * For `chat`, every registered provider that is available (keyed-with-key or
 * configured keyless) qualifies. For `stt`, only available providers that also
 * have a speech-to-text client qualify. The result preserves the registry's
 * registration order so the first entry is a sensible default selection.
 */
export async function listAvailableProviders(
  providerManager: ProviderManager,
  keyVault: KeyVault,
  capability: ProviderCapability,
): Promise<AvailableProvider[]> {
  const available: AvailableProvider[] = [];
  for (const descriptor of providerManager.listProviders()) {
    if (capability === 'stt' && !supportsStt(descriptor.id)) {
      continue;
    }
    if (await isAvailable(descriptor, keyVault)) {
      available.push({ id: descriptor.id, displayName: descriptor.displayName });
    }
  }
  return available;
}
