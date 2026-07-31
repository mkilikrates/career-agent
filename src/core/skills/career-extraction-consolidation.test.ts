// Unit + property tests for career extraction consolidation (task 41.9).
// Feature: career-agent, Property 1: consolidateExtractionReduced is idempotent.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  consolidateExtractionReduced,
  buildConsolidationPrompt,
  applyAiConsolidation,
} from './career-extraction';
import type {
  CareerExtraction,
  ExtractedPosition,
  ExtractedStandaloneSkill,
} from './career-extraction';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extraction(partial: {
  positions?: ExtractedPosition[];
  skills?: ExtractedStandaloneSkill[];
  coreCompetencies?: string[];
  professionalSummary?: string;
}): CareerExtraction {
  const skills = partial.skills ?? [];
  return {
    professionalSummary: partial.professionalSummary,
    positions: partial.positions ?? [],
    education: [],
    skills,
    technicalSkills: skills,
    coreCompetencies: partial.coreCompetencies ?? [],
    languages: [],
    hobbies: [],
    causes: [],
    additionalInfo: [],
  };
}

function pos(
  title: string,
  company: string,
  start?: string,
  technologies: string[] = [],
): ExtractedPosition {
  return {
    title,
    company,
    start,
    end: undefined,
    location: undefined,
    description: undefined,
    achievements: [],
    technologies,
  };
}

function skill(name: string, since?: string): ExtractedStandaloneSkill {
  return { name, since };
}

// ---------------------------------------------------------------------------
// consolidateExtractionReduced
// ---------------------------------------------------------------------------

