// Settings page (@ui) — task 33.6 (R67.4).
//
// A dedicated Settings view that groups the provider setup, provider selection,
// language, and privacy/consent components into labelled Card sections. It
// COMPOSES existing components — it does not re-implement them.
//
// Accessible from the sidebar nav at all times via the "Back to pipeline"
// button, and rendered when `appView.kind === 'settings'`.

import type { ReactNode } from 'react';
import type { ProviderSetupProps } from './ProviderSetup';
import type { ProviderSelectionProps } from './ProviderSelection';
import type { PrivacyStatementProps } from './PrivacyStatement';
import type { SessionLanguage } from '@core/locale';
import { SUPPORTED_LANGUAGES } from '@core/locale';
import { ProviderSetup } from './ProviderSetup';
import { ProviderSelection } from './ProviderSelection';
import { PrivacyStatement } from './PrivacyStatement';
import { ResponsiveContainer, Stack, Card, Button, Select, tokens } from './design-system';

export interface SettingsPageProps {
  /** Bound i18n translator (resolves externalised strings, R41.8). */
  readonly t: (key: string, options?: Record<string, unknown>) => string;
  /** The confirmed Session Language. */
  readonly language: SessionLanguage;
  /** Callback when the user changes the session language from the selector. */
  readonly onLanguageChange: (lang: SessionLanguage) => void;
  /** Props forwarded to the ProviderSetup component. */
  readonly providerSetupProps: ProviderSetupProps;
  /** Props forwarded to the ProviderSelection component. */
  readonly providerSelectionProps: ProviderSelectionProps;
  /** Props forwarded to the PrivacyStatement component. */
  readonly privacyProps: PrivacyStatementProps;
  /** Navigate back to the pipeline view. */
  readonly onBackToPipeline: () => void;
  /** Custom label for the back button (e.g. "Continue to upload documents" on first run). */
  readonly backLabel?: string;
  /** The PayloadPreviewModal node (rendered when a preview is pending). */
  readonly pendingPreview?: ReactNode;
}

/**
 * The dedicated Settings view (R67.4). Groups provider, language, and privacy
 * settings into labelled Card sections with consistent design-token spacing.
 */
export function SettingsPage({
  t,
  language,
  onLanguageChange,
  providerSetupProps,
  providerSelectionProps,
  privacyProps,
  onBackToPipeline,
  backLabel,
  pendingPreview,
}: SettingsPageProps) {
  return (
    <ResponsiveContainer>
      <main>
        <Stack gap="lg">
          <h1>{t('views.settings.heading')}</h1>

          {/* Section: Providers */}
          <Card aria-label={t('views.settings.providerSection')}>
            <Stack gap="md">
              <h2 style={{ margin: 0, fontFamily: tokens.typography.fontFamily.base, fontSize: tokens.typography.scale.lg }}>
                {t('views.settings.providerSection')}
              </h2>
              <ProviderSetup {...providerSetupProps} />
              <p style={{ fontStyle: 'italic', color: tokens.colour.muted, margin: 0 }}>
                {t('views.settings.sttNote')}
              </p>
              <ProviderSelection {...providerSelectionProps} />
            </Stack>
          </Card>

          {/* Section: Language */}
          <Card aria-label={t('views.settings.languageSection')}>
            <Stack gap="md">
              <h2 style={{ margin: 0, fontFamily: tokens.typography.fontFamily.base, fontSize: tokens.typography.scale.lg }}>
                {t('views.settings.languageSection')}
              </h2>
              <Select
                label={t('language.choosePrompt')}
                value={language}
                onChange={(e) => onLanguageChange(e.target.value as SessionLanguage)}
              >
                {SUPPORTED_LANGUAGES.map((lng) => (
                  <option key={lng} value={lng}>
                    {t(`language.names.${lng}`)}
                  </option>
                ))}
              </Select>
              <p style={{ margin: 0 }}>
                <small>{t('language.applied', { language: t(`language.names.${language}`) })}</small>
              </p>
            </Stack>
          </Card>

          {/* Section: Privacy & consent */}
          <Card aria-label={t('views.settings.privacySection')}>
            <Stack gap="md">
              <h2 style={{ margin: 0, fontFamily: tokens.typography.fontFamily.base, fontSize: tokens.typography.scale.lg }}>
                {t('views.settings.privacySection')}
              </h2>
              <PrivacyStatement {...privacyProps} />
            </Stack>
          </Card>

          {/* Back to pipeline / Continue */}
          <Button onClick={onBackToPipeline}>
            {backLabel ?? t('views.settings.backToPipeline')}
          </Button>

          {/* Outbound payload preview modal (when active) */}
          {pendingPreview}
        </Stack>
      </main>
    </ResponsiveContainer>
  );
}
