import { describe, it, expect } from 'vitest';
import type { ExtractedItem, RolePreference, StarAnswer } from '@core/types';
import { asISODate, asQuestionId, asRoleSlug, asSkillId, asSkillTerm } from '@core/types';
import { generate } from '@core/skills';
import { interviewPath } from '@core/storage';
import {
  generateQuestions,
  buildInterview,
  serializeInterview,
  parseInterview,
  saveInterview,
  withResponse,
  withTalkingPoint,
  withQuestions,
  flaggedResponses,
  resumeState,
  refine,
  confirmTalkingPoint,
  retire,
} from './index';
import { IdRegistry } from '@core/registry';

const skill = (id: string, name: string): ExtractedItem =>
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

const map = generate(
  [skill('i1', 'TypeScript'), skill('i2', 'JavaScript'), skill('i3', 'PostgreSQL')],
  { asOf: asISODate('2024-05-01') },
);

const role: RolePreference = {
  slug: asRoleSlug('backend-engineer'),
  title: 'Backend Engineer',
  description: 'Build server-side services.',
  matchScore: 80,
  matchedSkills: [asSkillId('SKILL-typescript'), asSkillId('SKILL-javascript')],
  gapSkills: [asSkillTerm('Kubernetes')],
  rationale: 'Strong match.',
  rank: 1,
  tag: 'actively_applying',
};

