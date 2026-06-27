// Unit tests for the shared <AssistChoice> opt-in-first control (task 25.2).
//
// Rendered to static markup (the test environment is `node`, matching the
// existing e2e smoke test) so we assert the surfaced choice and the destination
// network/privacy label without a DOM event loop.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createI18n } from '@core/locale';
import { AssistChoice } from './AssistChoice';

const render = async (
  props: Partial<Parameters<typeof AssistChoice>[0]>,
): Promise<{ markup: string; t: (k: string, o?: Record<string, unknown>) => string }> => {
  const i18n = await createI18n('en');
  const t = i18n.t.bind(i18n);
  const markup = renderToStaticMarkup(
    <AssistChoice
      mode="script-only"
      onMode={() => {}}
      aiAvailable
      provider="openai"
      destinationKind="keyed-cloud"
      t={t}
      {...props}
    />,
  );
  return { markup, t };
};

describe('AssistChoice — opt-in-first choice (R14.5, R47.7)', () => {
  it('always offers both the script-only and the script + AI assist options', async () => {
    const { markup, t } = await render({});
    expect(markup).toContain(t('assist.scriptOnly'));
    expect(markup).toContain(t('assist.aiAssisted'));
    expect(markup).toContain('value="script-only"');
    expect(markup).toContain('value="ai-assisted"');
  });

  it('offers the AI-only option and treats it as an AI (provider) selection', async () => {
    const { markup, t } = await render({ mode: 'ai-only', destinationKind: 'keyed-cloud' });
    expect(markup).toContain(t('assist.aiOnly'));
    expect(markup).toContain('value="ai-only"');
    // ai-only is an AI mode, so the third-party network label is surfaced.
    expect(markup).toContain('data-assist-label="third-party"');
  });

  it('defaults the script-only hint and resolves real externalised strings', async () => {
    const { markup, t } = await render({ mode: 'script-only' });
    expect(markup).toContain('data-assist-label="script-only"');
    expect(markup).toContain(t('assist.scriptOnlyHint'));
    expect(t('assist.scriptOnlyHint')).not.toBe('assist.scriptOnlyHint');
  });
});

describe('AssistChoice — network/privacy label (R58.5, R7.6)', () => {
  it('shows the THIRD-PARTY label for a keyed cloud destination when AI is selected', async () => {
    const { markup, t } = await render({ mode: 'ai-assisted', destinationKind: 'keyed-cloud' });
    expect(markup).toContain('data-assist-label="third-party"');
    expect(markup).toContain(t('assist.networkThirdParty', { provider: 'openai' }));
  });

  it('shows the LOCAL on-device label for a keyless local destination when AI is selected', async () => {
    const { markup, t } = await render({
      mode: 'ai-assisted',
      destinationKind: 'keyless-local',
      provider: 'local',
    });
    expect(markup).toContain('data-assist-label="local"');
    expect(markup).toContain(t('assist.networkLocal', { provider: 'local' }));
  });
});

describe('AssistChoice — no provider available', () => {
  it('disables the AI option and shows the unavailable hint', async () => {
    const { markup, t } = await render({ aiAvailable: false, mode: 'script-only' });
    expect(markup).toContain('data-assist-label="unavailable"');
    expect(markup).toContain(t('assist.unavailable'));
    // The ai-assisted radio is rendered disabled.
    expect(markup).toContain('disabled');
  });
});
