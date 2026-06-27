import { describe, expect, it } from 'vitest';
import {
  asBulletId,
  asDocId,
  asISODate,
  asItemId,
  asRoleSlug,
  asSkillId,
  asStarId,
  type Accomplishment,
  type ExtractedItem,
  type LocaleConfig,
  type RolePreference,
  type SkillId,
  type SkillMapEntry,
  type TalkingPoint,
} from '@core/types';
import { sourceLine, trailOf } from '@core/provenance';
import { buildReferenceGraph } from '@core/registry';
import type { SkillMap } from '@core/skills';
import { buildCvModel } from './cv-model';
import type { CvModel } from './cv-model';
import {
  applyLocaleFormatting,
  collectCvText,
  DEFAULT_SECTION_NAMES,
  formatCurrency,
  formatDate,
  formatNumber,
  OUTPUT_LOCALE_PRESETS,
  resolveOutputLocale,
  SECTION_KEYS,
  verbatimTermsPreserved,
} from './locale-formatting';

const doc = asDocId('cv.md');

const skill = (id: string, name: string): SkillMapEntry => ({
  id: asSkillId(id),
  name,
  category: 'Technical',
  proficiencySignal: 'Evidence-based.',
  evidence: [],
  recency: asISODate('2024-01-01'),
});

const skillMapOf = (
  entries: SkillMapEntry[],
  accomplishments: readonly Accomplishment[] = [],
  talkingPoints: readonly TalkingPoint[] = [],
): SkillMap => ({
  entries,
  graph: buildReferenceGraph({ skills: entries, accomplishments, talkingPoints }),
});

const accomplishment = (id: string, text: string, skills: SkillId[]): Accomplishment => ({
  id: asBulletId(id),
  text,
  provenance: trailOf(sourceLine(doc, 1, text)),
  skills,
});

const talkingPoint = (
  id: string,
  polished: string,
  skills: SkillId[],
  flags: TalkingPoint['flags'] = [],
): TalkingPoint => ({
  id: asStarId(id),
  polished,
  skills,
  flags,
});

const role = (matched: SkillId[]): RolePreference => ({
  slug: asRoleSlug('staff-engineer'),
  title: 'Staff Engineer',
  description: '',
  matchScore: 0.8,
  matchedSkills: matched,
  gapSkills: [],
  rationale: '',
  rank: 1,
  tag: 'actively_applying',
});

const item = (
  id: string,
  type: ExtractedItem['type'],
  fields: Record<string, unknown>,
): ExtractedItem => ({
  id: asItemId(id),
  type,
  fields,
  confidence: 'High',
  provenance: trailOf(sourceLine(doc, 1, id)),
  userConfirmed: false,
  private: false,
  sourceDoc: doc,
});

/** A model packed with technical terms, tool names and proper nouns (R41.5). */
const fullModel = (): CvModel => {
  const react = skill('SKILL-react', 'React');
  const node = skill('SKILL-node', 'Node.js');
  const acc = accomplishment('BULLET-01', 'Led the React migration on Kubernetes.', [
    react.id,
  ]);
  const tp = talkingPoint('STAR-01', 'Scaled the Node.js platform on AWS.', [node.id]);
  const map = skillMapOf([react, node], [acc], [tp]);
  const edu = item('I-edu', 'education', {
    degree: 'BSc Computer Science',
    institution: 'MIT',
    field: 'Distributed Systems',
  });
  const cert = item('I-cert', 'certification', {
    name: 'AWS Solutions Architect',
    issuer: 'Amazon',
    date: '2023',
  });
  return buildCvModel(role([react.id]), {
    skillMap: map,
    accomplishments: [acc],
    talkingPoints: [tp],
    items: [edu, cert],
    header: { name: 'Ada Lovelace', contact: ['ada@example.com', '+55 11 99999-0000'] },
    summary: 'Staff engineer focused on React, Node.js and Kubernetes reliability.',
  });
};

