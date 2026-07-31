// Unit tests for CV tailoring full ATS output (task 41.12).

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
import type { ConfirmedEvidence } from './cv-model';
import { buildCvModel } from './cv-model';
import {
  parseCvDraft,
  buildCvTailoringPrompt,
} from './output-assist';
import { buildTailoringPayload, targetOpportunity } from './tailoring';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEST: EgressDestination = { provider: 'openai', kind: 'keyed-cloud' };

const skillItem = (id: string, name: string): ExtractedItem =>
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



const MAP: SkillMap = generate([skillItem('doc.md#a', 'TypeScript')]);

const ROLE: RolePreference = {
  slug: asRoleSlug('devops-engineer'),
  title: 'DevOps Engineer',
  description: 'Manages infrastructure.',
  matchScore: 85,
  matchedSkills: [asSkillId('SKILL-typescript')],
  gapSkills: [],
  rationale: 'Good fit.',
  rank: 1,
  tag: 'exploring',
};

const educationItem: ExtractedItem = {
  id: asItemId('edu-001'),
  type: 'education',
  fields: {
    degree: 'MSc Computer Science',
    institution: 'MIT',
    start: '2014-09',
    end: '2016-06',
  },
  confidence: 'High',
  provenance: [],
  userConfirmed: true,
  private: false,
  sourceDoc: asDocId('doc.md'),
} as unknown as ExtractedItem;

const employmentItem: ExtractedItem = {
  id: asItemId('emp-001'),
  type: 'employment',
  fields: {
    title: 'Senior DevOps Engineer',
    employer: 'Acme Corp',
    start: '2019-01',
    end: '2023-06',
    technologies: ['Kubernetes', 'Terraform'],
    achievements: ['Reduced deploy time by 60%'],
  },
  confidence: 'High',
  provenance: [],
  userConfirmed: true,
  private: false,
  sourceDoc: asDocId('doc.md'),
} as unknown as ExtractedItem;

const competencyItem: ExtractedItem = {
  id: asItemId('comp-001'),
  type: 'core_competency',
  fields: { name: 'Infrastructure Automation' },
  confidence: 'High',
  provenance: [],
  userConfirmed: true,
  private: false,
  sourceDoc: asDocId('doc.md'),
} as unknown as ExtractedItem;

const summaryItem: ExtractedItem = {
  id: asItemId('summ-001'),
  type: 'professional_summary',
  fields: { text: 'Experienced infrastructure engineer.' },
  confidence: 'High',
  provenance: [],
  userConfirmed: true,
  private: false,
  sourceDoc: asDocId('doc.md'),
} as unknown as ExtractedItem;

const EVIDENCE_WITH_ITEMS: ConfirmedEvidence = {
  skillMap: MAP,
  talkingPoints: [],
  items: [educationItem, employmentItem, competencyItem, summaryItem],
  header: { name: 'Jane Doe', contact: ['jane@example.com', '+1-555-0123'] },
};

// ---------------------------------------------------------------------------
// buildCvTailoringPrompt
// ---------------------------------------------------------------------------

