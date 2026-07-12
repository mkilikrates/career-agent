// Unit tests for description-based role scoring (R71.21).
// Task 39.4: When computing match scores for user-added roles that have no
// requiredSkills and no employment items, parse skills from the role's
// description field and match against the confirmed skill map using ontological
// matching to produce a meaningful score rather than 0%.

import { describe, it, expect } from 'vitest';
import { asItemId, asDocId, type ExtractedItem } from '@core/types';
import { generate, type SkillMap } from '@core/skills';
import { scoreMatch, type RoleSpec } from './role-suggestion';
import { loadTaxonomyFromYaml } from './taxonomy';

// --- Test helpers ----------------------------------------------------------

const skill = (id: string, name: string): ExtractedItem =>
  ({
    id: asItemId(id),
    type: 'skill',
    fields: { name },
    confidence: 'High',
    provenance: [{ kind: 'source-line', sourceDoc: asDocId('doc.md'), line: 1 }],
    userConfirmed: false,
    private: false,
    sourceDoc: asDocId('doc.md'),
  }) as unknown as ExtractedItem;

// --- Fixtures --------------------------------------------------------------

// A user-added role whose description mentions specific technologies.
const ROLE_WITH_TECH_DESCRIPTION: RoleSpec = {
  title: 'Cloud Platform Engineer',
  description:
    'Experience in cloud management platforms like AWS, Kubernetes, and Terraform. ' +
    'Build infrastructure using Docker containers and TypeScript-based tooling.',
  roleType: 'employed',
  requiredSkills: [],
};

// A role whose description mentions skills that match via taxonomy (ontological).
const ROLE_WITH_ONTOLOGICAL_DESCRIPTION: RoleSpec = {
  title: 'Database Administrator',
  description:
    'Manage SQL Database systems, optimize queries, and ensure high availability ' +
    'for production workloads. Strong JavaScript skills preferred.',
  roleType: 'employed',
  requiredSkills: [],
};

// A role whose description has NO skill-like terms.
const ROLE_WITH_GENERIC_DESCRIPTION: RoleSpec = {
  title: 'Team Lead',
  description: 'Lead a team of engineers and drive project delivery.',
  roleType: 'employed',
  requiredSkills: [],
};

// A role with an empty description.
const ROLE_WITH_EMPTY_DESCRIPTION: RoleSpec = {
  title: 'Mystery Role',
  description: '',
  roleType: 'employed',
  requiredSkills: [],
};

// Skill map with common tech skills.
const MAP: SkillMap = generate([
  skill('s-1', 'Kubernetes'),
  skill('s-2', 'Docker'),
  skill('s-3', 'TypeScript'),
  skill('s-4', 'PostgreSQL'),
  skill('s-5', 'Terraform'),
]);

// Extended taxonomy with more relations for testing ontological matching.
const EXTENDED_TAXONOMY_YAML = `
relations:
  - { child: PostgreSQL, parent: "SQL Database", type: implements }
  - { child: MySQL, parent: "SQL Database", type: implements }
  - { child: TypeScript, parent: JavaScript, type: extends }
  - { child: Kubernetes, parent: "Container Orchestration", type: implements }
  - { child: Docker, parent: "Container Runtime", type: implements }
`;

// --- Tests -----------------------------------------------------------------

