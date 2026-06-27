// Unit tests for the Career_Agent re-entry triggers (task 17.3, R35.3–R35.5).
//
// These exercise the pure re-entry logic in isolation from the statechart: the
// local job-posting parser, the parse → score → propose matching pipeline
// (R35.3), the Requirement-9 document merge (R35.4), and the post-interview
// debrief (R35.5). No provider, no statechart — just the deterministic core.

import { describe, expect, it } from 'vitest';
import {
  asDocId,
  asISODate,
  asItemId,
  asQuestionId,
  asRoleSlug,
  asSkillId,
  type ExtractedItem,
  type SkillMapEntry,
  type StarAnswer,
} from '@core/types';
import { sourceLine } from '@core/provenance';
import { buildReferenceGraph } from '@core/registry';
import { IdRegistry } from '@core/registry';
import type { SkillMap } from '@core/skills';
import type { ConfirmedEvidence } from '@core/output';
import type { ExtractedDoc } from '@core/ingestion';
import {
  DEFAULT_JOB_POSTING_PARSER,
  matchJobPosting,
  mergeDocument,
  parseJobPosting,
  processDebrief,
} from './re-entry';

const skillEntry = (id: string, name: string): SkillMapEntry => ({
  id: asSkillId(id),
  name,
  category: 'Technical',
  proficiencySignal: 'Evidence-based.',
  evidence: [],
  recency: asISODate('2024-01-01'),
});

const mapOf = (entries: SkillMapEntry[]): SkillMap => ({
  entries,
  graph: buildReferenceGraph({ skills: entries }),
});

const evidenceWith = (entries: SkillMapEntry[]): ConfirmedEvidence => ({
  skillMap: mapOf(entries),
});

// --- R35.3: parsing --------------------------------------------------------

describe('parseJobPosting (R35.3)', () => {
  it('uses the first line as the title and buckets required vs preferred skills', () => {
    const posting = parseJobPosting(
      [
        'Senior Backend Engineer',
        'Required:',
        '- JavaScript',
        '- SQL Database',
        'Preferred:',
        '- TypeScript',
      ].join('\n'),
    );
    expect(posting.title).toBe('Senior Backend Engineer');
    expect(posting.requiredSkills).toEqual(['JavaScript', 'SQL Database']);
    expect(posting.preferredSkills).toEqual(['TypeScript']);
  });

  it('splits inline comma/and-separated lists and dedupes', () => {
    const posting = parseJobPosting(
      'Data Engineer\nRequired: Python, SQL and Airflow\nPreferred: Python',
    );
    expect(posting.requiredSkills).toEqual(['Python', 'SQL', 'Airflow']);
    // Python is not duplicated even though it appears twice.
    expect(posting.preferredSkills).toEqual(['Python']);
  });

  it('defaults un-headed skill lines to required', () => {
    const posting = parseJobPosting('Engineer\nGo\nRust');
    expect(posting.requiredSkills).toEqual(['Go', 'Rust']);
    expect(posting.preferredSkills).toEqual([]);
  });

  it('the default parser delegates to parseJobPosting', () => {
    const text = 'Engineer\nRequired: Go';
    expect(DEFAULT_JOB_POSTING_PARSER.parse(text)).toEqual(parseJobPosting(text));
  });
});

// --- R35.3: matching + CV proposal -----------------------------------------

describe('matchJobPosting (R35.3)', () => {
  it('scores ontologically against the map, lists gaps, and proposes a tailored CV', () => {
    const evidence = evidenceWith([
      skillEntry('SKILL-javascript', 'JavaScript'),
      skillEntry('SKILL-postgresql', 'PostgreSQL'),
    ]);
    const match = matchJobPosting(
      {
        title: 'Backend Engineer',
        description: 'Backend Engineer',
        requiredSkills: ['JavaScript', 'SQL Database', 'Kubernetes'],
        preferredSkills: [],
      },
      evidence,
    );

    expect(match.slug).toBe('backend-engineer');
    // PostgreSQL ontologically satisfies "SQL Database" (R20.3); JavaScript matches directly.
    expect(match.matchedSkills.map(String).sort()).toEqual([
      'SKILL-javascript',
      'SKILL-postgresql',
    ]);
    // Kubernetes is the only unmet required skill → the single gap.
    expect(match.gapSkills.map(String)).toEqual(['Kubernetes']);
    expect(match.score.estimated).toBe(true);
    expect(match.score.scoreLabel).toContain('Estimated');
    // The CV is tailored to the posting and surfaces the confirmed skills.
    expect(match.proposedCv.targetRole.slug).toBe(asRoleSlug('backend-engineer'));
    expect(match.proposedCv.skills.map((s) => s.name).sort()).toEqual([
      'JavaScript',
      'PostgreSQL',
    ]);
  });

  it('marks matched skills target-relevant on the proposed CV (R30.2)', () => {
    const evidence = evidenceWith([skillEntry('SKILL-javascript', 'JavaScript')]);
    const match = matchJobPosting(
      {
        title: 'JS Dev',
        description: 'JS Dev',
        requiredSkills: ['JavaScript'],
        preferredSkills: [],
      },
      evidence,
    );
    const js = match.proposedCv.skills.find((s) => s.name === 'JavaScript');
    expect(js?.targetRelevant).toBe(true);
  });
});

