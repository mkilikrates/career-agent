// Locale-driven output formatting for the Output_Engine (R41.5, R41.6, R41.7).
//
// When generating a CV, the Output_Engine asks the user for the target country
// or region (R41.6) and applies that locale's conventions — date format,
// number / currency format, page-length norm, and section naming — while
// letting the user override any individual convention (R41.6). Two invariants
// are non-negotiable:
//
//   * R41.5 / R41.7 — technical terms, tool names, and proper nouns are
//     preserved VERBATIM and never translated or reformatted. The formatting in
//     this module only ever touches dates, numbers, currency, page-length, and
//     section labels; it never rewrites the user's content (skill names, bullet
//     text, header, summary), so those terms always survive untouched. The
//     {@link verbatimTermsPreserved} guard makes that invariant checkable.
//   * R41.7 — locale-driven personal-data fields (photo, age, marital status)
//     default to the privacy-preserving option (omitted) and are included only
//     on explicit user opt-in.
//
// Everything here is pure and deterministic: the same locale config + model
// always yields the same resolved locale and the same localised model.

import type { LocaleConfig, OutputLocale } from '@core/types';
import type { CvModel } from './cv-model';

// --- Section-name keys ------------------------------------------------------

/**
 * The CV sections whose headings the renderers emit, in their fixed reading
 * order. A locale supplies a localised label for each (R41.6 section naming);
 * any key a locale omits falls back to the English default.
 */
export const SECTION_KEYS = [
  'summary',
  'experience',
  'skills',
  'education',
  'certifications',
] as const;

/** A CV section key (`summary`, `experience`, …). */
export type SectionKey = (typeof SECTION_KEYS)[number];

/** Localised section labels, one per {@link SECTION_KEYS} entry. */
export type LocalisedSections = Readonly<Record<SectionKey, string>>;

/** The English section labels every locale falls back to for missing keys. */
export const DEFAULT_SECTION_NAMES: LocalisedSections = {
  summary: 'Summary',
  experience: 'Experience',
  skills: 'Skills',
  education: 'Education',
  certifications: 'Certifications',
};

// --- Locale presets ---------------------------------------------------------

/**
 * The default {@link OutputLocale} presets keyed by locale tag. The resolver
 * ({@link resolveOutputLocale}) selects the most specific preset for a
 * {@link LocaleConfig} and then layers the user's per-convention overrides on
 * top. Every preset defaults the personal-data fields to omitted (R41.7).
 *
 * `numberFormat` is a canonical sample (`1,234.56` / `1.234,56`) from which the
 * grouping and decimal separators are derived; `currencyFormat` carries a `#`
 * placeholder the formatted number is substituted into; `dateFormat` uses the
 * numeric tokens `YYYY`, `MM`, and `DD`.
 */
export const OUTPUT_LOCALE_PRESETS: Readonly<Record<string, OutputLocale>> = {
  // International-English default (used for `en` with no/unknown region).
  en: {
    dateFormat: 'DD/MM/YYYY',
    pageLengthNorm: 2,
    currencyFormat: '$#',
    numberFormat: '1,234.56',
    sectionNames: { ...DEFAULT_SECTION_NAMES },
    includePhoto: false,
    includeAge: false,
    includeMaritalStatus: false,
  },
  'en-US': {
    dateFormat: 'MM/DD/YYYY',
    pageLengthNorm: 1,
    currencyFormat: '$#',
    numberFormat: '1,234.56',
    sectionNames: { ...DEFAULT_SECTION_NAMES },
    includePhoto: false,
    includeAge: false,
    includeMaritalStatus: false,
  },
  'en-GB': {
    dateFormat: 'DD/MM/YYYY',
    pageLengthNorm: 2,
    currencyFormat: '£#',
    numberFormat: '1,234.56',
    sectionNames: { ...DEFAULT_SECTION_NAMES },
    includePhoto: false,
    includeAge: false,
    includeMaritalStatus: false,
  },
  'pt-BR': {
    dateFormat: 'DD/MM/YYYY',
    pageLengthNorm: 2,
    currencyFormat: 'R$ #',
    numberFormat: '1.234,56',
    sectionNames: {
      summary: 'Resumo',
      experience: 'Experiência',
      skills: 'Competências',
      education: 'Formação',
      certifications: 'Certificações',
    },
    includePhoto: false,
    includeAge: false,
    includeMaritalStatus: false,
  },
};