describe('@core/output — resolveOutputLocale applies per-locale defaults (R41.5)', () => {
  it('resolves pt-BR defaults from the session language', () => {
    const loc = resolveOutputLocale({ sessionLanguage: 'pt-BR' });
    expect(loc.dateFormat).toBe('DD/MM/YYYY');
    expect(loc.numberFormat).toBe('1.234,56');
    expect(loc.currencyFormat).toBe('R$ #');
    expect(loc.sectionNames.experience).toBe('Experiência');
  });

  it('resolves the en-GB region preset over the bare en default', () => {
    const loc = resolveOutputLocale({ sessionLanguage: 'en', region: 'GB' });
    expect(loc.dateFormat).toBe('DD/MM/YYYY');
    expect(loc.currencyFormat).toBe('£#');
    expect(loc.pageLengthNorm).toBe(2);
  });

  it('resolves the en-US region preset with its own conventions', () => {
    const loc = resolveOutputLocale({ sessionLanguage: 'en', region: 'US' });
    expect(loc.dateFormat).toBe('MM/DD/YYYY');
    expect(loc.currencyFormat).toBe('$#');
    expect(loc.pageLengthNorm).toBe(1);
  });

  it('is region-case-insensitive', () => {
    expect(resolveOutputLocale({ sessionLanguage: 'en', region: 'gb' })).toEqual(
      resolveOutputLocale({ sessionLanguage: 'en', region: 'GB' }),
    );
  });

  it('falls back to the bare language preset for an unknown region', () => {
    const loc = resolveOutputLocale({ sessionLanguage: 'en', region: 'ZZ' });
    expect(loc).toEqual(OUTPUT_LOCALE_PRESETS.en);
  });

  it('does not mutate the shared preset when resolving', () => {
    const before = JSON.stringify(OUTPUT_LOCALE_PRESETS['pt-BR']);
    const loc = resolveOutputLocale({ sessionLanguage: 'pt-BR' });
    (loc.sectionNames as Record<string, string>).experience = 'tampered';
    expect(JSON.stringify(OUTPUT_LOCALE_PRESETS['pt-BR'])).toBe(before);
  });
});

describe('@core/output — pt-BR vs en-GB conventions differ (R41.6)', () => {
  it('formats numbers per the resolved locale', () => {
    const gb = resolveOutputLocale({ sessionLanguage: 'en', region: 'GB' });
    const br = resolveOutputLocale({ sessionLanguage: 'pt-BR' });
    expect(formatNumber(1234567.5, gb)).toBe('1,234,567.50');
    expect(formatNumber(1234567.5, br)).toBe('1.234.567,50');
  });

  it('formats currency per the resolved locale', () => {
    const gb = resolveOutputLocale({ sessionLanguage: 'en', region: 'GB' });
    const br = resolveOutputLocale({ sessionLanguage: 'pt-BR' });
    expect(formatCurrency(1234.5, gb)).toBe('£1,234.50');
    expect(formatCurrency(1234.5, br)).toBe('R$ 1.234,50');
  });

  it('formats dates per the resolved locale', () => {
    const us = resolveOutputLocale({ sessionLanguage: 'en', region: 'US' });
    const br = resolveOutputLocale({ sessionLanguage: 'pt-BR' });
    expect(formatDate('2024-03-09', us)).toBe('03/09/2024');
    expect(formatDate('2024-03-09', br)).toBe('09/03/2024');
  });

  it('formats a Date object deterministically in UTC', () => {
    const br = resolveOutputLocale({ sessionLanguage: 'pt-BR' });
    expect(formatDate(new Date(Date.UTC(2024, 0, 5)), br)).toBe('05/01/2024');
  });

  it('handles negative numbers and zero fraction digits', () => {
    const br = resolveOutputLocale({ sessionLanguage: 'pt-BR' });
    expect(formatNumber(-1234.5, br)).toBe('-1.234,50');
    const noFraction = resolveOutputLocale({
      sessionLanguage: 'en',
      outputOverrides: { numberFormat: '1,234' },
    });
    expect(formatNumber(1234.9, noFraction)).toBe('1,235');
  });
});

describe('@core/output — each convention is individually overridable (R41.6)', () => {
  it('overrides only the date format, leaving the rest at locale defaults', () => {
    const loc = resolveOutputLocale({
      sessionLanguage: 'pt-BR',
      outputOverrides: { dateFormat: 'YYYY-MM-DD' },
    });
    expect(loc.dateFormat).toBe('YYYY-MM-DD');
    expect(loc.numberFormat).toBe('1.234,56'); // unchanged pt-BR default
    expect(loc.currencyFormat).toBe('R$ #'); // unchanged pt-BR default
  });

  it('overrides the page-length norm independently', () => {
    const loc = resolveOutputLocale({
      sessionLanguage: 'en',
      region: 'GB',
      outputOverrides: { pageLengthNorm: 1 },
    });
    expect(loc.pageLengthNorm).toBe(1);
    expect(loc.currencyFormat).toBe('£#');
  });

  it('overrides a single section name, leaving the other labels intact', () => {
    const loc = resolveOutputLocale({
      sessionLanguage: 'pt-BR',
      outputOverrides: { sectionNames: { skills: 'Habilidades' } },
    });
    expect(loc.sectionNames.skills).toBe('Habilidades');
    expect(loc.sectionNames.experience).toBe('Experiência'); // other labels kept
  });

  it('overrides number and currency formats independently', () => {
    const loc = resolveOutputLocale({
      sessionLanguage: 'en',
      region: 'US',
      outputOverrides: { numberFormat: '1.234,56', currencyFormat: '# €' },
    });
    expect(formatCurrency(1234.5, loc)).toBe('1.234,50 €');
    expect(loc.dateFormat).toBe('MM/DD/YYYY'); // en-US default untouched
  });
});