describe('buildCvTailoringPrompt', () => {
  const model = buildCvModel(ROLE, EVIDENCE_WITH_ITEMS);

  it('includes "complete ATS-formatted CV draft in Markdown" instruction', () => {
    const prompt = buildCvTailoringPrompt(model, EVIDENCE_WITH_ITEMS);
    expect(prompt).toContain('complete ATS-formatted CV draft in Markdown');
  });

  it('includes confirmed career data: positions section', () => {
    const prompt = buildCvTailoringPrompt(model, EVIDENCE_WITH_ITEMS);
    expect(prompt).toContain('- Positions:');
  });

  it('includes confirmed career data: competencies section', () => {
    const prompt = buildCvTailoringPrompt(model, EVIDENCE_WITH_ITEMS);
    expect(prompt).toContain('Core competencies:');
  });

  it('includes confirmed career data: education section', () => {
    const prompt = buildCvTailoringPrompt(model, EVIDENCE_WITH_ITEMS);
    expect(prompt).toContain('- Education:');
  });

  it('includes confirmed career data: skills section', () => {
    const prompt = buildCvTailoringPrompt(model, EVIDENCE_WITH_ITEMS);
    expect(prompt).toContain('- Skills:');
  });

  it('includes explicit No-Fabrication instruction ("Do NOT invent")', () => {
    const prompt = buildCvTailoringPrompt(model, EVIDENCE_WITH_ITEMS);
    expect(prompt).toContain('Do NOT invent');
  });

  it('with evidence containing education items: education is present in prompt', () => {
    const prompt = buildCvTailoringPrompt(model, EVIDENCE_WITH_ITEMS);
    expect(prompt).toContain('MSc Computer Science');
  });

  it('with name/contact in header: prompt contains "- Name:" and "- Contact:"', () => {
    const prompt = buildCvTailoringPrompt(model, EVIDENCE_WITH_ITEMS);
    expect(prompt).toContain('- Name:');
    expect(prompt).toContain('Jane Doe');
    expect(prompt).toContain('- Contact:');
    expect(prompt).toContain('jane@example.com');
  });
});

// ---------------------------------------------------------------------------
// parseCvDraft
// ---------------------------------------------------------------------------

describe('parseCvDraft', () => {
  it('strips code fences from input', () => {
    const input = 'preamble\n```markdown\n# Professional CV\nExperienced engineer with cloud skills.\n```';
    const result = parseCvDraft(input);
    expect(result).toBeDefined();
    expect(result!.markdown).toBe('# Professional CV\nExperienced engineer with cloud skills.');
    expect(result!.summary).toBe('Professional CV');
  });

  it('strips preamble text before the first heading', () => {
    const input = 'Here is the draft:\n# Professional Summary\nExperienced engineer with expertise.';
    const result = parseCvDraft(input);
    expect(result).toBeDefined();
    expect(result!.markdown).toContain('# Professional Summary');
    expect(result!.markdown).not.toContain('Here is the draft:');
  });

  it('returns undefined for short input (< 20 chars)', () => {
    const input = 'short';
    const result = parseCvDraft(input);
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseCvDraft('')).toBeUndefined();
  });

  it('handles input with no code fences and no preamble', () => {
    const input = '# DevOps Engineer CV\n\nExperienced infrastructure professional with 10+ years.';
    const result = parseCvDraft(input);
    expect(result).toBeDefined();
    expect(result!.markdown).toContain('# DevOps Engineer CV');
  });
});

// ---------------------------------------------------------------------------
// buildTailoringPayload (with Target Opportunity)
// ---------------------------------------------------------------------------

describe('buildTailoringPayload', () => {
  it('includes "TAILORING TARGET ONLY" and confirmed career data', () => {
    const opp = targetOpportunity('pasted', 'We are looking for a DevOps Engineer...');
    const payload = buildTailoringPayload(EVIDENCE_WITH_ITEMS, opp, DEST);
    expect(payload).toContain('TAILORING TARGET ONLY');
    expect(payload).toContain('Confirmed career data:');
  });

  it('includes the Target Opportunity text in the payload', () => {
    const opp = targetOpportunity('pasted', 'Join our team as a Senior DevOps Engineer.');
    const payload = buildTailoringPayload(EVIDENCE_WITH_ITEMS, opp, DEST);
    expect(payload).toContain('Join our team as a Senior DevOps Engineer.');
  });

  it('includes No-Fabrication instruction', () => {
    const opp = targetOpportunity('pasted', 'DevOps role');
    const payload = buildTailoringPayload(EVIDENCE_WITH_ITEMS, opp, DEST);
    expect(payload).toContain('Do NOT invent');
  });

  it('includes career data sections: positions, skills, education', () => {
    const opp = targetOpportunity('pasted', 'DevOps role');
    const payload = buildTailoringPayload(EVIDENCE_WITH_ITEMS, opp, DEST);
    expect(payload).toContain('- Positions:');
    expect(payload).toContain('- Skills:');
    expect(payload).toContain('- Education:');
  });
});
