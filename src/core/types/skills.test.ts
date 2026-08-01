import { describe, it, expect } from 'vitest';
import { asISODate } from './brands';
import { experienceDuration, experienceYears } from './skills';

describe('experienceDuration (R70.1, R70.8)', () => {
  it('returns undefined when since is absent', () => {
    expect(experienceDuration(undefined, asISODate('2025-01-01'))).toBeUndefined();
  });

  it('returns undefined when since is unparseable', () => {
    expect(experienceDuration(asISODate('not-a-date'), asISODate('2025-01-01'))).toBeUndefined();
  });

  it('computes duration as lastEvidence - since (not now - since)', () => {
    // COBOL: used from 1993 to 1997 → ~4 years, NOT ~31 years
    const years = experienceDuration(asISODate('1993-01-01'), asISODate('1997-01-01'));
    expect(years).toBe(4);
  });

  it('legacy skill example: COBOL since 1995, lastEvidence 1995 → ~1 year (half-year rounds up)', () => {
    const years = experienceDuration(asISODate('1995-06-01'), asISODate('1995-12-01'));
    expect(years).toBe(1); // ~6 months rounds to 1
  });

  it('active skill example: BGP since 2006, lastEvidence 2025 → ~19 years', () => {
    const years = experienceDuration(asISODate('2006-01-01'), asISODate('2025-01-01'));
    expect(years).toBe(19);
  });

  it('falls back to current date when lastEvidence is undefined (still active)', () => {
    // Since 2020 → should be a positive number of years (depends on current date)
    const years = experienceDuration(asISODate('2020-01-01'), undefined);
    expect(years).toBeGreaterThanOrEqual(4); // at least 4 years from 2020
  });

  it('returns 0 when since equals lastEvidence', () => {
    expect(experienceDuration(asISODate('2024-06-15'), asISODate('2024-06-15'))).toBe(0);
  });

  it('returns 0 (never negative) when lastEvidence is before since', () => {
    expect(experienceDuration(asISODate('2024-01-01'), asISODate('2020-01-01'))).toBe(0);
  });
});

describe('experienceYears (deprecated, backward compat)', () => {
  it('still computes now - since for backward compat', () => {
    const years = experienceYears(asISODate('2020-01-01'));
    expect(years).toBeGreaterThanOrEqual(4);
  });

  it('returns undefined when since is absent', () => {
    expect(experienceYears(undefined)).toBeUndefined();
  });
});
