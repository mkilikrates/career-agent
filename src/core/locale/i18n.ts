// i18next wiring with externalised locale resources (R41.1, R41.8).
//
// All user-facing text lives in external locale resource files, never in
// hardcoded strings (R41.8). The two Tier-1 resource files —
// `/locales/en.json` and `/locales/pt-BR.json` — are imported here as the
// i18next resource bundles, so the core/shell reads every message, prompt,
// review-step, and output section-name label through `t(...)` rather than from
// inline literals (R41.1).
//
// This module is framework-agnostic: it returns a configured i18next instance
// that BOTH the React shell (@ui) and any core caller can read strings from.
// The structure leaves room for future Tier-2 languages by adding a file and a
// single resource entry — no code change to consumers (design §Localisation).

import i18next, { type i18n as I18n } from 'i18next';
import type { LocaleConfig } from '@core/types';
import en from '../../../locales/en.json';
import ptBR from '../../../locales/pt-BR.json';

/** The Tier-1 Session Languages (R41.1). Mirrors `LocaleConfig.sessionLanguage`. */
export type SessionLanguage = LocaleConfig['sessionLanguage'];

/** The supported Session Languages, English first as the default/fallback. */
export const SUPPORTED_LANGUAGES = ['en', 'pt-BR'] as const satisfies readonly SessionLanguage[];

/** The default Session Language used as the i18next fallback (R41.1). */
export const DEFAULT_LANGUAGE: SessionLanguage = 'en';

/**
 * The externalised resource bundles, keyed by Session Language (R41.8). The
 * single default namespace (`translation`) holds the whole resource tree, so
 * callers reference strings by dotted key (e.g. `t('app.title')`).
 */
export const LOCALE_RESOURCES = {
  en: { translation: en },
  'pt-BR': { translation: ptBR },
} as const;

/** True when `lng` is one of the Tier-1 Session Languages (R41.1). */
export const isSupportedLanguage = (lng: string): lng is SessionLanguage =>
  (SUPPORTED_LANGUAGES as readonly string[]).includes(lng);

/**
 * Create and initialise an i18next instance for `language`, loading all strings
 * from the externalised resource bundles (R41.8). A fresh instance is returned
 * (rather than mutating the global singleton) so callers — including tests —
 * stay isolated. The returned instance's `t(...)` reads only from the resource
 * files; unknown keys fall back through `en`.
 */
export const createI18n = async (
  language: SessionLanguage = DEFAULT_LANGUAGE,
): Promise<I18n> => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: language,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: [...SUPPORTED_LANGUAGES],
    resources: LOCALE_RESOURCES,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance;
};

/**
 * Apply the selected Session Language to an existing i18next instance so all
 * subsequent messages, prompts, review steps, and outputs render in that
 * language (R41.3). Returns the instance for chaining.
 */
export const applyLanguage = async (
  instance: I18n,
  language: SessionLanguage,
): Promise<I18n> => {
  await instance.changeLanguage(language);
  return instance;
};

export type { I18n };
