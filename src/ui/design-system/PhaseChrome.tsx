// Shared phase chrome (@ui/design-system) — task 29.1 (R58.2).
//
// The reusable wrapper rendered on every one of the seven wizard screens
// (Provider Setup, Ingest, Skill Map, Role Discovery, Interview Coaching,
// Output, Memory & Maintenance). It surfaces, identically everywhere:
//   - the CURRENT PHASE NAME (R58.2);
//   - controls to move to the PREVIOUS and the NEXT phase (R58.2), consistent
//     with the wizard interface in Requirement 48.
//
// It is purely presentational: navigation is delegated to the supplied
// `onPrevious` / `onNext` callbacks (wired to the phase-wizard controller by the
// shell), so this component reaches no orchestrator or provider. All labels are
// passed in already-resolved from the externalised locale resources (R41.8).
// Built from the shared component library, so its controls inherit keyboard
// operability, the visible focus indicator, and the token styling (R58.1, R58.4,
// R58.10).

import type { ReactNode } from 'react';
import { tokens } from './tokens';
import { Button } from './components';
import { Row } from './Layout';

export interface PhaseChromeProps {
  /** The current phase name, surfaced as the chrome heading (R58.2). */
  readonly phaseName: string;
  /** Accessible label for the "previous phase" control (R58.2, R58.4). */
  readonly previousLabel: string;
  /** Accessible label for the "next phase" control (R58.2, R58.4). */
  readonly nextLabel: string;
  /** Navigate to the previous phase. When omitted, the control is disabled. */
  readonly onPrevious?: () => void;
  /** Navigate to the next phase. When omitted, the control is disabled. */
  readonly onNext?: () => void;
  /** The screen body. */
  readonly children: ReactNode;
}

/** Render the current phase name + previous/next controls around a screen. */
export function PhaseChrome({
  phaseName,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
  children,
}: PhaseChromeProps) {
  return (
    <section className="ca-phase-chrome" data-phase-chrome aria-label={phaseName}>
      <header
        className="ca-phase-chrome-header"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: tokens.spacing.sm,
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: `1px solid ${tokens.colour.border}`,
          paddingBottom: tokens.spacing.sm,
          marginBottom: tokens.spacing.md,
        }}
      >
        <h2
          data-phase-name
          style={{
            margin: 0,
            fontFamily: tokens.typography.fontFamily.base,
            fontSize: tokens.typography.scale.xl,
            fontWeight: tokens.typography.weight.bold,
            color: tokens.colour.text,
          }}
        >
          {phaseName}
        </h2>
        <Row>
          <Button
            variant="secondary"
            data-phase-nav="previous"
            aria-label={previousLabel}
            disabled={!onPrevious}
            onClick={onPrevious}
          >
            ← {previousLabel}
          </Button>
          <Button
            variant="secondary"
            data-phase-nav="next"
            aria-label={nextLabel}
            disabled={!onNext}
            onClick={onNext}
          >
            {nextLabel} →
          </Button>
        </Row>
      </header>
      <div className="ca-phase-chrome-body">{children}</div>
    </section>
  );
}