/** The preset key used when a config matches no specific preset. */
export const FALLBACK_LOCALE_KEY = 'en';

// --- Resolver ---------------------------------------------------------------

/** A deep, immutable copy of a preset so callers can never mutate the shared one. */
const clonePreset = (preset: OutputLocale): OutputLocale => ({
  ...preset,
  sectionNames: { ...preset.sectionNames },
});

/**
 * The candidate preset keys for a {@link LocaleConfig}, most specific first:
 * `${sessionLanguage}-${region}`, then the bare `sessionLanguage`, then the
 * `en` fallback. Region is upper-cased so `gb`/`GB` resolve alike.
 */
const candidateKeys = (config: LocaleConfig): string[] => {
  const keys: string[] = [];
  const region = config.region?.trim();
  if (region) keys.push(`${config.sessionLanguage}-${region.toUpperCase()}`);
  keys.push(config.sessionLanguage);
  if (!keys.includes(FALLBACK_LOCALE_KEY)) keys.push(FALLBACK_LOCALE_KEY);
  return keys;
};

/**
 * Resolve a concrete {@link OutputLocale} from a {@link LocaleConfig} (R41.5):
 * the session language and target region select the most specific default
 * preset, then the user's `outputOverrides` are layered on so each convention —
 * date, number, currency, page-length, and section naming — is individually
 * overridable (R41.6). Section-name overrides merge per key, so overriding one
 * heading leaves the rest at their locale defaults. Personal-data opt-ins
 * (photo/age/marital status) are likewise overridable but default to omitted
 * (R41.7). Pure and deterministic.
 */
export const resolveOutputLocale = (config: LocaleConfig): OutputLocale => {
  const key =
    candidateKeys(config).find((k) => OUTPUT_LOCALE_PRESETS[k] !== undefined) ??
    FALLBACK_LOCALE_KEY;
  const base = clonePreset(OUTPUT_LOCALE_PRESETS[key]);

  const overrides = config.outputOverrides;
  if (!overrides) return base;

  const merged: OutputLocale = { ...base };
  if (overrides.dateFormat !== undefined) merged.dateFormat = overrides.dateFormat;
  if (overrides.pageLengthNorm !== undefined) merged.pageLengthNorm = overrides.pageLengthNorm;
  if (overrides.currencyFormat !== undefined) merged.currencyFormat = overrides.currencyFormat;
  if (overrides.numberFormat !== undefined) merged.numberFormat = overrides.numberFormat;
  if (overrides.includePhoto !== undefined) merged.includePhoto = overrides.includePhoto;
  if (overrides.includeAge !== undefined) merged.includeAge = overrides.includeAge;
  if (overrides.includeMaritalStatus !== undefined) {
    merged.includeMaritalStatus = overrides.includeMaritalStatus;
  }
  // Section names merge per key so a partial override keeps the other labels.
  if (overrides.sectionNames !== undefined) {
    merged.sectionNames = { ...base.sectionNames, ...overrides.sectionNames };
  }
  return merged;
};

// --- Formatting helpers -----------------------------------------------------

/** The grouping and decimal separators derived from a `numberFormat` sample. */
interface Separators {
  readonly group: string;
  readonly decimal: string;
  readonly fractionDigits: number;
}

/**
 * Derive the grouping separator, decimal separator, and fraction-digit count
 * from a canonical `numberFormat` sample (`1,234.56` → group `,`, decimal `.`,
 * 2 digits; `1.234,56` → group `.`, decimal `,`, 2 digits).
 */
