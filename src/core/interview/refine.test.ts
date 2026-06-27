import { describe, it, expect } from 'vitest';
import { asQuestionId, asSkillId } from '@core/types';
import type { StarAnswer } from '@core/types';
import { IdRegistry } from '@core/registry';
import { contentContribution } from './firewall';
import { refine, confirmTalkingPoint, retire } from './index';

const QID = asQuestionId('Q-01');

/** A complete, captured STAR answer with delivery noise in every element. */
const captured: StarAnswer = {
  questionId: QID,
  // "um", "like", "you know", "[inaudible]", "gonna" are delivery — must not leak.
  situation: 'um the team faced a scaling crisis you know',
  task: 'like i was responsible for the migration plan',
  action: 'i gonna lead the database migration myself',
  result: 'we reduced latency by forty percent [inaudible]',
  flags: [],
  status: 'complete',
};

/** A Soft-Closed answer missing the result (carries the needs_metric flag). */
const softClosed: StarAnswer = {
  questionId: QID,
  situation: 'the onboarding flow was confusing for new users',
  task: 'i owned improving the first run experience',
  action: 'i redesigned the welcome screens and copy',
  flags: ['needs_metric'],
  status: 'soft_closed',
};

describe('refine — structured STAR summary with flags (R28.1)', () => {
  it('summarises all four STAR elements in canonical order', () => {
    const draft = refine(captured);
    expect(draft.summary.map((s) => s.element)).toEqual([
      'situation',
      'task',
      'action',
      'result',
    ]);
    expect(draft.summary.map((s) => s.label)).toEqual([
      'Situation',
      'Task',
      'Action',
      'Result',
    ]);
    expect(draft.summary.every((s) => s.present)).toBe(true);
  });

  it('shows the missing-element flag against its element (R28.1)', () => {
    const draft = refine(softClosed);
    const result = draft.summary.find((s) => s.element === 'result');
    const situation = draft.summary.find((s) => s.element === 'situation');
    expect(result?.flag).toBe('needs_metric');
    expect(result?.present).toBe(false);
    expect(situation?.flag).toBeUndefined();
    expect(draft.flags).toEqual(['needs_metric']);
  });

  it('summary content is the delivery-stripped firewall content (R27.1)', () => {
    const draft = refine(captured);
    const expected = contentContribution(captured).elements;
    for (const row of draft.summary) {
      expect(row.content).toBe(expected[row.element]);
    }
  });
});

describe('refine — weaknesses as coaching suggestions, never blockers (R28.2)', () => {
  it('expresses each flag as an advisory suggestion', () => {
    const draft = refine(softClosed);
    expect(draft.suggestions).toHaveLength(1);
    const [suggestion] = draft.suggestions;
    expect(suggestion.element).toBe('result');
    expect(suggestion.flag).toBe('needs_metric');
    // Advisory text pointing at finding/phrasing the element later (R25.5).
    expect(suggestion.suggestion.toLowerCase()).toContain('later');
  });

  it('a complete answer has no suggestions', () => {
    expect(refine(captured).suggestions).toEqual([]);
  });
});