// --- R35.4: new-document merge ---------------------------------------------

describe('mergeDocument (R35.4: Requirement 9 merge)', () => {
  const employment = (employer: string, title: string, start: string): ExtractedItem => ({
    id: asItemId(`${employer}-${title}`),
    type: 'employment',
    fields: { employer, title, start },
    confidence: 'High',
    provenance: [sourceLine(asDocId('cv.pdf'), 1, title)],
    userConfirmed: false,
    private: false,
    sourceDoc: asDocId('cv.pdf'),
  });

  it('merges same-role items and records the differing field as a conflict (R9.1, R9.2)', () => {
    const existing: ExtractedDoc[] = [
      {
        docId: asDocId('old.pdf'),
        date: asISODate('2023-01-01'),
        items: [employment('Acme', 'Engineer', '2020-01')],
      },
    ];
    const incoming: ExtractedDoc = {
      docId: asDocId('new.pdf'),
      date: asISODate('2024-01-01'),
      items: [employment('Acme', 'Staff Engineer', '2020-01')],
    };

    const result = mergeDocument(existing, incoming);

    expect(result.merged).toHaveLength(1);
    const titleConflict = result.conflicts.find((c) => c.field.endsWith('::title'));
    expect(titleConflict).toBeDefined();
    // The more recent document's value is the default recommendation (R9.3).
    expect(titleConflict?.recommended).toBe('Staff Engineer');
  });

  it('passes non-conflicting documents straight through', () => {
    const result = mergeDocument([], {
      docId: asDocId('new.pdf'),
      items: [employment('Beta', 'Designer', '2021-05')],
    });
    expect(result.merged).toHaveLength(1);
    expect(result.conflicts).toEqual([]);
  });
});

// --- R35.5: post-interview debrief -----------------------------------------

describe('processDebrief (R35.5)', () => {
  const answer = (
    questionId: string,
    overrides: Partial<StarAnswer> = {},
  ): StarAnswer => ({
    questionId: asQuestionId(questionId),
    situation: 'a production incident occurred',
    task: 'I needed to restore the service',
    action: 'I reverted the faulty deployment',
    result: 'service recovered in ten minutes',
    flags: [],
    status: 'complete',
    ...overrides,
  });

  it('refines each reported answer into a confirmed talking point with a minted id (R28)', () => {
    const registry = new IdRegistry();
    const result = processDebrief(
      {
        roleSlug: asRoleSlug('backend-engineer'),
        answers: [
          { answer: answer('Q-01'), skills: [asSkillId('SKILL-javascript')] },
          { answer: answer('Q-02'), skills: [asSkillId('SKILL-javascript')] },
        ],
      },
      mapOf([skillEntry('SKILL-javascript', 'JavaScript')]),
      registry,
    );

    expect(result.talkingPoints).toHaveLength(2);
    expect(result.talkingPoints.map((tp) => String(tp.id))).toEqual(['STAR-01', 'STAR-02']);
    // Both answers are complete → no gaps, and the only skill is already in the map.
    expect(result.gaps).toEqual([]);
    expect(result.skillDelta.candidates).toEqual([]);
  });

  it('notes flagged answers as gaps and surfaces revealed skills unapplied (R25.1, R29)', () => {
    const result = processDebrief(
      {
        roleSlug: asRoleSlug('backend-engineer'),
        answers: [
          {
            answer: answer('Q-03', { result: '', flags: ['needs_metric'], status: 'soft_closed' }),
            skills: [asSkillId('SKILL-kubernetes')],
          },
        ],
      },
      mapOf([skillEntry('SKILL-javascript', 'JavaScript')]),
      new IdRegistry(),
    );

    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].questionId).toBe(asQuestionId('Q-03'));
    expect(result.gaps[0].flags).toEqual(['needs_metric']);
    // Kubernetes is referenced by the talking point but absent from the map → a candidate.
    expect(result.skillDelta.candidates.map((c) => String(c.skill))).toEqual(['SKILL-kubernetes']);
  });

  it('carries forward an existing interview file when detecting gaps', () => {
    const registry = new IdRegistry();
    const result = processDebrief(
      {
        roleSlug: asRoleSlug('backend-engineer'),
        roleTitle: 'Backend Engineer',
        answers: [{ answer: answer('Q-01'), skills: [asSkillId('SKILL-graphql')] }],
        interview: {
          roleSlug: asRoleSlug('backend-engineer'),
          roleTitle: 'Backend Engineer',
          questions: [],
        },
      },
      mapOf([skillEntry('SKILL-javascript', 'JavaScript')]),
      registry,
    );
    expect(result.skillDelta.candidates.map((c) => String(c.skill))).toEqual(['SKILL-graphql']);
  });
});
