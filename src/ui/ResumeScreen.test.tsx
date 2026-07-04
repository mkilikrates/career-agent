// Unit tests for the ResumeScreen component (task 33.5 — R69.1–R69.5).
//
// Rendered to static markup (node environment, no DOM event loop) — asserts
// that all structural elements are present, externalised strings resolve, and
// the outstanding-items list renders correctly for both empty and populated cases.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createI18n } from '@core/locale';
import type { OutstandingItem } from '@core/orchestrator';
import { ResumeScreen } from './ResumeScreen';

const defaultProps = () => ({
  currentPhase: 'ingest' as string,
  outstanding: [] as OutstandingItem[],
  onContinue: vi.fn(),
  onGoToSettings: vi.fn(),
  onStartFresh: vi.fn(),
});

const render = async (overrides: Partial<ReturnType<typeof defaultProps>> = {}) => {
  const i18n = await createI18n('en');
  const t = i18n.t.bind(i18n);
  const props = { ...defaultProps(), ...overrides };
  const markup = renderToStaticMarkup(
    <ResumeScreen t={t} {...props} />,
  );
  return { markup, t, props };
};

describe('ResumeScreen — structure (R69.1, R69.2)', () => {
  it('renders the "Welcome back" heading from externalised strings', async () => {
    const { markup, t } = await render();
    expect(markup).toContain(t('views.resume.heading'));
    expect(t('views.resume.heading')).not.toBe('views.resume.heading');
  });

  it('renders the intro paragraph', async () => {
    const { markup, t } = await render();
    expect(markup).toContain(t('views.resume.intro'));
  });

  it('renders the last-active phase with the localised phase name', async () => {
    const { markup, t } = await render({ currentPhase: 'skill-map' });
    const phaseName = t('wizard.phase.skill-map');
    expect(markup).toContain(phaseName);
  });
});

describe('ResumeScreen — outstanding items (R69.3)', () => {
  it('shows "nothing outstanding" when the list is empty', async () => {
    const { markup, t } = await render({ outstanding: [] });
    expect(markup).toContain(t('wizard.outstanding.none'));
  });

  it('renders each outstanding item with its kind label and detail', async () => {
    const items: OutstandingItem[] = [
      { kind: 'unanswered-question', ref: 'Q-01', detail: 'Interview SRE: question Q-01 is unanswered.' },
      { kind: 'unresolved-conflict', ref: 'email', detail: 'Unresolved conflict on field email.' },
    ];
    const { markup, t } = await render({ outstanding: items });
    expect(markup).toContain(t('wizard.outstanding.unanswered-question'));
    expect(markup).toContain('Interview SRE: question Q-01 is unanswered.');
    expect(markup).toContain(t('wizard.outstanding.unresolved-conflict'));
    expect(markup).toContain('Unresolved conflict on field email.');
    // Should NOT show the "none" message.
    expect(markup).not.toContain(t('wizard.outstanding.none'));
  });

  it('renders outstanding items in a list element', async () => {
    const items: OutstandingItem[] = [
      { kind: 'flagged-talking-point', ref: 'STAR-01', detail: 'Flagged.' },
    ];
    const { markup } = await render({ outstanding: items });
    expect(markup).toContain('<ul');
    expect(markup).toContain('<li');
  });
});

describe('ResumeScreen — actions (R69.4, R69.5)', () => {
  it('renders a primary "Continue" button', async () => {
    const { markup, t } = await render();
    expect(markup).toContain(t('views.resume.continue'));
    expect(markup).toContain('data-variant="primary"');
  });

  it('renders a secondary "Go to Settings" button', async () => {
    const { markup, t } = await render();
    expect(markup).toContain(t('views.resume.goToSettings'));
    expect(markup).toContain('data-variant="secondary"');
  });

  it('renders a danger "Start fresh" button', async () => {
    const { markup, t } = await render();
    expect(markup).toContain(t('views.resume.startFresh'));
    expect(markup).toContain('data-variant="danger"');
  });
});
