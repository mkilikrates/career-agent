// Navigation sidebar (@ui) — task 33.2 (R67.2, R67.4, R68.1, R68.3).
//
// Persistent sidebar shown in the pipeline view containing:
//   - Phase stepper (with status badges and recommended-next indicator)
//   - Settings link
//   - Save & Exit button
//
// Collapses to a top bar on narrow viewports.

import type { Phase } from '@core/orchestrator';
import type { PhaseView } from './phase-wizard-controller';
import { PhaseStepper } from './PhaseStepper';
import { Button, tokens } from './design-system';

export interface NavSidebarProps {
  /** Phase views from the controller. */
  readonly phases: readonly PhaseView[];
  /** The current phase id. */
  readonly currentPhase: string;
  /** Navigate to a phase. */
  readonly onPhaseSelect: (phase: Phase) => void;
  /** Navigate to the Settings page. */
  readonly onGoToSettings: () => void;
  /** Trigger Save & Exit (Memory Store export). */
  readonly onSaveExit: () => void;
  /** Trigger Save & Exit as zip (R72.4). */
  readonly onSaveExitZip?: () => void;
  /** Bound i18n translator. */
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}

export function NavSidebar({
  phases,
  currentPhase,
  onPhaseSelect,
  onGoToSettings,
  onSaveExit,
  onSaveExitZip,
  t,
}: NavSidebarProps) {
  return (
    <aside
      data-nav-sidebar
      style={{
        minWidth: '200px',
        maxWidth: '240px',
        padding: tokens.spacing.md,
        borderRight: `1px solid ${tokens.colour.border}`,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing.md,
        background: tokens.colour.surface,
      }}
    >
      <PhaseStepper
        phases={phases}
        currentPhase={currentPhase}
        onPhaseClick={onPhaseSelect}
        t={t}
      />

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: tokens.spacing.sm }}>
        <Button variant="secondary" onClick={onGoToSettings} style={{ width: '100%' }}>
          ⚙ {t('views.pipeline.goToSettings')}
        </Button>
        <Button variant="secondary" onClick={onSaveExit} style={{ width: '100%' }}>
          💾 {t('saveExit.button')}
        </Button>
        {onSaveExitZip && (
          <Button variant="secondary" onClick={onSaveExitZip} style={{ width: '100%' }}>
            📦 {t('saveExit.downloadZip')}
          </Button>
        )}
      </div>
    </aside>
  );
}
