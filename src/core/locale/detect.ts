// Preferred-language detection from the browser/OS locale (R41.2).
//
// On first use, Career_Agent detects the user's preferred language from the
// browser or operating-system locale and asks the user to CONFIRM or CHANGE it
// — it does NOT silently apply the detected language (R41.2). This module owns
// the pure detection step: mapping a list of BCP-47 locale tags (e.g.
// `navigator.languages`) to a Tier-1 Session Language *suggestion*. The
// confirmation step is a UI concern (@ui), and applying/persisting the choice
// is done only after confirmation via `@core/locale`'s document + i18n wiring.

import { DEFAULT_LANGUAGE, type SessionLanguage } from './i18n';

/**
 * The detected Session Language suggestion plus the explicit signal that it
 * must be confirmed before being applied (R41.2). `requiresConfirmation` is
 * always `true` — detection never auto-applies.
 */
export interface LanguageDetection {
  /** The Tier-1 Session Language suggested from the browser/OS locale. */
  readonly detected: SessionLanguage;
  /** Always true: the user must confirm or change before it is applied (R41.2). */
  readonly requiresConfirmation: true;
}

/**
 * Map one BCP-47 locale tag to a Tier-1 Session Language, or `undefined` when
 * the tag matches no Tier-1 language. Portuguese of any region maps to the only
 * Tier-1 Portuguese (`pt-BR`); English of any region maps to `en`.
 */
const matchLanguage = (tag: string): SessionLanguage | undefined => {
  const lower = tag.trim().toLowerCase();
  if (lower === 'pt-br' || lower === 'pt' || lower.startsWith('pt-') || lower.startsWith('pt_')) {
    return 'pt-BR';
  }
  if (lower === 'en' || lower.startsWith('en-') || lower.startsWith('en_')) {
    return 'en';
  }
  return undefined;
};

/**
 * Detect the preferred Session Language from an ordered list of BCP-47 locale
 * tags (most-preferred first), falling back to {@link DEFAULT_LANGUAGE} when no
 * tag matches a Tier-1 language (R41.2). Pure and deterministic.
 */
export const detectSessionLanguage = (
  preferred: readonly string[] | undefined,
): SessionLanguage => {
  for (const tag of preferred ?? []) {
    const match = matchLanguage(tag);
    if (match) return match;
  }
  return DEFAULT_LANGUAGE;
};

/**
 * Detect the preferred language and wrap it with the confirmation signal
 * (R41.2). The returned suggestion must be confirmed or changed by the user
 * before it is applied/persisted.
 */
export const proposeSessionLanguage = (
  preferred: readonly string[] | undefined,
): LanguageDetection => ({
  detected: detectSessionLanguage(preferred),
  requiresConfirmation: true,
});

/**
 * Read the browser/OS preferred locale tags in priority order. Safe to call in
 * a non-browser environment (returns an empty list), so the detection seam is
 * usable from tests and the core without a `navigator`.
 */
export const browserPreferredLocales = (): string[] => {
  if (typeof navigator === 'undefined') return [];
  const langs = navigator.languages;
  if (langs && langs.length > 0) return [...langs];
  return navigator.language ? [navigator.language] : [];
};
