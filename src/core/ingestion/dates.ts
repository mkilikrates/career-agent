// Lightweight, honest date handling for ingestion (R10.4, R13.1, R13.4).
//
// Source documents and LinkedIn exports phrase dates many ways ("Jan 2019",
// "2019-03", "March 2019", "2019", "Present"). Ingestion needs two things from
// them: a comparable year-month for gap detection (R10.4), and an *honest*
// month-year rendering for display that never conceals a gap (R13.4). These
// helpers are intentionally small and pure; they normalise to a year-month and
// never invent precision that the source did not provide.

/** A parsed calendar month: 1-based `month` within `year`. */
export interface YearMonth {
  readonly year: number;
  /** 1..12 */
  readonly month: number;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** Tokens meaning "no end date / ongoing", which are never a gap boundary. */
const PRESENT_TOKENS = new Set(['present', 'current', 'now', 'ongoing', 'atual', 'presente']);

/** True when a date token denotes an ongoing role (no end date). */
export const isPresent = (value: string | undefined): boolean =>
  value !== undefined && PRESENT_TOKENS.has(value.trim().toLowerCase());

/**
 * Parse a free-form date string into a {@link YearMonth}, or `undefined` when no
 * year can be found. Recognises `YYYY-MM`, `YYYY/MM`, `MM/YYYY`, `Mon YYYY`,
 * `Month YYYY`, and a bare `YYYY` (which defaults to January). Never guesses a
 * day; ingestion only ever reasons at month granularity.
 */
export const parseYearMonth = (value: string | undefined): YearMonth | undefined => {
  if (!value) return undefined;
  const text = value.trim();
  if (text.length === 0 || isPresent(text)) return undefined;

  // ISO-ish: 2019-03 / 2019/03 / 2019-03-15
  const iso = /^(\d{4})[-/](\d{1,2})/.exec(text);
  if (iso) {
    const month = Number(iso[2]);
    if (month >= 1 && month <= 12) return { year: Number(iso[1]), month };
  }

  // MM/YYYY
  const mmYyyy = /^(\d{1,2})[-/](\d{4})$/.exec(text);
  if (mmYyyy) {
    const month = Number(mmYyyy[1]);
    if (month >= 1 && month <= 12) return { year: Number(mmYyyy[2]), month };
  }

  // Month name + year, e.g. "Jan 2019", "March 2019".
  const named = /([A-Za-z]+)\.?\s+(\d{4})/.exec(text);
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    if (month) return { year: Number(named[2]), month };
  }

  // Bare year → January of that year.
  const bare = /\b(\d{4})\b/.exec(text);
  if (bare) return { year: Number(bare[1]), month: 1 };

  return undefined;
};

/** Total months since year 0 (for arithmetic). */
const absoluteMonths = (ym: YearMonth): number => ym.year * 12 + (ym.month - 1);

/**
 * Whole-month difference `later - earlier` (can be negative when the ranges
 * overlap). Used to measure the gap between consecutive roles (R10.4).
 */
export const monthsBetween = (earlier: YearMonth, later: YearMonth): number =>
  absoluteMonths(later) - absoluteMonths(earlier);

const PAD = (n: number): string => String(n).padStart(2, '0');

/** Canonical `YYYY-MM` rendering of a {@link YearMonth}. */
export const formatYearMonth = (ym: YearMonth): string => `${ym.year}-${PAD(ym.month)}`;

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Honest, human-readable "Month YYYY" rendering used for displaying gap
 * boundaries (R13.4). Always shows the month and year explicitly so a gap can
 * never be concealed by collapsing to bare years.
 */
export const honestMonthYear = (ym: YearMonth): string =>
  `${MONTH_LABELS[ym.month - 1]} ${ym.year}`;
