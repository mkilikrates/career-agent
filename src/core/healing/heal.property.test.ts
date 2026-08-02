// Feature: career-agent, Property 14: State-healing detection completeness
//
// For any Memory Store into which dangling identifier references and duplicate
// identifiers have been injected, the healing pass detects exactly those broken
// references and duplicates, flags them (prompting repair / re-index) rather
// than throwing, and a structurally clean store yields an empty healing report.
//
// **Validates: Requirements 36.1, 36.2, 36.3**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { asDocId, asISODate, asMemoryPath, asSkillId, type SkillMapEntry } from '@core/types';
import { anchorComment } from '@core/markdown';
import { healStore, collectDeclarations, type StoreFile } from './heal';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a STAR or BULLET id string. */
const arbProofId = fc
  .tuple(
    fc.constantFrom('STAR', 'BULLET'),
    fc.integer({ min: 1, max: 30 }),
  )
  .map(([kind, n]) => `${kind}-${String(n).padStart(2, '0')}`);

/** Generate a valid MemoryPath. */
const arbPath = fc
  .integer({ min: 1, max: 10 })
  .map((n) => asMemoryPath(`profile/file-${n}.md`));

/** Generate a set of declared IDs across files (with possible duplicates). */
const arbDeclarations = fc
  .array(fc.tuple(arbPath, arbProofId), { minLength: 1, maxLength: 15 })
  .map((pairs) =>
    pairs.map(([path, id]) => ({
      path,
      markdown: `# Heading\n${anchorComment(id)}\nSome content`,
    })),
  );

/** Generate skill entries referencing given proof IDs. */
const arbSkillEntries = (proofIds: string[]): fc.Arbitrary<SkillMapEntry[]> =>
  fc
    .array(
      fc.tuple(
        fc.integer({ min: 1, max: 10 }),
        fc.subarray(proofIds, { minLength: 0, maxLength: Math.min(4, proofIds.length) }),
      ),
      { minLength: 1, maxLength: 5 },
    )
    .map((entries) =>
      entries.map(([n, refs]) => ({
        id: asSkillId(`SKILL-${n}`),
        name: `Skill ${n}`,
        category: 'Technical' as const,
        proficiencySignal: 'demonstrated' as const,
        evidence: refs.map((ref) => ({
          ref: ref as unknown as typeof asDocId extends (s: string) => infer T ? T : never,
          when: asISODate('2024-01-01'),
          note: `evidence for ${ref}`,
        })),
        since: asISODate('2023-01-01'),
      })),
    );

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('@core/healing — Property 14: State-healing detection completeness', () => {
  it('a structurally clean store yields an empty report (ok: true)', () => {
    fc.assert(
      fc.property(
        fc.array(arbProofId, { minLength: 2, maxLength: 8 }).chain((declaredIds) => {
          const uniqueIds = [...new Set(declaredIds)];
          // Build files declaring each id exactly once (no duplicates)
          const files: StoreFile[] = uniqueIds.map((id, i) => ({
            path: asMemoryPath(`profile/file-${i}.md`),
            markdown: `# Entry\n${anchorComment(id)}\nContent`,
          }));
          // Skills reference only declared IDs
          return arbSkillEntries(uniqueIds).map((skills) => ({ files, skills }));
        }),
        ({ files, skills }) => {
          const declarations = collectDeclarations(files);
          const report = healStore({ declarations, skills });
          expect(report.ok).toBe(true);
          expect(report.brokenReferences).toHaveLength(0);
          expect(report.duplicateIds).toHaveLength(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('detects every broken reference (skill refs a non-existent ID)', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.array(arbProofId, { minLength: 1, maxLength: 5 }),
          fc.array(arbProofId, { minLength: 1, maxLength: 5 }),
        ),
        ([declaredIds, danglingIds]) => {
          const declared = new Set(declaredIds);
          // Ensure dangling IDs are genuinely absent
          const actualDangling = danglingIds.filter((id) => !declared.has(id));
          if (actualDangling.length === 0) return;

          const files: StoreFile[] = [...declared].map((id, i) => ({
            path: asMemoryPath(`profile/file-${i}.md`),
            markdown: `# X\n${anchorComment(id)}`,
          }));

          // Skills reference BOTH declared and dangling
          const allRefs = [...declaredIds, ...actualDangling];
          const skills: SkillMapEntry[] = [
            {
              id: asSkillId('SKILL-0'),
              name: 'TestSkill',
              category: 'Technical',
              proficiencySignal: 'demonstrated',
              evidence: allRefs.map((ref) => ({
                ref: ref as unknown as typeof asDocId extends (s: string) => infer T ? T : never,
                when: asISODate('2024-01-01'),
                note: `ref to ${ref}`,
              })),
              since: asISODate('2023-01-01'),
            },
          ];

          const declarations = collectDeclarations(files);
          const report = healStore({ declarations, skills });

          // Every dangling reference should be detected
          const brokenMissing = report.brokenReferences.map((b) => String(b.missing));
          for (const dangling of actualDangling) {
            expect(brokenMissing).toContain(dangling);
          }
          expect(report.ok).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('detects every duplicate identifier (same ID in multiple files)', () => {
    fc.assert(
      fc.property(
        arbProofId,
        fc.integer({ min: 2, max: 4 }),
        (duplicateId, fileCount) => {
          // Declare the same ID in multiple distinct files
          const files: StoreFile[] = Array.from({ length: fileCount }, (_, i) => ({
            path: asMemoryPath(`interviews/file-${i}.md`),
            markdown: `# Interview\n${anchorComment(duplicateId)}\nAnswer`,
          }));

          const declarations = collectDeclarations(files);
          const report = healStore({ declarations, skills: [] });

          // The duplicate should be detected
          const dupIds = report.duplicateIds.map((d) => String(d.id));
          expect(dupIds).toContain(duplicateId);
          expect(report.ok).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('never throws regardless of input (R36: fail-safe)', () => {
    fc.assert(
      fc.property(arbDeclarations, (files) => {
        const declarations = collectDeclarations(files);
        // Even with random/potentially malformed data, healStore should not throw
        expect(() => healStore({ declarations, skills: [] })).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});
