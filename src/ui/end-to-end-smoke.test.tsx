// End-to-end smoke / integration test for the shipped static bundle (task 19.3).
//
// This is an EXAMPLE/INTEGRATION smoke test (not a property test). It pins the
// three cross-cutting promises that make Career Agent a trustworthy local-first
// app, end to end:
//
//   1. The static bundle loads from a `file://` context — the Vite build emits
//      relative asset paths (`base: './'`), so `dist/index.html` opens directly
//      from disk with NO backend server (R1.1).
//   2. The privacy notice renders — the React shell's PrivacyStatement renders
//      every mandated declaration, declaring that user files stay on the device
//      and that the app is not fully offline because it sends a Redacted Payload
//      to user-chosen providers (R1.3, R1.4).
//   3. No network call occurs except via the Egress Gate — the only path from a
//      domain/UI component to a provider is the single Egress Gate chokepoint.
//      Verified both behaviourally (the wired orchestrator reaches a provider
//      ONLY by delegating to the gate, which labels + screens first) and
//      architecturally (no @core/@ui module reaches the Provider_Manager or a
//      provider client except the gate itself and the composition root) (R1.3,
//      R7.x).
//
// Requirements: 1.1, 1.3, 1.4.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { createI18n, SUPPORTED_LANGUAGES } from '@core/locale';
import {
  PRIVACY_STATEMENT_DECLARATIONS,
  PRIVACY_STATEMENT_HEADING_KEY,
  defaultConsentState,
  mayUseForTraining,
} from '@core/privacy';
import { PrivacyStatement } from './PrivacyStatement';

import { createEgressGate, type NetworkOperationLabel } from '@core/egress';
import { createCareerAgent } from '@core/orchestrator';
import { createPiiScanner } from '@adapters/pii';
import type {
  ProviderId,
  ProviderManager,
  ProviderResponse,
  RedactedPayload,
} from '@adapters/provider';

