// Unit tests for PhaseStepper component (task 33.3 — R67.2, R67.3).
//
// Rendered to static markup (node environment) — asserts structural elements,
// status badges, current-phase highlighting, and recommended-next indicator.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createI18n } from '@core/locale';
import { PhaseStepper } from './PhaseStepper';
import type { PhaseView } from './phase-wizard-controller';

const PHASES: PhaseView[] = [
  { phase: 'ingest', index: 0, status: 'complete', current: false },
  { phase: 'skill-map', index: 1, status: 'in-progress', current: true },
  { phase: 'role-discovery', index: 2, status: 'pending', current: false },
  { phase: 'interview-coaching', index: 3, status: 'pending', current: false },
  { phase: 'output', index: 4, status: 'pending', current: false },
  { phase: 'memory', index: 5, status: 'pending', current: false },
];

const render = async (
  phases = PHASES,
  currentPhase = 'skill-map',
  orientation?: 'vertical' | 'horizontal',
) => {
  const i18n = await createI18n('en');
  const t = i18n.t.bind(i18n);
  const onPhaseClick = vi.fn();
  const markup = renderToStaticMarkup(
    <PhaseStepper
      phases={phases}
      currentPhase={currentPhase}
      onPhaseClick={onPhaseClick}
      t={t}
      orientation={orientation}
    />,
  );
  return { markup, t, onPhaseClick };
};

describe('PhaseStepper — structure (R67.2)', () => {
  it('renders a semantic ordered list with aria-label', async () => {
    const { markup, t } = await render();
    expect(markup).toContain('<ol');
    expect(markup).toContain(`aria-label="${t('stepper.label')}"`);
  });

  it('renders a list item for each phase', async () => {
    const { markup } = await render();
    const liCount = (markup.match(/<li/g) ?? []).length;
    expect(liCount).toBe(6);
  });

  it('renders localised phase names from externalised strings', async () => {
    const { markup, t } = await render();
    expect(markup).toContain(t('wizard.phase.ingest'));
    expect(markup).toContain(t('wizard.phase.skill-map'));
    expect(markup).toContain(t('wizard.phase.role-discovery'));
    expect(markup).toContain(t('wizard.phase.interview-coaching'));
    expect(markup).toContain(t('wizard.phase.output'));
    // "Memory & Maintenance" has an ampersand that gets HTML-encoded.
    // Check the raw key resolves and the encoded form is in the markup.
    expect(t('wizard.phase.memory')).toBe('Memory & Maintenance');
    expect(markup).toContain('Memory &amp; Maintenance');
  });
});

describe('PhaseStepper — status badges (R67.2)', () => {
  it('renders the "Done" badge for a complete phase', async () => {
    const { markup, t } = await render();
    expect(markup).toContain(t('stepper.status.done'));
  });

  it('renders the "In progress" badge for the current phase', async () => {
    const { markup, t } = await render();
    expect(markup).toContain(t('stepper.status.inProgress'));
  });

  it('renders "Not started" badge for pending phases', async () => {
    const { markup, t } = await render();
    expect(markup).toContain(t('stepper.status.notStarted'));
  });
});

describe('PhaseStepper — current phase highlighting (R67.2)', () => {
  it('marks the current phase button with variant="primary" and aria-current="step"', async () => {
    const { markup } = await render();
    expect(markup).toContain('aria-current="step"');
    // The primary button should be present for the current phase
    expect(markup).toContain('data-variant="primary"');
  });

  it('marks non-current phase buttons with variant="secondary"', async () => {
    const { markup } = await render();
    expect(markup).toContain('data-variant="secondary"');
  });
});

describe('PhaseStepper — recommended next indicator (R67.3)', () => {
  it('shows the "→" recommended indicator on the first pending phase after a complete phase', async () => {
    // Phases where ingest + skill-map are complete, role-discovery is pending
    // → role-discovery should be recommended.
    const phasesWithRecommended: PhaseView[] = [
      { phase: 'ingest', index: 0, status: 'complete', current: false },
      { phase: 'skill-map', index: 1, status: 'complete', current: false },
      { phase: 'role-discovery', index: 2, status: 'pending', current: false },
      { phase: 'interview-coaching', index: 3, status: 'pending', current: false },
      { phase: 'output', index: 4, status: 'pending', current: false },
      { phase: 'memory', index: 5, status: 'pending', current: false },
    ];
    const { markup, t } = await render(phasesWithRecommended, 'role-discovery');
    // The "→ recommended" locale value includes the arrow character.
    expect(markup).toContain(`aria-label="${t('stepper.recommended')}"`);
    expect(markup).toContain('→');
  });

  it('does not show any recommended indicator when no phase is complete', async () => {
    const allPending: PhaseView[] = PHASES.map((p) => ({
      ...p,
      status: 'pending' as const,
      current: p.phase === 'ingest',
    }));
    const { markup, t } = await render(allPending, 'ingest');
    expect(markup).not.toContain(`aria-label="${t('stepper.recommended')}"`);
  });

  it('does not show recommended indicator when all phases are complete', async () => {
    const allComplete: PhaseView[] = PHASES.map((p) => ({
      ...p,
      status: 'complete' as const,
      current: p.phase === 'memory',
    }));
    const { markup, t } = await render(allComplete, 'memory');
    expect(markup).not.toContain(`aria-label="${t('stepper.recommended')}"`);
  });
});

describe('PhaseStepper — orientation', () => {
  it('defaults to vertical (column) layout', async () => {
    const { markup } = await render();
    expect(markup).toContain('flex-direction:column');
  });

  it('renders horizontal (row) layout when orientation is "horizontal"', async () => {
    const { markup } = await render(PHASES, 'skill-map', 'horizontal');
    expect(markup).toContain('flex-direction:row');
  });
});
