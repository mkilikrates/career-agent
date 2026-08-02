// Feature: career-agent, Property 8: Employment gap detection
//
// For any chronologically ordered list of employment date ranges, every interval
// greater than three months between consecutive roles is detected and reported,
// and no interval of three months or less is reported.
//
// **Validates: Requirements 10.4, 13.1**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { detectGaps, GAP_THRESHOLD_MONTHS } from './review';
import type { EmploymentRecord } from './extraction';
import { formatYearMonth, type YearMonth } from './dates';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a year-month in a realistic range. */
const arbYearMonth: fc.Arbitrary<YearMonth> = fc
  .tuple(fc.integer({ min: 2000, max: 2025 }), fc.integer({ min: 1, max: 12 }))
  .map(([year, month]) => ({ year, month }));

/**
 * Generate a non-overlapping, chronologically sequential employment history
 * with random gaps between roles. This gives us a predictable structure to
 * verify gap detection against.
 */
const arbSequentialHistory = fc
  .tuple(
    arbYearMonth, // start of first role
    fc.array(
      fc.tuple(
        fc.integer({ min: 3, max: 36 }), // duration of role in months
        fc.integer({ min: 0, max: 12 }), // gap before next role in months
      ),
      { minLength: 2, maxLength: 8 },
    ),
  )
  .map(([firstStart, segments]) => {
    const roles: EmploymentRecord[] = [];
    const expectedGaps: { months: number; afterIdx: number }[] = [];

    let current = firstStart;

    for (let i = 0; i < segments.length; i++) {
      const [duration, gapMonths] = segments[i];

      // Role start
      const start: YearMonth = { ...current };
      // Role end
      const endAbsolute = start.year * 12 + (start.month - 1) + duration;
      const end: YearMonth = {
        year: Math.floor(endAbsolute / 12),
        month: (endAbsolute % 12) + 1,
      };

      roles.push({
        employer: `Company-${i}`,
        title: `Role-${i}`,
        start: formatYearMonth(start),
        end: formatYearMonth(end),
      });

      // Track gap (only if strictly > threshold)
      if (i < segments.length - 1 && gapMonths > GAP_THRESHOLD_MONTHS) {
        expectedGaps.push({ months: gapMonths, afterIdx: i });
      }

      // Next role starts after the gap
      const nextAbsolute = end.year * 12 + (end.month - 1) + gapMonths;
      current = {
        year: Math.floor(nextAbsolute / 12),
        month: (nextAbsolute % 12) + 1,
      };
    }

    return { roles, expectedGaps };
  });

/**
 * Generate a history where all gaps are exactly at or below the threshold
 * (should produce zero detected gaps).
 */
const arbNoGapHistory = fc
  .tuple(
    arbYearMonth,
    fc.array(
      fc.tuple(
        fc.integer({ min: 3, max: 24 }), // duration
        fc.integer({ min: 0, max: GAP_THRESHOLD_MONTHS }), // gap ≤ threshold
      ),
      { minLength: 2, maxLength: 6 },
    ),
  )
  .map(([firstStart, segments]) => {
    const roles: EmploymentRecord[] = [];
    let current = firstStart;

    for (let i = 0; i < segments.length; i++) {
      const [duration, gapMonths] = segments[i];
      const start: YearMonth = { ...current };
      const endAbsolute = start.year * 12 + (start.month - 1) + duration;
      const end: YearMonth = {
        year: Math.floor(endAbsolute / 12),
        month: (endAbsolute % 12) + 1,
      };

      roles.push({
        employer: `Company-${i}`,
        title: `Role-${i}`,
        start: formatYearMonth(start),
        end: formatYearMonth(end),
      });

      const nextAbsolute = end.year * 12 + (end.month - 1) + gapMonths;
      current = {
        year: Math.floor(nextAbsolute / 12),
        month: (nextAbsolute % 12) + 1,
      };
    }

    return roles;
  });

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('@core/ingestion — Property 8: Employment gap detection', () => {
  it('every gap > 3 months is detected and reported', () => {
    fc.assert(
      fc.property(arbSequentialHistory, ({ roles, expectedGaps }) => {
        const detected = detectGaps(roles);

        // Every expected gap (> threshold) should be in the detected list
        for (const expected of expectedGaps) {
          const matchingGap = detected.find(
            (g) =>
              g.afterEmployer === `Company-${expected.afterIdx}` &&
              g.beforeEmployer === `Company-${expected.afterIdx + 1}`,
          );
          expect(
            matchingGap,
            `Expected gap of ${expected.months} months after Company-${expected.afterIdx} was not detected`,
          ).toBeDefined();
          expect(matchingGap!.months).toBe(expected.months);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('no gap of 3 months or less is reported', () => {
    fc.assert(
      fc.property(arbNoGapHistory, (roles) => {
        const detected = detectGaps(roles);
        expect(detected).toHaveLength(0);
      }),
      { numRuns: 200 },
    );
  });

  it('every detected gap has months strictly greater than the threshold', () => {
    fc.assert(
      fc.property(arbSequentialHistory, ({ roles }) => {
        const detected = detectGaps(roles);

        for (const gap of detected) {
          expect(gap.months).toBeGreaterThan(GAP_THRESHOLD_MONTHS);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('overlapping roles never produce a gap', () => {
    fc.assert(
      fc.property(
        arbYearMonth,
        fc.integer({ min: 12, max: 36 }), // long role
        fc.integer({ min: 3, max: 11 }),   // overlap amount
        fc.integer({ min: 6, max: 24 }),   // second role duration
        (start, firstDuration, overlap, secondDuration) => {
          const endAbsolute = start.year * 12 + (start.month - 1) + firstDuration;
          const firstEnd: YearMonth = {
            year: Math.floor(endAbsolute / 12),
            month: (endAbsolute % 12) + 1,
          };

          // Second role starts before the first ends (overlap)
          const secondStartAbsolute = endAbsolute - overlap;
          const secondStart: YearMonth = {
            year: Math.floor(secondStartAbsolute / 12),
            month: (secondStartAbsolute % 12) + 1,
          };
          const secondEndAbsolute = secondStartAbsolute + secondDuration;
          const secondEnd: YearMonth = {
            year: Math.floor(secondEndAbsolute / 12),
            month: (secondEndAbsolute % 12) + 1,
          };

          const roles: EmploymentRecord[] = [
            {
              employer: 'First Corp',
              title: 'Role A',
              start: formatYearMonth(start),
              end: formatYearMonth(firstEnd),
            },
            {
              employer: 'Second Corp',
              title: 'Role B',
              start: formatYearMonth(secondStart),
              end: formatYearMonth(secondEnd),
            },
          ];

          const detected = detectGaps(roles);
          // No gap between overlapping roles
          expect(detected).toHaveLength(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('detected gaps carry neutral framing (R13.1)', () => {
    fc.assert(
      fc.property(arbSequentialHistory, ({ roles }) => {
        const detected = detectGaps(roles);

        for (const gap of detected) {
          // Framing is neutral and non-empty
          expect(gap.framing.length).toBeGreaterThan(0);
          // Should not contain judgemental language
          expect(gap.framing.toLowerCase()).not.toContain('unexplained');
          expect(gap.framing.toLowerCase()).not.toContain('concerning');
          // No note is invented (R13.3)
          expect(gap.note).toBeUndefined();
        }
      }),
      { numRuns: 100 },
    );
  });
});
