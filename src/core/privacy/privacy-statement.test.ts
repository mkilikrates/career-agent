// Unit tests for the privacy statement structure (@core/privacy).
//
// Verify the statement contains every mandated declaration (R1.4, R42.1) and
// that each declaration's i18n key resolves to a non-empty string in BOTH
// Tier-1 locales (R41.8) — i.e. no clause is missing from either resource file.

import { describe, expect, it } from 'vitest';
import { createI18n, SUPPORTED_LANGUAGES } from '@core/locale';
import {
  PRIVACY_STATEMENT_DECLARATIONS,
  PRIVACY_STATEMENT_HEADING_KEY,
  privacyDeclarations,
  type PrivacyDeclarationId,
} from './privacy-statement';

describe('privacy statement structure (R1.4, R42.1)', () => {
  it('includes the three mandated declarations in order', () => {
    const ids = PRIVACY_STATEMENT_DECLARATIONS.map((d) => d.id);
    const expected: PrivacyDeclarationId[] = [
      'filesOnDevice', // files remain on the device (R1.3, R1.4)
      'notFullyOffline', // Redacted Payload to chosen providers (R1.4)
      'trainingExclusion', // excluded from training without consent (R42.1)
    ];
    expect(ids).toEqual(expected);
  });

  it('is frozen so the mandated structure cannot be mutated', () => {
    expect(Object.isFrozen(PRIVACY_STATEMENT_DECLARATIONS)).toBe(true);
  });
});

describe('privacyDeclarations variant selection (R1.4, R1.5)', () => {
  it('uses the not-fully-offline clause for the cloud variant (R1.4)', () => {
    const ids = privacyDeclarations(false).map((d) => d.id);
    expect(ids).toEqual(['filesOnDevice', 'notFullyOffline', 'trainingExclusion']);
  });

  it('uses the fully-offline clause when every provider is local (R1.5)', () => {
    const decls = privacyDeclarations(true);
    const ids = decls.map((d) => d.id);
    expect(ids).toEqual(['filesOnDevice', 'fullyOffline', 'trainingExclusion']);
    const fullyOffline = decls.find((d) => d.id === 'fullyOffline');
    expect(fullyOffline?.i18nKey).toBe('privacy.statement.fullyOffline');
  });

  it('returns a frozen ordered set in both variants', () => {
    expect(Object.isFrozen(privacyDeclarations(true))).toBe(true);
    expect(Object.isFrozen(privacyDeclarations(false))).toBe(true);
  });
});

describe('externalised strings exist in every locale (R41.8)', () => {
  it.each(SUPPORTED_LANGUAGES)('resolves all privacy keys for %s', async (lng) => {
    const i18n = await createI18n(lng);
    const t = i18n.t.bind(i18n);

    const heading = t(PRIVACY_STATEMENT_HEADING_KEY);
    expect(heading).toBeTruthy();
    expect(heading).not.toBe(PRIVACY_STATEMENT_HEADING_KEY);

    for (const declaration of PRIVACY_STATEMENT_DECLARATIONS) {
      const text = t(declaration.i18nKey);
      expect(text, `${declaration.i18nKey} missing for ${lng}`).toBeTruthy();
      expect(text).not.toBe(declaration.i18nKey);
    }
  });

  it.each(SUPPORTED_LANGUAGES)('resolves consent + label + clarification keys for %s', async (lng) => {
    const i18n = await createI18n(lng);
    const t = i18n.t.bind(i18n);
    const keys = [
      'privacy.consent.heading',
      'privacy.consent.description',
      'privacy.consent.grant',
      'privacy.consent.revoke',
      'privacy.consent.statusGranted',
      'privacy.consent.statusExcluded',
      'privacy.statement.fullyOffline',
      'privacy.networkLabel.heading',
      'privacy.networkLabel.none',
      'privacy.networkLabel.thirdParty',
      'privacy.networkLabel.localOnDevice',
    ];
    for (const key of keys) {
      const text = t(key);
      expect(text, `${key} missing for ${lng}`).toBeTruthy();
      expect(text).not.toBe(key);
    }
    // Interpolated clarification messages embed the field name.
    expect(t('privacy.clarification.incomplete', { field: 'Start date' })).toContain('Start date');
    expect(t('privacy.clarification.ambiguous', { field: 'Employer' })).toContain('Employer');
  });
});
