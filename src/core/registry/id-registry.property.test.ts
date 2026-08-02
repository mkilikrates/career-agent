// Feature: career-agent, Property 2: Stable identifier integrity and bi-directionality
//
// For any sequence of create / edit / retire operations on accomplishments and
// talking points, every assigned BULLET-NN and STAR-NN identifier is unique, is
// never reused or renumbered, and retired items remain present and marked rather
// than deleted; and for every skill→accomplishment link the reverse
// accomplishment→skill link resolves consistently.
//
// **Validates: Requirements 18.1, 18.3, 18.4, 23.1, 23.2, 23.3, 28.3**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { IdRegistry, formatId, parseId } from './id-registry';
import { ReferenceGraph } from './reference-graph';
import { asSkillId, asBulletId, asStarId, type SkillId } from '@core/types';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

type Op =
  | { type: 'mint'; kind: 'STAR' | 'BULLET' }
  | { type: 'retire'; kind: 'STAR' | 'BULLET'; n: number }
  | { type: 'seed'; kind: 'STAR' | 'BULLET'; n: number };

const arbKind: fc.Arbitrary<'STAR' | 'BULLET'> = fc.constantFrom('STAR', 'BULLET');

const arbMint: fc.Arbitrary<Op> = arbKind.map((kind) => ({ type: 'mint', kind }));

const arbRetire: fc.Arbitrary<Op> = fc
  .tuple(arbKind, fc.integer({ min: 1, max: 50 }))
  .map(([kind, n]) => ({ type: 'retire', kind, n }));

const arbSeed: fc.Arbitrary<Op> = fc
  .tuple(arbKind, fc.integer({ min: 1, max: 50 }))
  .map(([kind, n]) => ({ type: 'seed', kind, n }));

/** Generate a sequence of 5-30 registry operations. */
const arbOps: fc.Arbitrary<Op[]> = fc.array(
  fc.oneof(arbMint, arbMint, arbMint, arbRetire, arbSeed),
  { minLength: 5, maxLength: 30 },
);

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('@core/registry — Property 2: Stable identifier integrity and bi-directionality', () => {
  it('every assigned id is unique, never reused, and retired items remain present and marked', () => {
    fc.assert(
      fc.property(arbOps, (ops) => {
        const registry = new IdRegistry();
        const minted: string[] = [];

        for (const op of ops) {
          switch (op.type) {
            case 'mint': {
              const id = registry.mint(op.kind);
              minted.push(id);
              break;
            }
            case 'retire': {
              const id = formatId(op.kind, op.n);
              registry.retire(id);
              break;
            }
            case 'seed': {
              const id = formatId(op.kind, op.n);
              registry.seed([id]);
              break;
            }
          }
        }

        // 1. Every minted id is unique (no two mint calls ever return the same string)
        const mintedSet = new Set(minted);
        expect(mintedSet.size).toBe(minted.length);

        // 2. Every minted id is allocated
        for (const id of minted) {
          expect(registry.isAllocated(id)).toBe(true);
        }

        // 3. Every retired id is still present and marked retired (not deleted)
        for (const op of ops) {
          if (op.type === 'retire') {
            const id = formatId(op.kind, op.n);
            expect(registry.isAllocated(id)).toBe(true);
            expect(registry.isRetired(id)).toBe(true);
          }
        }

        // 4. Retired ids remain in allIds (never removed)
        const allIds = registry.allIds();
        const retiredIds = registry.retiredIds();
        for (const r of retiredIds) {
          expect(allIds).toContain(r);
        }

        // 5. Every id parses back correctly (never renumbered)
        for (const id of minted) {
          const parsed = parseId(id);
          expect(parsed).toBeDefined();
          expect(formatId(parsed!.kind, parsed!.n)).toBe(id);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('minting after seeding never reuses a seeded id', () => {
    fc.assert(
      fc.property(
        arbKind,
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 1, max: 10 }),
        (kind, seedNums, mintCount) => {
          const registry = new IdRegistry();
          const seedIds = seedNums.map((n) => formatId(kind, n));
          registry.seed(seedIds);

          const newIds: string[] = [];
          for (let i = 0; i < mintCount; i++) {
            newIds.push(registry.mint(kind));
          }

          // No newly minted id collides with a seeded id
          for (const id of newIds) {
            expect(seedIds).not.toContain(id);
          }

          // Newly minted ids are unique among themselves
          expect(new Set(newIds).size).toBe(newIds.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('bi-directional graph: every skill→proof link has a resolving reverse proof→skill link', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 1, maxLength: 5 }),
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: 4 }),
            fc.integer({ min: 0, max: 4 }),
            fc.constantFrom('BULLET', 'STAR') as fc.Arbitrary<'BULLET' | 'STAR'>,
          ),
          { minLength: 1, maxLength: 20 },
        ),
        (skillNums, links) => {
          const graph = new ReferenceGraph();
          const skills: SkillId[] = skillNums.map((n) => asSkillId(`SKILL-${n}`));

          // Add links
          for (const [si, pi, kind] of links) {
            const skill = skills[si % skills.length];
            const proof = kind === 'BULLET'
              ? asBulletId(`BULLET-${String((pi % 5) + 1).padStart(2, '0')}`)
              : asStarId(`STAR-${String((pi % 5) + 1).padStart(2, '0')}`);
            graph.addLink(skill, proof);
          }

          // For every skill→proof direction, the reverse holds
          for (const [skill, proof] of graph.links()) {
            const reverseSkills = graph.skillsFor(proof);
            expect(reverseSkills).toContain(skill);
          }

          // For every proof→skill direction, the forward also holds
          for (const [skill, proof] of graph.links()) {
            const forwardProofs = graph.proofsFor(skill);
            expect(forwardProofs.map(String)).toContain(String(proof));
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