describe('refine — polished first-person past-tense talking point (R28.3)', () => {
  it('is first-person and past-tense', () => {
    const polished = refine(captured).polished;
    // First-person voice.
    expect(polished).toMatch(/\bI\b/);
    // Past-tense framing markers from the fixed scaffold.
    expect(polished).toMatch(/\bwas\b/);
    expect(polished).toMatch(/\btook\b|\bobserved\b/);
  });

  it('adds no facts beyond the answer content (no fabrication, R28.3)', () => {
    const draft = refine(captured);
    const contentTokens = new Set(contentContribution(captured).tokens);
    // The only non-content tokens permitted are the fixed first-person
    // past-tense scaffold words — never invented facts, metrics, or outcomes.
    const scaffold = new Set([
      'i',
      'was',
      'in',
      'a',
      'situation',
      'where',
      'responsible',
      'for',
      'took',
      'the',
      'following',
      'action',
      'observed',
      'result',
    ]);
    const words = draft.polished
      .toLowerCase()
      .replace(/[.:,]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0);
    for (const word of words) {
      expect(contentTokens.has(word) || scaffold.has(word)).toBe(true);
    }
  });

  it('delivery noise never leaks into the polished text (firewall, R27)', () => {
    const polished = refine(captured).polished.toLowerCase();
    // Fillers / hesitations / artefacts / dialect present in the raw answer.
    expect(polished).not.toContain('um ');
    expect(polished).not.toContain('you know');
    expect(polished).not.toContain('inaudible');
    expect(polished).not.toContain('gonna');
    // The substantive content survives.
    expect(polished).toContain('latency');
    expect(polished).toContain('migration');
  });

  it('builds clauses only for captured elements', () => {
    const draft = refine(softClosed); // no result element
    expect(draft.polished).not.toContain('I observed the result');
    expect(draft.elements.result).toBeUndefined();
    expect(draft.elements.situation).toBeDefined();
  });

  it('an empty answer yields an empty polished point', () => {
    const empty: StarAnswer = { questionId: QID, flags: [], status: 'passed' };
    expect(refine(empty).polished).toBe('');
  });

  it('is pure — never mutates the input answer', () => {
    const before = JSON.stringify(captured);
    refine(captured);
    expect(JSON.stringify(captured)).toBe(before);
  });
});

describe('confirmTalkingPoint — stable STAR ID assignment (R28.3, R23.1)', () => {
  it('mints a stable STAR id and carries the polished text, elements & skills', () => {
    const registry = new IdRegistry();
    const skills = [asSkillId('SKILL-db'), asSkillId('SKILL-perf')];
    const draft = refine(captured, { skills });
    const tp = confirmTalkingPoint(draft, registry);

    expect(tp.id).toBe('STAR-01');
    expect(tp.polished).toBe(draft.polished);
    expect(tp.skills).toEqual(skills);
    expect(tp.flags).toEqual([]);
    expect(tp.situation).toBe(draft.elements.situation);
    expect(tp.result).toBe(draft.elements.result);
    expect(tp.retired).toBeUndefined();
  });

  it('assigns unique, sequential ids that are never reused (R23.1, R23.2)', () => {
    const registry = new IdRegistry();
    const a = confirmTalkingPoint(refine(captured), registry);
    const b = confirmTalkingPoint(refine(softClosed), registry);
    expect(a.id).toBe('STAR-01');
    expect(b.id).toBe('STAR-02');
    expect(a.id).not.toBe(b.id);
  });

  it('confirmation succeeds even with outstanding flags (R28.2)', () => {
    const registry = new IdRegistry();
    const draft = refine(softClosed); // carries needs_metric
    const tp = confirmTalkingPoint(draft, registry);
    expect(tp.flags).toEqual(['needs_metric']);
    expect(tp.id).toBe('STAR-01'); // confirmed despite the flag
  });

  it('resumes past seeded ids so it never renumbers (R23.2)', () => {
    const registry = new IdRegistry().seed(['STAR-04']);
    const tp = confirmTalkingPoint(refine(captured), registry);
    expect(tp.id).toBe('STAR-05');
  });
});

describe('retire — mark rather than delete (R23.3, R23.2)', () => {
  it('marks the talking point retired without dropping any field', () => {
    const registry = new IdRegistry();
    const tp = confirmTalkingPoint(refine(captured), registry);
    const retired = retire(tp);

    expect(retired.retired).toBe(true);
    expect(retired.id).toBe(tp.id); // same stable id
    expect(retired.polished).toBe(tp.polished);
    expect(retired.skills).toEqual(tp.skills);
    // Pure: the original is untouched.
    expect(tp.retired).toBeUndefined();
  });

  it('retires the id in the registry so it is kept allocated, never reissued', () => {
    const registry = new IdRegistry();
    const tp = confirmTalkingPoint(refine(captured), registry);
    retire(tp, registry);

    expect(registry.isAllocated(String(tp.id))).toBe(true);
    expect(registry.isRetired(String(tp.id))).toBe(true);
    // The next mint continues forward — the retired number is not reissued.
    const next = confirmTalkingPoint(refine(softClosed), registry);
    expect(next.id).toBe('STAR-02');
  });
});
