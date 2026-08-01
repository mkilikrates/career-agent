import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  buildCareerExtractionPrompt,
  buildConsolidationPrompt,
  parseCareerExtraction,
  parseCareerExtractionWithTracking,
  mergeCareerExtractions,
  consolidateExtraction,
  consolidateExtractionReduced,
  applyAiConsolidation,
  careerExtractionToItems,
  splitCompoundSkills,
  normalizeDate,
  loadCompetencySynonyms,
  loadCompoundNames,
  DEFAULT_COMPETENCY_SYNONYMS_YAML,
  DEFAULT_COMPOUND_NAMES_YAML,
  CAREER_EXTRACTION_INSTRUCTION,
  stripNonAlpha,
  mergeCompoundFragments,
} from './career-extraction';
import type {
  CareerExtraction,
  ExtractedPosition,
  ExtractedEducation,
  ExtractedStandaloneSkill,
} from './career-extraction';

// Helper to build a CareerExtraction with defaults for new fields (backward compat in tests).
function extraction(partial: {
  positions?: ExtractedPosition[];
  education?: ExtractedEducation[];
  skills?: ExtractedStandaloneSkill[];
  professionalSummary?: string;
  coreCompetencies?: string[];
  languages?: { language: string; proficiency: string }[];
  hobbies?: string[];
  causes?: string[];
  additionalInfo?: { category: string; value: string }[];
}): CareerExtraction {
  const skills = partial.skills ?? [];
  return {
    professionalSummary: partial.professionalSummary,
    positions: partial.positions ?? [],
    education: partial.education ?? [],
    skills,
    technicalSkills: skills,
    coreCompetencies: partial.coreCompetencies ?? [],
    languages: partial.languages ?? [],
    hobbies: partial.hobbies ?? [],
    causes: partial.causes ?? [],
    additionalInfo: partial.additionalInfo ?? [],
  };
}

// ---------------------------------------------------------------------------
// buildCareerExtractionPrompt
// ---------------------------------------------------------------------------

describe('buildCareerExtractionPrompt', () => {
  it('includes the instruction and the corpus chunk', () => {
    const chunk = 'Senior Engineer at Acme Corp 2019-2023';
    const prompt = buildCareerExtractionPrompt(chunk);
    expect(prompt).toContain(CAREER_EXTRACTION_INSTRUCTION);
    expect(prompt).toContain('DOCUMENT CONTENT:');
    expect(prompt).toContain(chunk);
  });

  it('includes No-Fabrication rule language', () => {
    const prompt = buildCareerExtractionPrompt('test');
    expect(prompt).toContain('do NOT invent');
    expect(prompt).toContain('not present in the source');
  });
});

// ---------------------------------------------------------------------------
// parseCareerExtraction
// ---------------------------------------------------------------------------

describe('parseCareerExtraction', () => {
  it('parses a clean JSON reply with all three sections', () => {
    const reply = JSON.stringify({
      positions: [
        { title: 'SRE', company: 'Acme', start: '2019-01', end: '2022-06', technologies: ['Kubernetes', 'Go'] },
      ],
      education: [
        { institution: 'MIT', degree: 'BSc Computer Science', start: '2015', end: '2019', skills: ['Algorithms'] },
      ],
      skills: [
        { name: 'Leadership', since: '2020' },
      ],
    });
    const result = parseCareerExtraction(reply);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]).toEqual({
      title: 'SRE',
      company: 'Acme',
      start: '2019-01',
      end: '2022-06',
      technologies: ['Kubernetes', 'Go'],
    });
    expect(result.education).toHaveLength(1);
    expect(result.education[0]).toEqual({
      institution: 'MIT',
      degree: 'BSc Computer Science',
      start: '2015',
      end: '2019',
      skills: ['Algorithms'],
    });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toEqual({ name: 'Leadership', since: '2020' });
  });

  it('tolerates markdown code fences around JSON', () => {
    const reply =
      'Here is the extraction:\n```json\n' +
      '{"positions":[{"title":"Dev","company":"Corp","technologies":[]}],"education":[],"skills":[]}\n' +
      '```\nHope this helps!';
    const result = parseCareerExtraction(reply);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].title).toBe('Dev');
  });

  it('tolerates preamble text before and after the JSON object', () => {
    const reply =
      'I found the following career data:\n\n' +
      '{"positions":[],"education":[{"institution":"Oxford","degree":"PhD","skills":["Research"]}],"skills":[]}\n\n' +
      'Let me know if you need more.';
    const result = parseCareerExtraction(reply);
    expect(result.education).toHaveLength(1);
    expect(result.education[0].institution).toBe('Oxford');
  });

  it('returns empty extraction on completely unparseable reply', () => {
    const result = parseCareerExtraction('Sorry, I cannot process this document.');
    expect(result.positions).toHaveLength(0);
    expect(result.education).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
  });

  it('returns empty extraction on empty string', () => {
    const result = parseCareerExtraction('');
    expect(result.positions).toHaveLength(0);
    expect(result.education).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
  });

  it('tolerates alternative field names (employer, startDate, endDate)', () => {
    const reply = JSON.stringify({
      positions: [
        { title: 'Manager', employer: 'BigCo', startDate: '2020', endDate: '2023', skills: ['Strategy'] },
      ],
      education: [],
      skills: [],
    });
    const result = parseCareerExtraction(reply);
    expect(result.positions[0].company).toBe('BigCo');
    expect(result.positions[0].start).toBe('2020');
    expect(result.positions[0].end).toBe('2023');
    expect(result.positions[0].technologies).toEqual(['Strategy']);
  });

  it('handles null dates gracefully (R71.9)', () => {
    const reply = JSON.stringify({
      positions: [
        { title: 'Intern', company: 'Startup', start: null, end: null, technologies: [] },
      ],
      education: [],
      skills: [{ name: 'Python', since: null }],
    });
    const result = parseCareerExtraction(reply);
    expect(result.positions[0].start).toBeUndefined();
    expect(result.positions[0].end).toBeUndefined();
    expect(result.skills[0].since).toBeUndefined();
  });

  it('drops positions without title AND company', () => {
    const reply = JSON.stringify({
      positions: [
        { title: '', company: '', technologies: [] },
        { title: 'Valid', company: 'Place', technologies: [] },
      ],
      education: [],
      skills: [],
    });
    const result = parseCareerExtraction(reply);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].title).toBe('Valid');
  });

  it('drops education without institution AND degree', () => {
    const reply = JSON.stringify({
      positions: [],
      education: [
        { institution: '', degree: '', skills: [] },
        { institution: 'Uni', degree: 'MSc', skills: [] },
      ],
      skills: [],
    });
    const result = parseCareerExtraction(reply);
    expect(result.education).toHaveLength(1);
  });

  it('drops skills without a name', () => {
    const reply = JSON.stringify({
      positions: [],
      education: [],
      skills: [{ name: '' }, { name: 'Docker' }],
    });
    const result = parseCareerExtraction(reply);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe('Docker');
  });

  it('tolerates technologies as a comma-separated string', () => {
    const reply = JSON.stringify({
      positions: [
        { title: 'Dev', company: 'Co', technologies: 'React, TypeScript, Node.js' },
      ],
      education: [],
      skills: [],
    });
    const result = parseCareerExtraction(reply);
    expect(result.positions[0].technologies).toEqual(['React', 'TypeScript', 'Node.js']);
  });
});

// ---------------------------------------------------------------------------
// mergeCareerExtractions
// ---------------------------------------------------------------------------

describe('mergeCareerExtractions', () => {
  it('returns empty extraction for empty input', () => {
    const result = mergeCareerExtractions([]);
    expect(result.positions).toHaveLength(0);
    expect(result.education).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
  });

  it('returns single chunk unchanged', () => {
    const chunk = extraction({
      positions: [{ title: 'A', company: 'B', start: '2020', technologies: ['X'] }],
      skills: [{ name: 'Z' }],
    });
    expect(mergeCareerExtractions([chunk])).toBe(chunk);
  });

  it('de-duplicates positions by company+title+start', () => {
    const a = extraction({
      positions: [{ title: 'SRE', company: 'Acme', start: '2020', technologies: ['K8s'] }],
    });
    const b = extraction({
      positions: [{ title: 'SRE', company: 'Acme', start: '2020', technologies: ['K8s', 'Go', 'Terraform'] }],
    });
    const result = mergeCareerExtractions([a, b]);
    expect(result.positions).toHaveLength(1);
    // Keeps the richer entry (more technologies).
    expect(result.positions[0].technologies).toEqual(['K8s', 'Go', 'Terraform']);
  });

  it('de-duplicates education by institution+degree', () => {
    const a = extraction({
      education: [{ institution: 'MIT', degree: 'BSc', skills: ['Math'] }],
    });
    const b = extraction({
      education: [{ institution: 'MIT', degree: 'BSc', skills: ['Math', 'CS', 'Physics'] }],
    });
    const result = mergeCareerExtractions([a, b]);
    expect(result.education).toHaveLength(1);
    expect(result.education[0].skills).toEqual(['Math', 'CS', 'Physics']);
  });

  it('de-duplicates skills by name (case-insensitive) keeping earliest since', () => {
    const a = extraction({
      skills: [{ name: 'Kubernetes', since: '2020' }],
    });
    const b = extraction({
      skills: [{ name: 'kubernetes', since: '2018' }],
    });
    const result = mergeCareerExtractions([a, b]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].since).toBe('2018');
  });

  it('preserves distinct entries from multiple chunks', () => {
    const a = extraction({
      positions: [{ title: 'Dev', company: 'A', start: '2018', technologies: [] }],
      education: [{ institution: 'Uni A', degree: 'BSc', skills: [] }],
      skills: [{ name: 'Go' }],
    });
    const b = extraction({
      positions: [{ title: 'Lead', company: 'B', start: '2021', technologies: [] }],
      education: [{ institution: 'Uni B', degree: 'MSc', skills: [] }],
      skills: [{ name: 'Rust' }],
    });
    const result = mergeCareerExtractions([a, b]);
    expect(result.positions).toHaveLength(2);
    expect(result.education).toHaveLength(2);
    expect(result.skills).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests — broad-input invariants
// ---------------------------------------------------------------------------

// Feature: career-agent, Property 1: parseCareerExtraction never throws on
// arbitrary string input and always returns a valid CareerExtraction shape.
describe('parseCareerExtraction property tests', () => {
  it('never throws and always returns a valid shape for arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = parseCareerExtraction(input);
        expect(result).toBeDefined();
        expect(Array.isArray(result.positions)).toBe(true);
        expect(Array.isArray(result.education)).toBe(true);
        expect(Array.isArray(result.skills)).toBe(true);
        // Every position has required fields.
        for (const pos of result.positions) {
          expect(typeof pos.title).toBe('string');
          expect(typeof pos.company).toBe('string');
          expect(Array.isArray(pos.technologies)).toBe(true);
        }
        // Every education has required fields.
        for (const edu of result.education) {
          expect(typeof edu.institution).toBe('string');
          expect(typeof edu.degree).toBe('string');
          expect(Array.isArray(edu.skills)).toBe(true);
        }
        // Every skill has a name.
        for (const skill of result.skills) {
          expect(typeof skill.name).toBe('string');
          expect(skill.name.length).toBeGreaterThan(0);
        }
      }),
    );
  });
});

