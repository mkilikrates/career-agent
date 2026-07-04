// Unit tests for the WelcomePage component (task 33.4 — R66.1–R66.8).
//
// Rendered to static markup (node environment, no DOM event loop) — asserts
// that all structural elements are present and externalised strings resolve.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createI18n } from '@core/locale';
import { WelcomePage } from './WelcomePage';

const render = async (onGetStarted = vi.fn()) => {
  const i18n = await createI18n('en');
  const t = i18n.t.bind(i18n);
  const markup = renderToStaticMarkup(
    <WelcomePage t={t} onGetStarted={onGetStarted} />,
  );
  return { markup, t };
};

describe('WelcomePage — structure (R66.1, R66.2, R66.3)', () => {
  it('renders the heading from externalised strings', async () => {
    const { markup, t } = await render();
    expect(markup).toContain(t('views.welcome.heading'));
    // Must not fall back to the key itself.
    expect(t('views.welcome.heading')).not.toBe('views.welcome.heading');
  });

  it('renders the tagline', async () => {
    const { markup, t } = await render();
    expect(markup).toContain(t('views.welcome.tagline'));
  });

  it('renders the intro paragraph', async () => {
    const { markup, t } = await render();
    expect(markup).toContain(t('views.welcome.intro'));
  });
});

describe('WelcomePage — 5-step pipeline visual (R66.6)', () => {
  it('renders all five pipeline steps', async () => {
    const { markup, t } = await render();
    expect(markup).toContain(t('views.welcome.step1'));
    expect(markup).toContain(t('views.welcome.step2'));
    expect(markup).toContain(t('views.welcome.step3'));
    expect(markup).toContain(t('views.welcome.step4'));
    expect(markup).toContain(t('views.welcome.step5'));
  });

  it('renders the steps inside an ordered list with aria-label', async () => {
    const { markup } = await render();
    expect(markup).toContain('<ol');
    expect(markup).toContain('aria-label');
    expect(markup).toContain('<li');
  });
});

describe('WelcomePage — privacy callout card (R66.7)', () => {
  it('renders the privacy callout text', async () => {
    const { markup, t } = await render();
    expect(markup).toContain(t('views.welcome.privacyCallout'));
  });

  it('wraps the callout in a card with a test id', async () => {
    const { markup } = await render();
    expect(markup).toContain('data-testid="privacy-callout"');
  });
});

describe('WelcomePage — Get started button (R66.8)', () => {
  it('renders a primary button with the externalised label', async () => {
    const { markup, t } = await render();
    expect(markup).toContain(t('views.welcome.getStarted'));
    expect(markup).toContain('data-variant="primary"');
  });
});
