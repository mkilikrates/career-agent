// Feature: career-agent, Property 22: Role-discovery payload minimisation
//
// For any skill map, the role-discovery AI-assist payload contains no employer
// or company name and includes an approximate experience duration for every
// skill it carries; and for a keyed cloud (third-party) destination it excludes
// every item marked private.
//
// **Validates: Requirements 20.6, 47.2, 47.4**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { asDocId, asISODate, asSkillId, type SkillCategory, type SkillMapEntry } from '@core/types';
import type { EgressDestination } from '@core/assist';
import type { SkillMap } from '@core/skills';
import { buildReferenceGraph } from '@core/registry';
import { buildDiscoveryPayload } from './role-discovery-payload';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a skill name that looks like a real tech skill (no employer). */
const arbSkillName = fc.constantFrom(
  'Kubernetes', 'React', 'TypeScript', 'Python', 'PostgreSQL',
  'AWS Lambda', 'Docker', 'Node.js', 'GraphQL', 'Terraform',
  'Java', 'Go', 'Rust', 'Redis', 'MongoDB',
);

const arbCategory: fc.Arbitrary<SkillCategory> = fc.constantFrom(
  'Technical', 'Domain', 'Leadership', 'Communication',
);

/** Generate a skill map entry with optional private flag. */
const arbEntry = fc
  .tuple(
    fc.integer({ min: 1, max: 20 }),
    arbSkillName,
    arbCategory,
    fc.boolean(), // private
    fc.integer({ min: 2018, max: 2025 }), // since year
  )
  .map(([n, name, category, isPrivate, sinceYear]): SkillMapEntry => ({
    id: asSkillId(`SKILL-${n}`),
    name,
    category,
    proficiencySignal: 'demonstrated',
    evidence: [
      {
        ref: asDocId('doc.pdf'),
        when: asISODate(`${sinceYear}-06-01`),
        note: `Evidence for ${name}`,
      },
    ],
    since: asISODate(`${sinceYear}-01-01`),
    private: isPrivate,
  }));

/** Generate a skill map with 3-10 entries. */
const arbSkillMap: fc.Arbitrary<SkillMap> = fc
  .array(arbEntry, { minLength: 3, maxLength: 10 })
  .map((entries) => ({
    entries,
    graph: buildReferenceGraph({ skills: entries }),
  }));

const arbDestination: fc.Arbitrary<EgressDestination> = fc.constantFrom(
  { provider: 'openai', kind: 'keyed-cloud' } as EgressDestination,
  { provider: 'anthropic', kind: 'keyed-cloud' } as EgressDestination,
  { provider: 'ollama', kind: 'keyless-local' } as EgressDestination,
);

/** Known employer / company names that should NEVER appear in the payload. */
const EMPLOYER_NAMES = [
  'Google', 'Amazon', 'Meta', 'Microsoft', 'Apple',
  'Acme Corp', 'StartupCo', 'MegaBank',
];

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('@core/role-matcher — Property 22: Role-discovery payload minimisation', () => {
  it('payload contains no employer or company name (R20.6, R47.2)', () => {
    fc.assert(
      fc.property(arbSkillMap, arbDestination, (map, dest) => {
        const payload = buildDiscoveryPayload(map, dest);

        // The payload's text representation should not contain employer names
        const payloadStr = JSON.stringify(payload);
        for (const employer of EMPLOYER_NAMES) {
          expect(payloadStr).not.toContain(employer);
        }

        // The payload carries only name, approxDurationMonths, and category per skill
        for (const skill of payload.skills) {
          expect(skill.name).toBeDefined();
          expect(skill.approxDurationMonths).toBeDefined();
          expect(skill.category).toBeDefined();
          // No extra fields that could leak employer info
          expect(Object.keys(skill)).toEqual(['name', 'approxDurationMonths', 'category']);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('every carried skill includes an approximate experience duration (R20.6)', () => {
    fc.assert(
      fc.property(arbSkillMap, arbDestination, (map, dest) => {
        const payload = buildDiscoveryPayload(map, dest);

        for (const skill of payload.skills) {
          expect(skill.approxDurationMonths).toBeGreaterThanOrEqual(1);
          expect(Number.isFinite(skill.approxDurationMonths)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('keyed cloud destination excludes every private skill (R47.4)', () => {
    fc.assert(
      fc.property(arbSkillMap, (map) => {
        const dest: EgressDestination = { provider: 'openai', kind: 'keyed-cloud' };
        const payload = buildDiscoveryPayload(map, dest);

        const nonPrivateCount = map.entries.filter((e) => e.private !== true).length;

        // The payload should contain exactly the non-private entries
        expect(payload.skills.length).toBe(nonPrivateCount);
      }),
      { numRuns: 200 },
    );
  });

  it('keyless local destination retains private skills (R46.5)', () => {
    fc.assert(
      fc.property(arbSkillMap, (map) => {
        const dest: EgressDestination = { provider: 'ollama', kind: 'keyless-local' };
        const payload = buildDiscoveryPayload(map, dest);

        // All entries (including private ones) should be in the payload
        expect(payload.skills.length).toBe(map.entries.length);
      }),
      { numRuns: 200 },
    );
  });
});
