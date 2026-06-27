// Unit tests for the adaptive STAR coaching loop controller (task 31.3):
// termination at ENOUGH=yes, at the three-follow-up cap, on user stop, and on
// dig-deeper continuation past the cap (R63.3, R63.4, R63.5).

import { describe, it, expect, vi } from 'vitest';
import {
  asRoleSlug,
  asSkillId,
  asSkillTerm,
  type RolePreference,
} from '@core/types';
import { type AssistTransport, type EgressDestination } from '@core/assist';
import type { ConfirmedTranscript } from './audio';
import {
  createStarCoachingLoop,
  StarCoachingLoop,
  CoachingLoopStateError,
  MAX_AI_FOLLOW_UPS,
} from './coaching-loop';

const DEST: EgressDestination = { provider: 'openai', kind: 'keyed-cloud' };

const ROLE: RolePreference = {
  slug: asRoleSlug('backend-engineer'),
  title: 'Backend Engineer',
  description: 'Builds services.',
  matchScore: 80,
  matchedSkills: [asSkillId('SKILL-javascript')],
  gapSkills: [asSkillTerm('Kubernetes')],
  rationale: 'Estimated 80% match.',
  rank: 1,
  tag: 'exploring',
};

const INIT = {
  role: ROLE,
  competency: 'Resilience',
  question: 'Tell me about a time a service failed under load.',
};

/** Build a strict adequacy reply with a follow-up (not enough). */
const notEnough = (followUp: string): string =>
  'SITUATION: covered\nTASK: missing\nACTION: missing\nRESULT: missing\n' +
  `ENOUGH: no\nFOLLOWUP: ${followUp}`;

/** Build a strict adequacy reply that reports the answer is sufficient. */
const ENOUGH =
  'SITUATION: covered\nTASK: covered\nACTION: covered\nRESULT: covered\n' +
  'ENOUGH: yes\nFOLLOWUP: none';

/** Build a strict adequacy reply that is not enough but offers no follow-up. */
const NO_FOLLOW_UP =
  'SITUATION: covered\nTASK: missing\nACTION: missing\nRESULT: missing\n' +
  'ENOUGH: no\nFOLLOWUP: none';

/** A transport that replies with each queued string in turn, then throws. */
const queuedTransport = (replies: string[]): AssistTransport => {
  let i = 0;
  return vi.fn<AssistTransport>(async () => {
    if (i >= replies.length) throw new Error('no more queued replies');
    return replies[i++];
  });
};

describe('StarCoachingLoop — initial state (R63.1)', () => {
  it('opens awaiting the first answer to the original question (no follow-up yet)', () => {
    const loop = createStarCoachingLoop(INIT, DEST, queuedTransport([]));
    expect(loop.action).toEqual({
      kind: 'await-answer',
      followUp: null,
      followUpCount: 0,
    });
    expect(loop.isFinished).toBe(false);
    expect(loop.state.answersSoFar).toEqual([]);
  });
});

describe('StarCoachingLoop — termination at ENOUGH=yes (R63.3)', () => {
  it('finishes with reason "enough" on a sufficient answer', async () => {
    const loop = createStarCoachingLoop(INIT, DEST, queuedTransport([ENOUGH]));

    const action = await loop.submitAnswer('I scaled the service and cut errors in half.');

    expect(action.kind).toBe('finished');
    if (action.kind === 'finished') {
      expect(action.reason).toBe('enough');
      expect(action.assessment?.enough).toBe(true);
    }
    expect(loop.state.followUpCount).toBe(0);
    expect(loop.state.answersSoFar).toHaveLength(1);
  });
});

describe('StarCoachingLoop — termination when the model offers no follow-up', () => {
  it('finishes with reason "no-follow-up" when not enough but FOLLOWUP=none', async () => {
    const loop = createStarCoachingLoop(INIT, DEST, queuedTransport([NO_FOLLOW_UP]));

    const action = await loop.submitAnswer('It was rough.');

    expect(action).toMatchObject({ kind: 'finished', reason: 'no-follow-up' });
  });
});