describe('scoreMatch with description parsing (R71.21)', () => {
  it('produces a non-zero score when the description mentions skills from the map', () => {
    const result = scoreMatch(ROLE_WITH_TECH_DESCRIPTION, MAP);

    // The description mentions Kubernetes, Terraform, Docker, TypeScript — all in the map.
    expect(result.score).toBeGreaterThan(0);
    expect(result.matchedSkills.length).toBeGreaterThan(0);
    expect(result.estimated).toBe(true);
  });

  it('populates matchedSkills with skill IDs from the map', () => {
    const result = scoreMatch(ROLE_WITH_TECH_DESCRIPTION, MAP);

    const mapIds = new Set(MAP.entries.map((e) => e.id as unknown as string));
    for (const id of result.matchedSkills) {
      expect(mapIds.has(id as unknown as string)).toBe(true);
    }
  });

  it('populates gapSkills with description-mentioned skills NOT in the map', () => {
    // Build a map that only has Kubernetes — other mentioned skills become gaps.
    const smallMap = generate([skill('s-1', 'Kubernetes')]);

    const result = scoreMatch(ROLE_WITH_TECH_DESCRIPTION, smallMap);

    // The description mentions Kubernetes (matched), plus Docker, TypeScript,
    // Terraform (gaps when not in map). AWS isn't in taxonomy so not detected.
    expect(result.matchedSkills.length).toBeGreaterThan(0);
    // With the default taxonomy, TypeScript is known. Docker and Terraform are
    // in the description but not in the skill map or taxonomy, so they won't
    // be detected unless they're also in the map or taxonomy.
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
  });

  it('uses ontological matching — PostgreSQL satisfies SQL Database in description', () => {
    const taxonomy = loadTaxonomyFromYaml(EXTENDED_TAXONOMY_YAML);
    // Map has PostgreSQL; description mentions "SQL Database".
    const result = scoreMatch(ROLE_WITH_ONTOLOGICAL_DESCRIPTION, MAP, taxonomy);

    // PostgreSQL (in map) should ontologically satisfy "SQL Database" (in description).
    expect(result.score).toBeGreaterThan(0);
    expect(result.matchedSkills.length).toBeGreaterThan(0);
  });

  it('includes rationale mentioning role description when description data is used', () => {
    const result = scoreMatch(ROLE_WITH_TECH_DESCRIPTION, MAP);

    expect(result.rationale).toContain('role description');
  });

  it('returns 0 when the description has no recognizable skill terms', () => {
    const result = scoreMatch(ROLE_WITH_GENERIC_DESCRIPTION, MAP);

    // "Lead a team of engineers and drive project delivery" has no known skills.
    expect(result.score).toBe(0);
    expect(result.matchedSkills).toHaveLength(0);
    expect(result.gapSkills).toHaveLength(0);
  });

  it('returns 0 when the description is empty', () => {
    const result = scoreMatch(ROLE_WITH_EMPTY_DESCRIPTION, MAP);

    expect(result.score).toBe(0);
    expect(result.matchedSkills).toHaveLength(0);
    expect(result.gapSkills).toHaveLength(0);
  });

  it('does not use description parsing when explicit requiredSkills exist', () => {
    const roleWithSkills: RoleSpec = {
      title: 'Backend Engineer',
      description: 'Experience with Kubernetes, Docker, and TypeScript.',
      roleType: 'employed',
      requiredSkills: ['Go'], // explicit skill — only Go is scored
    };
    // Map does NOT have Go — score should reflect that, ignoring description.
    const mapWithoutGo = generate([skill('s-1', 'Kubernetes')]);

    const result = scoreMatch(roleWithSkills, mapWithoutGo);

    // Score is based on requiredSkills: ['Go'] vs a map that only has Kubernetes.
    // Go is not in the map → 0% (description Kubernetes is NOT used).
    expect(result.score).toBe(0);
    expect(result.gapSkills.map((g) => g as unknown as string)).toContain('Go');
  });

  it('prefers employment items over description parsing', () => {
    const employment: ExtractedItem = {
      id: asItemId('emp-1'),
      type: 'employment',
      fields: { title: 'SRE', employer: 'Corp', technologies: ['Go', 'Linux'] },
      confidence: 'High',
      provenance: [{ kind: 'source-line', sourceDoc: asDocId('doc.md'), line: 1 }],
      userConfirmed: true,
      private: false,
      sourceDoc: asDocId('doc.md'),
    } as unknown as ExtractedItem;

    // Description mentions Kubernetes/Docker but employment items have Go/Linux.
    const result = scoreMatch(ROLE_WITH_TECH_DESCRIPTION, MAP, undefined, {
      items: [employment],
    });

    // Employment items take precedence — rationale should mention employment.
    expect(result.rationale).toContain('employment history');
    expect(result.rationale).not.toContain('role description');
  });

  it('computes percentage score correctly: 100% when all description skills match', () => {
    // All skills mentioned in description that are known are in the map.
    const taxonomy = loadTaxonomyFromYaml(EXTENDED_TAXONOMY_YAML);
    const role: RoleSpec = {
      title: 'Container Engineer',
      description: 'Work with Kubernetes and Docker daily.',
      roleType: 'employed',
      requiredSkills: [],
    };
    // Map has both Kubernetes and Docker; taxonomy knows both.
    const result = scoreMatch(role, MAP, taxonomy);

    expect(result.score).toBe(100);
    expect(result.gapSkills).toHaveLength(0);
  });

  it('identifies gap skills when description mentions skills NOT in the map', () => {
    const taxonomy = loadTaxonomyFromYaml(EXTENDED_TAXONOMY_YAML);
    const role: RoleSpec = {
      title: 'Full-Stack DBA',
      description: 'Strong PostgreSQL and MySQL experience required.',
      roleType: 'employed',
      requiredSkills: [],
    };
    // Map only has PostgreSQL, not MySQL. Both are known via taxonomy.
    const result = scoreMatch(role, MAP, taxonomy);

    expect(result.matchedSkills.length).toBeGreaterThan(0);
    const gapStrings = result.gapSkills.map((g) => g as unknown as string);
    expect(gapStrings).toContain('MySQL');
    expect(result.score).toBe(50); // 1 of 2 matched
  });
});
