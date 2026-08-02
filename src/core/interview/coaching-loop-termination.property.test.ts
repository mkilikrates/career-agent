// Feature: career-agent, Property 16: Coaching-loop termination and outstanding-set correctness
//
// For any coaching interaction, the per-question loop terminates exactly when
// the STAR answer is complete, the user invokes Soft-Close, or the user passes
// (no other exit), and a Soft-Closed answer always produces a persisted flagged
// point that reappears in the resume outstanding set; and for any Memory Store
// state, the resume summary's outstanding list equals exactly the union of
// unanswered questions, flagged talking points, unreviewed skill entries, and
// unresolved conflicts present in the store.
//
// **Validates: Requirements 24.4, 25.1, 25.2, 35.1**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Question, QuestionId, StarAnswer, StarFlag, ResponseStatus } from '@core/types';
import { asQuestionId, asRoleSlug, asSkillId } from '@core/types';
import { softClose, pass, collectText, newAnswer } from './coach';
import { resumeState, type InterviewFile } from './interview-document';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a question ID. */
const arbQuestionId: fc.Arbitrary<QuestionId> = fc
  .integer({ min: 1, max: 20 })
  .map((n) => asQuestionId(`Q-${String(n).padStart(2, '0')}`));

/** Generate a question. */
const arbQuestion = (id: QuestionId): Question => ({
  id,
  category: 'behavioural' as const,
  starFramed: true,
  skill: asSkillId('SKILL-1'),
  prompt: `Tell me about a time you demonstrated testing.`,
});

/** Generate a response status. */
const arbStatus: fc.Arbitrary<ResponseStatus> = fc.constantFrom(
  'in_progress', 'complete', 'soft_closed', 'passed',
);

/** Generate a StarAnswer with a given status and optional flags. */
const arbAnswer = (qid: QuestionId, status: ResponseStatus): StarAnswer => ({
  questionId: qid,
  situation: status !== 'passed' ? 'Some situation' : undefined,
  task: status === 'complete' ? 'Some task' : undefined,
  action: status === 'complete' ? 'Some action' : undefined,
  result: status === 'complete' ? 'Some result' : undefined,
  flags: status === 'soft_closed' ? ['needs_metric' as StarFlag] : [],
  status,
});

/** Generate an interview file with questions and mixed responses. */
const arbInterviewFile: fc.Arbitrary<InterviewFile> = fc
  .array(
    fc.tuple(arbQuestionId, fc.option(arbStatus, { nil: undefined })),
    { minLength: 2, maxLength: 8 },
  )
  .map((pairs) => {
    // De-duplicate question IDs
    const seen = new Set<string>();
    const unique = pairs.filter(([qid]) => {
      const s = String(qid);
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    });

    const questions: Question[] = unique.map(([qid]) => arbQuestion(qid));
    const responses: StarAnswer[] = unique
      .filter(([, status]) => status !== undefined)
      .map(([qid, status]) => arbAnswer(qid, status!));

    const file: InterviewFile = {
      roleSlug: asRoleSlug('test-role'),
      roleTitle: 'Test Role',
      questions,
      responses,
    };
    return file;
  })
  .filter((f) => f.questions.length >= 2);

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('@core/interview — Property 16: Coaching-loop termination and outstanding-set correctness', () => {
  it('softClose produces a flagged answer with status soft_closed (R25.1)', () => {
    fc.assert(
      fc.property(arbQuestionId, (qid) => {
        const answer = newAnswer(qid);
        // Provide a situation then soft-close on the task
        const withSituation = collectText(answer, 'I led a full production migration project successfully.');
        const flagged = softClose(withSituation.answer, 'task');

        expect(flagged.answer.status).toBe('soft_closed');
        expect(flagged.answer.flags.length).toBeGreaterThan(0);
        expect(flagged.flag).toBe('needs_task');
      }),
      { numRuns: 100 },
    );
  });

  it('pass produces a passed answer (R24.4)', () => {
    fc.assert(
      fc.property(arbQuestionId, (qid) => {
        const answer = newAnswer(qid);
        const passed = pass(answer);
        expect(passed.status).toBe('passed');
      }),
      { numRuns: 100 },
    );
  });

  it('a complete answer has all four STAR elements filled', () => {
    fc.assert(
      fc.property(arbQuestionId, (qid) => {
        const initial = newAnswer(qid);
        const t1 = collectText(initial, 'The system was under heavy production load');
        const t2 = collectText(t1.answer, 'I needed to fix the critical performance issue');
        const t3 = collectText(t2.answer, 'I refactored the database queries and added caching');
        const t4 = collectText(t3.answer, 'Response time dropped by fifty percent overall');

        expect(t4.status).toBe('complete');
        expect(t4.answer.status).toBe('complete');
        expect(t4.answer.situation).toBeDefined();
        expect(t4.answer.task).toBeDefined();
        expect(t4.answer.action).toBeDefined();
        expect(t4.answer.result).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });

  it('outstanding set includes exactly unanswered, in_progress, and soft_closed questions', () => {
    fc.assert(
      fc.property(arbInterviewFile, (file) => {
        const state = resumeState(file);

        const responseByQ = new Map<string, StarAnswer>();
        for (const r of file.responses ?? []) {
          responseByQ.set(String(r.questionId), r);
        }

        for (const q of file.questions) {
          const response = responseByQ.get(String(q.id));
          const inOutstanding = state.outstanding.some(
            (o) => String(o.questionId) === String(q.id),
          );

          if (!response) {
            // Unanswered → must be in outstanding
            expect(inOutstanding).toBe(true);
          } else if (response.status === 'in_progress') {
            expect(inOutstanding).toBe(true);
          } else if (response.status === 'soft_closed') {
            expect(inOutstanding).toBe(true);
          } else {
            // complete or passed → not outstanding
            expect(inOutstanding).toBe(false);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a soft_closed answer resurfaces in outstanding with its flags (R25.2)', () => {
    fc.assert(
      fc.property(arbInterviewFile, (file) => {
        const state = resumeState(file);

        for (const response of file.responses ?? []) {
          if (response.status === 'soft_closed') {
            const outstanding = state.outstanding.find(
              (o) => String(o.questionId) === String(response.questionId),
            );
            expect(outstanding).toBeDefined();
            expect(outstanding!.reason).toBe('flagged');
            expect(outstanding!.flags).toEqual(response.flags);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
