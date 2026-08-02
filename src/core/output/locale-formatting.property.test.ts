// Feature: career-agent, Property 17: Locale formatting and verbatim-term preservation
//
// For any output and any selected locale, listed technical terms, tool names,
// and proper nouns appear verbatim and untranslated; date, number, currency,
// page-length, and section-name conventions match the selected locale unless
// individually overridden; and locale-driven personal-data fields (photo, age,
// marital status) are omitted unless the user has explicitly opted in.
//
// **Validates: Requirements 41.5, 41.6, 41.7**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { asBulletId, asRoleSlug, asSkillId } from '@core/types';
import type { LocaleConfig } from '@core/types';
import {
  applyLocaleFormatting,
  resolveOutputLocale,
  verbatimTermsPreserved,
  collectCvText,
} from './locale-formatting';
import type { CvModel } from './cv-model';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeModel = (terms: string[]): CvModel => ({
  targetRole: { slug: asRoleSlug('engineer'), title: 'Platform Engineer' },
  header: { name: 'Ada Lovelace', contact: ['ada@example.com'] },
  skills: terms.map((t, i) => ({
    id: asSkillId(`SKILL-${i}`),
    name: t,
    category: 'Technical' as const,
    targetRelevant: true,
  })),
  experience: terms.map((t, i) => ({
    id: asBulletId(`BULLET-${String(i).padStart(2, '0')}`),
    source: 'accomplishment' as const,
    text: `Led migration of ${t} infrastructure to production.`,
    skills: [asSkillId(`SKILL-${i}`)],
    targetRelevant: true,
    quantified: false,
    needsMetric: false,
  })),
  education: [],
  certifications: [],
});

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate technical/tool terms that must be preserved verbatim. */
const arbTerms = fc
  .subarray(
    ['Kubernetes', 'TypeScript', 'React.js', 'Node.js', 'C++', 'C#', 'PostgreSQL', 'AWS', 'CI/CD', 'GraphQL'],
    { minLength: 2, maxLength: 6 },
  );

/** Generate a locale config from available presets. */
const arbLocaleConfig: fc.Arbitrary<LocaleConfig> = fc
  .tuple(
    fc.constantFrom('en' as const, 'pt-BR' as const),
    fc.option(fc.constantFrom('US', 'GB', 'BR'), { nil: undefined }),
    fc.boolean(),
    fc.boolean(),
    fc.boolean(),
  )
  .map(([lang, region, photo, age, marital]): LocaleConfig => ({
    sessionLanguage: lang,
    region,
    outputOverrides: {
      includePhoto: photo,
      includeAge: age,
      includeMaritalStatus: marital,
    },
  }));

/** Generate a locale config that has no personal-data opt-ins. */
const arbDefaultLocaleConfig: fc.Arbitrary<LocaleConfig> = fc
  .tuple(
    fc.constantFrom('en' as const, 'pt-BR' as const),
    fc.option(fc.constantFrom('US', 'GB', 'BR'), { nil: undefined }),
  )
  .map(([lang, region]): LocaleConfig => ({
    sessionLanguage: lang,
    region,
  }));

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('@core/output — Property 17: Locale formatting and verbatim-term preservation', () => {
  it('technical terms appear verbatim after locale formatting is applied (R41.5)', () => {
    fc.assert(
      fc.property(arbTerms, arbLocaleConfig, (terms, config) => {
        const model = makeModel(terms);
        const locale = resolveOutputLocale(config);
        const localised = applyLocaleFormatting(model, locale);

        // The verbatimTermsPreserved guard confirms terms are untouched
        expect(verbatimTermsPreserved(terms, model, localised)).toBe(true);

        // Direct check: each term still appears in the localised model content
        const text = collectCvText(localised);
        for (const term of terms) {
          expect(text).toContain(term);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('personal-data fields default to omitted when not opted in (R41.7)', () => {
    fc.assert(
      fc.property(arbDefaultLocaleConfig, arbTerms, (config, terms) => {
        const model = makeModel(terms);
        const locale = resolveOutputLocale(config);
        const localised = applyLocaleFormatting(model, locale);

        // Without explicit opt-in, all personal data is omitted
        expect(localised.personalData.photo).toBe(false);
        expect(localised.personalData.age).toBe(false);
        expect(localised.personalData.maritalStatus).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('personal-data inclusion matches the user opt-in exactly (R41.7)', () => {
    fc.assert(
      fc.property(arbLocaleConfig, arbTerms, (config, terms) => {
        const model = makeModel(terms);
        const locale = resolveOutputLocale(config);
        const localised = applyLocaleFormatting(model, locale);

        const overrides = config.outputOverrides;
        if (overrides?.includePhoto !== undefined) {
          expect(localised.personalData.photo).toBe(overrides.includePhoto);
        }
        if (overrides?.includeAge !== undefined) {
          expect(localised.personalData.age).toBe(overrides.includeAge);
        }
        if (overrides?.includeMaritalStatus !== undefined) {
          expect(localised.personalData.maritalStatus).toBe(overrides.includeMaritalStatus);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('section names match the selected locale preset (R41.6)', () => {
    fc.assert(
      fc.property(arbDefaultLocaleConfig, arbTerms, (config, terms) => {
        const model = makeModel(terms);
        const locale = resolveOutputLocale(config);
        const localised = applyLocaleFormatting(model, locale);

        // Section names should match the resolved locale's section names
        expect(localised.sectionNames.summary).toBe(locale.sectionNames.summary);
        expect(localised.sectionNames.experience).toBe(locale.sectionNames.experience);
        expect(localised.sectionNames.skills).toBe(locale.sectionNames.skills);
        expect(localised.sectionNames.education).toBe(locale.sectionNames.education);
        expect(localised.sectionNames.certifications).toBe(locale.sectionNames.certifications);
      }),
      { numRuns: 100 },
    );
  });
});
