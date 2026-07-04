// App shell layout (@ui) — task 33.2 (R67.2, R67.4, R68.1, R68.3).
//
// The structural wrapper for the pipeline view. Provides:
//   - Header: app title + save-status indicator
//   - Sidebar: NavSidebar (phase stepper + settings + save & exit)
//   - Main content area: renders one phase card at a time
//
// On narrow viewports the sidebar collapses above the main area.

import type { ReactNode } from 'react';
import type { Phase } from '@core/orchestrator';
import type { PhaseView } from './phase-wizard-controller';
import { NavSidebar } from './NavSidebar';
import { tokens } from './design-system';

export interface AppShellProps {
  /** The phase stepper data. */
  readonly phases: readonly PhaseView[];
  /** The current phase id. */
  readonly currentPhase: string;
  /** Navigate to a phase. */
  readonly onPhaseSelect: (phase: Phase) => void;
  /** Navigate to Settings. */
  readonly onGoToSettings: () => void;
  /** Trigger Save & Exit. */
  readonly onSaveExit: () => void;
  /** Save status text shown in the header. */
  readonly saveStatus: string;
  /** The main content (the current phase card). */
  readonly children: ReactNode;
  /** Bound i18n translator. */
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}

export function AppShell({
  phases,
  currentPhase,
  onPhaseSelect,
  onGoToSettings,
  onSaveExit,
  saveStatus,
  children,
  t,
}: AppShellProps) {
  return (
    <div
      data-app-shell
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
      }}
    >
      {/* Header */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `${tokens.spacing.sm} ${tokens.spacing.md}`,
          borderBottom: `1px solid ${tokens.colour.border}`,
          background: tokens.colour.bg,
        }}
      >
        <strong style={{ fontSize: tokens.typography.scale.lg }}>{t('app.title')}</strong>
        <small style={{ color: tokens.colour.muted }}>{saveStatus}</small>
      </header>

      {/* Body: sidebar + main */}
      <div
        style={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
        }}
      >
        <NavSidebar
          phases={phases}
          currentPhase={currentPhase}
          onPhaseSelect={onPhaseSelect}
          onGoToSettings={onGoToSettings}
          onSaveExit={onSaveExit}
          t={t}
        />
        <main
          style={{
            flex: 1,
            padding: tokens.spacing.lg,
            overflowY: 'auto',
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
