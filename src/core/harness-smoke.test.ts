import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { add, reverse } from './harness-smoke';

// Smoke tests proving the Vitest + fast-check harness is wired up and that the
// global property default (minimum 100 iterations) is in effect.

describe('harness smoke — unit', () => {
  it('add sums two numbers', () => {
    expect(add(2, 3)).toBe(5);
  });

  it('reverse reverses a known array without mutating the input', () => {
    const input = [1, 2, 3];
    expect(reverse(input)).toEqual([3, 2, 1]);
    expect(input).toEqual([1, 2, 3]);
  });
});

describe('harness smoke — property', () => {
  it('add is commutative', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        expect(add(a, b)).toBe(add(b, a));
      }),
    );
  });

  it('reverse is its own inverse (involution)', () => {
    fc.assert(
      fc.property(fc.array(fc.anything()), (arr) => {
        expect(reverse(reverse(arr))).toEqual([...arr]);
      }),
    );
  });

  it('the global numRuns default is at least 100', () => {
    expect(fc.readConfigureGlobal().numRuns).toBe(100);
  });
});
