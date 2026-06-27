// Unit tests for session resume + the outstanding-items summary (R35.1).
//
// These exercise the pure core of task 17.2: `computeOutstanding` (the R35.1
// union — unanswered questions, flagged talking points, unreviewed skill
// entries, unresolved conflicts), `resumePhaseOf` (continue-from-last), and
// `summariseSession` (which also folds in the resume-time state-healing pass,
// R36). All inputs use the real domain types.

import { describe, expect, it } from 'vitest';

import {
  computeOutstanding,
  resumePhaseOf,
  summariseSession,
  type PhaseStatus,
  type ResumeStoreState,
} from './resume';
import type { Phase } from './phases';
import type { InterviewFile } from '@core/interview';
import type {
  ConflictRecord,
  Question,
  SkillMapEntry,
  StarAnswer,
  TalkingPoint,
} from '@core/types';
import {
  asDocId,
  asISODate,
  asQuestionId,
  asRoleSlug,
  asSkillId,
  asStarId,
} from '@core/types';

// --- builders ---------------------------------------------------------------

const question = (id: string): Question => ({
  id: asQuestionId(id),
  category: 'behavioural',
  starFramed: true,
  prompt: `Prompt for ${id}`,
});

const answer = (qid: string, status: StarAnswer['status'], flags: StarAnswer['flags'] = []): StarAnswer => ({
  questionId: asQuestionId(qid),
  flags,
  status,
});

const interview = (overrides: Partial<InterviewFile> = {}): InterviewFile => ({
  roleSlug: asRoleSlug('staff-engineer'),
  roleTitle: 'Staff Engineer',
  questions: [question('Q-01'), question('Q-02')],
  ...overrides,
});

const skill = (id: string, name: string): SkillMapEntry => ({
  id: asSkillId(id),
  name,
  category: 'Technical',
  proficiencySignal: 'Evidence-based: 1 source.',
  evidence: [],
  recency: asISODate('2024-01-01'),
});

const talkingPoint = (id: string, flags: TalkingPoint['flags'], retired = false): TalkingPoint => ({
  id: asStarId(id),
  flags,
  polished: `Polished ${id}`,
  skills: [],
  ...(retired ? { retired: true } : {}),
});

const conflict = (field: string, resolved: boolean): ConflictRecord => ({
  field,
  candidates: [{ value: 'a', doc: asDocId('DOC-1') }, { value: 'b', doc: asDocId('DOC-2') }],
  recommended: 'a',
  ...(resolved
    ? { resolved: { value: 'a', by: 'user' as const, at: asISODate('2024-02-02') } }
    : {}),
});

const baseState = (overrides: Partial<ResumeStoreState> = {}): ResumeStoreState => ({
  storeFiles: [],
  skills: [],
  interviews: [],
  conflicts: [],
  ...overrides,
});

// --- computeOutstanding -----------------------------------------------------

