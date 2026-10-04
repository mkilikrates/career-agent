// Feature: career-agent, Property 1 (fact-fidelity clause): a resolved claim
// that adds a new fact token fails; pure rephrasing of the source passes.
//
// This exercises the fact-fidelity half of Correctness Property 1 (R40.2b) — the
// companion to `no-fabrication.property.test.ts`, which covers the resolution
// half (R40.2a). For any confirmed source quote and any resolved CV bullet keyed
// to it:
//   * if the bullet text injects a numeric/entity fact token the source does not
//     contain, verifyOutput reports it unfaithful and fails the output (R37.5);
//   * if the bullet text carries only the source's own fact tokens woven into
//     fresh prose (no new fact token), verifyOutput passes it (R37.5).
//
// **Validates: Requirements 37.5, 40.2**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { asBulletId, asDocId, asRoleSlug } from '@core/types';
import { ProvenanceIndex, sourceLine } from '@core/provenance';
import { verifyOutput } from './verify';
import { extractFactTokens } from './fidelity';
import type { CvModel } from '@core/output';

const DOC = asDocId('cv.pdf');

/** A source sentence that carries at least one fact token (an entity or metric). */
const arbSourceText = fc
  .tuple(
    fc.constantFrom('Led', 'Built', 'Shipped', 'Owned', 'Scaled'),
    fc.constantFrom('the billing platform', 'a design system', 'the data pipeline'),
    fc.constantFrom('at Acme', 'at Globex', 'at Initech'),
    fc.integer({ min: 2, max: 95 }),
  )
  .map(([verb, what, where, pct]) => `${verb} ${what} ${where}, improving throughput ${pct}%`);

/** A new fact token guaranteed absent from any source produced above. */
const arbNewFact = fc.constantFrom('999%', 'at Umbrella', 'in 1998', '$7M');

const bulletCv = (text: string): CvModel => ({
  targetRole: { slug: asRoleSlug('engineer'), title: 'Engineer' },
  header: {},
  skills: [],
  experience: [
    {
      id: asBulletId('BULLET-01'),
      source: 'accomplishment',
      text,
      skills: [],
      targetRelevant: true,
      quantified: /\d/.test(text),
      needsMetric: false,
    },
  ],
  education: [],
  certifications: [],
});

const indexFor = (sourceText: string): ProvenanceIndex =>
  new ProvenanceIndex().attach(asBulletId('BULLET-01'), sourceLine(DOC, 1, sourceText));

describe('@core/no-fabrication — Property 23: fact fidelity', () => {
  it('a bullet that injects a new fact token fails verification', () => {
    fc.assert(
      fc.property(arbSourceText, arbNewFact, (sourceText, newFact) => {
        // Guard: skip the rare case the "new" fact already appears in the source.
        fc.pre(!extractFactTokens(sourceText).some(
          (t) => extractFactTokens(newFact).some((n) => n.norm === t.norm),
        ));
        const emitted = `${sourceText} ${newFact}`;
        const report = verifyOutput({ kind: 'cv', model: bulletCv(emitted) }, indexFor(sourceText));
        expect(report.unresolved).toHaveLength(0); // id still resolves
        expect(report.passed).toBe(false); // ...but fidelity fails
        expect(report.unfaithful.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it('a rephrase carrying only the source fact tokens passes verification', () => {
    // A faithful rephrase introduces no new fact token. We simulate one by
    // weaving the source's own fact tokens into fresh lowercase prose (lowercase
    // so no accidental new proper-noun entity is created), in any order.
    const arbFiller = fc.subarray(
      ['improved', 'the', 'system', 'and', 'overall', 'results', 'for', 'users'],
      { minLength: 0, maxLength: 4 },
    );
    fc.assert(
      fc.property(arbSourceText, arbFiller, fc.integer({ min: 0, max: 1000 }), (sourceText, filler, seed) => {
        const factRaws = extractFactTokens(sourceText).map((t) => t.raw);
        const pieces = ['delivered', ...filler, ...factRaws];
        // Deterministic shuffle of the pieces (word order is free).
        for (let i = pieces.length - 1; i > 0; i--) {
          const j = (seed * (i + 7)) % (i + 1);
          [pieces[i], pieces[j]] = [pieces[j]!, pieces[i]!];
        }
        const emitted = pieces.join(' ');
        const report = verifyOutput({ kind: 'cv', model: bulletCv(emitted) }, indexFor(sourceText));
        expect(report.passed).toBe(true);
        expect(report.unfaithful).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });
});