describe('generateQuestions — role-grounded STAR questions (R22.1, R22.2)', () => {
  it('produces one behavioural STAR question per matched core skill', () => {
    const questions = generateQuestions(role, map);
    const behavioural = questions.filter((q) => q.category === 'behavioural');
    expect(behavioural).toHaveLength(role.matchedSkills.length);
    // Each behavioural question is grounded in a matched skill and STAR-framed.
    expect(behavioural.map((q) => q.skill)).toEqual(role.matchedSkills);
    for (const q of behavioural) {
      expect(q.starFramed).toBe(true);
      expect(q.prompt).toMatch(/Situation/);
      expect(q.prompt).toMatch(/Result/);
    }
    // Grounded in the user's own phrasing from the skill map (R22.1).
    expect(behavioural[0].prompt).toContain('TypeScript');
    expect(behavioural[1].prompt).toContain('JavaScript');
  });

  it('produces exactly one gap question targeting an identified gap (R22.2)', () => {
    const gaps = generateQuestions(role, map).filter((q) => q.category === 'gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].gap).toBe(asSkillTerm('Kubernetes'));
    expect(gaps[0].starFramed).toBe(true);
    expect(gaps[0].prompt).toContain('Kubernetes');
  });

  it('produces exactly one professional motivation question (R22.2)', () => {
    const motivation = generateQuestions(role, map).filter(
      (q) => q.category === 'motivation',
    );
    expect(motivation).toHaveLength(1);
    expect(motivation[0].skill).toBeUndefined();
    expect(motivation[0].gap).toBeUndefined();
    expect(motivation[0].prompt).toContain('Backend Engineer');
  });

  it('assigns stable sequential per-role question ids', () => {
    const ids = generateQuestions(role, map).map((q) => String(q.id));
    expect(ids).toEqual(['Q-01', 'Q-02', 'Q-03', 'Q-04']);
  });

  it('omits the gap question when the role has no identified gap', () => {
    const noGap: RolePreference = { ...role, gapSkills: [] };
    const questions = generateQuestions(noGap, map);
    expect(questions.filter((q) => q.category === 'gap')).toHaveLength(0);
    // 2 behavioural + 1 motivation.
    expect(questions).toHaveLength(3);
  });

  it('is deterministic for a fixed role + map', () => {
    expect(generateQuestions(role, map)).toEqual(generateQuestions(role, map));
  });
});

describe('interview file persistence (R22.3, R34.2)', () => {
  it('round-trips through interview_[role_slug].md', () => {
    const file = buildInterview(role, map);
    const md = serializeInterview(file);
    const parsed = parseInterview(md);
    expect(parsed).toEqual(file);
    // Fixpoint: re-serializing the parsed file reproduces the same Markdown.
    expect(serializeInterview(parsed)).toBe(md);
  });

  it('mirrors question ids and the owning role into frontmatter', () => {
    const md = serializeInterview(buildInterview(role, map));
    expect(md).toContain('# Interview');
    expect(md).toContain('## Questions');
    expect(md).toContain('Q-01');
    expect(md).toContain('backend-engineer');
    expect(md).toContain('Backend Engineer');
  });

  it('saves to the canonical per-role interview path (R22.3)', async () => {
    const writes: Record<string, string> = {};
    const writer = { write: (p: never, d: string) => void (writes[String(p)] = d) };
    const file = buildInterview(role, map);
    const path = await saveInterview(writer, file);
    expect(path).toBe(interviewPath(role.slug));
    expect(writes[String(interviewPath(role.slug))]).toContain('## Questions');
  });
});

describe('interview file with responses & mid-question state (R24, R25)', () => {
  const detail = 'a sufficiently detailed answer here';

  const inProgress: StarAnswer = {
    questionId: asQuestionId('Q-01'),
    situation: detail,
    task: detail,
    flags: [],
    status: 'in_progress',
  };
  const softClosed: StarAnswer = {
    questionId: asQuestionId('Q-02'),
    situation: detail,
    task: detail,
    action: detail,
    flags: ['needs_metric'],
    status: 'soft_closed',
  };
  const passed: StarAnswer = {
    questionId: asQuestionId('Q-03'),
    flags: [],
    status: 'passed',
  };

  it('round-trips responses, flags, and cursor losslessly (R25.2, R25.4)', () => {
    const base = buildInterview(role, map);
    let file = withResponse(base, inProgress, 0);
    file = withResponse(file, softClosed, 0);
    file = withResponse(file, passed, 0);

    const md = serializeInterview(file);
    const parsed = parseInterview(md);
    expect(parsed).toEqual(file);
    // Fixpoint: re-serializing the parsed file reproduces the same Markdown.
    expect(serializeInterview(parsed)).toBe(md);
  });

  it('makes flags and the derived recommendation visible in the file (R25.2, R25.5)', () => {
    const file = withResponse(buildInterview(role, map), softClosed, 1);
    const md = serializeInterview(file);
    expect(md).toContain('## Responses');
    expect(md).toContain('- **Flags:** needs_metric');
    // Derived later-recommendation line (R25.5).
    expect(md).toContain('Recommendation (needs_metric)');
    // Mid-question cursor persisted in frontmatter (R25.4).
    expect(md).toContain('cursor: 1');
  });

  it('a freshly-built interview file has no responses section (back-compat)', () => {
    const md = serializeInterview(buildInterview(role, map));
    expect(md).not.toContain('## Responses');
    expect(md).not.toContain('cursor:');
  });

  it('withResponse replaces an existing answer rather than duplicating it', () => {
    let file = withResponse(buildInterview(role, map), inProgress, 0);
    const completed: StarAnswer = { ...inProgress, action: detail, result: detail, status: 'complete' };
    file = withResponse(file, completed, 0);
    expect(file.responses).toHaveLength(1);
    expect(file.responses?.[0].status).toBe('complete');
  });
});

describe('resume reconstruction from a loaded interview file (R25.2, R25.3, R25.4)', () => {
  const detail = 'a sufficiently detailed answer here';

  it('resumes at the persisted cursor with the in-progress answer (R25.4)', () => {
    const inProgress: StarAnswer = {
      questionId: asQuestionId('Q-02'),
      situation: detail,
      flags: [],
      status: 'in_progress',
    };
    const file = withResponse(buildInterview(role, map), inProgress, 1);
    const state = resumeState(parseInterview(serializeInterview(file)));

    expect(state.cursor).toBe(1);
    expect(state.currentQuestion?.id).toBe(asQuestionId('Q-02'));
    expect(state.currentAnswer?.status).toBe('in_progress');
    expect(state.progress.label).toBe('Q 2 of 4'); // R25.3
  });

  it('surfaces unanswered, in-progress, and flagged questions as outstanding (R25.2)', () => {
    let file = buildInterview(role, map); // Q-01..Q-04
    file = withResponse(file, {
      questionId: asQuestionId('Q-01'),
      situation: detail,
      task: detail,
      action: detail,
      result: detail,
      flags: [],
      status: 'complete',
    });
    file = withResponse(file, {
      questionId: asQuestionId('Q-02'),
      situation: detail,
      task: detail,
      action: detail,
      flags: ['needs_metric'],
      status: 'soft_closed',
    });

    const state = resumeState(file);
    // Q-01 complete → done. Q-02 flagged. Q-03, Q-04 unanswered.
    expect(state.outstanding).toEqual([
      { questionId: asQuestionId('Q-02'), reason: 'flagged', flags: ['needs_metric'] },
      { questionId: asQuestionId('Q-03'), reason: 'unanswered', flags: [] },
      { questionId: asQuestionId('Q-04'), reason: 'unanswered', flags: [] },
    ]);
    // Flagged answers resurface on resume (R25.2).
    expect(flaggedResponses(file).map((a) => String(a.questionId))).toEqual(['Q-02']);
  });

  it('falls back to the first outstanding question when no cursor is stored', () => {
    let file = buildInterview(role, map);
    file = withResponse(file, {
      questionId: asQuestionId('Q-01'),
      situation: detail,
      task: detail,
      action: detail,
      result: detail,
      flags: [],
      status: 'complete',
    });
    delete file.cursor; // simulate a file without a persisted cursor
    const state = resumeState(file);
    expect(state.cursor).toBe(1); // Q-02 is the first outstanding
    expect(state.currentQuestion?.id).toBe(asQuestionId('Q-02'));
  });
});

describe('interview file with confirmed talking points (R28.4, R23)', () => {
  const detail = 'a sufficiently detailed answer here';

  const captured: StarAnswer = {
    questionId: asQuestionId('Q-01'),
    situation: 'the team faced a scaling crisis',
    task: 'i owned the migration plan',
    action: 'i led the database migration myself',
    result: 'we reduced latency noticeably across services',
    flags: [],
    status: 'complete',
  };

  it('persists a confirmed talking point with its STAR id (R28.4)', () => {
    const registry = new IdRegistry();
    const tp = confirmTalkingPoint(refine(captured, { skills: [asSkillId('SKILL-db')] }), registry);
    const file = withTalkingPoint(buildInterview(role, map), tp);
    const md = serializeInterview(file);

    expect(md).toContain('## Talking Points');
    expect(md).toContain('STAR-01');
    expect(md).toContain('- **Status:** active');
    expect(md).toContain('- **Skills:** SKILL-db');
    expect(md).toContain('- **Polished:**');
    // The STAR id is mirrored into the frontmatter ids list (R34.2).
    expect(md).toMatch(/ids:[\s\S]*STAR-01/);
  });

  it('round-trips talking points (with flags, skills, retired) losslessly', () => {
    const registry = new IdRegistry();
    const active = confirmTalkingPoint(
      refine(captured, { skills: [asSkillId('SKILL-db'), asSkillId('SKILL-perf')] }),
      registry,
    );
    const softClosed: StarAnswer = {
      questionId: asQuestionId('Q-02'),
      situation: detail,
      task: detail,
      action: detail,
      flags: ['needs_metric'],
      status: 'soft_closed',
    };
    const flaggedTp = confirmTalkingPoint(refine(softClosed), registry);
    const retiredTp = retire(confirmTalkingPoint(refine(captured), registry), registry);

    let file = withTalkingPoint(buildInterview(role, map), active);
    file = withTalkingPoint(file, flaggedTp);
    file = withTalkingPoint(file, retiredTp);

    const md = serializeInterview(file);
    const parsed = parseInterview(md);
    expect(parsed).toEqual(file);
    // Fixpoint: re-serializing the parsed file reproduces the same Markdown.
    expect(serializeInterview(parsed)).toBe(md);
  });

  it('marks a retired talking point rather than dropping it (R23.3)', () => {
    const registry = new IdRegistry();
    const tp = confirmTalkingPoint(refine(captured), registry);
    let file = withTalkingPoint(buildInterview(role, map), tp);
    // Retire: upsert swaps in the retired version under the same id.
    file = withTalkingPoint(file, retire(tp, registry));

    expect(file.talkingPoints).toHaveLength(1);
    expect(file.talkingPoints?.[0].retired).toBe(true);
    expect(file.talkingPoints?.[0].id).toBe('STAR-01');
    expect(serializeInterview(file)).toContain('- **Status:** retired');
  });

  it('keeps talking points and responses in the same file without disturbing each other', () => {
    const registry = new IdRegistry();
    const tp = confirmTalkingPoint(refine(captured), registry);
    let file = withResponse(buildInterview(role, map), captured, 0);
    file = withTalkingPoint(file, tp);
    const md = serializeInterview(file);

    expect(md).toContain('## Questions');
    expect(md).toContain('## Responses');
    expect(md).toContain('## Talking Points');
    const parsed = parseInterview(md);
    expect(parsed).toEqual(file);
    expect(serializeInterview(parsed)).toBe(md);
  });

  it('a file with no confirmed talking points has no Talking Points section (back-compat)', () => {
    const md = serializeInterview(buildInterview(role, map));
    expect(md).not.toContain('## Talking Points');
  });
});

describe('withQuestions — AI question persistence (R22.3)', () => {
  it('appends AI-generated questions with competencies to the interview file', () => {
    const base = buildInterview(role, map);
    const existingCount = base.questions.length;
    const aiQuestions = [
      {
        id: asQuestionId('Q-05'),
        category: 'behavioural' as const,
        starFramed: true,
        prompt: 'Tell me about a time you led a cross-functional initiative.',
        competencies: ['Leadership', 'Stakeholder Management'],
      },
      {
        id: asQuestionId('Q-06'),
        category: 'behavioural' as const,
        starFramed: true,
        prompt: 'Describe a situation where you resolved a conflict.',
        competencies: ['Conflict Resolution'],
      },
    ];
    const updated = withQuestions(base, aiQuestions);
    expect(updated.questions).toHaveLength(existingCount + 2);
    expect(updated.questions[existingCount].competencies).toEqual(['Leadership', 'Stakeholder Management']);
    expect(updated.questions[existingCount + 1].competencies).toEqual(['Conflict Resolution']);
  });

  it('deduplicates questions by prompt text', () => {
    const base = buildInterview(role, map);
    const existingPrompt = base.questions[0].prompt;
    const aiQuestions = [
      {
        id: asQuestionId('Q-10'),
        category: 'behavioural' as const,
        starFramed: true,
        prompt: existingPrompt, // same as existing
        competencies: ['Duplicate'],
      },
      {
        id: asQuestionId('Q-11'),
        category: 'behavioural' as const,
        starFramed: true,
        prompt: 'A genuinely new question about leadership.',
        competencies: ['Leadership'],
      },
    ];
    const updated = withQuestions(base, aiQuestions);
    // Only the new question is added.
    expect(updated.questions).toHaveLength(base.questions.length + 1);
    expect(updated.questions[updated.questions.length - 1].prompt).toBe(
      'A genuinely new question about leadership.',
    );
  });

  it('round-trips competencies through serialize/parse losslessly', () => {
    const base = buildInterview(role, map);
    const aiQuestions = [
      {
        id: asQuestionId('Q-05'),
        category: 'behavioural' as const,
        starFramed: true,
        prompt: 'Tell me about a time you mentored someone.',
        competencies: ['Mentorship', 'Technical Leadership'],
      },
    ];
    const file = withQuestions(base, aiQuestions);
    const md = serializeInterview(file);
    // Competencies appear in the serialized output.
    expect(md).toContain('- **Competencies:** Mentorship, Technical Leadership');
    // Parse round-trips correctly.
    const parsed = parseInterview(md);
    expect(parsed).toEqual(file);
    expect(serializeInterview(parsed)).toBe(md);
  });

  it('persists AI questions to the interview file immediately on receipt', async () => {
    const writes: Record<string, string> = {};
    const writer = { write: (p: never, d: string) => void (writes[String(p)] = d) };
    const base = buildInterview(role, map);
    const aiQuestions = [
      {
        id: asQuestionId('Q-05'),
        category: 'behavioural' as const,
        starFramed: true,
        prompt: 'Tell me about a tricky deploy you managed.',
        competencies: ['Adaptability'],
      },
    ];
    const updated = withQuestions(base, aiQuestions);
    await saveInterview(writer, updated);
    const saved = writes[String(interviewPath(role.slug))];
    expect(saved).toContain('Tell me about a tricky deploy you managed.');
    expect(saved).toContain('- **Competencies:** Adaptability');
  });

  it('preserves existing responses and talking points when appending questions', () => {
    const registry = new IdRegistry();
    const base = buildInterview(role, map);
    const answer: StarAnswer = {
      questionId: asQuestionId('Q-01'),
      situation: 'context here',
      task: 'task here',
      action: 'action here',
      result: 'result here',
      flags: [],
      status: 'complete',
    };
    let file = withResponse(base, answer, 0);
    const tp = confirmTalkingPoint(refine(answer), registry);
    file = withTalkingPoint(file, tp);

    const aiQuestions = [
      {
        id: asQuestionId('Q-05'),
        category: 'behavioural' as const,
        starFramed: true,
        prompt: 'Describe a mentoring experience.',
        competencies: ['Mentorship'],
      },
    ];
    const updated = withQuestions(file, aiQuestions);
    expect(updated.responses).toHaveLength(1);
    expect(updated.talkingPoints).toHaveLength(1);
    expect(updated.cursor).toBe(0);
  });
});
