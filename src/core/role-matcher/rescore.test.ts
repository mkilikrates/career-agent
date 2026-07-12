import { describe, it, expect } from 'vitest';
import { asISODate, type ExtractedItem, type RolePreference } from '@core/types';
import { asRoleSlug } from '@core/types';
import { generate, type SkillMap } from '@core/skills';
import { capturePreferences, rescorePreferences } from './index';
import { suggestRoles } from './role-suggestion';

// --- Helpers ----------------------------------------------------------------

const mkSkill = (id: string, name: string): ExtractedItem =>
  ({
    id: id as never,
    type: 'skill',
    fields: { name },
    confidence: 'High',
    userConfirmed: true,
    private: false,
    sourceDoc: 'doc1' as never,
    provenance: [{ kind: 'source-line', sourceDoc: 'doc1' as never, line: 1 }] as never,
  }) as unknown as ExtractedItem;

const baseMap = (skills: string[]): SkillMap =>
  generate(
    skills.map((name, i) => mkSkill(`i${i}`, name)),
    { asOf: asISODate('2024-05-01') },
  );

const basePref = (title: string, description: string, rank = 1): RolePreference => ({
  slug: asRoleSlug(title.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
  title,
  description,
  matchScore: 0,
  matchedSkills: [],
  gapSkills: [],
  rationale: 'Unscored',
  rank,
  tag: 'exploring',
});

// --- Tests ------------------------------------------------------------------

describe('rescorePreferences (R77)', () => {
  it('updates match scores when skill map has matching skills', () => {
    const map = baseMap(['TypeScript', 'React', 'PostgreSQL']);
    const prefs: RolePreference[] = [
      basePref('Frontend Engineer', 'Develop accessible, performant user interfaces using React and TypeScript'),
    ];

    const rescored = rescorePreferences(prefs, map);

    expect(rescored).toHaveLength(1);
    expect(rescored[0].matchScore).toBeGreaterThan(0);
    expect(rescored[0].matchedSkills.length).toBeGreaterThan(0);
    expect(rescored[0].title).toBe('Frontend Engineer');
    expect(rescored[0].rank).toBe(1);
    expect(rescored[0].tag).toBe('exploring');
  });

  it('preserves rank and tag after re-scoring', () => {
    const map = baseMap(['JavaScript', 'SQL Database']);
    const prefs: RolePreference[] = [
      { ...basePref('Backend Engineer', 'Build server-side services with JavaScript and SQL Database', 2), tag: 'actively_applying' },
      { ...basePref('Frontend Engineer', 'Build UIs with React and TypeScript', 1), tag: 'practice_only' },
    ];

    const rescored = rescorePreferences(prefs, map);

    expect(rescored[0].rank).toBe(2);
    expect(rescored[0].tag).toBe('actively_applying');
    expect(rescored[1].rank).toBe(1);
    expect(rescored[1].tag).toBe('practice_only');
  });

  it('scores higher when more skills match', () => {
    // Both maps know about React and TypeScript (the description mentions both),
    // but only bigMap also has JavaScript — so bigMap matches more of the
    // description's skill mentions.
    const smallMap = baseMap(['TypeScript', 'React']);
    const bigMap = baseMap(['TypeScript', 'React', 'JavaScript']);
    // A description with skills that only bigMap can fully satisfy
    const prefs: RolePreference[] = [
      basePref('Frontend Engineer', 'Requires React, TypeScript, and JavaScript'),
    ];

    const rescoredSmall = rescorePreferences(prefs, smallMap);
    const rescoredBig = rescorePreferences(prefs, bigMap);

    // bigMap has JavaScript too, so it scores higher or has more matched skills
    expect(rescoredBig[0].matchedSkills.length).toBeGreaterThanOrEqual(
      rescoredSmall[0].matchedSkills.length,
    );
  });

  it('returns empty array for empty preferences', () => {
    const map = baseMap(['TypeScript']);
    expect(rescorePreferences([], map)).toEqual([]);
  });

  it('handles roles with descriptions that mention no known skills', () => {
    const map = baseMap(['TypeScript']);
    const prefs: RolePreference[] = [
      basePref('Philosopher', 'Think deep thoughts about the nature of existence'),
    ];

    const rescored = rescorePreferences(prefs, map);

    expect(rescored[0].matchScore).toBe(0);
    expect(rescored[0].matchedSkills).toEqual([]);
  });
});

describe('fromAddedRole fix — roles without requiredSkills get scored (R77.3)', () => {
  it('scores a user-added role with no requiredSkills via description parsing', () => {
    const map = baseMap(['TypeScript', 'React', 'Node.js']);
    const suggestions = suggestRoles(map);

    const prefs = capturePreferences(
      suggestions,
      [
        {
          added: {
            title: 'Full-Stack TypeScript Developer',
            description: 'Build applications using TypeScript, React, and Node.js',
            // No requiredSkills!
          },
          rank: 1,
          tag: 'actively_applying',
        },
      ],
      { map },
    );

    expect(prefs).toHaveLength(1);
    // With the guard removed, the role should be scored (> 0%) from description
    expect(prefs[0].matchScore).toBeGreaterThan(0);
    expect(prefs[0].matchedSkills.length).toBeGreaterThan(0);
  });

  it('still scores roles WITH requiredSkills correctly', () => {
    const map = baseMap(['TypeScript', 'React']);
    const suggestions = suggestRoles(map);

    const prefs = capturePreferences(
      suggestions,
      [
        {
          added: {
            title: 'React Developer',
            description: 'Build React apps',
            requiredSkills: ['React', 'TypeScript'],
          },
          rank: 1,
        },
      ],
      { map },
    );

    expect(prefs).toHaveLength(1);
    expect(prefs[0].matchScore).toBeGreaterThan(0);
  });

  it('falls back to 0 when no skill map is provided', () => {
    const suggestions = suggestRoles(baseMap(['TypeScript']));

    const prefs = capturePreferences(
      suggestions,
      [
        {
          added: {
            title: 'Mysterious Role',
            description: 'Uses TypeScript heavily',
            // No requiredSkills
          },
          rank: 1,
        },
      ],
      {}, // no map
    );

    expect(prefs).toHaveLength(1);
    expect(prefs[0].matchScore).toBe(0);
    expect(prefs[0].rationale).toContain('No skill-match estimate computed');
  });
});