describe('computeOutstanding — the R35.1 union', () => {
  it('returns an empty union for an empty store', () => {
    expect(computeOutstanding(baseState())).toEqual([]);
  });

  it('flags every interview question that is not complete or passed', () => {
    const file = interview({
      questions: [question('Q-01'), question('Q-02'), question('Q-03'), question('Q-04')],
      responses: [
        answer('Q-01', 'complete'),
        answer('Q-02', 'passed'),
        answer('Q-03', 'in_progress'),
        // Q-04 has no response at all → unanswered.
      ],
    });
    const out = computeOutstanding(baseState({ interviews: [file] }));
    const questions = out.filter((i) => i.kind === 'unanswered-question');
    expect(questions.map((i) => i.ref)).toEqual(['Q-03', 'Q-04']);
    expect(questions.find((i) => i.ref === 'Q-03')?.reason).toBe('in_progress');
    expect(questions.find((i) => i.ref === 'Q-04')?.reason).toBe('unanswered');
  });

  it('surfaces a Soft-Closed answer as an outstanding (flagged) question (Property 16)', () => {
    const file = interview({
      questions: [question('Q-01')],
      responses: [answer('Q-01', 'soft_closed', ['needs_metric'])],
    });
    const out = computeOutstanding(baseState({ interviews: [file] }));
    const item = out.find((i) => i.kind === 'unanswered-question' && i.ref === 'Q-01');
    expect(item?.reason).toBe('flagged');
    expect(item?.flags).toEqual(['needs_metric']);
  });

  it('surfaces flagged talking points but skips clean and retired ones', () => {
    const file = interview({
      questions: [],
      talkingPoints: [
        talkingPoint('STAR-01', ['needs_metric']),
        talkingPoint('STAR-02', []), // no flags → not outstanding
        talkingPoint('STAR-03', ['needs_action'], true), // retired → not outstanding
      ],
    });
    const out = computeOutstanding(baseState({ interviews: [file] }));
    const tps = out.filter((i) => i.kind === 'flagged-talking-point');
    expect(tps.map((i) => i.ref)).toEqual(['STAR-01']);
    expect(tps[0].flags).toEqual(['needs_metric']);
  });

  it('treats only un-reviewed skill entries as outstanding', () => {
    const skills = [skill('SKILL-a', 'Rust'), skill('SKILL-b', 'Go'), skill('SKILL-c', 'SQL')];
    const out = computeOutstanding(
      baseState({ skills, reviewedSkillIds: new Set(['SKILL-b']) }),
    );
    const unreviewed = out.filter((i) => i.kind === 'unreviewed-skill');
    expect(unreviewed.map((i) => i.ref)).toEqual(['SKILL-a', 'SKILL-c']);
  });

  it('treats all skills as unreviewed when no review set is given', () => {
    const out = computeOutstanding(baseState({ skills: [skill('SKILL-a', 'Rust')] }));
    expect(out.filter((i) => i.kind === 'unreviewed-skill').map((i) => i.ref)).toEqual([
      'SKILL-a',
    ]);
  });

  it('surfaces only unresolved conflicts', () => {
    const out = computeOutstanding(
      baseState({ conflicts: [conflict('title', false), conflict('email', true)] }),
    );
    const conflicts = out.filter((i) => i.kind === 'unresolved-conflict');
    expect(conflicts.map((i) => i.ref)).toEqual(['title']);
  });

  it('produces the union across all four sources in a stable order', () => {
    const state = baseState({
      interviews: [
        interview({
          questions: [question('Q-01')],
          responses: [answer('Q-01', 'in_progress')],
          talkingPoints: [talkingPoint('STAR-01', ['needs_task'])],
        }),
      ],
      skills: [skill('SKILL-a', 'Rust')],
      reviewedSkillIds: new Set<string>(),
      conflicts: [conflict('title', false)],
    });
    const out = computeOutstanding(state);
    expect(out.map((i) => i.kind)).toEqual([
      'unanswered-question',
      'flagged-talking-point',
      'unreviewed-skill',
      'unresolved-conflict',
    ]);
  });
});

// --- resumePhaseOf (continue-from-last) -------------------------------------

describe('resumePhaseOf — continue-from-last (R35.1)', () => {
  const allPending: Record<Phase, PhaseStatus> = {
    ingest: 'pending',
    'skill-map': 'pending',
    'role-discovery': 'pending',
    'interview-coaching': 'pending',
    output: 'pending',
    memory: 'pending',
  };

  it('honours an explicit lastPhase', () => {
    expect(resumePhaseOf(baseState({ lastPhase: 'role-discovery' }), allPending)).toBe(
      'role-discovery',
    );
  });

  it('falls back to the initial phase when nothing has started', () => {
    expect(resumePhaseOf(baseState(), allPending)).toBe('ingest');
  });

  it('picks the furthest non-pending phase when no lastPhase is given', () => {
    const states: Record<Phase, PhaseStatus> = {
      ...allPending,
      ingest: 'complete',
      'skill-map': 'in-progress',
    };
    expect(resumePhaseOf(baseState(), states)).toBe('skill-map');
  });
});

// --- summariseSession -------------------------------------------------------

describe('summariseSession', () => {
  it('assembles phase statuses, the outstanding union, resume point, and a healing report', () => {
    const summary = summariseSession(
      baseState({
        skills: [skill('SKILL-a', 'Rust')],
        reviewedSkillIds: new Set<string>(),
      }),
    );
    expect(summary.healingReport.ok).toBe(true);
    expect(summary.phaseStates['skill-map']).toBe('in-progress');
    expect(summary.outstanding.some((i) => i.kind === 'unreviewed-skill')).toBe(true);
    // skill-map is the furthest non-pending phase → resume there.
    expect(summary.resumePhase).toBe('skill-map');
  });

  it('lets the reader override a derived phase status', () => {
    const summary = summariseSession(
      baseState({
        skills: [skill('SKILL-a', 'Rust')],
        reviewedSkillIds: new Set(['SKILL-a']),
        phaseStates: { 'role-discovery': 'in-progress' },
      }),
    );
    expect(summary.phaseStates['skill-map']).toBe('complete'); // all reviewed
    expect(summary.phaseStates['role-discovery']).toBe('in-progress'); // override
  });

  it('reports an empty store as fully pending and resuming at ingest', () => {
    const summary = summariseSession(baseState());
    expect(Object.values(summary.phaseStates).every((s) => s === 'pending')).toBe(true);
    expect(summary.outstanding).toEqual([]);
    expect(summary.resumePhase).toBe('ingest');
  });
});
