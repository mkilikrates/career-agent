// AssistChoice control (@ui) — the shared opt-in-first AI choice surfaced on
// every AI-assistable phase screen (task 25.2; design "Where the choice is
// surfaced").
//
// Each phase screen (Skill Map, Role Discovery, Coaching, Output) renders this
// BEFORE running its operation so the user picks `script-only` vs
// `script + AI assist` up front (R14.5, R20.4, R22.4, R28.5, R30.7, R47.7), and
// it shows the network/privacy label for the destination alongside the choice
// (R58.5): a local on-device call has no third-party egress (R7.6) whereas a
// keyed cloud provider is a third-party network call. The chosen
// {@link AssistMode} is lifted to the screen, which routes it (with the
// destination) through `runAssist` from `@core/assist`.
//
// This is a PURE presentation component: it reaches no provider and makes no
// network call (the destination/availability are computed by the shell and
// passed in), preserving the Egress-Gate-only boundary (Requirements 6, 7).

import type { AssistMode } from '@core/assist';
import type { DestinationKind } from '@core/egress';

export interface AssistChoiceProps {
  /** The user's current pre-operation selection. */
  readonly mode: AssistMode;
  /** Change the selected mode. */
  readonly onMode: (mode: AssistMode) => void;
  /** Whether an AI provider is configured for this capability (R47.7). */
  readonly aiAvailable: boolean;
  /** The chosen provider id for the destination label, or null when none. */
  readonly provider: string | null;
  /** Whether the destination is keyless local on-device or keyed cloud (R7.6). */
  readonly destinationKind: DestinationKind | null;
  /** Bound i18n translator (resolves externalised strings, R41.8). */
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}

/**
 * The opt-in-first choice + destination network/privacy label for one phase.
 * When no AI provider is available only the (selected) script-only option is
 * offered, with a short hint; the AI option is disabled.
 */
export function AssistChoice({
  mode,
  onMode,
  aiAvailable,
  provider,
  destinationKind,
  t,
}: AssistChoiceProps): JSX.Element {
  const isLocal = destinationKind === 'keyless-local';
  const aiSelected = aiAvailable && (mode === 'ai-assisted' || mode === 'ai-only');

  return (
    <fieldset data-assist-choice data-mode={mode} style={{ border: 'none', padding: 0, margin: 0 }}>
      <legend>
        <small>{t('assist.modeLegend')}</small>
      </legend>

      <label style={{ marginRight: '1rem' }}>
        <input
          type="radio"
          name="assist-mode"
          value="script-only"
          checked={mode === 'script-only'}
          onChange={() => onMode('script-only')}
        />{' '}
        {t('assist.scriptOnly')}
      </label>

      <label style={{ marginRight: '1rem' }}>
        <input
          type="radio"
          name="assist-mode"
          value="ai-assisted"
          checked={mode === 'ai-assisted'}
          disabled={!aiAvailable}
          onChange={() => onMode('ai-assisted')}
        />{' '}
        {t('assist.aiAssisted')}
      </label>

      <label>
        <input
          type="radio"
          name="assist-mode"
          value="ai-only"
          checked={mode === 'ai-only'}
          disabled={!aiAvailable}
          onChange={() => onMode('ai-only')}
        />{' '}
        {t('assist.aiOnly')}
      </label>

      <br />
      {!aiAvailable ? (
        <small data-assist-label="unavailable">{t('assist.unavailable')}</small>
      ) : aiSelected ? (
        <small data-assist-label={isLocal ? 'local' : 'third-party'}>
          {t(isLocal ? 'assist.networkLocal' : 'assist.networkThirdParty', {
            provider: provider ?? '',
          })}
        </small>
      ) : (
        <small data-assist-label="script-only">{t('assist.scriptOnlyHint')}</small>
      )}
    </fieldset>
  );
}
