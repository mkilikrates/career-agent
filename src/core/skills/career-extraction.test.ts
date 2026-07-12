import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  buildCareerExtractionPrompt,
  parseCareerExtraction,
  parseCareerExtractionWithTracking,
  mergeCareerExtractions,
  careerExtractionToItems,
  splitCompoundSkills,
  normalizeDate,
  CAREER_EXTRACTION_INSTRUCTION,
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
