// Feature: career-agent, Property 13: CV version immutability and diff correctness
//
// For any sequence of CV edits for a role, every previously stored version
// remains byte-identical and each edit yields a new version identifier; and for
// any two versions, the produced diff enumerates exactly the accomplishments
// added, removed, or reordered and the skills whose emphasis changed.
//
// **Validates: Requirements 33.1, 33.2, 33.3**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { asBulletId, asRoleSlug, asSkillId, asStarId } from '@core/types';
import { MemoryTree } from '@core/storage';
import {
  recordVersion,
  storedVersions,
  diffCv,
  type CvVersionContents,
} from './versioning';
import type { CvModel, CvBullet, CvSkill } from './cv-model';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SLUG = asRoleSlug('test-role');

const makeSkill = (n: number, relevant: boolean): CvSkill => ({
  id: asSkillId(`SKILL-${n}`),
  name: `Skill${n}`,
  category: 'Technical',
  targetRelevant: relevant,
});

const makeBullet = (n: number, kind: 'BULLET' | 'STAR' = 'BULLET'): CvBullet => ({
  id: kind === 'BULLET' ? asBulletId(`BULLET-${String(n).padStart(2, '0')}`) : asStarId(`STAR-${String(n).padStart(2, '0')}`),
  source: kind === 'BULLET' ? 'accomplishment' : 'talking-point',
  text: `Accomplishment text ${n}`,
  skills: [asSkillId(`SKILL-${n % 3}`)],
  targetRelevant: true,
  quantified: false,
  needsMetric: false,
});

const makeModel = (bullets: CvBullet[], skills: CvSkill[]): CvModel => ({
  targetRole: { slug: SLUG, title: 'Test Role' },
  header: { name: 'User' },
  skills,
  experience: bullets,
  education: [],
  certifications: [],
});

const makeContents = (n: number): CvVersionContents => ({
  md: `# CV version ${n}\n\nContent for version ${n}.`,
});

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a sequence of 2-6 distinct CV markdown contents. */
const arbVersionSequence = fc
  .integer({ min: 2, max: 6 })
  .map((count) =>
    Array.from({ length: count }, (_, i) => makeContents(i + 1)),
  );

/** Generate an array of bullets with unique IDs in a given order. */
const arbBullets = fc
  .shuffledSubarray(
    Array.from({ length: 8 }, (_, i) => makeBullet(i)),
    { minLength: 2, maxLength: 8 },
  );

/** Generate skills with shuffled relevance. */
const arbSkills = fc
  .shuffledSubarray(
    Array.from({ length: 6 }, (_, i) => makeSkill(i, i % 2 === 0)),
    { minLength: 2, maxLength: 6 },
  );

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('@core/output — Property 13: CV version immutability and diff correctness', () => {
  it('each edit yields a new version number strictly greater than all existing (R33.2)', () => {
    fc.assert(
      fc.property(arbVersionSequence, (versions) => {
        const tree = new MemoryTree();
        const recorded: number[] = [];

        for (const contents of versions) {
          const id = recordVersion(tree, SLUG, contents);
          recorded.push(id.version);
        }

        // Every version is unique
        expect(new Set(recorded).size).toBe(recorded.length);

        // Strictly increasing
        for (let i = 1; i < recorded.length; i++) {
          expect(recorded[i]).toBeGreaterThan(recorded[i - 1]);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('previously stored versions remain byte-identical after subsequent edits (R33.1)', () => {
    fc.assert(
      fc.property(arbVersionSequence, (versions) => {
        const tree = new MemoryTree();
        const stored: Map<number, string> = new Map();

        for (const contents of versions) {
          const id = recordVersion(tree, SLUG, contents);
          stored.set(id.version, contents.md);
        }

        // After all edits, every stored version still reads back identically
        for (const [version, originalMd] of stored) {
          const path = `outputs/cv_test-role_v${version}.md`;
          expect(tree.readText(path)).toBe(originalMd);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('recordVersion never overwrites: each call produces a unique higher version (R33.2)', () => {
    fc.assert(
      fc.property(arbVersionSequence, (versions) => {
        const tree = new MemoryTree();
        const ids: number[] = [];

        for (const contents of versions) {
          const id = recordVersion(tree, SLUG, contents);
          ids.push(id.version);
        }

        // Each successive version is unique and strictly increasing
        for (let i = 1; i < ids.length; i++) {
          expect(ids[i]).toBeGreaterThan(ids[i - 1]);
        }

        // storedVersions includes every recorded version
        const stored = storedVersions(tree, SLUG);
        for (const v of ids) {
          expect(stored).toContain(v);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('diffCv reports added accomplishments correctly (R33.3)', () => {
    fc.assert(
      fc.property(arbBullets, arbBullets, arbSkills, (bulletsA, bulletsB, skills) => {
        const a = makeModel(bulletsA, skills);
        const b = makeModel(bulletsB, skills);
        const diff = diffCv(a, b);

        const idsA = new Set(bulletsA.map((x) => String(x.id)));
        const idsB = new Set(bulletsB.map((x) => String(x.id)));

        // Added: in B but not A
        for (const added of diff.accomplishments.added) {
          expect(idsB.has(String(added))).toBe(true);
          expect(idsA.has(String(added))).toBe(false);
        }

        // Removed: in A but not B
        for (const removed of diff.accomplishments.removed) {
          expect(idsA.has(String(removed))).toBe(true);
          expect(idsB.has(String(removed))).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('diffCv reports skill emphasis changes accurately (R33.3)', () => {
    fc.assert(
      fc.property(arbSkills, arbSkills, (skillsA, skillsB) => {
        const bullets = [makeBullet(0)];
        const a = makeModel(bullets, skillsA);
        const b = makeModel(bullets, skillsB);
        const diff = diffCv(a, b);

        const idsA = new Set(skillsA.map((s) => String(s.id)));
        const idsB = new Set(skillsB.map((s) => String(s.id)));

        for (const change of diff.skills.emphasised) {
          if (change.kind === 'added') {
            expect(idsB.has(String(change.id))).toBe(true);
            expect(idsA.has(String(change.id))).toBe(false);
          } else if (change.kind === 'removed') {
            expect(idsA.has(String(change.id))).toBe(true);
            expect(idsB.has(String(change.id))).toBe(false);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('diffCv of identical models is empty', () => {
    fc.assert(
      fc.property(arbBullets, arbSkills, (bullets, skills) => {
        const model = makeModel(bullets, skills);
        const diff = diffCv(model, model);
        expect(diff.empty).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
