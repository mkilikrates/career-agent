// Locale persistence — serialize / parse / save `config/locale.md` (R41.3, R34.1, R34.2).
//
// When the user sets or changes the Session Language, Career_Agent SHALL store
// the choice in the Memory Store and apply it to subsequent messages, prompts,
// review steps, and outputs (R41.3). This module owns that persistence: the
// {@link LocaleConfig} (session language + optional region + optional output
// overrides) is written to the canonical `config/locale.md` path.
//
// Following the Markdown-as-database pattern (R34.1), the structured config is
// stored in the document frontmatter (the natural home for machine-read config)
// with a short human-readable body, and round-trips losslessly (R34.2):
// `parseLocaleConfig ∘ serializeLocaleConfig` recovers the config. Persistence
// is confirmation-gated (R41.2 → R41.3): {@link saveConfirmedLocaleConfig} only
// writes once the user has confirmed the Session Language, BEFORE the pipeline
// advances.

import type { LocaleConfig, MemoryPath, OutputLocale } from '@core/types';
import { parseMarkdown, serializeMarkdown } from '@core/markdown';
import { CANONICAL_FILES } from '@core/storage';
import { DEFAULT_LANGUAGE, isSupportedLanguage, type SessionLanguage } from './i18n';

/** Canonical Memory Store location for the locale config (R34.1, R41.3). */
export const LOCALE_PATH: MemoryPath = CANONICAL_FILES.locale;

/** Title heading written at the top of the locale document. */
export const LOCALE_HEADING = '# Locale';

// --- Serialize --------------------------------------------------------------

/**
 * Serialize a {@link LocaleConfig} to the canonical `config/locale.md` Markdown
 * (R34.1, R41.3). The structured config lives in frontmatter so it is read back
 * exactly; the body is a short human-readable summary. Deterministic: the
 * output depends only on the config.
 */
export const serializeLocaleConfig = (config: LocaleConfig): string => {
  const frontmatter: Record<string, unknown> = {
    sessionLanguage: config.sessionLanguage,
  };
  if (config.region !== undefined) frontmatter.region = config.region;
  if (config.outputOverrides !== undefined) {
    frontmatter.outputOverrides = config.outputOverrides;
  }

  const body: string[] = [
    LOCALE_HEADING,
    '',
    `- **Session language:** ${config.sessionLanguage}`,
  ];
  if (config.region !== undefined) {
    body.push(`- **Region:** ${config.region}`);
  }
  body.push('');

  return serializeMarkdown({ frontmatter, ids: [], body: `${body.join('\n')}\n` });
};

// --- Parse ------------------------------------------------------------------

/** Coerce a parsed session-language value to a Tier-1 language, defaulting safely. */
const readSessionLanguage = (value: unknown): SessionLanguage =>
  typeof value === 'string' && isSupportedLanguage(value) ? value : DEFAULT_LANGUAGE;

/**
 * Parse a `config/locale.md` document back into a {@link LocaleConfig} (R34.2).
 * The exact inverse of {@link serializeLocaleConfig}: the structured config is
 * recovered from frontmatter, and an unrecognised/absent session language falls
 * back to the default Tier-1 language.
 */
export const parseLocaleConfig = (markdown: string): LocaleConfig => {
  const { frontmatter } = parseMarkdown(markdown);

  const config: LocaleConfig = {
    sessionLanguage: readSessionLanguage(frontmatter.sessionLanguage),
  };
  if (typeof frontmatter.region === 'string') {
    config.region = frontmatter.region;
  }
  if (frontmatter.outputOverrides && typeof frontmatter.outputOverrides === 'object') {
    config.outputOverrides = frontmatter.outputOverrides as Partial<OutputLocale>;
  }
  return config;
};

// --- Persist (R41.3) --------------------------------------------------------

/** Minimal writer satisfied by both the Storage_Adapter and the MemoryTree. */
export interface LocaleConfigWriter {
  write(path: MemoryPath, data: string): unknown;
}

/** Minimal reader satisfied by both the Storage_Adapter and the MemoryTree. */
export interface LocaleConfigReader {
  has(path: MemoryPath): boolean;
  readText(path: MemoryPath): string;
}

/**
 * Persist the Session Language choice to `config/locale.md` via the supplied
 * writer (Storage_Adapter or MemoryTree). Serialization is shared with
 * {@link serializeLocaleConfig}, so the written file round-trips losslessly
 * (R34.2). Awaits the write so a Promise-returning adapter completes before the
 * caller advances (R41.3).
 */
export const saveLocaleConfig = async (
  writer: LocaleConfigWriter,
  config: LocaleConfig,
): Promise<MemoryPath> => {
  await writer.write(LOCALE_PATH, serializeLocaleConfig(config));
  return LOCALE_PATH;
};

/**
 * Confirmation-gated persistence (R41.2 → R41.3): save the Session Language
 * ONLY when the user has confirmed it, BEFORE the pipeline advances. Returns
 * the written path when saved, or `undefined` when `confirmed` is false
 * (nothing is written, so a detected-but-unconfirmed language is never applied
 * — R41.2).
 */
export const saveConfirmedLocaleConfig = async (
  writer: LocaleConfigWriter,
  config: LocaleConfig,
  confirmed: boolean,
): Promise<MemoryPath | undefined> => {
  if (!confirmed) return undefined;
  return saveLocaleConfig(writer, config);
};

/**
 * Load the persisted {@link LocaleConfig} from `config/locale.md` via the
 * supplied reader, or `undefined` when no locale has been stored yet (i.e. a
 * first-use profile that still needs the detect→confirm step — R41.2).
 */
export const loadLocaleConfig = (reader: LocaleConfigReader): LocaleConfig | undefined => {
  if (!reader.has(LOCALE_PATH)) return undefined;
  return parseLocaleConfig(reader.readText(LOCALE_PATH));
};
