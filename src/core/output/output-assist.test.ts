// Unit tests for the Output_Engine `cv_tailoring` assist operation (task 25.2).

import { describe, it, expect, vi } from 'vitest';
import {
  asRoleSlug,
  asSkillId,
  asItemId,
  asDocId,
  type RolePreference,
  type ExtractedItem,
} from '@core/types';
import { generate, type SkillMap } from '@core/skills';
import {
  runAssist,
  type AssistTransport,
  type EgressDestination,
} from '@core/assist';
import type { ConfirmedEvidence } from './cv-model';
import {
  createCvTailoringOperation,
  CvTailoringOperation,
  parseTailoringNotes,
} from './output-assist';

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
  rationale: 'Estimated 80% match.',
  rank: 1,
  tag: 'exploring',
};

const EVIDENCE: ConfirmedEvidence = { skillMap: MAP, talkingPoints: [], items: [] };

describe('parseTailoringNotes', () => {
  it('parses one note per non-empty line, de-duplicated', () => {
    const notes = parseTailoringNotes('- Lead with impact\nLead with impact\n* Quantify results');
    expect(notes).toEqual(['Lead with impact', 'Quantify results']);
  });
});

describe('CvTailoringOperation — scriptOnly (R30.7)', () => {
  it('issues zero provider calls and returns the deterministic CV model', () => {
    const transport = vi.fn<AssistTransport>(async () => 'never');
    const op = createCvTailoringOperation(transport);

    const outcome = op.scriptOnly({ role: ROLE, evidence: EVIDENCE });

    expect(transport).not.toHaveBeenCalled();
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.baseline.targetRole.title).toBe('Backend Engineer');
    expect(outcome.baseline.skills.map((s) => s.name)).toContain('JavaScript');
  });
});

describe('CvTailoringOperation — aiAssisted (R22.6, R47.3)', () => {
  it('returns the deterministic CV model plus confirm-before-entry tailoring notes', async () => {
    const transport = vi.fn<AssistTransport>(
      async () => 'Lead with backend impact\nGroup cloud skills together',
    );
    const op = new CvTailoringOperation(transport);

    const outcome = await op.aiAssisted({ role: ROLE, evidence: EVIDENCE }, DEST);

    // The CV model is the SAME deterministic model — AI notes never replace it.
    expect(outcome.baseline.targetRole.title).toBe('Backend Engineer');
    expect(outcome.suggestions.map((s) => s.value)).toEqual([
      'Lead with backend impact',
      'Group cloud skills together',
    ]);
    expect(outcome.suggestions.every((s) => s.requiresConfirmation === true)).toBe(true);
  });
});

describe('CvTailoringOperation — provider failure fallback (runAssist)', () => {
  it('falls back to the deterministic CV model with a non-blocking error', async () => {
    const transport = vi.fn<AssistTransport>(async () => {
      throw new Error('429 rate limited');
    });
    const op = createCvTailoringOperation(transport);

    const { outcome, error } = await runAssist(
      op,
      { role: ROLE, evidence: EVIDENCE },
      { mode: 'ai-assisted', capability: 'cv_tailoring' },
      DEST,
    );

    expect(outcome.baseline.targetRole.title).toBe('Backend Engineer');
    expect(outcome.suggestions).toEqual([]);
    expect(error?.capability).toBe('cv_tailoring');
    expect(error?.message).toContain('429');
  });
});