const separatorsOf = (sample: string): Separators => {
  const nonDigits = [...sample].filter((c) => !/\d/.test(c));
  if (nonDigits.length === 0) return { group: '', decimal: '.', fractionDigits: 0 };

  const rightmost = nonDigits[nonDigits.length - 1];
  const trailing = sample.length - sample.lastIndexOf(rightmost) - 1;

  // A single separator is ambiguous (grouping vs decimal). The well-known
  // heuristic: exactly three trailing digits means it groups thousands and the
  // sample carries no fractional part; otherwise it is the decimal separator.
  if (nonDigits.length === 1) {
    return trailing === 3
      ? { group: rightmost, decimal: '', fractionDigits: 0 }
      : { group: '', decimal: rightmost, fractionDigits: trailing };
  }

  // Multiple separators: the first groups thousands, the last is the decimal.
  return { group: nonDigits[0], decimal: rightmost, fractionDigits: trailing };
};

/** Group an integer-part digit string into 3-digit clusters with `sep`. */
const groupDigits = (digits: string, sep: string): string => {
  if (sep === '') return digits;
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
};

/**
 * Format a number per the resolved locale's `numberFormat` convention (R41.6).
 * Deterministic: the value is rounded to the sample's fraction-digit count,
 * its integer part grouped with the locale separator, and its fractional part
 * joined with the locale decimal separator. Negative values keep a leading `-`.
 */
export const formatNumber = (value: number, locale: OutputLocale): string => {
  const { group, decimal, fractionDigits } = separatorsOf(locale.numberFormat);
  const sign = value < 0 ? '-' : '';
  const fixed = Math.abs(value).toFixed(fractionDigits);
  const [intPart, fracPart] = fixed.split('.');
  const grouped = groupDigits(intPart, group);
  return fractionDigits > 0 ? `${sign}${grouped}${decimal}${fracPart}` : `${sign}${grouped}`;
};

/**
 * Format a monetary amount per the resolved locale's `currencyFormat` (R41.6).
 * The number is formatted with {@link formatNumber} and substituted into the
 * `#` placeholder of the currency pattern (`$#` → `$1,234.56`,
 * `R$ #` → `R$ 1.234,56`).
 */
export const formatCurrency = (value: number, locale: OutputLocale): string => {
  const number = formatNumber(value, locale);
  return locale.currencyFormat.includes('#')
    ? locale.currencyFormat.replace('#', number)
    : `${locale.currencyFormat}${number}`;
};

/** Zero-pad a number to a fixed width. */
const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** The year / month / day parts of a date, read in UTC for determinism. */
const dateParts = (date: Date | string): { year: number; month: number; day: number } => {
  if (typeof date === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date.trim());
    if (match) {
      return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    }
    const parsed = new Date(date);
    return {
      year: parsed.getUTCFullYear(),
      month: parsed.getUTCMonth() + 1,
      day: parsed.getUTCDate(),
    };
  }
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
};

/**
 * Format a date per the resolved locale's `dateFormat` convention (R41.6),
 * supporting the numeric tokens `YYYY`, `MM`, and `DD`. Dates are read in UTC
 * so the output is deterministic regardless of the host timezone. Accepts a
 * `Date` or an ISO `YYYY-MM-DD` string.
 */
export const formatDate = (date: Date | string, locale: OutputLocale): string => {
  const { year, month, day } = dateParts(date);
  return locale.dateFormat
    .replace(/YYYY/g, pad(year, 4))
    .replace(/MM/g, pad(month, 2))
    .replace(/DD/g, pad(day, 2));
};

// --- Verbatim-term guard ----------------------------------------------------

