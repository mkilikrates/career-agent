// Localisation data models (R41).

/** Per-output locale formatting conventions (R41.6, R41.7). */
export interface OutputLocale {
  dateFormat: string;
  pageLengthNorm: number;
  currencyFormat: string;
  numberFormat: string;
  sectionNames: Record<string, string>;
  // Locale-driven personal-data fields default to omitted (false) unless the
  // user explicitly opts in (R41.7).
  includePhoto: boolean;
  includeAge: boolean;
  includeMaritalStatus: boolean;
}

/** Session-level locale configuration backing `config/locale.md` (R41). */
export interface LocaleConfig {
  sessionLanguage: 'en' | 'pt-BR'; // Tier-1 (R41.1)
  region?: string; // e.g. 'BR', 'GB', 'US'
  outputOverrides?: Partial<OutputLocale>; // user can override any convention (R41.6)
}