describe('@core/output — applyLocaleFormatting localises section names (R41.6)', () => {
  it('attaches the pt-BR section labels', () => {
    const loc = resolveOutputLocale({ sessionLanguage: 'pt-BR' });
    const localised = applyLocaleFormatting(fullModel(), loc);
    expect(localised.sectionNames.experience).toBe('Experiência');
    expect(localised.sectionNames.education).toBe('Formação');
    expect(localised.pageLengthNorm).toBe(2);
  });

  it('falls back to English labels for a locale missing a section key', () => {
    const loc = resolveOutputLocale({
      sessionLanguage: 'en',
      outputOverrides: { sectionNames: {} },
    });
    const localised = applyLocaleFormatting(fullModel(), loc);
    for (const key of SECTION_KEYS) {
      expect(localised.sectionNames[key]).toBe(DEFAULT_SECTION_NAMES[key]);
    }
  });
});

describe('@core/output — technical terms, tool names and proper nouns stay verbatim (R41.5, R41.7)', () => {
  const terms = ['React', 'Node.js', 'Kubernetes', 'AWS', 'MIT', 'Amazon', 'Ada Lovelace'];

  it('preserves every listed term across all locales', () => {
    const cv = fullModel();
    for (const config of [
      { sessionLanguage: 'en', region: 'GB' },
      { sessionLanguage: 'en', region: 'US' },
      { sessionLanguage: 'pt-BR' },
    ] satisfies LocaleConfig[]) {
      const localised = applyLocaleFormatting(cv, resolveOutputLocale(config));
      expect(verbatimTermsPreserved(terms, cv, localised)).toBe(true);
      const text = collectCvText(localised);
      for (const term of terms) expect(text).toContain(term);
    }
  });

  it('detects when a term would be altered by formatting', () => {
    const before = 'Built on Node.js and Kubernetes';
    const translated = 'Construído em Node e Kubernetes'; // tool name altered
    expect(verbatimTermsPreserved(['Node.js'], before, translated)).toBe(false);
    expect(verbatimTermsPreserved(['Kubernetes'], before, translated)).toBe(true);
  });

  it('does not change any user content field', () => {
    const cv = fullModel();
    const localised = applyLocaleFormatting(cv, resolveOutputLocale({ sessionLanguage: 'pt-BR' }));
    expect(collectCvText(localised)).toBe(collectCvText(cv));
    expect(localised.skills).toEqual(cv.skills);
    expect(localised.experience).toEqual(cv.experience);
    expect(localised.summary).toBe(cv.summary);
  });
});

describe('@core/output — personal data is privacy-preserving by default (R41.7)', () => {
  it('omits photo, age and marital status by default for every preset', () => {
    const cv = fullModel();
    for (const key of Object.keys(OUTPUT_LOCALE_PRESETS)) {
      const localised = applyLocaleFormatting(cv, OUTPUT_LOCALE_PRESETS[key]);
      expect(localised.personalData).toEqual({
        photo: false,
        age: false,
        maritalStatus: false,
      });
    }
  });

  it('includes a personal-data field only on explicit opt-in', () => {
    const loc = resolveOutputLocale({
      sessionLanguage: 'pt-BR',
      outputOverrides: { includePhoto: true },
    });
    const localised = applyLocaleFormatting(fullModel(), loc);
    expect(localised.personalData).toEqual({
      photo: true,
      age: false,
      maritalStatus: false,
    });
  });

  it('includes all personal-data fields when all are opted in', () => {
    const loc = resolveOutputLocale({
      sessionLanguage: 'en',
      outputOverrides: {
        includePhoto: true,
        includeAge: true,
        includeMaritalStatus: true,
      },
    });
    const localised = applyLocaleFormatting(fullModel(), loc);
    expect(localised.personalData).toEqual({
      photo: true,
      age: true,
      maritalStatus: true,
    });
  });
});

describe('@core/output — locale formatting is deterministic', () => {
  it('resolves an identical locale for an identical config', () => {
    const config: LocaleConfig = {
      sessionLanguage: 'pt-BR',
      outputOverrides: { pageLengthNorm: 3 },
    };
    expect(resolveOutputLocale(config)).toEqual(resolveOutputLocale(config));
  });

  it('produces an identical localised model for an identical input', () => {
    const cv = fullModel();
    const loc = resolveOutputLocale({ sessionLanguage: 'en', region: 'GB' });
    expect(applyLocaleFormatting(cv, loc)).toEqual(applyLocaleFormatting(cv, loc));
  });

  it('formats numbers, currency and dates deterministically', () => {
    const loc = resolveOutputLocale({ sessionLanguage: 'pt-BR' });
    expect(formatNumber(9876.54, loc)).toBe(formatNumber(9876.54, loc));
    expect(formatCurrency(9876.54, loc)).toBe(formatCurrency(9876.54, loc));
    expect(formatDate('2024-12-31', loc)).toBe(formatDate('2024-12-31', loc));
  });
});
