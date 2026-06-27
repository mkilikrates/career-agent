// Phase wizard and review screens (@ui) — task 19.1, refreshed for the shared
// design system (task 29, R58).
//
// The thin presentation boundary over {@link PhaseWizardController}. It renders:
//   * the six-phase navigator — every phase is selectable so the user can jump
//     directly to ANY phase (the PHASE HUB, R35.2), with its coarse resume
//     status surfaced from the SessionSummary;
//   * the current phase's review screen, wrapped in the shared <PhaseChrome> so
//     every pipeline screen shows the current phase name plus next/previous
//     controls (R58.2), with a "Confirm and continue" action that persists the
//     confirmed step before advancing (R35.2);
//   * the outstanding-items list from the resume summary (R35.1).
//
// All orchestration lives in the controller; this component only dispatches user
// intent into it and re-renders when it changes. Every user-facing string is
// read from the externalised locale resources via `t(...)` (R41.8); none are
// hardcoded here. Controls come from the shared component library, so they
// inherit the design tokens, keyboard operability, and focus indicator (R58.1,
// R58.4, R58.10). No provider client is imported — provider access exists only
// inside the orchestrator behind the Egress Gate (Requirements 6, 7).

import { useEffect, useReducer, type ReactNode } from 'react';
import { PHASE_SEQUENCE, type Phase } from '@core/orchestrator';
import type { PhaseWizardController } from './phase-wizard-controller';
import { Badge, Button, PhaseChrome } from './design-system';

export interface PhaseWizardProps {
  /** The controller driving the orchestrator (phase hub + confirm/advance). */
  readonly controller: PhaseWizardController;
  /** Bound i18n translator (resolves externalised strings, R41.8). */
  readonly t: (key: string, options?: Record<string, unknown>) => string;
  /**
   * Optional per-phase body renderer. The wizard renders the returned node
   * inside the current phase's review screen, so each phase can surface its own
   * working UI (ingest, skill map, roles, coaching, output, memory) while the
   * wizard owns navigation and the confirm/advance step.
   */
  readonly renderPhase?: (phase: Phase) => ReactNode;
}

/** Render the phase navigator, the current review screen, and outstanding items. */
export function PhaseWizard({ controller, t, renderPhase }: PhaseWizardProps) {
  // Re-render whenever the controller (orchestrator phase / summary) changes.
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => controller.subscribe(forceRender), [controller]);

  const phases = controller.phases();
  const current = controller.currentPhase();
  const outstanding = controller.outstanding();
  const currentLabel = t(`wizard.phase.${current}`);

  // Neighbours for the shared <PhaseChrome> previous/next controls (R58.2).
  const currentIndex = PHASE_SEQUENCE.indexOf(current);
  const previous = currentIndex > 0 ? PHASE_SEQUENCE[currentIndex - 1] : null;
  const next =
    currentIndex >= 0 && currentIndex < PHASE_SEQUENCE.length - 1
      ? PHASE_SEQUENCE[currentIndex + 1]
      : null;

  return (
    <section aria-label={t('wizard.heading')}>
      <h2>{t('wizard.heading')}</h2>
      <p>{t('wizard.intro')}</p>

      {/* Phase hub (R35.2): jump directly to any phase from any phase. */}
      <nav aria-label={t('wizard.navLabel')}>
        <ol>
          {phases.map((view) => (
            <li key={view.phase}>
              <Button
                variant={view.current ? 'primary' : 'secondary'}
                aria-current={view.current ? 'step' : undefined}
                disabled={view.current}
                onClick={() => void controller.goToPhase(view.phase)}
              >
                {t(`wizard.phase.${view.phase}`)}
              </Button>{' '}
              <Badge>
                <span data-status={view.status}>{t(`wizard.status.${view.status}`)}</span>
              </Badge>
            </li>
          ))}
        </ol>
      </nav>

      {/* Current phase review screen, wrapped in the shared phase chrome (R58.2). */}
      <PhaseChrome
        phaseName={t('wizard.currentPhase', { phase: currentLabel })}
        previousLabel={
          previous
            ? t('wizard.goToPrevious', { phase: t(`wizard.phase.${previous}`) })
            : t('wizard.previousPhase')
        }
        nextLabel={
          next ? t('wizard.goToNext', { phase: t(`wizard.phase.${next}`) }) : t('wizard.nextPhase')
        }
        onPrevious={previous ? () => void controller.goToPhase(previous) : undefined}
        onNext={next ? () => void controller.goToPhase(next) : undefined}
      >
        <div data-current-phase={current}>
          {/* The phase's own working UI, when provided by the host shell. */}
          {renderPhase ? renderPhase(current) : null}
          {controller.isFinalPhase() ? (
            <p>
              <small>{t('wizard.lastPhaseFinal')}</small>
            </p>
          ) : null}
          {/* Persist after every confirmed step (R35.2). */}
          <Button onClick={() => void controller.confirmStep()}>
            {t('wizard.confirmAndContinue')}
          </Button>
        </div>
      </PhaseChrome>

      {/* Outstanding-items union from the resume summary (R35.1). */}
      <section aria-label={t('wizard.outstanding.heading')}>
        <h3>{t('wizard.outstanding.heading')}</h3>
        {outstanding.length === 0 ? (
          <p>
            <small>{t('wizard.outstanding.none')}</small>
          </p>
        ) : (
          <ul>
            {outstanding.map((item) => (
              <li key={`${item.kind}-${item.ref}`}>
                <strong>{t(`wizard.outstanding.${item.kind}`)}</strong>: {item.detail}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
