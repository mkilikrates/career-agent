// Unit tests for enhanced role-discovery scoring with employment data (R71.8).
// Task 35.6: When computing match scores for user-added roles, use structured
// employment data (skills per position) rather than only the flat skill map.

import { describe, it, expect } from 'vitest';
import { asItemId, asDocId, type ExtractedItem } from '@core/types';
import { generate, type SkillMap } from '@core/skills';
import { scoreMatch, type RoleSpec } from './role-suggestion';

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

const employment = (
  id: string,
  title: string,
  company: string,
  technologies: string[],
  start?: string,
  end?: string,
): ExtractedItem =>
  ({
    id: asItemId(id),
    type: 'employment',
    fields: { title, employer: company, technologies, start, end },
    confidence: 'High',
    provenance: [{ kind: 'source-line', sourceDoc: asDocId('doc.md'), line: 1 }],
    userConfirmed: true,
    private: false,
    sourceDoc: asDocId('doc.md'),
  }) as unknown as ExtractedItem;

const education = (
  id: string,
  institution: string,
  degree: string,
  skills: string[],
): ExtractedItem =>
  ({
    id: asItemId(id),
    type: 'education',
    fields: { institution, degree, skills },
    confidence: 'High',
    provenance: [{ kind: 'source-line', sourceDoc: asDocId('doc.md'), line: 1 }],
    userConfirmed: true,
    private: false,
    sourceDoc: asDocId('doc.md'),
  }) as unknown as ExtractedItem;

// A user-added role with NO requiredSkills — the situation R71.8 addresses.
const USER_ADDED_ROLE: RoleSpec = {
  title: 'Platform Engineer',
  description: 'Build and maintain cloud infrastructure for teams.',
  roleType: 'employed',
  requiredSkills: [],
};

// Employment items carrying technologies the user actually has.
const EMPLOYMENT_ITEMS: ExtractedItem[] = [
  employment('emp-1', 'SRE', 'Acme Corp', ['Kubernetes', 'Go', 'Terraform'], '2019-01', '2022-06'),
  employment('emp-2', 'Backend Dev', 'Startup Inc', ['TypeScript', 'Docker', 'PostgreSQL'], '2017-03', '2019-01'),
];

// Skill map built from the employment items + some standalone skills.
const MAP: SkillMap = generate([
  skill('s-1', 'Kubernetes'),
  skill('s-2', 'Go'),
  skill('s-3', 'TypeScript'),
  skill('s-4', 'Docker'),
  ...EMPLOYMENT_ITEMS,
]);

// --- Tests -----------------------------------------------------------------

