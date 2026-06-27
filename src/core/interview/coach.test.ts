import { describe, it, expect } from 'vitest';
import { asQuestionId } from '@core/types';
import type { StarAnswer, StarElement } from '@core/types';
import {
  STAR_ORDER,
  OPEN_FOLLOW_UPS,
  LATER_RECOMMENDATIONS,
  elementToFlag,
  flagToElement,
  isElementPresent,
  outstandingElements,
  openFollowUp,
  recommendationFor,
  newAnswer,
  collectText,
  softClose,
  pass,
  progress,
} from './index';

const QID = asQuestionId('Q-01');

/** A four-or-more-word adequate element value. */
const adequate = 'a sufficiently detailed answer here';

describe('STAR element tracking (R24.1, R24.2)', () => {
  it('tracks the four STAR elements in canonical order', () => {
    expect(STAR_ORDER).toEqual(['situation', 'task', 'action', 'result']);
  });

  it('treats absent or too-vague values as not present (R24.2)', () => {
    expect(isElementPresent(undefined)).toBe(false);
    expect(isElementPresent('')).toBe(false);
    expect(isElementPresent('too short')).toBe(false); // < 4 words
    expect(isElementPresent(adequate)).toBe(true);
  });

  it('reports outstanding elements in canonical order', () => {
    const answer: StarAnswer = {
      questionId: QID,
      situation: adequate,
      action: adequate,
      flags: [],
      status: 'in_progress',
    };
    expect(outstandingElements(answer)).toEqual(['task', 'result']);
  });

  it('maps every element to a flag and back (R25.1)', () => {
    for (const element of STAR_ORDER) {
      expect(flagToElement(elementToFlag(element))).toBe(element);
    }
    expect(elementToFlag('result')).toBe('needs_metric');
    expect(elementToFlag('situation')).toBe('needs_situation');
  });
});

describe('open follow-up bank — content firewall (R24.2, R24.3)', () => {
  it('asks a targeted open follow-up for the next missing element', () => {
    const turn = collectText(newAnswer(QID), adequate); // fills situation
    expect(turn.status).toBe('incomplete');
    expect(turn.next).toBe('task');
    expect(turn.followUp).toBe(openFollowUp('task'));
  });

  it('only ever returns prompts drawn from the fixed bank', () => {
    for (const element of STAR_ORDER) {
      const bank = OPEN_FOLLOW_UPS[element];
      expect(bank.length).toBeGreaterThan(0);
      expect(bank).toContain(openFollowUp(element, 0));
      // Wrapping selection stays within the bank for any attempt index.
      expect(bank).toContain(openFollowUp(element, 5));
      expect(bank).toContain(openFollowUp(element, -1));
    }
  });

  it('every follow-up is an open question that suggests no facts (R24.3)', () => {
    const forbidden =
      /\b(for example|such as|you could say|you might say|e\.g\.|maybe you)\b/i;
    for (const element of STAR_ORDER) {
      for (const prompt of OPEN_FOLLOW_UPS[element]) {
        expect(prompt).toContain('?'); // open, not a statement of fact
        expect(prompt).not.toMatch(forbidden);
      }
    }
  });
});

describe('collectText loop progression and completion (R24.1, R24.4)', () => {
  it('walks S→T→A→R then reports complete (a loop exit)', () => {
    let answer = newAnswer(QID);
    const seen: (StarElement | undefined)[] = [];
    for (const element of STAR_ORDER) {
      const turn = collectText(answer, adequate, element);
      answer = turn.answer;
      seen.push(turn.next);
    }
    // Each turn pointed at the next missing element, then none on completion.
    expect(seen).toEqual(['task', 'action', 'result', undefined]);
    expect(answer.status).toBe('complete');
    expect(outstandingElements(answer)).toEqual([]);
  });

  it('fills the first outstanding element when none is specified', () => {
    const first = collectText(newAnswer(QID), adequate);
    expect(first.answer.situation).toBe(adequate);
    expect(first.next).toBe('task');
  });

  it('does not mutate the input answer (pure)', () => {
    const answer = newAnswer(QID);
    collectText(answer, adequate);
    expect(answer.situation).toBeUndefined();
    expect(answer.status).toBe('in_progress');
  });
});

describe('softClose — accept partial, flag, recommend later (R25.1, R25.5)', () => {
  it('attaches the missing-element flag and a later-recommendation', () => {
    const answer: StarAnswer = {
      questionId: QID,
      situation: adequate,
      task: adequate,
      action: adequate,
      flags: [],
      status: 'in_progress',
    };
    const flagged = softClose(answer, 'result');
    expect(flagged.flag).toBe('needs_metric');
    expect(flagged.element).toBe('result');
    expect(flagged.answer.flags).toEqual(['needs_metric']);
    expect(flagged.answer.status).toBe('soft_closed'); // a loop exit
    // R25.5: a recommendation for finding/phrasing it later, not a fact to claim.
    expect(flagged.recommendation).toBe(recommendationFor('result'));
    expect(flagged.recommendation).toBe(LATER_RECOMMENDATIONS.result);
    expect(flagged.recommendation.toLowerCase()).toContain('later');
  });

  it('does not duplicate a flag already present and is pure', () => {
    const answer: StarAnswer = {
      questionId: QID,
      flags: ['needs_metric'],
      status: 'in_progress',
    };
    const flagged = softClose(answer, 'result');
    expect(flagged.answer.flags).toEqual(['needs_metric']);
    expect(answer.status).toBe('in_progress'); // input untouched
  });
});

describe('pass — explicit skip (R24.4)', () => {
  it('marks the answer passed without flags or content', () => {
    const passed = pass(newAnswer(QID));
    expect(passed.status).toBe('passed');
    expect(passed.flags).toEqual([]);
    expect(passed.situation).toBeUndefined();
  });
});

describe('progress indicator (R25.3)', () => {
  const questions = [
    { id: asQuestionId('Q-01') },
    { id: asQuestionId('Q-02') },
    { id: asQuestionId('Q-03') },
  ] as never[];

  it('reports 1-based position out of total as "Q n of N"', () => {
    expect(progress(questions, 0)).toEqual({ current: 1, total: 3, label: 'Q 1 of 3' });
    expect(progress(questions, 2)).toEqual({ current: 3, total: 3, label: 'Q 3 of 3' });
  });

  it('clamps an out-of-range cursor into the display range', () => {
    expect(progress(questions, 9).label).toBe('Q 3 of 3');
    expect(progress(questions, -5).label).toBe('Q 1 of 3');
  });

  it('reports "Q 0 of 0" for an empty session', () => {
    expect(progress([], 0)).toEqual({ current: 0, total: 0, label: 'Q 0 of 0' });
  });
});