describe('StarCoachingLoop — follow-up loop and the three-follow-up cap (R63.3, R63.4)', () => {
  it('presents up to three AI follow-ups, then offers the dig-deeper opt-in', async () => {
    const loop = createStarCoachingLoop(
      INIT,
      DEST,
      queuedTransport([
        notEnough('What was your specific task?'),
        notEnough('What did you personally do?'),
        notEnough('What was the measurable result?'),
        notEnough('Can you quantify the impact further?'),
      ]),
    );

    // Answer 1 → follow-up #1.
    let action = await loop.submitAnswer('a1');
    expect(action).toMatchObject({ kind: 'await-answer', followUpCount: 1 });

    // Answer 2 → follow-up #2.
    action = await loop.submitAnswer('a2');
    expect(action).toMatchObject({ kind: 'await-answer', followUpCount: 2 });

    // Answer 3 → follow-up #3 (the cap).
    action = await loop.submitAnswer('a3');
    expect(action).toMatchObject({ kind: 'await-answer', followUpCount: MAX_AI_FOLLOW_UPS });

    // Answer 4 → cap reached, model still has a follow-up → dig-deeper offer (R63.4).
    action = await loop.submitAnswer('a4');
    expect(action).toMatchObject({
      kind: 'await-dig-deeper',
      followUp: 'Can you quantify the impact further?',
      followUpCount: MAX_AI_FOLLOW_UPS,
    });
    expect(loop.state.answersSoFar).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('finishes "cap-reached" when the user declines to dig deeper (R63.4)', async () => {
    const loop = createStarCoachingLoop(
      INIT,
      DEST,
      queuedTransport([
        notEnough('q1'),
        notEnough('q2'),
        notEnough('q3'),
        notEnough('q4'),
      ]),
    );
    await loop.submitAnswer('a1');
    await loop.submitAnswer('a2');
    await loop.submitAnswer('a3');
    await loop.submitAnswer('a4');

    const action = loop.declineDigDeeper();

    expect(action).toMatchObject({ kind: 'finished', reason: 'cap-reached' });
  });

  it('finishes "enough" at the cap when the answer becomes sufficient (no dig-deeper offered)', async () => {
    const loop = createStarCoachingLoop(
      INIT,
      DEST,
      queuedTransport([notEnough('q1'), notEnough('q2'), notEnough('q3'), ENOUGH]),
    );
    await loop.submitAnswer('a1');
    await loop.submitAnswer('a2');
    await loop.submitAnswer('a3');

    const action = await loop.submitAnswer('a4');

    expect(action).toMatchObject({ kind: 'finished', reason: 'enough' });
  });
});

describe('StarCoachingLoop — dig-deeper continuation past the cap (R63.4)', () => {
  it('continues with the offered follow-up when the user opts in', async () => {
    const loop = createStarCoachingLoop(
      INIT,
      DEST,
      queuedTransport([
        notEnough('q1'),
        notEnough('q2'),
        notEnough('q3'),
        notEnough('deeper q'),
        ENOUGH,
      ]),
    );
    await loop.submitAnswer('a1');
    await loop.submitAnswer('a2');
    await loop.submitAnswer('a3');
    const offer = await loop.submitAnswer('a4');
    expect(offer.kind).toBe('await-dig-deeper');

    // Opt in: the offered follow-up becomes the next answer prompt past the cap.
    const resumed = loop.digDeeper();
    expect(resumed).toMatchObject({
      kind: 'await-answer',
      followUp: 'deeper q',
      followUpCount: MAX_AI_FOLLOW_UPS + 1,
    });

    // A further sufficient answer ends the loop.
    const action = await loop.submitAnswer('a5');
    expect(action).toMatchObject({ kind: 'finished', reason: 'enough' });
    expect(loop.state.answersSoFar).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });

  it('re-offers dig-deeper each round past the cap while a follow-up remains', async () => {
    const loop = createStarCoachingLoop(
      INIT,
      DEST,
      queuedTransport([
        notEnough('q1'),
        notEnough('q2'),
        notEnough('q3'),
        notEnough('deeper q1'),
        notEnough('deeper q2'),
      ]),
    );
    await loop.submitAnswer('a1');
    await loop.submitAnswer('a2');
    await loop.submitAnswer('a3');
    await loop.submitAnswer('a4'); // dig-deeper offer #1
    loop.digDeeper();

    const offerAgain = await loop.submitAnswer('a5');
    expect(offerAgain).toMatchObject({
      kind: 'await-dig-deeper',
      followUp: 'deeper q2',
    });
  });
});

describe('StarCoachingLoop — user stop at any round (R63.5)', () => {
  it('stops before any answer is given', () => {
    const loop = createStarCoachingLoop(INIT, DEST, queuedTransport([]));
    const action = loop.stop();
    expect(action).toMatchObject({ kind: 'finished', reason: 'user-stop' });
    expect(action).toHaveProperty('assessment', null);
  });

  it('stops mid-loop while a follow-up is pending', async () => {
    const loop = createStarCoachingLoop(
      INIT,
      DEST,
      queuedTransport([notEnough('q1'), notEnough('q2')]),
    );
    await loop.submitAnswer('a1');
    const action = loop.stop();
    expect(action).toMatchObject({ kind: 'finished', reason: 'user-stop' });
  });

  it('stops while a dig-deeper offer is pending', async () => {
    const loop = createStarCoachingLoop(
      INIT,
      DEST,
      queuedTransport([notEnough('q1'), notEnough('q2'), notEnough('q3'), notEnough('q4')]),
    );
    await loop.submitAnswer('a1');
    await loop.submitAnswer('a2');
    await loop.submitAnswer('a3');
    await loop.submitAnswer('a4');
    expect(loop.action.kind).toBe('await-dig-deeper');

    const action = loop.stop();
    expect(action).toMatchObject({ kind: 'finished', reason: 'user-stop' });
  });

  it('stop is idempotent on an already-finished loop', async () => {
    const loop = createStarCoachingLoop(INIT, DEST, queuedTransport([ENOUGH]));
    await loop.submitAnswer('a1');
    const first = loop.stop();
    const second = loop.stop();
    expect(first).toMatchObject({ kind: 'finished', reason: 'enough' });
    expect(second).toBe(first);
  });
});

describe('StarCoachingLoop — gate routing and context accumulation (R63.2)', () => {
  it('routes every assessment through the transport carrying all answers so far', async () => {
    const transport = vi.fn<AssistTransport>(async () =>
      notEnough('what next?'),
    );
    const loop = new StarCoachingLoop(INIT, DEST, transport);

    await loop.submitAnswer('first');
    await loop.submitAnswer('second');

    expect(transport).toHaveBeenCalledTimes(2);
    // Routed to the chosen destination each turn.
    expect(transport.mock.calls[0][1]).toEqual(DEST);
    // The second prompt carries BOTH answers (stateless model, R63.2).
    const secondPrompt = transport.mock.calls[1][0];
    expect(secondPrompt).toContain('first');
    expect(secondPrompt).toContain('second');
  });

  it('accepts a confirmed audio transcript via the existing gated STT path (R63.1)', async () => {
    const transport = vi.fn<AssistTransport>(async () => ENOUGH);
    const loop = new StarCoachingLoop(INIT, DEST, transport);
    const transcript: ConfirmedTranscript = {
      text: 'I scaled the service and reduced errors.',
      format: 'wav',
      confirmed: true,
      corrected: false,
    };

    const action = await loop.submitTranscript(transcript);

    expect(action).toMatchObject({ kind: 'finished', reason: 'enough' });
    expect(loop.state.answersSoFar).toEqual([transcript.text]);
  });
});

describe('StarCoachingLoop — failure preserves coaching state', () => {
  it('leaves answers and follow-up count unchanged when assessment fails (retryable)', async () => {
    let fail = true;
    const transport = vi.fn<AssistTransport>(async () => {
      if (fail) throw new Error('provider down');
      return notEnough('what next?');
    });
    const loop = new StarCoachingLoop(INIT, DEST, transport);

    await expect(loop.submitAnswer('a1')).rejects.toThrow('provider down');
    // State unchanged: no answer committed, still awaiting the first answer.
    expect(loop.state.answersSoFar).toEqual([]);
    expect(loop.action).toMatchObject({ kind: 'await-answer', followUpCount: 0 });

    // Retry succeeds with the same answer.
    fail = false;
    const action = await loop.submitAnswer('a1');
    expect(action).toMatchObject({ kind: 'await-answer', followUpCount: 1 });
    expect(loop.state.answersSoFar).toEqual(['a1']);
  });
});

describe('StarCoachingLoop — invalid-state guards', () => {
  it('rejects submitAnswer once finished', async () => {
    const loop = createStarCoachingLoop(INIT, DEST, queuedTransport([ENOUGH]));
    await loop.submitAnswer('a1');
    await expect(loop.submitAnswer('again')).rejects.toBeInstanceOf(
      CoachingLoopStateError,
    );
  });

  it('throws when digging deeper without a pending offer', () => {
    const loop = createStarCoachingLoop(INIT, DEST, queuedTransport([]));
    expect(() => loop.digDeeper()).toThrow(CoachingLoopStateError);
    expect(() => loop.declineDigDeeper()).toThrow(CoachingLoopStateError);
  });
});