describe('consolidateExtractionReduced', () => {
  it('deduplicates skills by exact case-insensitive match, keeping first occurrence name', () => {
    const input = extraction({
      skills: [skill('AWS', '2020-01'), skill('aws', '2021-01'), skill('Terraform')],
    });
    const result = consolidateExtractionReduced(input);
    expect(result.technicalSkills).toHaveLength(2);
    expect(result.technicalSkills[0].name).toBe('AWS');
    expect(result.technicalSkills[1].name).toBe('Terraform');
  });

  it('preserves the earliest since date when deduplicating skills', () => {
    const input = extraction({
      skills: [skill('AWS', '2021-01'), skill('aws', '2019-06')],
    });
    const result = consolidateExtractionReduced(input);
    expect(result.technicalSkills).toHaveLength(1);
    expect(result.technicalSkills[0].name).toBe('AWS');
    expect(result.technicalSkills[0].since).toBe('2019-06');
  });

  it('deduplicates positions by (company+title+start) key case-insensitively', () => {
    const input = extraction({
      positions: [
        pos('Senior Engineer', 'Acme Corp', '2020-01', ['TypeScript']),
        pos('senior engineer', 'acme corp', '2020-01', ['TypeScript', 'Node.js']),
      ],
    });
    const result = consolidateExtractionReduced(input);
    expect(result.positions).toHaveLength(1);
  });

  it('deduplicates core competencies by exact case-insensitive match, keeping first', () => {
    const input = extraction({
      coreCompetencies: ['Leadership', 'leadership', 'Communication', 'COMMUNICATION'],
    });
    const result = consolidateExtractionReduced(input);
    expect(result.coreCompetencies).toEqual(['Leadership', 'Communication']);
  });

  it('deduplicates per-position technologies case-insensitively', () => {
    const input = extraction({
      positions: [pos('Eng', 'Co', '2020', ['React', 'react', 'TypeScript'])],
    });
    const result = consolidateExtractionReduced(input);
    expect(result.positions[0].technologies).toEqual(['React', 'TypeScript']);
  });

  // Property test: idempotency
  it('is IDEMPOTENT — running twice yields the same result as once', () => {
    // Feature: career-agent, Property 1: consolidateExtractionReduced idempotency
    const arbSkill = fc.record({
      name: fc.string({ minLength: 1, maxLength: 30 }),
      since: fc.option(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2025-01-01') })
          .map((d) => d.toISOString().slice(0, 7)),
        { nil: undefined },
      ),
    });
    const arbPosition: fc.Arbitrary<ExtractedPosition> = fc.record({
      title: fc.string({ minLength: 1, maxLength: 40 }),
      company: fc.string({ minLength: 1, maxLength: 40 }),
      start: fc.option(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2025-01-01') })
          .map((d) => d.toISOString().slice(0, 7)),
        { nil: undefined },
      ),
      end: fc.constant(undefined),
      location: fc.constant(undefined),
      description: fc.constant(undefined),
      achievements: fc.constant([] as string[]),
      technologies: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
    });
    const arbExtraction = fc
      .record({
        skills: fc.array(arbSkill, { maxLength: 10 }),
        positions: fc.array(arbPosition, { maxLength: 5 }),
        coreCompetencies: fc.array(fc.string({ minLength: 1, maxLength: 30 }), { maxLength: 8 }),
      })
      .map((r) => extraction({ skills: r.skills, positions: r.positions, coreCompetencies: r.coreCompetencies }));

    fc.assert(
      fc.property(arbExtraction, (ext) => {
        const once = consolidateExtractionReduced(ext);
        const twice = consolidateExtractionReduced(once);
        expect(twice.technicalSkills).toEqual(once.technicalSkills);
        expect(twice.positions).toEqual(once.positions);
        expect(twice.coreCompetencies).toEqual(once.coreCompetencies);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// buildConsolidationPrompt
// ---------------------------------------------------------------------------

describe('buildConsolidationPrompt', () => {
  it('produces a prompt containing positions, skills, and competencies as JSON', () => {
    const input = extraction({
      positions: [pos('Engineer', 'Acme', '2020-01', ['TypeScript'])],
      skills: [skill('TypeScript', '2019')],
      coreCompetencies: ['Leadership'],
    });
    const prompt = buildConsolidationPrompt(input);
    expect(prompt).toContain('"title"');
    expect(prompt).toContain('"Engineer"');
    expect(prompt).toContain('"Acme"');
    expect(prompt).toContain('"TypeScript"');
    expect(prompt).toContain('"Leadership"');
  });

  it('contains dedup instructions for positions, skills, and competencies', () => {
    const input = extraction({ skills: [skill('AWS')] });
    const prompt = buildConsolidationPrompt(input);
    expect(prompt).toContain('MERGE duplicate positions');
    expect(prompt).toContain('MERGE duplicate skills');
    expect(prompt).toContain('COLLAPSE synonymous competencies');
  });
});

// ---------------------------------------------------------------------------
// applyAiConsolidation
// ---------------------------------------------------------------------------

describe('applyAiConsolidation', () => {
  const original = extraction({
    positions: [
      pos('Senior Engineer', 'Acme Corp', '2020-01', ['TypeScript', 'Node.js']),
      pos('Sr. Engineer', 'Acme Corporation', '2020-01', ['TypeScript']),
    ],
    skills: [skill('Kubernetes', '2019'), skill('K8s', '2020')],
    coreCompetencies: ['Team Leadership', 'Leadership'],
  });

  it('applies deduplicated AI response with fewer entries', () => {
    const aiReply = JSON.stringify({
      positions: [
        {
          title: 'Senior Engineer',
          company: 'Acme Corp',
          start: '2020-01',
          technologies: ['TypeScript', 'Node.js'],
        },
      ],
      technical_skills: [{ name: 'Kubernetes', since: '2019' }],
      core_competencies: ['Leadership'],
    });
    const result = applyAiConsolidation(original, aiReply);
    expect(result.positions).toHaveLength(1);
    expect(result.technicalSkills).toHaveLength(1);
    expect(result.coreCompetencies).toEqual(['Leadership']);
  });

  it('throws when AI returns empty/invalid JSON', () => {
    expect(() => applyAiConsolidation(original, '')).toThrow();
    expect(() => applyAiConsolidation(original, 'not json')).toThrow();
  });

  it('throws when AI returns valid JSON with all empty arrays', () => {
    const emptyReply = JSON.stringify({
      positions: [],
      technical_skills: [],
      core_competencies: [],
    });
    expect(() => applyAiConsolidation(original, emptyReply)).toThrow(
      'AI consolidation returned empty result',
    );
  });
});