/** Count non-overlapping occurrences of `term` in `text` (verbatim). */
const occurrences = (text: string, term: string): number => {
  if (term.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(term, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + term.length;
  }
};

/** Concatenate every user-content text field of a {@link CvModel} (R41.5). */
export const collectCvText = (cv: CvModel): string => {
  const parts: string[] = [];
  if (cv.header.name) parts.push(cv.header.name);
  for (const line of cv.header.contact ?? []) parts.push(line);
  if (cv.summary) parts.push(cv.summary);
  for (const skill of cv.skills) parts.push(skill.name);
  for (const bullet of cv.experience) parts.push(bullet.text);
  for (const entry of [...cv.education, ...cv.certifications]) {
    parts.push(entry.title);
    if (entry.subtitle) parts.push(entry.subtitle);
    if (entry.detail) parts.push(entry.detail);
  }
  return parts.join('\n');
};

/**
 * The verbatim-term guard (R41.5, R41.7): a listed technical term, tool name,
 * or proper noun is preserved iff it occurs the same number of times in the
 * `after` content as it did in the `before` content — i.e. formatting neither
 * dropped, added, nor altered it. Returns `true` only when every listed term is
 * preserved across all CV content. Strings or whole {@link CvModel}s may be
 * compared.
 */
export const verbatimTermsPreserved = (
  terms: readonly string[],
  before: string | CvModel,
  after: string | CvModel,
): boolean => {
  const beforeText = typeof before === 'string' ? before : collectCvText(before);
  const afterText = typeof after === 'string' ? after : collectCvText(after);
  return terms.every(
    (term) => occurrences(beforeText, term) === occurrences(afterText, term),
  );
};

// --- Localised model --------------------------------------------------------

/** Whether each locale-driven personal-data field is included (R41.7). */
export interface PersonalDataInclusion {
  /** Included only on explicit opt-in; otherwise omitted (R41.7). */
  readonly photo: boolean;
  /** Included only on explicit opt-in; otherwise omitted (R41.7). */
  readonly age: boolean;
  /** Included only on explicit opt-in; otherwise omitted (R41.7). */
  readonly maritalStatus: boolean;
}

/**
 * A {@link CvModel} with the resolved locale conventions attached (R41.6). It is
 * a {@link CvModel} (the content is unchanged and preserved verbatim, R41.5), so
 * the format renderers consume it exactly as before, plus the localised
 * `sectionNames` they label headings with, the `pageLengthNorm` they target, and
 * the `personalData` inclusion flags that stay omitted unless opted in (R41.7).
 */
export interface LocalisedCvModel extends CvModel {
  /** Localised section headings, one per {@link SECTION_KEYS} entry (R41.6). */
  readonly sectionNames: LocalisedSections;
  /** The locale's page-length norm in pages (R41.6). */
  readonly pageLengthNorm: number;
  /** Personal-data inclusion, privacy-preserving by default (R41.7). */
  readonly personalData: PersonalDataInclusion;
}

/** Resolve the localised label for every section key, falling back to English. */
const localisedSections = (locale: OutputLocale): LocalisedSections => {
  const out = {} as Record<SectionKey, string>;
  for (const key of SECTION_KEYS) {
    const label = locale.sectionNames[key];
    out[key] =
      typeof label === 'string' && label.trim().length > 0
        ? label
        : DEFAULT_SECTION_NAMES[key];
  }
  return out;
};

/**
 * Apply a resolved {@link OutputLocale} to a {@link CvModel} (R41.6, R41.7).
 *
 * The user's content is copied through VERBATIM — no skill name, bullet,
 * header, or summary is translated or reformatted — so technical terms, tool
 * names, and proper nouns are preserved exactly (R41.5, R41.7). What the locale
 * adds is presentation metadata the renderers use: localised section headings,
 * the page-length norm, and the personal-data inclusion flags, which default to
 * omitted and are set only when the locale explicitly opts in (R41.7). Pure and
 * deterministic.
 */
export const applyLocaleFormatting = (
  cv: CvModel,
  locale: OutputLocale,
): LocalisedCvModel => ({
  ...cv,
  sectionNames: localisedSections(locale),
  pageLengthNorm: locale.pageLengthNorm,
  personalData: {
    photo: locale.includePhoto === true,
    age: locale.includeAge === true,
    maritalStatus: locale.includeMaritalStatus === true,
  },
});
