// Phase stepper component (@ui) — task 33.3 (R67.2, R67.3).
//
// A stepper showing each pipeline phase with: localised name, status badge
// (not started / in progress / done), highlight on the current phase, and a
// subtle "→ recommended" indicator on the next incomplete phase after a complete
// phase. Clicking a step navigates to that phase.

import type { Phase } from '@core/orchestrator';
import { PHASE_SEQUENCE } from '@core/orchestrator';
import type { PhaseView } from './phase-wizard-controller';
import { tokens } from './design-system';

export interface PhaseStepperProps {
  /** Phase views from the controller. */
  readonly phases: readonly PhaseView[];
  /** The current phase id (determines primary highlight). */
  readonly currentPhase: string;
  /** Navigate to a phase. */
  readonly onPhaseClick: (phase: Phase) => void;
  /** Bound i18n translator. */
  readonly t: (key: string, options?: Record<string, unknown>) => string;
  /** Layout direction: vertical (default) or horizontal. */
  readonly orientation?: 'vertical' | 'horizontal';
}

/** Map PhaseStatus to a display badge key. */
const statusBadge = (status: string, t: PhaseStepperProps['t']): string => {
  switch (status) {
    case 'complete':
      return t('stepper.status.done');
    case 'in-progress':
      return t('stepper.status.inProgress');
    default:
      return t('stepper.status.notStarted');
  }
};

/**
 * Find the recommended next phase: the first 'pending' phase that comes after
 * at least one 'complete' phase in pipeline order.
 */
function recommendedPhase(phases: readonly PhaseView[]): Phase | null {
  let seenComplete = false;
  for (const p of PHASE_SEQUENCE) {
    const view = phases.find((v) => v.phase === p);
    if (!view) continue;
    if (view.status === 'complete') {
      seenComplete = true;
    } else if (seenComplete && view.status === 'pending') {
      return view.phase;
    }
  }
  return null;
}

export function PhaseStepper({
  phases,
  currentPhase,
  onPhaseClick,
  t,
  orientation = 'vertical',
}: PhaseStepperProps) {
  const recommended = recommendedPhase(phases);
  const isHorizontal = orientation === 'horizontal';

  return (
    <nav aria-label={t('stepper.label')}>
      <ol
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'flex',
          flexDirection: isHorizontal ? 'row' : 'column',
          gap: tokens.spacing.xs,
          flexWrap: isHorizontal ? 'wrap' : undefined,
        }}
      >
        {phases.map((view) => {
          const isCurrent = view.phase === currentPhase;
          const isRecommended = view.phase === recommended;
          const variant = isCurrent ? 'primary' : 'secondary';
          return (
            <li key={view.phase}>
              <button
                type="button"
                data-variant={variant}
                onClick={() => onPhaseClick(view.phase)}
                aria-current={isCurrent ? 'step' : undefined}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: tokens.spacing.xs,
                  padding: `${tokens.spacing.xs} ${tokens.spacing.sm}`,
                  borderRadius: tokens.radius.sm,
                  border: `1px solid ${tokens.colour.accent}`,
                  background: isCurrent ? tokens.colour.accent : tokens.colour.bg,
                  color: isCurrent ? tokens.colour.onAccent : tokens.colour.accent,
                  cursor: 'pointer',
                  fontWeight: isCurrent ? 'bold' : 'normal',
                  fontSize: tokens.typography.scale.sm,
                  fontFamily: tokens.typography.fontFamily.base,
                  width: isHorizontal ? undefined : '100%',
                  textAlign: 'left',
                }}
              >
                <span>{t(`wizard.phase.${view.phase}`)}</span>
                <span
                  style={{
                    fontSize: tokens.typography.scale.xs,
                    marginLeft: 'auto',
                    opacity: 0.8,
                  }}
                >
                  {statusBadge(view.status, t)}
                </span>
                {isRecommended && (
                  <span aria-label={t('stepper.recommended')}>→</span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
