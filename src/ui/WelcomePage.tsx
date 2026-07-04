// Welcome Page (@ui) — task 33.4 (R66.1, R66.2, R66.3, R66.4, R66.5, R66.6, R66.7, R66.8).
//
// First-run-only page shown when no persisted session exists. Introduces the
// user to the 5-step pipeline, highlights the local-first privacy guarantee,
// and offers a single "Get started" CTA that transitions to the settings view.
// All user-facing strings are read from `locales/` via the `t` translator —
// there are no hardcoded strings here (R41.8).

import type { TFunction } from 'i18next';
import { ResponsiveContainer, Stack, Card, Button } from './design-system';
import { tokens } from './design-system';

export interface WelcomePageProps {
  /** i18n translator bound to the current Session Language. */
  readonly t: TFunction;
  /** Callback invoked when the user clicks "Get started" — transitions to settings view. */
  readonly onGetStarted: () => void;
}

/** The pipeline steps shown on the welcome page. */
const PIPELINE_STEPS = [
  'views.welcome.step1',
  'views.welcome.step2',
  'views.welcome.step3',
  'views.welcome.step4',
  'views.welcome.step5',
] as const;

/**
 * First-run welcome page (R66.1, R66.2). Shown only when no persisted session
 * exists. Presents the value proposition, a 5-step pipeline visual, a privacy
 * callout, and a single "Get started" button.
 */
export function WelcomePage({ t, onGetStarted }: WelcomePageProps) {
  return (
    <ResponsiveContainer>
      <main>
        <Stack gap="lg">
          {/* Heading (R66.3) */}
          <h1 style={{
            fontFamily: tokens.typography.fontFamily.base,
            fontSize: tokens.typography.scale.xxl,
            fontWeight: tokens.typography.weight.bold,
            lineHeight: tokens.typography.lineHeight.tight,
            color: tokens.colour.text,
            margin: 0,
          }}>
            {t('views.welcome.heading')}
          </h1>

          {/* Tagline (R66.4) */}
          <p style={{
            fontFamily: tokens.typography.fontFamily.base,
            fontSize: tokens.typography.scale.lg,
            fontWeight: tokens.typography.weight.medium,
            color: tokens.colour.muted,
            margin: 0,
          }}>
            {t('views.welcome.tagline')}
          </p>

          {/* Intro paragraph (R66.5) */}
          <p style={{
            fontFamily: tokens.typography.fontFamily.base,
            fontSize: tokens.typography.scale.base,
            lineHeight: tokens.typography.lineHeight.base,
            color: tokens.colour.text,
            margin: 0,
          }}>
            {t('views.welcome.intro')}
          </p>

          {/* 5-step pipeline visual (R66.6) */}
          <ol
            aria-label={t('wizard.navLabel')}
            style={{
              fontFamily: tokens.typography.fontFamily.base,
              fontSize: tokens.typography.scale.base,
              lineHeight: tokens.typography.lineHeight.base,
              color: tokens.colour.text,
              paddingLeft: tokens.spacing.xl,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: tokens.spacing.sm,
            }}
          >
            {PIPELINE_STEPS.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ol>

          {/* Privacy callout card (R66.7) */}
          <Card aria-label={t('privacy.statement.heading')} data-testid="privacy-callout">
            <p style={{
              fontFamily: tokens.typography.fontFamily.base,
              fontSize: tokens.typography.scale.base,
              lineHeight: tokens.typography.lineHeight.base,
              color: tokens.colour.text,
              margin: 0,
            }}>
              {t('views.welcome.privacyCallout')}
            </p>
          </Card>

          {/* Get started CTA (R66.8) */}
          <div>
            <Button variant="primary" onClick={onGetStarted}>
              {t('views.welcome.getStarted')}
            </Button>
          </div>
        </Stack>
      </main>
    </ResponsiveContainer>
  );
}