describe('scoreMatch with employment items (R71.8)', () => {
  it('produces a non-zero score for a user-added role with no requiredSkills', () => {
    const result = scoreMatch(USER_ADDED_ROLE, MAP, undefined, {
      items: EMPLOYMENT_ITEMS,
    });

    // The employment items declare 6 unique technologies: Kubernetes, Go,
    // Terraform, TypeScript, Docker, PostgreSQL. The map has at least 4 of them.
    expect(result.score).toBeGreaterThan(0);
    expect(result.matchedSkills.length).toBeGreaterThan(0);
    expect(result.estimated).toBe(true);
  });

  it('fills matchedSkills from the overlap between employment technologies and skill map', () => {
    const result = scoreMatch(USER_ADDED_ROLE, MAP, undefined, {
      items: EMPLOYMENT_ITEMS,
    });

    // matchedSkills should reference skill IDs from the map.
    expect(result.matchedSkills.length).toBeGreaterThan(0);

    // All matchedSkills should be actual SkillIds from the map.
    const mapIds = new Set(MAP.entries.map((e) => e.id as unknown as string));
    for (const id of result.matchedSkills) {
      expect(mapIds.has(id as unknown as string)).toBe(true);
    }
  });

  it('fills gapSkills with technologies from employment not in the skill map', () => {
    // Build a map that has only Kubernetes — the rest become gaps.
    const smallMap = generate([skill('s-1', 'Kubernetes')]);

    const result = scoreMatch(USER_ADDED_ROLE, smallMap, undefined, {
      items: EMPLOYMENT_ITEMS,
    });

    expect(result.gapSkills.length).toBeGreaterThan(0);
    // Terraform should be a gap since it's from employment but not in the small map.
    const gapStrings = result.gapSkills.map((g) => g as unknown as string);
    expect(gapStrings).toContain('Terraform');
  });

  it('includes rationale mentioning employment history when employment data is used', () => {
    const result = scoreMatch(USER_ADDED_ROLE, MAP, undefined, {
      items: EMPLOYMENT_ITEMS,
    });

    expect(result.rationale).toContain('employment history');
  });

  it('extracts skills from education items as well', () => {
    const eduItems: ExtractedItem[] = [
      education('edu-1', 'MIT', 'BSc CS', ['Python', 'Algorithms']),
    ];
    const eduMap = generate([skill('s-py', 'Python')]);

    const result = scoreMatch(USER_ADDED_ROLE, eduMap, undefined, {
      items: eduItems,
    });

    expect(result.score).toBeGreaterThan(0);
    expect(result.matchedSkills.length).toBeGreaterThan(0);
  });

  it('de-duplicates skills across multiple employment items', () => {
    // Both positions use Docker — it should only count once.
    const items: ExtractedItem[] = [
      employment('emp-a', 'Dev', 'A', ['Docker', 'Go'], '2020', '2022'),
      employment('emp-b', 'SRE', 'B', ['Docker', 'Kubernetes'], '2022'),
    ];
    const testMap = generate([skill('s-d', 'Docker'), skill('s-g', 'Go'), skill('s-k', 'Kubernetes')]);

    const result = scoreMatch(USER_ADDED_ROLE, testMap, undefined, { items });

    // 3 unique technologies (Docker, Go, Kubernetes), all in map → 100%.
    expect(result.score).toBe(100);
    expect(result.gapSkills).toHaveLength(0);
  });
});

describe('scoreMatch backwards compatibility (R71.8)', () => {
  it('behaves identically without employment items', () => {
    const roleWithSkills: RoleSpec = {
      title: 'Backend Engineer',
      description: 'Build APIs and services.',
      roleType: 'employed',
      requiredSkills: ['JavaScript', 'SQL Database'],
      preferredSkills: ['TypeScript'],
    };
    const jsMap = generate([skill('s-js', 'JavaScript'), skill('s-ts', 'TypeScript')]);

    const withoutItems = scoreMatch(roleWithSkills, jsMap);
    const withEmptyItems = scoreMatch(roleWithSkills, jsMap, undefined, { items: [] });
    const withUndefinedItems = scoreMatch(roleWithSkills, jsMap, undefined, undefined);

    // All three should produce the same score.
    expect(withoutItems.score).toBe(withEmptyItems.score);
    expect(withoutItems.score).toBe(withUndefinedItems.score);
    expect(withoutItems.matchedSkills).toEqual(withEmptyItems.matchedSkills);
    expect(withoutItems.gapSkills).toEqual(withEmptyItems.gapSkills);
  });

  it('uses explicit requiredSkills when they exist even if items are provided', () => {
    const roleWithSkills: RoleSpec = {
      title: 'Frontend Engineer',
      description: 'Build UIs.',
      roleType: 'employed',
      requiredSkills: ['React', 'CSS'],
      preferredSkills: ['TypeScript'],
    };
    const testMap = generate([
      skill('s-r', 'React'),
      skill('s-ts', 'TypeScript'),
      ...EMPLOYMENT_ITEMS,
    ]);

    const withItems = scoreMatch(roleWithSkills, testMap, undefined, {
      items: EMPLOYMENT_ITEMS,
    });
    const withoutItems = scoreMatch(roleWithSkills, testMap);

    // When explicit skills are present (>=1), employment items are ignored.
    expect(withItems.score).toBe(withoutItems.score);
    expect(withItems.matchedSkills).toEqual(withoutItems.matchedSkills);
    expect(withItems.gapSkills).toEqual(withoutItems.gapSkills);
  });

  it('returns 0 for a user-added role with no skills and no employment items', () => {
    const result = scoreMatch(USER_ADDED_ROLE, MAP);

    expect(result.score).toBe(0);
    expect(result.matchedSkills).toHaveLength(0);
    expect(result.gapSkills).toHaveLength(0);
  });
});