// Repo root, relative to this file (src/ui/end-to-end-smoke.test.tsx).
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('e2e smoke: static bundle loads from file:// (R1.1)', () => {
  it('declares relative asset paths in the Vite config so the build opens from file://', () => {
    const viteConfig = readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    // `base: './'` is the mechanism that makes every emitted asset URL relative,
    // which is what lets the bundle load from a `file://` page with no server.
    expect(viteConfig).toMatch(/base:\s*['"]\.\/['"]/);
  });

  it('the built dist/index.html references only relative assets and a root mount node', () => {
    const distIndex = join(REPO_ROOT, 'dist', 'index.html');
    if (!existsSync(distIndex)) {
      // The artifact is only present after `npm run build`. Skip rather than
      // fail when the bundle has not been built yet (e.g. a fresh checkout); the
      // config assertion above still pins the relative-path guarantee.
      return;
    }
    const html = readFileSync(distIndex, 'utf8');

    // The SPA mount point the shell hydrates into must exist.
    expect(html).toMatch(/id=["']root["']/);

    // Every script/link asset URL must be relative (begin with `./` or `../`).
    // An absolute `/assets/...` path or an `http(s)://host/...` path would break
    // a `file://` load, so assert none of those appear on asset references.
    const assetUrls = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((m) => m[1]);
    expect(assetUrls.length).toBeGreaterThan(0);
    for (const url of assetUrls) {
      expect(
        url.startsWith('./') || url.startsWith('../'),
        `asset URL "${url}" must be relative so dist/index.html opens from file://`,
      ).toBe(true);
    }
  });
});

describe('e2e smoke: the privacy notice renders (R1.3, R1.4)', () => {
  it.each(SUPPORTED_LANGUAGES)(
    'renders the heading and every mandated declaration with its externalised text (%s)',
    async (lng) => {
      const i18n = await createI18n(lng);
      const t = i18n.t.bind(i18n);

      const markup = renderToStaticMarkup(
        <PrivacyStatement
          t={t}
          consent={defaultConsentState()}
          onGrantConsent={() => {}}
          onRevokeConsent={() => {}}
          networkLabels={[]}
        />,
      );

      // The statement heading is present, rendered from the externalised string.
      const heading = t(PRIVACY_STATEMENT_HEADING_KEY);
      expect(heading).not.toBe(PRIVACY_STATEMENT_HEADING_KEY);
      expect(markup).toContain(heading);

      // Each mandated declaration renders its dedicated paragraph (by id) and the
      // resolved, externalised prose — not the raw i18n key.
      for (const declaration of PRIVACY_STATEMENT_DECLARATIONS) {
        const text = t(declaration.i18nKey);
        expect(text).not.toBe(declaration.i18nKey);
        expect(markup).toContain(`data-declaration="${declaration.id}"`);
        expect(markup).toContain(text);
      }

      // The two clauses Requirement 1.4 names explicitly must be present.
      expect(markup).toContain(t('privacy.statement.filesOnDevice'));
      expect(markup).toContain(t('privacy.statement.notFullyOffline'));

      // Consent defaults to NOT granted (R42.1), so the "excluded" status shows.
      expect(mayUseForTraining(defaultConsentState())).toBe(false);
      expect(markup).toContain(t('privacy.consent.statusExcluded'));
    },
  );
});

describe('e2e smoke: no network call occurs except via the Egress Gate (R1.3, R7.x)', () => {
  it('the wired orchestrator reaches a provider ONLY by delegating to the gate (label + screen first)', async () => {
    const provider: ProviderId = 'openai';
    const response = { __brand: 'ProviderResponse' } as ProviderResponse;

    // The transmission boundary: a spy Provider_Manager standing in for the
    // adapter that would otherwise hit the network. If this is ever called, the
    // payload MUST already be the minimised, redacted form built by the gate.
    const order: string[] = [];
    const send = vi.fn(async (_p: ProviderId, payload: RedactedPayload) => {
      order.push('send');
      // What leaves the device is the gate's RedactedPayload, never raw text.
      expect(payload.__brand).toBe('RedactedPayload');
      return response;
    });
    const providerManager = { send } as unknown as ProviderManager;

    // Real PII scanner + a label channel that records every third-party label.
    const scanner = createPiiScanner();
    const labels: NetworkOperationLabel[] = [];
    const notifyLabel = (label: NetworkOperationLabel) => {
      order.push('label');
      labels.push(label);
    };

    // The single chokepoint, wired into the real orchestrator. The orchestrator
    // holds NO provider client — provider reachability exists only via the gate.
    const egressGate = createEgressGate({
      scanner,
      providerManager,
      notifyLabel,
      confirmRedactAndProceed: () => true,
    });
    const agent = createCareerAgent({ egressGate });

    const result = await agent.requestProvider({
      provider,
      text: 'Please summarise my experience.',
      operation: 'llm-chat',
    });

    // The call went all the way through to the (spy) transmission boundary…
    expect(result).toBe(response);
    expect(send).toHaveBeenCalledTimes(1);
    // …and it was labelled as a third-party network operation BEFORE sending,
    // proving the request traversed the gate rather than any direct path.
    expect(labels).toHaveLength(1);
    expect(labels[0]?.thirdParty).toBe(true);
    expect(labels[0]?.provider).toBe(provider);
    expect(order[0]).toBe('label');
    expect(order[order.length - 1]).toBe('send');
  });

  it('no @core/@ui source module reaches the Provider_Manager except the gate and the composition root', () => {
    // Architectural guard: enumerate every non-test source module under @core and
    // @ui and assert the ONLY ones that (a) call providerManager.send/transcribe
    // or (b) value-import the Provider_Manager adapter are the Egress Gate itself
    // and the single composition root (the UI runtime). Any new bypass path would
    // trip this and fail the smoke suite.
    const srcRoots = [join(REPO_ROOT, 'src', 'core'), join(REPO_ROOT, 'src', 'ui')];
    const sourceFiles = srcRoots.flatMap((root) => collectSourceFiles(root));
    expect(sourceFiles.length).toBeGreaterThan(0);

    // Allowed holders of provider transmission: the chokepoint + composition root.
    const gateFile = join('src', 'core', 'egress', 'egress-gate.ts');
    const compositionRoot = join('src', 'ui', 'runtime.ts');

    const transmitters: string[] = [];
    const managerImporters: string[] = [];

    for (const file of sourceFiles) {
      const rel = relative(REPO_ROOT, file);
      const code = readFileSync(file, 'utf8');

      if (/providerManager\.(send|transcribe)\b/.test(code)) {
        transmitters.push(rel);
      }
      // A *value* import of the Provider_Manager adapter (type-only imports of
      // boundary types like ProviderId/ProviderResponse are fine — they create
      // no runtime network path).
      const valueImportsManager =
        /import\s+(?!type\b)[^;]*from\s+['"]@adapters\/provider-manager['"]/.test(code);
      if (valueImportsManager) {
        managerImporters.push(rel);
      }
    }

    expect(transmitters).toEqual([gateFile]);
    expect(managerImporters).toEqual([compositionRoot]);
  });
});

/** Recursively collect non-test `.ts`/`.tsx` source files under `dir`. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue;
    // Skip ambient declaration files.
    if (entry.name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}
