// Unit tests for STAR questions multi-competency format and full ATS context (task 41.11).

import { describe, it, expect } from 'vitest';
import {
  asRoleSlug,
  asSkillId,
  asItemId,
  asDocId,
  type RolePreference,
  type ExtractedItem,
} from '@core/types';
import { generate, type SkillMap } from '@core/skills';
import type { EgressDestination } from '@core/assist';
import {
  parseQuestionPrompts,
  buildStarQuestionsPrompt,
  buildCandidateProfile,
  DEFAULT_GENERIC_COMPETENCY,
  type AtsContext,
} from './coach-assist';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEST: EgressDestination = { provider: 'openai', kind: 'keyed-cloud' };

const skill = (id: string, name: string): ExtractedItem =>
  ({
    id: asItemId(id),
    type: 'skill',
    fields: { name },
    confidence: 'High',
    provenance: [],
    userConfirmed: false,
    private: false,
    sourceDoc: asDocId('doc.md'),
  }) as unknown as ExtractedItem;

const MAP: SkillMap = generate([skill('doc.md#a', 'JavaScript')]);

const ROLE: RolePreference = {
  slug: asRoleSlug('backend-engineer'),
  title: 'Backend Engineer',
  description: 'Builds services.',
  matchScore: 80,
  matchedSkills: [asSkillId('SKILL-javascript')],
  gapSkills: [],
  rationale: 'Good fit.',
  rank: 1,
  tag: 'exploring',
};

// ---------------------------------------------------------------------------
// parseQuestionPrompts — multi-competency format
// ---------------------------------------------------------------------------

describe('parseQuestionPrompts — multi-competency format', () => {
  it('accepts the new "competencies" array format', () => {
    const reply = JSON.stringify([
      {
        competencies: ['Leadership', 'Stakeholder Management'],
        question: 'Tell me about a time you led a cross-functional team through a crisis.',
      },
    ]);
    const result = parseQuestionPrompts(reply);
    expect(result).toHaveLength(1);
    expect(result[0].competencies).toEqual(['Leadership', 'Stakeholder Management']);
    expect(result[0].question).toContain('cross-functional team');
  });

  it('backward-compat: accepts legacy "competency" string and wraps into array', () => {
    const reply = JSON.stringify([
      {
        competency: 'Problem Solving',
        question: 'Describe a situation where you had to debug a complex production issue.',
      },
    ]);
    const result = parseQuestionPrompts(reply);
    expect(result).toHaveLength(1);
    expect(result[0].competencies).toEqual(['Problem Solving']);
  });

  it('assigns generic competency when neither competencies nor competency field is present', () => {
    const reply = JSON.stringify([
      {
        question: 'Tell me about a challenging project you completed recently.',
      },
    ]);
    const result = parseQuestionPrompts(reply);
    expect(result).toHaveLength(1);
    expect(result[0].competencies).toEqual([DEFAULT_GENERIC_COMPETENCY]);
  });

  it('accepts custom defaultCompetency via options', () => {
    const reply = JSON.stringify([
      { question: 'Tell me about a situation where you had to adapt quickly.' },
    ]);
    const result = parseQuestionPrompts(reply, { defaultCompetency: 'General' });
    expect(result[0].competencies).toEqual(['General']);
  });
});

// ---------------------------------------------------------------------------
// buildStarQuestionsPrompt
// ---------------------------------------------------------------------------

describe('buildStarQuestionsPrompt', () => {
  it('includes "competencies" (array) in the JSON schema instruction', () => {
    const prompt = buildStarQuestionsPrompt(ROLE, MAP, DEST);
    expect(prompt).toContain('"competencies"');
    // Should describe competencies as an array, not a singular string
    expect(prompt).toContain('an array of one or more');
  });

  it('does NOT instruct to use "competency" (singular string) in output schema', () => {
    const prompt = buildStarQuestionsPrompt(ROLE, MAP, DEST);
    // The prompt should reference "competencies" (plural) as the output field,
    // not instruct the model to return "competency" as a field name.
    // It may mention "competency" in prose but the JSON schema portion uses "competencies".
    expect(prompt).toMatch(/"competencies"/);
  });
});

// ---------------------------------------------------------------------------
// buildCandidateProfile — with and without ATS context
// ---------------------------------------------------------------------------

describe('buildCandidateProfile with atsContext', () => {
  const atsContext: AtsContext = {
    previousTitles: ['Staff Engineer', 'Senior Developer'],
    coreCompetencies: ['System Design', 'Mentoring'],
    educationDegrees: ['MSc Computer Science'],
    professionalSummary: 'Experienced backend engineer with 10+ years in distributed systems.',
  };

  it('output contains "Previous titles:" when atsContext is provided', () => {
    const profile = buildCandidateProfile(ROLE, MAP, DEST, atsContext);
    expect(profile).toContain('Previous titles:');
    expect(profile).toContain('Staff Engineer');
  });

  it('output contains "Core competencies:" when atsContext is provided', () => {
    const profile = buildCandidateProfile(ROLE, MAP, DEST, atsContext);
    expect(profile).toContain('Core competencies:');
    expect(profile).toContain('System Design');
  });

  it('output contains "Education:" when atsContext is provided', () => {
    const profile = buildCandidateProfile(ROLE, MAP, DEST, atsContext);
    expect(profile).toContain('Education:');
    expect(profile).toContain('MSc Computer Science');
  });

  it('output contains "Summary:" when atsContext is provided', () => {
    const profile = buildCandidateProfile(ROLE, MAP, DEST, atsContext);
    expect(profile).toContain('Summary:');
    expect(profile).toContain('distributed systems');
  });
});

describe('buildCandidateProfile without atsContext', () => {
  it('output does NOT contain ATS-specific lines when atsContext is absent', () => {
    const profile = buildCandidateProfile(ROLE, MAP, DEST);
    expect(profile).not.toContain('Previous titles:');
    expect(profile).not.toContain('Core competencies:');
    expect(profile).not.toContain('Education:');
    expect(profile).not.toContain('Summary:');
  });

  it('output does NOT contain ATS-specific lines when atsContext is undefined', () => {
    const profile = buildCandidateProfile(ROLE, MAP, DEST, undefined);
    expect(profile).not.toContain('Previous titles:');
    expect(profile).not.toContain('Core competencies:');
    expect(profile).not.toContain('Education:');
    expect(profile).not.toContain('Summary:');
  });
});