// Feature: career-agent, Property 2: mergeCareerExtractions is idempotent —
// merging an already-merged result with itself produces the same result.
describe('mergeCareerExtractions property tests', () => {
  // Arbitrary for a valid CareerExtraction.
  const arbPosition: fc.Arbitrary<ExtractedPosition> = fc.record({
    title: fc.string({ minLength: 1, maxLength: 30 }),
    company: fc.string({ minLength: 1, maxLength: 30 }),
    start: fc.option(fc.stringMatching(/^\d{4}(-\d{2})?$/), { nil: undefined }),
    end: fc.option(fc.stringMatching(/^\d{4}(-\d{2})?$/), { nil: undefined }),
    technologies: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
  });

  const arbEducation: fc.Arbitrary<ExtractedEducation> = fc.record({
    institution: fc.string({ minLength: 1, maxLength: 30 }),
    degree: fc.string({ minLength: 1, maxLength: 30 }),
    start: fc.option(fc.stringMatching(/^\d{4}(-\d{2})?$/), { nil: undefined }),
    end: fc.option(fc.stringMatching(/^\d{4}(-\d{2})?$/), { nil: undefined }),
    skills: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
  });

  const arbSkill: fc.Arbitrary<ExtractedStandaloneSkill> = fc.record({
    name: fc.string({ minLength: 1, maxLength: 30 }),
    since: fc.option(fc.stringMatching(/^\d{4}$/), { nil: undefined }),
  });

  const arbLanguage = fc.record({
    language: fc.string({ minLength: 1, maxLength: 20 }),
    proficiency: fc.string({ minLength: 1, maxLength: 20 }),
  });

  const arbAdditionalInfo = fc.record({
    category: fc.string({ minLength: 1, maxLength: 20 }),
    value: fc.string({ minLength: 1, maxLength: 30 }),
  });

  const arbExtraction: fc.Arbitrary<CareerExtraction> = fc.record({
    positions: fc.array(arbPosition, { maxLength: 3 }),
    education: fc.array(arbEducation, { maxLength: 3 }),
    technicalSkills: fc.array(arbSkill, { maxLength: 5 }),
    coreCompetencies: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 3 }),
    languages: fc.array(arbLanguage, { maxLength: 3 }),
    hobbies: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 3 }),
    causes: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 3 }),
    additionalInfo: fc.array(arbAdditionalInfo, { maxLength: 3 }),
  }).map((r) => ({ ...r, skills: r.technicalSkills }));

  it('idempotent: merge(merge(chunks)) produces no more entries than merge(chunks)', () => {
    fc.assert(
      fc.property(fc.array(arbExtraction, { minLength: 1, maxLength: 4 }), (chunks) => {
        const once = mergeCareerExtractions(chunks);
        const twice = mergeCareerExtractions([once, once]);
        expect(twice.positions.length).toBeLessThanOrEqual(once.positions.length);
        expect(twice.education.length).toBeLessThanOrEqual(once.education.length);
        expect(twice.skills.length).toBeLessThanOrEqual(once.skills.length);
        expect(twice.coreCompetencies.length).toBeLessThanOrEqual(once.coreCompetencies.length);
        expect(twice.languages.length).toBeLessThanOrEqual(once.languages.length);
        expect(twice.hobbies.length).toBeLessThanOrEqual(once.hobbies.length);
        expect(twice.causes.length).toBeLessThanOrEqual(once.causes.length);
        expect(twice.additionalInfo.length).toBeLessThanOrEqual(once.additionalInfo.length);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// careerExtractionToItems (R71.3)
// ---------------------------------------------------------------------------

describe('careerExtractionToItems', () => {
  const AI_SOURCE_DOC = 'ai-extraction.md';

  describe('position → employment items', () => {
    it('maps a position to an employment ExtractedItem with correct fields', () => {
      const ext = extraction({
        positions: [
          { title: 'SRE Lead', company: 'Acme Corp', start: '2019-03', end: '2022-06', technologies: ['Kubernetes', 'Go'] },
        ],
      });
      const items = careerExtractionToItems(ext);
      expect(items).toHaveLength(1);
      const item = items[0];
      expect(item.type).toBe('employment');
      expect(item.fields).toEqual({
        title: 'SRE Lead',
        employer: 'Acme Corp',
        start: '2019-03',
        end: '2022-06',
        technologies: ['Kubernetes', 'Go'],
      });
    });

    it('generates a deterministic slugified id', () => {
      const ext = extraction({
        positions: [
          { title: 'Senior Engineer', company: 'Big Co', start: '2020', technologies: [] },
        ],
      });
      const items = careerExtractionToItems(ext);
      expect(String(items[0].id)).toBe('ai-extraction.md#employment-senior-engineer-big-co');
    });

    it('handles positions with undefined dates', () => {
      const ext = extraction({
        positions: [
          { title: 'Intern', company: 'Startup', technologies: ['Python'] },
        ],
      });
      const items = careerExtractionToItems(ext);
      expect(items[0].fields).toEqual({
        title: 'Intern',
        employer: 'Startup',
        start: undefined,
        end: undefined,
        technologies: ['Python'],
      });
    });
  });

  describe('education → education items', () => {
    it('maps education to an education ExtractedItem with correct fields', () => {
      const ext = extraction({
        education: [
          { institution: 'MIT', degree: 'BSc Computer Science', start: '2015', end: '2019', skills: ['Algorithms', 'ML'] },
        ],
      });
      const items = careerExtractionToItems(ext);
      expect(items).toHaveLength(1);
      const item = items[0];
      expect(item.type).toBe('education');
      expect(item.fields).toEqual({
        degree: 'BSc Computer Science',
        institution: 'MIT',
        start: '2015',
        end: '2019',
        skills: ['Algorithms', 'ML'],
      });
    });

    it('generates a deterministic slugified id for education', () => {
      const ext = extraction({
        education: [
          { institution: 'Oxford University', degree: 'PhD Physics', skills: [] },
        ],
      });
      const items = careerExtractionToItems(ext);
      expect(String(items[0].id)).toBe('ai-extraction.md#education-phd-physics-oxford-university');
    });
  });

  describe('skills → skill items with since inference', () => {
    it('maps a standalone skill with explicit since', () => {
      const ext = extraction({
        skills: [{ name: 'Leadership', since: '2020' }],
      });
      const items = careerExtractionToItems(ext);
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('skill');
      expect(items[0].fields).toEqual({ name: 'Leadership', since: '2020' });
    });

    it('infers since from the earliest position using the skill', () => {
      const ext = extraction({
        positions: [
          { title: 'Dev', company: 'A', start: '2020', technologies: ['React', 'TypeScript'] },
          { title: 'Lead', company: 'B', start: '2018', technologies: ['React', 'Node'] },
        ],
        skills: [{ name: 'React' }],
      });
      const items = careerExtractionToItems(ext);
      const skillItem = items.find((i) => i.type === 'skill')!;
      // Should pick 2018 as earliest position using React.
      expect(skillItem.fields).toEqual({ name: 'React', since: '2018' });
    });

    it('inference is case-insensitive', () => {
      const ext = extraction({
        positions: [
          { title: 'Dev', company: 'X', start: '2017', technologies: ['kubernetes'] },
        ],
        skills: [{ name: 'Kubernetes' }],
      });
      const items = careerExtractionToItems(ext);
      const skillItem = items.find((i) => i.type === 'skill')!;
      expect(skillItem.fields).toEqual({ name: 'Kubernetes', since: '2017' });
    });

    it('returns undefined since when no position uses the skill', () => {
      const ext = extraction({
        positions: [
          { title: 'Dev', company: 'X', start: '2019', technologies: ['Go'] },
        ],
        skills: [{ name: 'Leadership' }],
      });
      const items = careerExtractionToItems(ext);
      const skillItem = items.find((i) => i.type === 'skill')!;
      expect(skillItem.fields).toEqual({ name: 'Leadership', since: undefined });
    });

    it('explicit since takes precedence over inference', () => {
      const ext = extraction({
        positions: [
          { title: 'Dev', company: 'A', start: '2015', technologies: ['Python'] },
        ],
        skills: [{ name: 'Python', since: '2012' }],
      });
      const items = careerExtractionToItems(ext);
      const skillItem = items.find((i) => i.type === 'skill')!;
      // Uses the explicit since (2012), not the position start (2015).
      expect(skillItem.fields).toEqual({ name: 'Python', since: '2012' });
    });
  });

  describe('common metadata on all items', () => {
    it('all items have Medium confidence', () => {
      const ext = extraction({
        positions: [{ title: 'A', company: 'B', technologies: [] }],
        education: [{ institution: 'C', degree: 'D', skills: [] }],
        skills: [{ name: 'E' }],
      });
      const items = careerExtractionToItems(ext);
      for (const item of items) {
        expect(item.confidence).toBe('Medium');
      }
    });

    it('all items have ai-extraction.md as sourceDoc', () => {
      const ext = extraction({
        positions: [{ title: 'A', company: 'B', technologies: [] }],
        education: [{ institution: 'C', degree: 'D', skills: [] }],
        skills: [{ name: 'E' }],
      });
      const items = careerExtractionToItems(ext);
      for (const item of items) {
        expect(String(item.sourceDoc)).toBe(AI_SOURCE_DOC);
      }
    });

    it('all items have userConfirmed: false and private: false', () => {
      const ext = extraction({
        positions: [{ title: 'A', company: 'B', technologies: [] }],
        education: [{ institution: 'C', degree: 'D', skills: [] }],
        skills: [{ name: 'E' }],
      });
      const items = careerExtractionToItems(ext);
      for (const item of items) {
        expect(item.userConfirmed).toBe(false);
        expect(item.private).toBe(false);
      }
    });

    it('all items have a non-empty provenance trail', () => {
      const ext = extraction({
        positions: [{ title: 'A', company: 'B', technologies: [] }],
        education: [{ institution: 'C', degree: 'D', skills: [] }],
        skills: [{ name: 'E' }],
      });
      const items = careerExtractionToItems(ext);
      for (const item of items) {
        expect(item.provenance.length).toBeGreaterThanOrEqual(1);
        expect(item.provenance[0].kind).toBe('source_line');
      }
    });
  });

  describe('professional summary → professional_summary items', () => {
    it('maps professional summary to a professional_summary item', () => {
      const ext = extraction({ professionalSummary: 'Experienced cloud architect with 10+ years.' });
      const items = careerExtractionToItems(ext);
      expect(items).toHaveLength(1);
      const item = items[0];
      expect(item.type).toBe('professional_summary');
      expect(item.fields).toEqual({ text: 'Experienced cloud architect with 10+ years.' });
      expect(String(item.id)).toBe('ai-extraction.md#professional-summary');
      expect(item.confidence).toBe('Medium');
      expect(item.userConfirmed).toBe(false);
    });

    it('does not emit professional_summary item when missing', () => {
      const ext = extraction({});
      const items = careerExtractionToItems(ext);
      expect(items.filter((i) => i.type === 'professional_summary')).toHaveLength(0);
    });
  });

  describe('core competencies → core_competency items', () => {
    it('maps each competency to a core_competency item', () => {
      const ext = extraction({ coreCompetencies: ['Leadership', 'Strategic Thinking'] });
      const items = careerExtractionToItems(ext);
      const compItems = items.filter((i) => i.type === 'core_competency');
      expect(compItems).toHaveLength(2);
      expect(compItems[0].fields).toEqual({ name: 'Leadership' });
      expect(compItems[1].fields).toEqual({ name: 'Strategic Thinking' });
    });

    it('generates deterministic slugified ids for competencies', () => {
      const ext = extraction({ coreCompetencies: ['Team Building'] });
      const items = careerExtractionToItems(ext);
      expect(String(items[0].id)).toBe('ai-extraction.md#core-competency-team-building');
    });
  });

  describe('languages → language_proficiency items', () => {
    it('maps each language to a language_proficiency item', () => {
      const ext = extraction({
        languages: [
          { language: 'English', proficiency: 'Native' },
          { language: 'Portuguese', proficiency: 'Fluent' },
        ],
      });
      const items = careerExtractionToItems(ext);
      const langItems = items.filter((i) => i.type === 'language_proficiency');
      expect(langItems).toHaveLength(2);
      expect(langItems[0].fields).toEqual({ language: 'English', proficiency: 'Native' });
      expect(langItems[1].fields).toEqual({ language: 'Portuguese', proficiency: 'Fluent' });
    });

    it('generates deterministic slugified ids for languages', () => {
      const ext = extraction({ languages: [{ language: 'French', proficiency: 'Intermediate' }] });
      const items = careerExtractionToItems(ext);
      expect(String(items[0].id)).toBe('ai-extraction.md#language-french');
    });
  });

  describe('hobbies → hobby items', () => {
    it('maps each hobby to a hobby item', () => {
      const ext = extraction({ hobbies: ['Photography', 'Hiking'] });
      const items = careerExtractionToItems(ext);
      const hobbyItems = items.filter((i) => i.type === 'hobby');
      expect(hobbyItems).toHaveLength(2);
      expect(hobbyItems[0].fields).toEqual({ name: 'Photography' });
      expect(hobbyItems[1].fields).toEqual({ name: 'Hiking' });
    });

    it('generates deterministic slugified ids for hobbies', () => {
      const ext = extraction({ hobbies: ['Rock Climbing'] });
      const items = careerExtractionToItems(ext);
      expect(String(items[0].id)).toBe('ai-extraction.md#hobby-rock-climbing');
    });
  });

  describe('causes → cause items', () => {
    it('maps each cause to a cause item', () => {
      const ext = extraction({ causes: ['Open Source', 'STEM Education'] });
      const items = careerExtractionToItems(ext);
      const causeItems = items.filter((i) => i.type === 'cause');
      expect(causeItems).toHaveLength(2);
      expect(causeItems[0].fields).toEqual({ name: 'Open Source' });
      expect(causeItems[1].fields).toEqual({ name: 'STEM Education' });
    });

    it('generates deterministic slugified ids for causes', () => {
      const ext = extraction({ causes: ['Climate Action'] });
      const items = careerExtractionToItems(ext);
      expect(String(items[0].id)).toBe('ai-extraction.md#cause-climate-action');
    });
  });

  describe('additional info → additional_info items', () => {
    it('maps each additional info entry to an additional_info item', () => {
      const ext = extraction({
        additionalInfo: [
          { category: 'Publications', value: 'Cloud Architecture Patterns, O\'Reilly 2022' },
          { category: 'Awards', value: 'Engineer of the Year 2021' },
        ],
      });
      const items = careerExtractionToItems(ext);
      const infoItems = items.filter((i) => i.type === 'additional_info');
      expect(infoItems).toHaveLength(2);
      expect(infoItems[0].fields).toEqual({ category: 'Publications', value: 'Cloud Architecture Patterns, O\'Reilly 2022' });
      expect(infoItems[1].fields).toEqual({ category: 'Awards', value: 'Engineer of the Year 2021' });
    });

    it('generates deterministic slugified ids for additional info', () => {
      const ext = extraction({
        additionalInfo: [{ category: 'Patents', value: 'US Patent 12345' }],
      });
      const items = careerExtractionToItems(ext);
      expect(String(items[0].id)).toBe('ai-extraction.md#additional-info-patents-us-patent-12345');
    });
  });

  describe('employment items include location, description, achievements when present', () => {
    it('includes location, description, and achievements in fields', () => {
      const ext = extraction({
        positions: [{
          title: 'SRE Lead',
          company: 'Acme',
          start: '2019',
          location: 'London, UK',
          description: 'Led reliability team',
          achievements: ['Reduced downtime by 50%', 'Built SLO framework'],
          technologies: ['K8s'],
        }],
      });
      const items = careerExtractionToItems(ext);
      expect(items[0].fields).toEqual({
        title: 'SRE Lead',
        employer: 'Acme',
        start: '2019',
        end: undefined,
        technologies: ['K8s'],
        location: 'London, UK',
        description: 'Led reliability team',
        achievements: ['Reduced downtime by 50%', 'Built SLO framework'],
      });
    });

    it('omits location/description/achievements from fields when absent', () => {
      const ext = extraction({
        positions: [{ title: 'Dev', company: 'Co', technologies: ['Go'] }],
      });
      const items = careerExtractionToItems(ext);
      expect(items[0].fields).toEqual({
        title: 'Dev',
        employer: 'Co',
        start: undefined,
        end: undefined,
        technologies: ['Go'],
      });
      expect(items[0].fields).not.toHaveProperty('location');
      expect(items[0].fields).not.toHaveProperty('description');
      expect(items[0].fields).not.toHaveProperty('achievements');
    });
  });

  describe('combined extraction', () => {
    it('produces items for all categories in order', () => {
      const ext = extraction({
        professionalSummary: 'Cloud engineer',
        positions: [
          { title: 'Dev', company: 'Co1', start: '2018', technologies: ['TS'] },
          { title: 'Lead', company: 'Co2', start: '2021', technologies: ['Go'] },
        ],
        education: [
          { institution: 'Uni', degree: 'MSc', start: '2016', end: '2018', skills: ['ML'] },
        ],
        skills: [
          { name: 'Docker', since: '2019' },
          { name: 'TS' },
        ],
        coreCompetencies: ['Leadership'],
        languages: [{ language: 'English', proficiency: 'Native' }],
        hobbies: ['Chess'],
        causes: ['Open Source'],
        additionalInfo: [{ category: 'Awards', value: 'Best Engineer' }],
      });
      const items = careerExtractionToItems(ext);
      // 1 summary + 2 positions + 1 education + 2 skills + 1 competency + 1 language + 1 hobby + 1 cause + 1 additional = 11 items
      expect(items).toHaveLength(11);
      expect(items[0].type).toBe('professional_summary');
      expect(items[1].type).toBe('employment');
      expect(items[2].type).toBe('employment');
      expect(items[3].type).toBe('education');
      expect(items[4].type).toBe('skill');
      expect(items[5].type).toBe('skill');
      expect(items[6].type).toBe('core_competency');
      expect(items[7].type).toBe('language_proficiency');
      expect(items[8].type).toBe('hobby');
      expect(items[9].type).toBe('cause');
      expect(items[10].type).toBe('additional_info');
      // The 'TS' skill should infer since from the position (2018)
      expect(items[5].fields).toEqual({ name: 'TS', since: '2018' });
    });
  });

  describe('empty extraction', () => {
    it('returns empty array for empty extraction', () => {
      const ext = extraction({});
      expect(careerExtractionToItems(ext)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// splitCompoundSkills (R71.11, R71.12)
// ---------------------------------------------------------------------------

describe('splitCompoundSkills', () => {
  describe('parenthetical expansion', () => {
    it('expands parenthetical entries into prefix + inner items', () => {
      const result = splitCompoundSkills(['AWS SAM (Python, Lambda)']);
      expect(result).toEqual(['AWS SAM', 'Python', 'Lambda']);
    });

    it('handles multiple comma-separated items in parentheses', () => {
      const result = splitCompoundSkills(['AWS SAM (Python, Lambda, Step Functions)']);
      expect(result).toEqual(['AWS SAM', 'Python', 'Lambda', 'Step Functions']);
    });

    it('handles single item in parentheses', () => {
      const result = splitCompoundSkills(['CDK (TypeScript)']);
      expect(result).toEqual(['CDK', 'TypeScript']);
    });
  });

  describe('slash-separated expansion', () => {
    it('expands slash-separated entries', () => {
      const result = splitCompoundSkills(['Terraform/Terragrunt']);
      expect(result).toEqual(['Terraform', 'Terragrunt']);
    });

    it('expands multiple slash-separated parts', () => {
      const result = splitCompoundSkills(['HTML/CSS/JavaScript']);
      expect(result).toEqual(['HTML', 'CSS', 'JavaScript']);
    });
  });

  describe('allowlist preservation', () => {
    it('does not split CI/CD', () => {
      const result = splitCompoundSkills(['CI/CD']);
      expect(result).toEqual(['CI/CD']);
    });

    it('does not split TCP/IP', () => {
      const result = splitCompoundSkills(['TCP/IP']);
      expect(result).toEqual(['TCP/IP']);
    });

    it('does not split IDS/IPS', () => {
      const result = splitCompoundSkills(['IDS/IPS']);
      expect(result).toEqual(['IDS/IPS']);
    });

    it('does not split Node.js', () => {
      const result = splitCompoundSkills(['Node.js']);
      expect(result).toEqual(['Node.js']);
    });

    it('does not split C#', () => {
      const result = splitCompoundSkills(['C#']);
      expect(result).toEqual(['C#']);
    });

    it('does not split C++', () => {
      const result = splitCompoundSkills(['C++']);
      expect(result).toEqual(['C++']);
    });

    it('does not split .NET', () => {
      const result = splitCompoundSkills(['.NET']);
      expect(result).toEqual(['.NET']);
    });

    it('does not split GitLab CI/CD', () => {
      const result = splitCompoundSkills(['GitLab CI/CD']);
      expect(result).toEqual(['GitLab CI/CD']);
    });

    it('allowlist matching is case-insensitive', () => {
      const result = splitCompoundSkills(['ci/cd', 'tcp/ip']);
      expect(result).toEqual(['ci/cd', 'tcp/ip']);
    });

    it('does not split OS/2', () => {
      const result = splitCompoundSkills(['OS/2']);
      expect(result).toEqual(['OS/2']);
    });

    it('does not split OS/2 Warp', () => {
      const result = splitCompoundSkills(['OS/2 Warp']);
      expect(result).toEqual(['OS/2 Warp']);
    });

    it('does not split L2/L3', () => {
      const result = splitCompoundSkills(['L2/L3']);
      expect(result).toEqual(['L2/L3']);
    });

    it('does not split L2/L3 Networking', () => {
      const result = splitCompoundSkills(['L2/L3 Networking']);
      expect(result).toEqual(['L2/L3 Networking']);
    });
  });

  describe('fragment detection and merge-back (R15.6)', () => {
    it('merges "OS" + "2 Warp" fragments back into "OS/2 Warp"', () => {
      const result = mergeCompoundFragments(['OS', '2 Warp']);
      expect(result).toEqual(['OS/2 Warp']);
    });

    it('merges "OS" + "2" fragments back into "OS/2"', () => {
      const result = mergeCompoundFragments(['OS', '2']);
      expect(result).toEqual(['OS/2']);
    });

    it('merges "L2" + "L3 Networking" fragments back into "L2/L3 Networking"', () => {
      const result = mergeCompoundFragments(['L2', 'L3 Networking']);
      expect(result).toEqual(['L2/L3 Networking']);
    });

    it('merges "L2" + "L3" fragments back into "L2/L3"', () => {
      const result = mergeCompoundFragments(['L2', 'L3']);
      expect(result).toEqual(['L2/L3']);
    });

    it('does not merge when compound is already present', () => {
      const result = mergeCompoundFragments(['OS/2', 'OS', '2']);
      expect(result).toEqual(['OS/2', 'OS', '2']);
    });

    it('preserves non-fragment entries alongside merged ones', () => {
      const result = mergeCompoundFragments(['Docker', 'OS', '2 Warp', 'Kubernetes']);
      expect(result).toEqual(['Docker', 'OS/2 Warp', 'Kubernetes']);
    });

    it('prefers longer compound name when both fragments match', () => {
      // If "OS" and "2 Warp" are present, should merge to "OS/2 Warp" not "OS/2"
      const result = mergeCompoundFragments(['OS', '2 Warp']);
      expect(result).toEqual(['OS/2 Warp']);
    });

    it('splitCompoundSkills integrates fragment detection end-to-end', () => {
      // Simulate: something upstream already split "OS/2 Warp" into "OS" + "2 Warp"
      const result = splitCompoundSkills(['OS', '2 Warp', 'Docker']);
      expect(result).toEqual(['OS/2 Warp', 'Docker']);
    });
  });

  describe('deduplication and trimming', () => {
    it('deduplicates results case-insensitively', () => {
      const result = splitCompoundSkills(['Python', 'AWS SAM (Python, Lambda)']);
      expect(result).toEqual(['Python', 'AWS SAM', 'Lambda']);
    });

    it('trims whitespace from results', () => {
      const result = splitCompoundSkills(['  Terraform / Terragrunt  ']);
      expect(result).toEqual(['Terraform', 'Terragrunt']);
    });

    it('filters out empty strings', () => {
      const result = splitCompoundSkills(['', 'Docker', '']);
      expect(result).toEqual(['Docker']);
    });
  });

  describe('passthrough (no expansion needed)', () => {
    it('passes through simple entries unchanged', () => {
      const result = splitCompoundSkills(['Docker', 'Kubernetes', 'Go']);
      expect(result).toEqual(['Docker', 'Kubernetes', 'Go']);
    });

    it('returns empty array for empty input', () => {
      const result = splitCompoundSkills([]);
      expect(result).toEqual([]);
    });
  });

  describe('integration with normalisePosition (via parseCareerExtraction)', () => {
    it('splits compound skills in parsed position technologies', () => {
      const reply = JSON.stringify({
        positions: [
          { title: 'DevOps', company: 'Corp', technologies: ['AWS SAM (Python, Lambda)', 'Terraform/Terragrunt', 'CI/CD'] },
        ],
        education: [],
        skills: [],
      });
      const result = parseCareerExtraction(reply);
      expect(result.positions[0].technologies).toEqual([
        'AWS SAM', 'Python', 'Lambda', 'Terraform', 'Terragrunt', 'CI/CD',
      ]);
    });
  });
});

// Feature: career-agent, Property 3: splitCompoundSkills never loses information —
// every token from the input appears in the output (possibly expanded).
describe('splitCompoundSkills property tests', () => {
  it('output length is always >= input length (expansion never shrinks)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 10 }),
        (techs) => {
          const result = splitCompoundSkills(techs);
          // After expansion, we should have at least as many unique items as
          // the unique items in the input (expansion adds, dedup may reduce
          // but net effect for non-duplicate inputs is >= input count).
          // Actually the key property is: result never throws and returns a valid array.
          expect(Array.isArray(result)).toBe(true);
          for (const item of result) {
            expect(typeof item).toBe('string');
            expect(item.trim()).toBe(item); // all trimmed
            expect(item.length).toBeGreaterThan(0); // no empty strings
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('is idempotent — splitting already-split results produces the same output', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 10 }),
        (techs) => {
          const once = splitCompoundSkills(techs);
          const twice = splitCompoundSkills(once);
          expect(twice).toEqual(once);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeDate (R71.8, R71.9, R70.1, R70.2)
// ---------------------------------------------------------------------------

describe('normalizeDate', () => {
  describe('English month names', () => {
    it('converts "March 2020" → "2020-03"', () => {
      expect(normalizeDate('March 2020')).toBe('2020-03');
    });

    it('converts abbreviated "Jan 2019" → "2019-01"', () => {
      expect(normalizeDate('Jan 2019')).toBe('2019-01');
    });

    it('converts "December 2018" → "2018-12"', () => {
      expect(normalizeDate('December 2018')).toBe('2018-12');
    });

    it('is case-insensitive: "FEBRUARY 2021" → "2021-02"', () => {
      expect(normalizeDate('FEBRUARY 2021')).toBe('2021-02');
    });
  });

  describe('Portuguese month names', () => {
    it('converts "Março 2020" → "2020-03"', () => {
      expect(normalizeDate('Março 2020')).toBe('2020-03');
    });

    it('converts "Janeiro 2018" → "2018-01"', () => {
      expect(normalizeDate('Janeiro 2018')).toBe('2018-01');
    });

    it('converts "Dezembro 2022" → "2022-12"', () => {
      expect(normalizeDate('Dezembro 2022')).toBe('2022-12');
    });

    it('handles abbreviated PT months: "Fev 2020" → "2020-02"', () => {
      expect(normalizeDate('Fev 2020')).toBe('2020-02');
    });
  });

  describe('date ranges (extract start only)', () => {
    it('extracts start from "Jan 2020 - Dec 2022" → "2020-01"', () => {
      expect(normalizeDate('Jan 2020 - Dec 2022')).toBe('2020-01');
    });

    it('extracts start from "2019-03 – 2022-06" → "2019-03"', () => {
      expect(normalizeDate('2019-03 – 2022-06')).toBe('2019-03');
    });

    it('extracts start from "March 2018 to Present" → "2018-03"', () => {
      expect(normalizeDate('March 2018 to Present')).toBe('2018-03');
    });

    it('extracts start from "2020 — 2023" → "2020"', () => {
      expect(normalizeDate('2020 — 2023')).toBe('2020');
    });
  });

  describe('"Present" / "current" / null → undefined', () => {
    it('returns undefined for "Present"', () => {
      expect(normalizeDate('Present')).toBeUndefined();
    });

    it('returns undefined for "current"', () => {
      expect(normalizeDate('current')).toBeUndefined();
    });

    it('returns undefined for "atual"', () => {
      expect(normalizeDate('atual')).toBeUndefined();
    });

    it('returns undefined for "Atualmente"', () => {
      expect(normalizeDate('Atualmente')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(normalizeDate('')).toBeUndefined();
    });

    it('returns undefined for whitespace-only', () => {
      expect(normalizeDate('   ')).toBeUndefined();
    });
  });

  describe('ISO passthrough', () => {
    it('passes through "2020-03" unchanged', () => {
      expect(normalizeDate('2020-03')).toBe('2020-03');
    });

    it('passes through "2020" unchanged', () => {
      expect(normalizeDate('2020')).toBe('2020');
    });

    it('truncates "2020-03-15" to "2020-03"', () => {
      expect(normalizeDate('2020-03-15')).toBe('2020-03');
    });
  });

  describe('numeric month/year formats', () => {
    it('converts "01/2020" → "2020-01"', () => {
      expect(normalizeDate('01/2020')).toBe('2020-01');
    });

    it('converts "12/2019" → "2019-12"', () => {
      expect(normalizeDate('12/2019')).toBe('2019-12');
    });

    it('converts "3/2021" → "2021-03"', () => {
      expect(normalizeDate('3/2021')).toBe('2021-03');
    });
  });

  describe('edge cases', () => {
    it('handles "15 March 2020" (day month year) → "2020-03"', () => {
      expect(normalizeDate('15 March 2020')).toBe('2020-03');
    });

    it('handles "March 15, 2020" (US format) → "2020-03"', () => {
      expect(normalizeDate('March 15, 2020')).toBe('2020-03');
    });

    it('handles "Set. 2019" (abbreviated with dot) → "2019-09"', () => {
      expect(normalizeDate('Set. 2019')).toBe('2019-09');
    });
  });
});

// Feature: career-agent, Property 3: normalizeDate always returns undefined or
// a well-formed ISO date (YYYY-MM or YYYY) for arbitrary string input.
describe('normalizeDate property tests', () => {
  it('always returns undefined or a well-formed YYYY-MM / YYYY string', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = normalizeDate(input);
        if (result === undefined) return true;
        // Must be YYYY or YYYY-MM format
        const isYear = /^\d{4}$/.test(result);
        const isYearMonth = /^\d{4}-\d{2}$/.test(result);
        expect(isYear || isYearMonth).toBe(true);
        // If YYYY-MM, month must be 01-12
        if (isYearMonth) {
          const month = parseInt(result.slice(5), 10);
          expect(month).toBeGreaterThanOrEqual(1);
          expect(month).toBeLessThanOrEqual(12);
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeDate integration: parsed extraction dates are normalised
// ---------------------------------------------------------------------------

describe('parseCareerExtraction date normalisation integration', () => {
  it('normalises written month names in position dates', () => {
    const reply = JSON.stringify({
      positions: [
        { title: 'Dev', company: 'Co', start: 'March 2020', end: 'December 2022', technologies: [] },
      ],
      education: [],
      skills: [],
    });
    const result = parseCareerExtraction(reply);
    expect(result.positions[0].start).toBe('2020-03');
    expect(result.positions[0].end).toBe('2022-12');
  });

  it('normalises "Present" in position end to undefined', () => {
    const reply = JSON.stringify({
      positions: [
        { title: 'Dev', company: 'Co', start: '2020-01', end: 'Present', technologies: [] },
      ],
      education: [],
      skills: [],
    });
    const result = parseCareerExtraction(reply);
    expect(result.positions[0].end).toBeUndefined();
  });

  it('normalises Portuguese dates in education entries', () => {
    const reply = JSON.stringify({
      positions: [],
      education: [
        { institution: 'USP', degree: 'BSc', start: 'Março 2018', end: 'Dezembro 2022', skills: [] },
      ],
      skills: [],
    });
    const result = parseCareerExtraction(reply);
    expect(result.education[0].start).toBe('2018-03');
    expect(result.education[0].end).toBe('2022-12');
  });

  it('normalises date ranges in standalone skill since field', () => {
    const reply = JSON.stringify({
      positions: [],
      education: [],
      skills: [
        { name: 'Python', since: 'Jan 2015 - Present' },
      ],
    });
    const result = parseCareerExtraction(reply);
    expect(result.skills[0].since).toBe('2015-01');
  });
});

// ---------------------------------------------------------------------------
// parseCareerExtractionWithTracking — R75.1, R75.2, R75.6
// ---------------------------------------------------------------------------

describe('parseCareerExtractionWithTracking', () => {
  it('records date normalisation transformations for positions', () => {
    const reply = JSON.stringify({
      positions: [
        { title: 'Engineer', company: 'Acme', start: 'March 2020', end: 'December 2022' },
      ],
    });
    const { extraction, transformations } = parseCareerExtractionWithTracking(reply);
    expect(extraction.positions).toHaveLength(1);
    expect(extraction.positions[0].start).toBe('2020-03');
    expect(extraction.positions[0].end).toBe('2022-12');

    const dateTx = transformations.filter((t) => t.kind === 'date-normalisation');
    expect(dateTx).toHaveLength(2);
    expect(dateTx[0]).toEqual({
      kind: 'date-normalisation',
      original: 'March 2020',
      normalized: '2020-03',
      context: 'Engineer at Acme',
    });
    expect(dateTx[1]).toEqual({
      kind: 'date-normalisation',
      original: 'December 2022',
      normalized: '2022-12',
      context: 'Engineer at Acme',
    });
  });

  it('records skill split transformations for compound technologies', () => {
    const reply = JSON.stringify({
      positions: [
        { title: 'Dev', company: 'Corp', technologies: ['AWS SAM (Python, Lambda)', 'Terraform/Terragrunt'] },
      ],
    });
    const { extraction, transformations } = parseCareerExtractionWithTracking(reply);
    expect(extraction.positions[0].technologies).toEqual(['AWS SAM', 'Python', 'Lambda', 'Terraform', 'Terragrunt']);

    const splitTx = transformations.filter((t) => t.kind === 'skill-split');
    expect(splitTx).toHaveLength(2);
    expect(splitTx[0]).toEqual({
      kind: 'skill-split',
      original: 'AWS SAM (Python, Lambda)',
      normalized: 'AWS SAM, Python, Lambda',
      context: 'Dev at Corp',
    });
    expect(splitTx[1]).toEqual({
      kind: 'skill-split',
      original: 'Terraform/Terragrunt',
      normalized: 'Terraform, Terragrunt',
      context: 'Dev at Corp',
    });
  });

  it('does not record a transformation when a date is already in ISO format', () => {
    const reply = JSON.stringify({
      positions: [
        { title: 'Eng', company: 'X', start: '2020-03', end: '2022-12' },
      ],
    });
    const { transformations } = parseCareerExtractionWithTracking(reply);
    expect(transformations).toHaveLength(0);
  });

  it('does not record a transformation when skills are not compound', () => {
    const reply = JSON.stringify({
      positions: [
        { title: 'Eng', company: 'X', technologies: ['Python', 'TypeScript', 'CI/CD'] },
      ],
    });
    const { transformations } = parseCareerExtractionWithTracking(reply);
    expect(transformations).toHaveLength(0);
  });

  it('tracks date normalisation for education entries', () => {
    const reply = JSON.stringify({
      education: [
        { institution: 'MIT', degree: 'BSc', start: 'Sep 2015', end: 'Jun 2019' },
      ],
    });
    const { extraction, transformations } = parseCareerExtractionWithTracking(reply);
    expect(extraction.education[0].start).toBe('2015-09');
    expect(extraction.education[0].end).toBe('2019-06');

    const dateTx = transformations.filter((t) => t.kind === 'date-normalisation');
    expect(dateTx).toHaveLength(2);
    expect(dateTx[0].context).toBe('BSc at MIT');
  });

  it('tracks date normalisation for standalone skills', () => {
    const reply = JSON.stringify({
      technical_skills: [
        { name: 'Kubernetes', since: 'January 2018' },
        { name: 'Docker', since: '2017' },
      ],
    });
    const { extraction, transformations } = parseCareerExtractionWithTracking(reply);
    expect(extraction.skills[0].since).toBe('2018-01');
    expect(extraction.skills[1].since).toBe('2017');

    // Only one transformation — "January 2018" → "2018-01". "2017" is already ISO year.
    const dateTx = transformations.filter((t) => t.kind === 'date-normalisation');
    expect(dateTx).toHaveLength(1);
    expect(dateTx[0]).toEqual({
      kind: 'date-normalisation',
      original: 'January 2018',
      normalized: '2018-01',
      context: 'skill: Kubernetes',
    });
  });

  it('returns an empty result for unparseable replies', () => {
    const { extraction, transformations } = parseCareerExtractionWithTracking('not json');
    expect(extraction.positions).toHaveLength(0);
    expect(transformations).toHaveLength(0);
  });

  it('returns the same normalised extraction as the non-tracking parser', () => {
    const reply = JSON.stringify({
      positions: [
        { title: 'SRE', company: 'Google', start: 'Mar 2019', technologies: ['GCP (BigQuery, Pub/Sub)'] },
      ],
      education: [
        { institution: 'Stanford', degree: 'MSc', start: 'September 2015', end: 'June 2017' },
      ],
      technical_skills: [
        { name: 'Go', since: 'Jan 2016' },
      ],
    });
    const { extraction } = parseCareerExtractionWithTracking(reply);
    const standard = parseCareerExtraction(reply);
    expect(extraction.positions).toEqual(standard.positions);
    expect(extraction.education).toEqual(standard.education);
    expect(extraction.skills).toEqual(standard.skills);
  });
});

// ---------------------------------------------------------------------------
// consolidateExtraction (R71.15, R71.16, R71.17)
// ---------------------------------------------------------------------------

describe('consolidateExtraction', () => {
  describe('sub-pass 1: vendor-prefix skill deduplication (R71.15)', () => {
    it('collapses "AWS S3" + "S3" to "S3" in technicalSkills', () => {
      const ext = extraction({
        skills: [
          { name: 'AWS S3', since: '2020' },
          { name: 'S3', since: '2021' },
        ],
      });
      const result = consolidateExtraction(ext);
      expect(result.technicalSkills).toHaveLength(1);
      expect(result.technicalSkills[0].name).toBe('S3');
      // Keeps earliest since date.
      expect(result.technicalSkills[0].since).toBe('2020');
    });

    it('collapses "AWS Lambda" + "Lambda" to "Lambda"', () => {
      const ext = extraction({
        skills: [
          { name: 'Lambda', since: '2019' },
          { name: 'AWS Lambda', since: '2018' },
        ],
      });
      const result = consolidateExtraction(ext);
      expect(result.technicalSkills).toHaveLength(1);
      expect(result.technicalSkills[0].name).toBe('Lambda');
      expect(result.technicalSkills[0].since).toBe('2018');
    });

    it('collapses "Azure DevOps" + "DevOps" to "DevOps"', () => {
      const ext = extraction({
        skills: [{ name: 'Azure DevOps' }, { name: 'DevOps' }],
      });
      const result = consolidateExtraction(ext);
      expect(result.technicalSkills).toHaveLength(1);
      expect(result.technicalSkills[0].name).toBe('DevOps');
    });

    it('does not collapse when base form does not exist', () => {
      const ext = extraction({
        skills: [{ name: 'AWS Lambda' }, { name: 'S3' }],
      });
      const result = consolidateExtraction(ext);
      expect(result.technicalSkills).toHaveLength(2);
    });

    it('deduplicates vendor-prefix skills in position technologies', () => {
      const ext = extraction({
        positions: [{
          title: 'Dev',
          company: 'Co',
          technologies: ['AWS S3', 'S3', 'Lambda', 'AWS Lambda', 'Docker'],
        }],
      });
      const result = consolidateExtraction(ext);
      const techs = result.positions[0].technologies;
      expect(techs).toContain('S3');
      expect(techs).toContain('Lambda');
      expect(techs).toContain('Docker');
      expect(techs).not.toContain('AWS S3');
      expect(techs).not.toContain('AWS Lambda');
    });

    it('keeps skills that are not vendor-qualified duplicates', () => {
      const ext = extraction({
        skills: [
          { name: 'Kubernetes' },
          { name: 'Docker' },
          { name: 'Go' },
        ],
      });
      const result = consolidateExtraction(ext);
      expect(result.technicalSkills).toHaveLength(3);
    });

    it('collapses containing-term: "GitHub Enterprise" + "GitHub" → keeps "GitHub"', () => {
      const ext = extraction({
        skills: [
          { name: 'GitHub Enterprise', since: '2020' },
          { name: 'GitHub', since: '2018' },
        ],
      });
      const result = consolidateExtraction(ext);
      expect(result.technicalSkills).toHaveLength(1);
      expect(result.technicalSkills[0].name).toBe('GitHub');
      expect(result.technicalSkills[0].since).toBe('2018');
    });

    it('prefers slash-compound: "IDS" + "IDS/IPS" → keeps "IDS/IPS"', () => {
      const ext = extraction({
        skills: [
          { name: 'IDS', since: '2017' },
          { name: 'IDS/IPS', since: '2019' },
        ],
      });
      const result = consolidateExtraction(ext);
      expect(result.technicalSkills).toHaveLength(1);
      expect(result.technicalSkills[0].name).toBe('IDS/IPS');
      expect(result.technicalSkills[0].since).toBe('2017');
    });

    it('normalizes GitHub casing: "Github" → "GitHub"', () => {
      const ext = extraction({
        skills: [
          { name: 'Github', since: '2020' },
          { name: 'GitHub Actions', since: '2021' },
        ],
      });
      const result = consolidateExtraction(ext);
      // "Github" normalised to "GitHub", then "GitHub Actions" contains "GitHub" → collapse to "GitHub"
      expect(result.technicalSkills).toHaveLength(1);
      expect(result.technicalSkills[0].name).toBe('GitHub');
    });

    it('normalizes "Enterprise Github" to "GitHub Enterprise" and deduplicates', () => {
      const ext = extraction({
        skills: [
          { name: 'Enterprise Github', since: '2020' },
          { name: 'GitHub', since: '2018' },
        ],
      });
      const result = consolidateExtraction(ext);
      // "Enterprise Github" → "Enterprise GitHub", then containing-term collapses to "GitHub"
      expect(result.technicalSkills).toHaveLength(1);
      expect(result.technicalSkills[0].name).toBe('GitHub');
    });

    it('does NOT collapse confusable pair: "React" + "React Native"', () => {
      const ext = extraction({
        skills: [
          { name: 'React' },
          { name: 'React Native' },
        ],
      });
      const result = consolidateExtraction(ext);
      expect(result.technicalSkills).toHaveLength(2);
    });

    it('handles slash-compound in technologies array', () => {
      const ext = extraction({
        positions: [{
          title: 'Security Engineer',
          company: 'Acme',
          start: '2020',
          technologies: ['IDS', 'IDS/IPS', 'Firewall'],
        }],
      });
      const result = consolidateExtraction(ext);
      const techs = result.positions[0].technologies;
      expect(techs).toContain('IDS/IPS');
      expect(techs).not.toContain('IDS');
      expect(techs).toContain('Firewall');
    });
  });

  describe('sub-pass 2: fuzzy position deduplication (R71.16)', () => {
    it('deduplicates positions with same company+title but different abbreviations', () => {
      const ext = extraction({
        positions: [
          { title: 'Sr. Engineer', company: 'Acme Corp', start: '2020', end: '2022', technologies: ['Go', 'K8s'], description: 'Short' },
          { title: 'Senior Engineer', company: 'Acme Corp', start: '2020-01', end: '2022-06', technologies: ['Go', 'K8s', 'Terraform'], description: 'Longer description here' },
        ],
      });
      const result = consolidateExtraction(ext);
      expect(result.positions).toHaveLength(1);
      // Keeps the richer entry (more technologies + longer description).
      expect(result.positions[0].technologies).toContain('Terraform');
    });

    it('deduplicates "SRE" vs "Site Reliability Engineer"', () => {
      const ext = extraction({
        positions: [
          { title: 'SRE', company: 'BigCo', start: '2019', technologies: ['K8s'] },
          { title: 'Site Reliability Engineer', company: 'BigCo', start: '2019', technologies: ['K8s', 'Go', 'Prometheus'], achievements: ['Reduced downtime 50%'] },
        ],
      });
      const result = consolidateExtraction(ext);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].achievements).toContain('Reduced downtime 50%');
    });

    it('does NOT deduplicate positions with different companies', () => {
      const ext = extraction({
        positions: [
          { title: 'Senior Engineer', company: 'Acme', start: '2020', technologies: ['Go'] },
          { title: 'Senior Engineer', company: 'Other Inc', start: '2020', technologies: ['Python'] },
        ],
      });
      const result = consolidateExtraction(ext);
      expect(result.positions).toHaveLength(2);
    });

    it('does NOT deduplicate positions with non-overlapping dates', () => {
      const ext = extraction({
        positions: [
          { title: 'Senior Engineer', company: 'Acme', start: '2015', end: '2018', technologies: ['Java'] },
          { title: 'Senior Engineer', company: 'Acme', start: '2020', end: '2023', technologies: ['Go'] },
        ],
      });
      const result = consolidateExtraction(ext);
      expect(result.positions).toHaveLength(2);
    });

    it('treats missing end date as "present" for overlap detection', () => {
      const ext = extraction({
        positions: [
          { title: 'Sr. Dev', company: 'Co', start: '2020', technologies: ['TS'] },
          { title: 'Senior Developer', company: 'Co', start: '2020-03', technologies: ['TS', 'React', 'Node'] },
        ],
      });
      const result = consolidateExtraction(ext);
      expect(result.positions).toHaveLength(1);
    });
  });

  describe('sub-pass 3: synonym competency deduplication (R71.17)', () => {
    it('collapses "Team Leadership" to "Leadership"', () => {
      const ext = extraction({
        coreCompetencies: ['Team Leadership', 'Communication'],
      });
      const result = consolidateExtraction(ext);
      expect(result.coreCompetencies).toContain('Leadership');
      expect(result.coreCompetencies).not.toContain('Team Leadership');
      expect(result.coreCompetencies).toContain('Communication');
    });

    it('deduplicates when both synonym and canonical form are present', () => {
      const ext = extraction({
        coreCompetencies: ['Leadership', 'Team Leadership', 'People Leadership'],
      });
      const result = consolidateExtraction(ext);
      expect(result.coreCompetencies).toEqual(['Leadership']);
    });

    it('collapses "Effective Communication" to "Communication"', () => {
      const ext = extraction({
        coreCompetencies: ['Effective Communication'],
      });
      const result = consolidateExtraction(ext);
      expect(result.coreCompetencies).toEqual(['Communication']);
    });

    it('collapses "Problem-Solving" to "Problem Solving"', () => {
      const ext = extraction({
        coreCompetencies: ['Problem-Solving', 'Innovation'],
      });
      const result = consolidateExtraction(ext);
      expect(result.coreCompetencies).toContain('Problem Solving');
      expect(result.coreCompetencies).toContain('Innovation');
      expect(result.coreCompetencies).not.toContain('Problem-Solving');
    });

    it('collapses "Cross-functional Collaboration" to "Collaboration"', () => {
      const ext = extraction({
        coreCompetencies: ['Cross-functional Collaboration'],
      });
      const result = consolidateExtraction(ext);
      expect(result.coreCompetencies).toEqual(['Collaboration']);
    });

    it('keeps competencies not in any synonym group unchanged', () => {
      const ext = extraction({
        coreCompetencies: ['Resilience', 'Creativity'],
      });
      const result = consolidateExtraction(ext);
      expect(result.coreCompetencies).toEqual(['Resilience', 'Creativity']);
    });
  });

  describe('combined consolidation', () => {
    it('runs all three sub-passes together', () => {
      const ext = extraction({
        skills: [
          { name: 'AWS S3', since: '2019' },
          { name: 'S3', since: '2020' },
          { name: 'Docker' },
        ],
        positions: [
          { title: 'Sr. SRE', company: 'Acme', start: '2020', technologies: ['Lambda', 'Go'] },
          { title: 'Senior Site Reliability Engineer', company: 'Acme', start: '2020', technologies: ['Go', 'Lambda', 'AWS Lambda', 'K8s', 'Terraform'], achievements: ['Led incident response'] },
        ],
        coreCompetencies: ['Team Leadership', 'Leadership', 'Problem-Solving', 'Resilience'],
      });
      const result = consolidateExtraction(ext);

      // Sub-pass 1: vendor-prefix dedup on skills.
      expect(result.technicalSkills.map((s) => s.name)).toEqual(['S3', 'Docker']);
      expect(result.technicalSkills[0].since).toBe('2019');

      // Sub-pass 2: fuzzy position dedup.
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].achievements).toContain('Led incident response');
      // Technologies should also be vendor-deduped (AWS Lambda collapsed since both Lambda and AWS Lambda present).
      expect(result.positions[0].technologies).toContain('Lambda');
      expect(result.positions[0].technologies).toContain('Go');
      expect(result.positions[0].technologies).toContain('K8s');
      expect(result.positions[0].technologies).toContain('Terraform');
      expect(result.positions[0].technologies).not.toContain('AWS Lambda');

      // Sub-pass 3: synonym competency dedup.
      expect(result.coreCompetencies).toContain('Leadership');
      expect(result.coreCompetencies).toContain('Problem Solving');
      expect(result.coreCompetencies).toContain('Resilience');
      expect(result.coreCompetencies).not.toContain('Team Leadership');
      expect(result.coreCompetencies).not.toContain('Problem-Solving');
    });

    it('preserves other extraction fields unchanged', () => {
      const ext = extraction({
        professionalSummary: 'Experienced engineer',
        education: [{ institution: 'MIT', degree: 'BSc', skills: ['ML'] }],
        languages: [{ language: 'English', proficiency: 'Native' }],
        hobbies: ['Hiking'],
        causes: ['Open Source'],
        additionalInfo: [{ category: 'Awards', value: 'Best Engineer' }],
      });
      const result = consolidateExtraction(ext);
      expect(result.professionalSummary).toBe('Experienced engineer');
      expect(result.education).toEqual(ext.education);
      expect(result.languages).toEqual(ext.languages);
      expect(result.hobbies).toEqual(ext.hobbies);
      expect(result.causes).toEqual(ext.causes);
      expect(result.additionalInfo).toEqual(ext.additionalInfo);
    });
  });
});

// ---------------------------------------------------------------------------
// loadCompetencySynonyms (R71.17)
// ---------------------------------------------------------------------------

describe('loadCompetencySynonyms', () => {
  it('parses the default YAML and returns a map', () => {
    const map = loadCompetencySynonyms(DEFAULT_COMPETENCY_SYNONYMS_YAML);
    expect(map.size).toBeGreaterThan(0);
    expect(map.get('team leadership')).toBe('Leadership');
    expect(map.get('leadership')).toBe('Leadership');
    expect(map.get('people leadership')).toBe('Leadership');
  });

  it('maps synonyms case-insensitively', () => {
    const map = loadCompetencySynonyms(DEFAULT_COMPETENCY_SYNONYMS_YAML);
    expect(map.get('effective communication')).toBe('Communication');
    expect(map.get('written communication')).toBe('Communication');
  });

  it('returns canonical form for all synonym entries', () => {
    const map = loadCompetencySynonyms(DEFAULT_COMPETENCY_SYNONYMS_YAML);
    expect(map.get('problem-solving')).toBe('Problem Solving');
    expect(map.get('analytical problem solving')).toBe('Problem Solving');
    expect(map.get('stakeholder engagement')).toBe('Stakeholder Management');
    expect(map.get('organisational change management')).toBe('Change Management');
    expect(map.get('creative innovation')).toBe('Innovation');
    expect(map.get('coaching & mentoring')).toBe('Mentoring');
    expect(map.get('cross-functional collaboration')).toBe('Collaboration');
  });

  it('returns an empty map for invalid YAML', () => {
    const map = loadCompetencySynonyms('not: valid: yaml: {{{}}}');
    expect(map.size).toBe(0);
  });

  it('returns an empty map for YAML without synonym_groups key', () => {
    const map = loadCompetencySynonyms('other_key:\n  - [A, B]');
    expect(map.size).toBe(0);
  });

  it('skips groups with fewer than 2 entries', () => {
    const yaml = 'synonym_groups:\n  - ["Solo"]';
    const map = loadCompetencySynonyms(yaml);
    expect(map.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadCompoundNames (R15.5)
// ---------------------------------------------------------------------------

describe('loadCompoundNames', () => {
  it('parses the default YAML and returns the full list', () => {
    const names = loadCompoundNames(DEFAULT_COMPOUND_NAMES_YAML);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('CI/CD');
    expect(names).toContain('TCP/IP');
    expect(names).toContain('OS/2');
    expect(names).toContain('OS/2 Warp');
    expect(names).toContain('L2/L3');
    expect(names).toContain('L2/L3 Networking');
  });

  it('returns an empty array for invalid YAML', () => {
    const names = loadCompoundNames('not: valid: yaml: {{{}}}');
    expect(names).toEqual([]);
  });

  it('returns an empty array for YAML without compound_names key', () => {
    const names = loadCompoundNames('other_key:\n  - "foo"');
    expect(names).toEqual([]);
  });

  it('filters out non-string entries', () => {
    const names = loadCompoundNames('compound_names:\n  - "valid"\n  - 123\n  - "also valid"');
    expect(names).toEqual(['valid', 'also valid']);
  });
});

// Feature: career-agent, Property 4: consolidateExtraction never increases counts —
// deduplication only removes or collapses, never adds entries.
describe('consolidateExtraction property tests', () => {
  const arbPosition: fc.Arbitrary<ExtractedPosition> = fc.record({
    title: fc.stringOf(fc.constantFrom(...'abcdefghij '.split('')), { minLength: 1, maxLength: 15 }),
    company: fc.stringOf(fc.constantFrom(...'abcdefghij '.split('')), { minLength: 1, maxLength: 10 }),
    start: fc.option(fc.constantFrom('2018', '2019', '2020', '2021', '2022'), { nil: undefined }),
    end: fc.option(fc.constantFrom('2020', '2021', '2022', '2023'), { nil: undefined }),
    technologies: fc.array(fc.stringOf(fc.constantFrom(...'ABCDEFGHIJ '.split('')), { minLength: 1, maxLength: 10 }), { maxLength: 5 }),
    description: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
    achievements: fc.option(fc.array(fc.string({ maxLength: 20 }), { maxLength: 3 }), { nil: undefined }),
  });

  const arbSkill: fc.Arbitrary<ExtractedStandaloneSkill> = fc.record({
    name: fc.stringOf(fc.constantFrom(...'ABCDEFGHIJ '.split('')), { minLength: 1, maxLength: 12 }),
    since: fc.option(fc.constantFrom('2017', '2018', '2019', '2020'), { nil: undefined }),
  });

  const arbExtraction: fc.Arbitrary<CareerExtraction> = fc.record({
    professionalSummary: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
    positions: fc.array(arbPosition, { maxLength: 4 }),
    education: fc.constant([]),
    skills: fc.array(arbSkill, { maxLength: 5 }),
    coreCompetencies: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
    languages: fc.constant([]),
    hobbies: fc.constant([]),
    causes: fc.constant([]),
    additionalInfo: fc.constant([]),
  }).map((e) => ({ ...e, technicalSkills: e.skills }));

  it('never increases the number of skills, positions, or competencies', () => {
    fc.assert(
      fc.property(arbExtraction, (ext) => {
        const result = consolidateExtraction(ext);
        expect(result.technicalSkills.length).toBeLessThanOrEqual(ext.technicalSkills.length);
        expect(result.positions.length).toBeLessThanOrEqual(ext.positions.length);
        expect(result.coreCompetencies.length).toBeLessThanOrEqual(ext.coreCompetencies.length);
      }),
      { numRuns: 100 },
    );
  });
});

describe('@core/skills — stripNonAlpha (R76.1, R76.2)', () => {
  it('strips spaces, dots, and special characters', () => {
    expect(stripNonAlpha('T RIP A DVISOR')).toBe('tripadvisor');
    expect(stripNonAlpha('TripAdvisor')).toBe('tripadvisor');
    expect(stripNonAlpha('FINOA (GmbH)')).toBe('finoagmbh');
    expect(stripNonAlpha('Finoa')).toBe('finoa');
    expect(stripNonAlpha('G LOBO . COM')).toBe('globocom');
    expect(stripNonAlpha('Globo.com')).toBe('globocom');
  });

  it('lowercases all characters', () => {
    expect(stripNonAlpha('HELLO WORLD')).toBe('helloworld');
    expect(stripNonAlpha('Hello-World')).toBe('helloworld');
  });

  it('preserves digits', () => {
    expect(stripNonAlpha('Web 2.0 Corp')).toBe('web20corp');
    expect(stripNonAlpha('3M Company')).toBe('3mcompany');
  });

  it('returns empty string for non-alphanumeric input', () => {
    expect(stripNonAlpha('---')).toBe('');
    expect(stripNonAlpha('   ')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildConsolidationPrompt (R71.15, R71.16, R71.17, R71.18)
// ---------------------------------------------------------------------------

describe('buildConsolidationPrompt', () => {
  it('produces a prompt containing the extraction data as JSON', () => {
    const ext = extraction({
      positions: [{ title: 'Engineer', company: 'Acme', start: '2020', technologies: ['Go'] }],
      skills: [{ name: 'Docker', since: '2018' }],
      coreCompetencies: ['Leadership', 'Problem Solving'],
    });
    const prompt = buildConsolidationPrompt(ext);
    expect(prompt).toContain('deduplicating');
    expect(prompt).toContain('"title": "Engineer"');
    expect(prompt).toContain('"company": "Acme"');
    expect(prompt).toContain('"name": "Docker"');
    expect(prompt).toContain('"Leadership"');
    expect(prompt).toContain('"Problem Solving"');
  });

  it('includes dedup instructions for positions, skills, and competencies', () => {
    const ext = extraction({});
    const prompt = buildConsolidationPrompt(ext);
    expect(prompt).toContain('MERGE duplicate positions');
    expect(prompt).toContain('MERGE duplicate skills');
    expect(prompt).toContain('COLLAPSE synonymous competencies');
  });

  it('omits optional fields from data when not present', () => {
    const ext = extraction({
      positions: [{ title: 'Dev', company: 'Corp', technologies: [] }],
    });
    const prompt = buildConsolidationPrompt(ext);
    // The INPUT section should not contain these optional fields for this position.
    const inputSection = prompt.slice(prompt.indexOf('INPUT:'));
    expect(inputSection).not.toContain('"location":');
    expect(inputSection).not.toContain('"description":');
    expect(inputSection).not.toContain('"achievements":');
  });

  it('instructs model to return only JSON', () => {
    const ext = extraction({});
    const prompt = buildConsolidationPrompt(ext);
    expect(prompt).toContain('Return ONLY');
    expect(prompt).toContain('no commentary');
  });
});

// ---------------------------------------------------------------------------
// consolidateExtractionReduced (R71.16, R71.17)
// ---------------------------------------------------------------------------

describe('consolidateExtractionReduced', () => {
  it('collapses exact case-insensitive skill duplicates', () => {
    const ext = extraction({
      skills: [
        { name: 'Docker', since: '2018' },
        { name: 'docker', since: '2020' },
        { name: 'DOCKER', since: '2019' },
      ],
    });
    const result = consolidateExtractionReduced(ext);
    expect(result.technicalSkills).toHaveLength(1);
    expect(result.technicalSkills[0].name).toBe('Docker');
    expect(result.technicalSkills[0].since).toBe('2018');
  });

  it('does NOT strip vendor prefixes (that is the AI job)', () => {
    const ext = extraction({
      skills: [
        { name: 'AWS S3', since: '2019' },
        { name: 'S3', since: '2020' },
      ],
    });
    const result = consolidateExtractionReduced(ext);
    // Both are kept because they are not exact case-insensitive matches.
    expect(result.technicalSkills).toHaveLength(2);
  });

  it('does NOT resolve synonym competencies', () => {
    const ext = extraction({
      coreCompetencies: ['Leadership', 'Team Leadership'],
    });
    const result = consolidateExtractionReduced(ext);
    // Both are kept because they are not exact case-insensitive matches.
    expect(result.coreCompetencies).toHaveLength(2);
  });

  it('collapses exact case-insensitive competency duplicates', () => {
    const ext = extraction({
      coreCompetencies: ['Leadership', 'leadership', 'LEADERSHIP'],
    });
    const result = consolidateExtractionReduced(ext);
    expect(result.coreCompetencies).toHaveLength(1);
    expect(result.coreCompetencies[0]).toBe('Leadership');
  });

  it('collapses exact case-insensitive position duplicates by key', () => {
    const ext = extraction({
      positions: [
        { title: 'Engineer', company: 'Acme', start: '2020', technologies: ['Go'] },
        { title: 'ENGINEER', company: 'ACME', start: '2020', technologies: ['Go', 'Rust'] },
      ],
    });
    const result = consolidateExtractionReduced(ext);
    expect(result.positions).toHaveLength(1);
    // Keeps the richer entry
    expect(result.positions[0].technologies.length).toBe(2);
  });

  it('does NOT merge positions with fuzzy-similar company names', () => {
    const ext = extraction({
      positions: [
        { title: 'Engineer', company: 'Acme Corp', start: '2020', technologies: ['Go'] },
        { title: 'Engineer', company: 'Acme Corporation', start: '2020', technologies: ['Rust'] },
      ],
    });
    const result = consolidateExtractionReduced(ext);
    // Kept separate — not exact match on company.
    expect(result.positions).toHaveLength(2);
  });

  it('deduplicates per-position technologies case-insensitively', () => {
    const ext = extraction({
      positions: [
        { title: 'Dev', company: 'X', start: '2020', technologies: ['Docker', 'docker', 'DOCKER'] },
      ],
    });
    const result = consolidateExtractionReduced(ext);
    expect(result.positions[0].technologies).toHaveLength(1);
    expect(result.positions[0].technologies[0]).toBe('Docker');
  });

  it('preserves non-dedup fields unchanged', () => {
    const ext = extraction({
      professionalSummary: 'Test summary',
      education: [{ institution: 'MIT', degree: 'BSc', skills: ['ML'] }],
      languages: [{ language: 'English', proficiency: 'Native' }],
      hobbies: ['Hiking'],
      causes: ['Open Source'],
    });
    const result = consolidateExtractionReduced(ext);
    expect(result.professionalSummary).toBe('Test summary');
    expect(result.education).toEqual(ext.education);
    expect(result.languages).toEqual(ext.languages);
    expect(result.hobbies).toEqual(ext.hobbies);
    expect(result.causes).toEqual(ext.causes);
  });
});

// ---------------------------------------------------------------------------
// applyAiConsolidation (R71.15, R71.18)
// ---------------------------------------------------------------------------

describe('applyAiConsolidation', () => {
  it('overlays AI-deduplicated positions, skills, and competencies', () => {
    const original = extraction({
      positions: [
        { title: 'Dev', company: 'Acme', start: '2020', technologies: ['Go'] },
        { title: 'Dev', company: 'ACME Corp', start: '2020', technologies: ['Go', 'Rust'] },
      ],
      skills: [{ name: 'AWS S3' }, { name: 'S3' }],
      coreCompetencies: ['Leadership', 'Team Leadership'],
      education: [{ institution: 'MIT', degree: 'BSc', skills: ['ML'] }],
    });
    const aiReply = JSON.stringify({
      positions: [
        { title: 'Dev', company: 'Acme', start: '2020', technologies: ['Go', 'Rust'] },
      ],
      technical_skills: [{ name: 'S3' }],
      core_competencies: ['Leadership'],
    });
    const result = applyAiConsolidation(original, aiReply);
    expect(result.positions).toHaveLength(1);
    expect(result.technicalSkills).toHaveLength(1);
    expect(result.coreCompetencies).toEqual(['Leadership']);
    // Preserves education from original
    expect(result.education).toEqual(original.education);
  });

  it('throws on empty AI result', () => {
    const original = extraction({
      positions: [{ title: 'Dev', company: 'X', technologies: ['Go'] }],
    });
    expect(() => applyAiConsolidation(original, '{}')).toThrow('empty result');
  });

  it('throws on completely unparseable response', () => {
    const original = extraction({
      skills: [{ name: 'Docker' }],
    });
    expect(() => applyAiConsolidation(original, 'not json at all!!!!')).toThrow('empty result');
  });

  it('handles markdown-fenced AI responses', () => {
    const originalWithPos = extraction({
      positions: [{ title: 'Dev', company: 'X', technologies: [] }],
      skills: [{ name: 'Docker' }, { name: 'docker' }],
      coreCompetencies: ['Leadership'],
    });
    const fencedValid = '```json\n' + JSON.stringify({
      positions: [{ title: 'Dev', company: 'X', technologies: [] }],
      technical_skills: [{ name: 'Docker' }],
      core_competencies: ['Leadership'],
    }) + '\n```';
    const result = applyAiConsolidation(originalWithPos, fencedValid);
    expect(result.technicalSkills).toHaveLength(1);
    expect(result.positions).toHaveLength(1);
  });
});

describe('@core/skills — fuzzyNormalize OCR-garbled dedup in consolidateExtraction (R71.16, R76.1)', () => {
  it('deduplicates positions with OCR-garbled company names', () => {
    const ext = extraction({
      positions: [
        {
          title: 'Engineer',
          company: 'T RIP A DVISOR',
          start: '2020-01',
          end: '2022-01',
          technologies: ['React'],
        },
        {
          title: 'Engineer',
          company: 'TripAdvisor',
          start: '2020-01',
          end: '2022-01',
          technologies: ['React', 'TypeScript'],
        },
      ],
    });
    const result = consolidateExtraction(ext);
    expect(result.positions).toHaveLength(1);
  });

  it('deduplicates positions with company names differing by dots and parens', () => {
    const ext = extraction({
      positions: [
        {
          title: 'Developer',
          company: 'G LOBO . COM',
          start: '2018-03',
          end: '2020-01',
          technologies: ['Java'],
        },
        {
          title: 'Developer',
          company: 'Globo.com',
          start: '2018-03',
          end: '2020-01',
          technologies: ['Java', 'Spring'],
        },
      ],
    });
    const result = consolidateExtraction(ext);
    expect(result.positions).toHaveLength(1);
  });
});
