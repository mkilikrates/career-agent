// @core/locale — Tier-1 multilingual support: i18next wiring, browser/OS
// language detection, and `config/locale.md` persistence (R41.1, R41.2, R41.3,
// R41.8).
//
// All user-facing text is loaded from externalised resource files
// (`/locales/en.json`, `/locales/pt-BR.json`) — no hardcoded strings (R41.8).
// On first use the preferred language is DETECTED and proposed for the user to
// confirm or change (R41.2); on confirmation the choice is persisted to the
// Memory Store and applied to all messages, prompts, review steps, and outputs
// (R41.3). Consumers import from a single stable path:
//
//   import { createI18n, detectSessionLanguage, saveConfirmedLocaleConfig } from '@core/locale';

export {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  LOCALE_RESOURCES,
  isSupportedLanguage,
  createI18n,
  applyLanguage,
} from './i18n';
export type { SessionLanguage, I18n } from './i18n';

export {
  detectSessionLanguage,
  proposeSessionLanguage,
  browserPreferredLocales,
} from './detect';
export type { LanguageDetection } from './detect';

export {
  LOCALE_PATH,
  LOCALE_HEADING,
  serializeLocaleConfig,
  parseLocaleConfig,
  saveLocaleConfig,
  saveConfirmedLocaleConfig,
  loadLocaleConfig,
} from './locale-document';
export type { LocaleConfigWriter, LocaleConfigReader } from './locale-document';
