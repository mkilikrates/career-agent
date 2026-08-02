// Feature: career-agent, Property 4: Conservative-merge guardrails and reversible merge
//
// For any set of skill terms, the normaliser merges two terms only when they are
// unambiguously the same skill, never merges a pair listed in confusables.yaml or
// two distinct named products on the basis of string similarity, never introduces
// a sub-skill absent from source, adds an umbrella term (when present in source)
// as a separate additional skill rather than a replacement, and for any merge that
// occurs a reversible MergeRecord exists such that a one-step split restores the
// original distinct terms.
//
// **Validates: Requirements 15.1, 15.2, 15.3, 15.4, 16.1, 16.2, 16.3, 19.3**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { asISODate, asSkillTerm, type SkillTerm } from '@core/types';
import {
  normalise,
  toMergeRecord,
  splitMergeRecord,
} from './normalise';
import {
  loadConfusables,
  loadConfusablesFromYaml,
  DEFAULT_CONFUSABLES_YAML,
  type Confusables,
} from './confusables';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const defaultConfusables = loadConfusablesFromYaml(DEFAULT_CONFUSABLES_YAML);

/** Build a confusables with synonyms. */
const confusablesWithSynonyms = (
  synonyms: string[][],
  pairs: [string, string][] = [],
  umbrellas: string[] = [],
): Confusables =>
  loadConfusables({ pairs, synonyms, abbreviations: [], umbrellas });

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a non-empty skill term (alphabetic + digits + spaces, 2-20 chars). */
const arbSkillTerm: fc.Arbitrary<SkillTerm> = fc
  .stringMatching(/^[A-Za-z][A-Za-z0-9 .+#-]{1,19}$/)
  .map((s) => asSkillTerm(s.trim() || 'Skill'));

/** Generate a set of 2-15 random skill terms. */
const arbTerms: fc.Arbitrary<SkillTerm[]> = fc
  .array(arbSkillTerm, { minLength: 2, maxLength: 15 })
  .map((terms) => terms.filter((t) => String(t).trim().length > 0))
  .filter((terms) => terms.length >= 2);

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('@core/skills — Property 4: Conservative-merge guardrails and reversible merge', () => {
  it('never introduces a skill absent from the input set (R15.3)', () => {
    fc.assert(
      fc.property(arbTerms, (terms) => {
        const plan = normalise(terms, defaultConfusables);

        // Every term in the output skills list must have appeared in the input
        const inputStrings = new Set(terms.map(String));
        for (const skill of plan.skills) {
          expect(
            inputStrings.has(String(skill)),
            `Output skill "${skill}" is not in the input set`,
          ).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('never merges a confusable pair (R16.3)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom(
            asSkillTerm('Java'),
            asSkillTerm('JavaScript'),
            asSkillTerm('C'),
            asSkillTerm('C++'),
            asSkillTerm('C#'),
            asSkillTerm('React'),
            asSkillTerm('React Native'),
          ),
          { minLength: 2, maxLength: 7 },
        ),
        (terms) => {
          const plan = normalise(terms, defaultConfusables);

          // Confusable pairs from DEFAULT_CONFUSABLES_YAML
          const confusablePairs: [string, string][] = [
            ['Java', 'JavaScript'],
            ['C', 'C++'],
            ['C', 'C#'],
            ['React', 'React Native'],
          ];

          for (const merge of plan.merges) {
            const merged = merge.from.map(String);
            for (const [a, b] of confusablePairs) {
              const hasA = merged.some((s) => s.toLowerCase() === a.toLowerCase());
              const hasB = merged.some((s) => s.toLowerCase() === b.toLowerCase());
              expect(
                hasA && hasB,
                `Confusable pair [${a}, ${b}] was merged together`,
              ).toBe(false);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('string similarity alone never triggers a merge (R16.1)', () => {
    fc.assert(
      fc.property(arbTerms, (terms) => {
        // Use empty confusables (no synonyms, no abbreviations)
        const noSynonyms = loadConfusables({
          pairs: [],
          synonyms: [],
          abbreviations: [],
          umbrellas: [],
        });
        const plan = normalise(terms, noSynonyms);

        // Without any synonym/abbreviation groups, the only allowed merge reason
        // is casing-or-spelling-variant (exact same canonical form)
        for (const merge of plan.merges) {
          expect(merge.reason).toBe('casing-or-spelling-variant');
        }
      }),
      { numRuns: 200 },
    );
  });

  it('umbrella terms present in source are kept as separate additional skills (R16.2)', () => {
    // Create confusables with "Cloud" as an umbrella
    const conf = loadConfusables({
      pairs: [],
      synonyms: [],
      abbreviations: [],
      umbrellas: ['Cloud'],
    });

    const terms: SkillTerm[] = [
      asSkillTerm('AWS'),
      asSkillTerm('Cloud'),
      asSkillTerm('Azure'),
    ];

    const plan = normalise(terms, conf);

    // "Cloud" must appear in the umbrellas list
    expect(plan.umbrellas.map(String)).toContain('Cloud');

    // "Cloud" must appear as its own skill in the output (not absorbed)
    expect(plan.skills.map(String)).toContain('Cloud');
  });

  it('every merge produces a reversible MergeRecord that restores original terms (R19.3)', () => {
    fc.assert(
      fc.property(arbTerms, (terms) => {
        // Use confusables with one synonym group to encourage merges
        const conf = confusablesWithSynonyms([
          ['kubernetes', 'k8s'],
          ['javascript', 'ecmascript'],
        ]);
        const plan = normalise(terms, conf);

        for (const merge of plan.merges) {
          // Convert to a MergeRecord
          const record = toMergeRecord(merge, asISODate('2024-06-01'));
          expect(record.reversible).toBe(true);

          // Split restores all original terms
          const restored = splitMergeRecord(record);
          const originalSet = new Set(merge.from.map(String));
          const restoredSet = new Set(restored.map(String));

          // Every original term is recovered after split
          for (const original of originalSet) {
            expect(restoredSet.has(original)).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('at most one merge suggestion per uncertain pair (R15.4)', () => {
    fc.assert(
      fc.property(arbTerms, (terms) => {
        const plan = normalise(terms, defaultConfusables);

        // Check no duplicate pair appears in suggestions
        const pairKeys = plan.suggestions.map((s) => {
          const [a, b] = s.terms.map(String).sort();
          return `${a}||${b}`;
        });
        expect(new Set(pairKeys).size).toBe(pairKeys.length);
      }),
      { numRuns: 200 },
    );
  });
});
