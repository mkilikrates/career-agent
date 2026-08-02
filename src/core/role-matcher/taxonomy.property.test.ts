// Feature: career-agent, Property 6: Ontological match resolution
//
// For any taxonomy and skill map, when a target role requires a parent skill and
// the map contains a child skill defined as implements/extends of that parent,
// the matcher recognises the requirement as satisfied rather than reporting a gap.
//
// **Validates: Requirements 17.2, 20.3**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { asSkillTerm, type SkillTerm } from '@core/types';
import {
  loadTaxonomy,
  type TaxonomyConfig,
  type TaxonomyRelation,
  type RelationType,
} from './taxonomy';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a skill term (alphabetic, 3-15 chars). */
const arbSkillName = fc
  .stringMatching(/^[A-Z][a-z]{2,14}$/)
  .map((s) => asSkillTerm(s));

/** Generate a relation type. */
const arbRelationType: fc.Arbitrary<RelationType> = fc.constantFrom('implements', 'extends');

/** Generate a taxonomy relation between two distinct skill names. */
const arbRelation = fc
  .tuple(arbSkillName, arbSkillName, arbRelationType)
  .filter(([child, parent]) => String(child).toLowerCase() !== String(parent).toLowerCase())
  .map(([child, parent, type]): TaxonomyRelation => ({
    child: String(child),
    parent: String(parent),
    type,
  }));

/** Generate a taxonomy with 1-10 relations. */
const arbTaxonomyConfig: fc.Arbitrary<TaxonomyConfig> = fc
  .array(arbRelation, { minLength: 1, maxLength: 10 })
  .map((relations) => ({ relations }));

/** Generate an owned skill set (1-8 skills). */
const arbOwnedSkills: fc.Arbitrary<SkillTerm[]> = fc
  .array(arbSkillName, { minLength: 1, maxLength: 8 });

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('@core/role-matcher — Property 6: Ontological match resolution', () => {
  it('a child skill satisfies its direct parent requirement', () => {
    fc.assert(
      fc.property(arbTaxonomyConfig, (config) => {
        const taxonomy = loadTaxonomy(config);

        // For each relation, the child should satisfy the parent
        for (const rel of config.relations ?? []) {
          const owned = [asSkillTerm(rel.child)];
          const satisfied = taxonomy.satisfies(asSkillTerm(rel.parent), owned);
          expect(
            satisfied,
            `Child "${rel.child}" should satisfy parent "${rel.parent}" via ${rel.type}`,
          ).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a skill satisfies itself (direct match)', () => {
    fc.assert(
      fc.property(arbOwnedSkills.filter((s) => s.length > 0), (owned) => {
        const taxonomy = loadTaxonomy({ relations: [] });

        // Every skill in the owned set satisfies a requirement for itself
        for (const skill of owned) {
          expect(taxonomy.satisfies(skill, owned)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('transitive: grandchild satisfies grandparent (A extends B extends C → A satisfies C)', () => {
    fc.assert(
      fc.property(
        arbSkillName,
        arbSkillName,
        arbSkillName,
        arbRelationType,
        arbRelationType,
        (grandchild, parent, grandparent, type1, type2) => {
          // Skip if any are the same (case-insensitive)
          const gc = String(grandchild).toLowerCase();
          const p = String(parent).toLowerCase();
          const gp = String(grandparent).toLowerCase();
          if (gc === p || p === gp || gc === gp) return;

          const config: TaxonomyConfig = {
            relations: [
              { child: String(grandchild), parent: String(parent), type: type1 },
              { child: String(parent), parent: String(grandparent), type: type2 },
            ],
          };
          const taxonomy = loadTaxonomy(config);

          // Grandchild satisfies grandparent transitively
          const owned = [grandchild];
          expect(
            taxonomy.satisfies(grandparent, owned),
            `"${grandchild}" should transitively satisfy "${grandparent}"`,
          ).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a skill that has no relation to the requirement does NOT satisfy it', () => {
    fc.assert(
      fc.property(
        arbSkillName,
        arbSkillName,
        arbTaxonomyConfig,
        (required, unrelated, config) => {
          // Ensure `unrelated` is genuinely unrelated: not the required term
          // and not a descendant of it in the taxonomy
          const requiredStr = String(required).toLowerCase();
          const unrelatedStr = String(unrelated).toLowerCase();
          if (requiredStr === unrelatedStr) return;

          const taxonomy = loadTaxonomy(config);

          // If unrelated is actually a descendant, skip this test case
          if (taxonomy.isDescendantOf(unrelated, required)) return;
          if (String(unrelated).toLowerCase() === String(required).toLowerCase()) return;

          const owned = [unrelated];
          expect(taxonomy.satisfies(required, owned)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('cycles in taxonomy are tolerated without infinite loops', () => {
    fc.assert(
      fc.property(arbSkillName, arbSkillName, (a, b) => {
        if (String(a).toLowerCase() === String(b).toLowerCase()) return;

        // Create a cycle: A extends B, B extends A
        const config: TaxonomyConfig = {
          relations: [
            { child: String(a), parent: String(b), type: 'extends' },
            { child: String(b), parent: String(a), type: 'extends' },
          ],
        };
        const taxonomy = loadTaxonomy(config);

        // Both satisfy each other (cycle is handled gracefully)
        expect(taxonomy.satisfies(b, [a])).toBe(true);
        expect(taxonomy.satisfies(a, [b])).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
