// Feature: career-agent, Property 1: No-Fabrication — every output claim resolves to provenance
//
// For any confirmed evidence set and any generated output (CV model), every
// skill name and every bullet text in the output resolves to at least one
// provenance record in the evidence. No skill appears that isn't in the skill
// map, no bullet text appears that isn't from a confirmed accomplishment or
// talking point.
//
// **Validates: Requirements 1.2**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  asBulletId,
  asDocId,
  asISODate,
  asRoleSlug,
  asSkillId,
  asStarId,
  type Accomplishment,
  type SkillMapEntry,
  type TalkingPoint,
} from '@core/types';
import { ProvenanceIndex, sourceLine, userConfirmation } from '@core/provenance';
import { verifyOutput } from './verify';
import type { CvModel, CvSkill, CvBullet } from '@core/output';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a random skill name (alphabetic, 2-20 chars). */
const arbSkillName = fc.stringMatching(/^[A-Za-z][A-Za-z0-9._-]{1,19}$/);

/** Generate an arbitrary skill map with 2-10 entries with random names. */
const arbSkillMap = fc
  .array(arbSkillName, { minLength: 2, maxLength: 10 })
  .map((names) => {
    const uniqueNames = [...new Set(names)];
    if (uniqueNames.length < 2) uniqueNames.push('FallbackSkill');
    return uniqueNames.map((name, i) => {
      const id = asSkillId(`SKILL-${i}`);
      const entry: SkillMapEntry = {
        id,
        name,
        category: 'Technical',
        proficiencySignal: 'demonstrated',
        evidence: [
          {
            ref: asDocId('doc.pdf'),
            when: asISODate('2023-01-01'),
            note: `Evidence for ${name}`,
          },
        ],
        since: asISODate('2023-01-01'),
      };
      return entry;
    });
  });

/** Generate random accomplishment texts. */
const arbAccomplishmentText = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{4,49}$/);

/**
 * Arbitrary model: given a skill map and random accomplishment/talking-point
 * texts, build a CvModel that only references skills from the map and only
 * uses bullet texts from those accomplishments/talking points.
 */
const arbCvModelWithEvidence = arbSkillMap.chain((skillMap) =>
  fc
    .tuple(
      // random accomplishment texts (1-5)
      fc.array(arbAccomplishmentText, { minLength: 1, maxLength: 5 }),
      // random talking-point texts (0-3)
      fc.array(arbAccomplishmentText, { minLength: 0, maxLength: 3 }),
    )
    .map(([accTexts, tpTexts]) => {
      // Build CvSkills from the map
      const cvSkills: CvSkill[] = skillMap.map((entry) => ({
        id: entry.id,
        name: entry.name,
        category: entry.category,
        targetRelevant: true,
      }));

      // Build accomplishments (each linked to the first skill)
      const accomplishments: Accomplishment[] = accTexts.map((text, i) => ({
        id: asBulletId(`BULLET-${i}`),
        text,
        provenance: [sourceLine(asDocId('doc.pdf'), i + 1, text)],
        skills: [skillMap[0].id],
      }));

      // Build talking points (each linked to the second skill if available)
      const talkingPoints: TalkingPoint[] = tpTexts.map((text, i) => ({
        id: asStarId(`STAR-${i}`),
        polished: text,
        flags: [],
        skills: [skillMap[Math.min(1, skillMap.length - 1)].id],
      }));

      // Build CvBullets from accomplishments and talking points
      const bullets: CvBullet[] = [
        ...accomplishments.map((acc) => ({
          id: acc.id,
          source: 'accomplishment' as const,
          text: acc.text,
          skills: acc.skills,
          targetRelevant: true,
          quantified: false,
          needsMetric: false,
        })),
        ...talkingPoints.map((tp) => ({
          id: tp.id,
          source: 'talking-point' as const,
          text: tp.polished,
          skills: tp.skills,
          targetRelevant: true,
          quantified: false,
          needsMetric: false,
        })),
      ];

      const model: CvModel = {
        targetRole: { slug: asRoleSlug('test-role'), title: 'Test Role' },
        header: { name: 'Test User' },
        skills: cvSkills,
        experience: bullets,
        education: [],
        certifications: [],
      };

      // Build provenance index with entries for every skill, accomplishment,
      // and talking point that the model references.
      const index = new ProvenanceIndex();
      for (const entry of skillMap) {
        index.attach(entry.id, sourceLine(asDocId('doc.pdf'), 1, entry.name));
      }
      for (const acc of accomplishments) {
        index.attach(acc.id, acc.provenance);
      }
      for (const tp of talkingPoints) {
        index.attach(
          tp.id,
          userConfirmation(asISODate('2024-01-01'), 'confirmed answer'),
        );
      }

      return { model, index, skillMap, accomplishments, talkingPoints };
    }),
);

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe('@core/no-fabrication — Property 1: No-Fabrication (every output claim resolves to provenance)', () => {
  it('every CvSkill.name matches a skill map entry and every CvBullet.text matches an accomplishment or talking point', () => {
    fc.assert(
      fc.property(arbCvModelWithEvidence, ({ model, index, skillMap, accomplishments, talkingPoints }) => {
        // 1. Verify via the harness: every claim resolves
        const report = verifyOutput({ kind: 'cv', model }, index);
        expect(report.passed).toBe(true);
        expect(report.unresolved).toHaveLength(0);

        // 2. Direct check: every skill name in the output is in the skill map
        const skillMapNames = new Set(skillMap.map((e) => e.name));
        for (const skill of model.skills) {
          expect(skillMapNames.has(skill.name)).toBe(true);
        }

        // 3. Direct check: every bullet text is from an accomplishment or talking point
        const validTexts = new Set([
          ...accomplishments.map((a) => a.text),
          ...talkingPoints.map((tp) => tp.polished),
        ]);
        for (const bullet of model.experience) {
          expect(validTexts.has(bullet.text)).toBe(true);
        }
      }),
    );
  });

  it('an output with an unregistered skill fails verification', () => {
    fc.assert(
      fc.property(arbSkillMap, (skillMap) => {
        // Build a model with a skill NOT in the provenance index
        const extraSkillId = asSkillId('SKILL-fabricated');
        const model: CvModel = {
          targetRole: { slug: asRoleSlug('test-role'), title: 'Test Role' },
          header: {},
          skills: [
            { id: extraSkillId, name: 'FabricatedSkill', category: 'Technical', targetRelevant: false },
          ],
          experience: [],
          education: [],
          certifications: [],
        };

        // Index only has the skill map entries, not the fabricated one
        const index = new ProvenanceIndex();
        for (const entry of skillMap) {
          index.attach(entry.id, sourceLine(asDocId('doc.pdf'), 1, entry.name));
        }

        const report = verifyOutput({ kind: 'cv', model }, index);
        expect(report.passed).toBe(false);
        expect(report.inventedSkills.length).toBeGreaterThan(0);
      }),
    );
  });
});
