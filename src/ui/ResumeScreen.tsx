// Resume screen (@ui) — task 33.5 (R69.1–R69.5).
//
// The return-visit page shown when a persisted session exists. Displays a
// "Welcome back" heading, last-active phase, outstanding-items list, and
// actions: Continue (primary), Go to Settings, Start fresh (danger, with
// window.confirm). All strings come from the externalised locale files (R41.8).

import type { TFunction } from 'i18next';
import type { OutstandingItem } from '@core/orchestrator';
import { ResponsiveContainer, Stack, Row, Button } from './design-system';
import { tokens } from './design-system';

export interface ResumeScreenProps {
  /** The i18n translator bound to the active Session Language. */
  readonly t: TFunction;
  /** The current (last-active) pipeline phase slug. */
  readonly currentPhase: string;
  /** Outstanding items from the session summary (R35.1). */
  readonly outstanding: readonly OutstandingItem[];
  /** Navigate to the pipeline at the current phase. */
  readonly onContinue: () => void;
  /** Navigate to the settings view. */
  readonly onGoToSettings: () => void;
  /** Clear the Memory Store and start a new session (after confirmation). */
  readonly onStartFresh: () => void;
}

/**
 * The resume screen rendered when the user returns to an existing session
 * (R69.1–R69.5). It summarises where they left off and lets them continue,
 * adjust settings, or start fresh (with confirmation).
 */
export function ResumeScreen({
  t,
  currentPhase,
  outstanding,
  onContinue,
  onGoToSettings,
  onStartFresh,
}: ResumeScreenProps) {
  const handleStartFresh = () => {
    const confirmed = window.confirm(t('views.resume.startFreshConfirm'));
    if (confirmed) {
      onStartFresh();
    }
  };

  return (
    <ResponsiveContainer>
      <main>
        <Stack gap="md">
          <h1>{t('views.resume.heading')}</h1>
          <p>{t('views.resume.intro')}</p>
          <p
            style={{
              fontFamily: tokens.typography.fontFamily.base,
              fontSize: tokens.typography.scale.sm,
              color: tokens.colour.muted,
            }}
          >
            {t('views.resume.lastActive', { phase: t(`wizard.phase.${currentPhase}`) })}
          </p>

          {/* Outstanding items section */}
          <section aria-labelledby="resume-outstanding-heading">
            <h2
              id="resume-outstanding-heading"
              style={{
                fontFamily: tokens.typography.fontFamily.base,
                fontSize: tokens.typography.scale.md,
                fontWeight: tokens.typography.weight.semibold,
              }}
            >
              {t('views.resume.outstandingHeading')}
            </h2>
            {outstanding.length === 0 ? (
              <p>{t('wizard.outstanding.none')}</p>
            ) : (
              <ul>
                {outstanding.map((item) => (
                  <li key={`${item.kind}-${item.ref}`}>
                    {t(`wizard.outstanding.${item.kind}`)}: {item.detail}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Actions */}
          <Row>
            <Button variant="primary" onClick={onContinue}>
              {t('views.resume.continue')}
            </Button>
            <Button variant="secondary" onClick={onGoToSettings}>
              {t('views.resume.goToSettings')}
            </Button>
            <Button variant="danger" onClick={handleStartFresh}>
              {t('views.resume.startFresh')}
            </Button>
          </Row>
        </Stack>
      </main>
    </ResponsiveContainer>
  );
}
