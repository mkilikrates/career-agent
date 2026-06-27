// Per-capability provider selection UI (@ui) — Requirement 44.
//
// Lets the user pick the chat/LLM provider and the speech-to-text provider
// INDEPENDENTLY (R44.1). Two dropdowns each list only the providers currently
// available for that capability (a keyed provider with a stored key, or the
// keyless Local Provider once configured). The selected chat provider is
// threaded into AI-assist/orchestrator calls and the selected STT provider into
// the coaching audio path by the shell; this component only surfaces the
// choice. When no provider is available for a capability, a short hint replaces
// the dropdown. Every user-facing string is read from the externalised locale
// resources via `t(...)` (R41.8).
//
// Boundary note: this is a pure presentation component. It reaches no provider
// and makes no network call; availability is computed by the shell and passed
// in, preserving the Egress-Gate-only boundary (Requirements 6, 7).

import type { AvailableProvider } from './provider-availability';
import { Select } from './design-system';

export interface ProviderSelectionProps {
  /** Providers available for chat/LLM operations (R44.1). */
  readonly chatProviders: readonly AvailableProvider[];
  /** Providers available for speech-to-text transcription (R44.1). */
  readonly sttProviders: readonly AvailableProvider[];
  /** The selected chat provider id, or null when none is available. */
  readonly chatProvider: string | null;
  /** The selected STT provider id, or null when none is available. */
  readonly sttProvider: string | null;
  /** Change the chat provider selection. */
  readonly onChatProvider: (id: string) => void;
  /** Change the STT provider selection. */
  readonly onSttProvider: (id: string) => void;
  /** Bound i18n translator (resolves externalised strings, R41.8). */
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}

/** One labelled capability dropdown, or a hint when nothing is available. */
function CapabilitySelect({
  label,
  emptyHint,
  providers,
  selected,
  onSelect,
  testId,
}: {
  readonly label: string;
  readonly emptyHint: string;
  readonly providers: readonly AvailableProvider[];
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
  readonly testId: string;
}): JSX.Element {
  if (providers.length === 0) {
    return (
      <p data-provider-capability={testId} data-available="0">
        <small>{emptyHint}</small>
      </p>
    );
  }
  return (
    <span data-provider-capability={testId} data-available={String(providers.length)}>
      <Select label={label} value={selected ?? ''} onChange={(e) => onSelect(e.target.value)}>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.displayName}
          </option>
        ))}
      </Select>
    </span>
  );
}

/** The per-capability provider selection screen (R44). */
export function ProviderSelection({
  chatProviders,
  sttProviders,
  chatProvider,
  sttProvider,
  onChatProvider,
  onSttProvider,
  t,
}: ProviderSelectionProps): JSX.Element {
  return (
    <section aria-label={t('provider.selection.heading')} data-provider-selection>
      <h3>{t('provider.selection.heading')}</h3>
      <p>{t('provider.selection.intro')}</p>
      <p>
        <CapabilitySelect
          label={t('provider.selection.chatLabel')}
          emptyHint={t('provider.selection.noneChat')}
          providers={chatProviders}
          selected={chatProvider}
          onSelect={onChatProvider}
          testId="chat"
        />
      </p>
      <p>
        <CapabilitySelect
          label={t('provider.selection.sttLabel')}
          emptyHint={t('provider.selection.noneStt')}
          providers={sttProviders}
          selected={sttProvider}
          onSelect={onSttProvider}
          testId="stt"
        />
      </p>
    </section>
  );
}
