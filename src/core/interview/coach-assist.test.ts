// Unit tests for the Interview_Coach assist operations (task 25.2):
// `star_questions` and `star_summary`.

import { describe, it, expect, vi } from 'vitest';
import {
  asRoleSlug,
  asSkillId,
  asSkillTerm,
  asQuestionId,
  asISODate,
  type RolePreference,
  type SkillMapEntry,
  type StarAnswer,
} from '@core/types';
import { buildReferenceGraph } from '@core/registry';
import { generate, type SkillMap } from '@core/skills';
import { asItemId, asDocId, type ExtractedItem } from '@core/types';
import {
  runAssist,
  type AssistTransport,
  type EgressDestination,
} from '@core/assist';
import {
  createStarQuestionsOperation,
  StarQuestionsOperation,
  createStarSummaryOperation,
  StarSummaryOperation,
  buildStarQuestionsPrompt,
  educationalSummary,
  buildTeachingSummary,
  parseQuestionPrompts,
  buildAdequacyPrompt,
  parseAdequacyReply,
  assessAdequacy,
  type AdequacyInput,
  buildPerQuestionSummaryPrompt,
  parsePerQuestionSummaryReply,
  perQuestionSummary,
  type PerQuestionSummaryInput,
} from './coach-assist';

const DEST: EgressDestination = { provider: 'openai', kind: 'keyed-cloud' };
const LOCAL: EgressDestination = { provider: 'local', kind: 'keyless-local' };

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

/** Build a skill-map entry directly so the `private` flag is carried (R22.7). */
const entry = (
  id: string,
  name: string,
  opts: Partial<SkillMapEntry> = {},
): SkillMapEntry => ({
  id: asSkillId(id),
  name,
  category: 'Technical',
  proficiencySignal: 'Evidence-based.',
  evidence: [],
  recency: asISODate('2024-01-01'),
  ...opts,
});

const mapOf = (entries: SkillMapEntry[]): SkillMap => ({
  entries,
  graph: buildReferenceGraph({ skills: entries }),
});

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

const ANSWER: StarAnswer = {
  questionId: asQuestionId('Q-01'),
  situation: 'the service was failing under load',
  task: 'i owned the reliability fix',
  action: 'i added autoscaling and caching',
  result: 'we cut error rates by half',
  flags: [],
  status: 'complete',
};

describe('parseQuestionPrompts', () => {
  it('parses "<competency> :: <question>" lines, strips markers, de-duplicates', () => {
    const qs = parseQuestionPrompts(
      '1. Leadership :: Tell me about X\n- Leadership :: Tell me about X\n* Resilience :: Describe a failure',
    );
    expect(qs).toEqual([
      { competency: 'Leadership', question: 'Tell me about X' },
      { competency: 'Resilience', question: 'Describe a failure' },
    ]);
  });

  it('drops preamble/chatter lines that lack the "::" delimiter (R62.3)', () => {
    const qs = parseQuestionPrompts(
      'Here are some questions for you:\nCollaboration :: How did you work with the team?\nHope these help!',
    );
    expect(qs).toEqual([
      { competency: 'Collaboration', question: 'How did you work with the team?' },
    ]);
  });
});

describe('StarQuestionsOperation — scriptOnly (R22.5)', () => {
  it('issues zero provider calls and returns the deterministic question set', () => {
    const transport = vi.fn<AssistTransport>(async () => 'never');
    const op = createStarQuestionsOperation(transport);

    const outcome = op.scriptOnly({ role: ROLE, map: MAP });

    expect(transport).not.toHaveBeenCalled();
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.baseline.length).toBeGreaterThan(0);
  });
});

describe('StarQuestionsOperation — aiAssisted supplements, never replaces (R22.6)', () => {
  it('returns the full script question set as baseline plus confirmable AI questions', async () => {
    const transport = vi.fn<AssistTransport>(
      async () =>
        'Adaptability :: Tell me about a tricky deploy\nMentorship :: Describe a mentoring moment',
    );
    const op = new StarQuestionsOperation(transport);

    const scriptOnly = op.scriptOnly({ role: ROLE, map: MAP });
    const outcome = await op.aiAssisted({ role: ROLE, map: MAP }, DEST);

    // Baseline is the SAME (full) script set — AI supplements never replace it.
    expect(outcome.baseline.map((q) => q.id)).toEqual(scriptOnly.baseline.map((q) => q.id));
    // Each suggestion carries the competency it probes (R62.3); the question is
    // what the user sees, while the competency is retained for the loop/summary.
    expect(outcome.suggestions.map((s) => s.value)).toEqual([
      { competency: 'Adaptability', question: 'Tell me about a tricky deploy' },
      { competency: 'Mentorship', question: 'Describe a mentoring moment' },
    ]);
    expect(outcome.suggestions.every((s) => s.requiresConfirmation === true)).toBe(true);
  });
});

describe('buildStarQuestionsPrompt — behaviour-first for the given role (R22.6)', () => {
  it('asks the model to infer the key behaviours/qualities for the role and references the role', () => {
    const prompt = buildStarQuestionsPrompt(ROLE, MAP, DEST);
    expect(prompt).toContain('Backend Engineer');
    expect(prompt).toContain('Builds services.');
    // Behaviour-first: derive the qualities that matter for the role.
    expect(prompt).toMatch(/behaviours and qualities that matter MOST/i);
    // Technical depth is capped, not the focus.
    expect(prompt).toMatch(/at most\s+one question focused on technical depth/i);
    // Practice prompts only — never suggest facts for the candidate to claim (R22.9).
    expect(prompt).toMatch(/Do NOT suggest facts or outcomes/i);
  });
});

describe('StarQuestionsOperation — private-skill exclusion by destination (R22.7)', () => {
  const mixedMap: SkillMap = mapOf([
    entry('SKILL-a', 'JavaScript'),
    entry('SKILL-b', 'Secret Skill', { private: true }),
  ]);

  it('EXCLUDES private skills from the request for a keyed cloud destination (R22.7, R46.4)', async () => {
    const transport = vi.fn<AssistTransport>(async () => '');
    const op = new StarQuestionsOperation(transport);

    await op.aiAssisted({ role: ROLE, map: mixedMap }, DEST);

    const prompt = transport.mock.calls[0][0];
    expect(prompt).toContain('JavaScript');
    expect(prompt).not.toContain('Secret Skill');
  });

  it('INCLUDES private skills for a keyless local destination (R46.5)', async () => {
    const transport = vi.fn<AssistTransport>(async () => '');
    const op = new StarQuestionsOperation(transport);

    await op.aiAssisted({ role: ROLE, map: mixedMap }, LOCAL);

    const prompt = transport.mock.calls[0][0];
    expect(prompt).toContain('JavaScript');
    expect(prompt).toContain('Secret Skill');
  });

  it('treats an absent destination kind as third-party (excludes private)', () => {
    const prompt = buildStarQuestionsPrompt(ROLE, mixedMap, { provider: 'openai' });
    expect(prompt).not.toContain('Secret Skill');
  });
});

describe('StarSummaryOperation — scriptOnly teaching artefact (R28.5)', () => {
  it('issues zero provider calls and returns the deterministic teaching summary', () => {
    const transport = vi.fn<AssistTransport>(async () => 'never');
    const op = createStarSummaryOperation(transport);

    const outcome = op.scriptOnly({ answer: ANSWER });

    expect(transport).not.toHaveBeenCalled();
    expect(outcome.suggestions).toEqual([]);
    // Teaching artefact identifies S/T/A/R from the user's own content (R28.6).
    expect(outcome.baseline.situation.length).toBeGreaterThan(0);
    expect(outcome.baseline.task.length).toBeGreaterThan(0);
    expect(outcome.baseline.action.length).toBeGreaterThan(0);
    expect(outcome.baseline.result.length).toBeGreaterThan(0);
    // ...and explains what a good STAR answer looks like (R28.7).
    expect(outcome.baseline.guidance.length).toBeGreaterThan(0);
  });

  it('aiAssisted adds an AI teaching summary as a confirm-before-entry suggestion (R28.7)', async () => {
    const transport = vi.fn<AssistTransport>(
      async () => 'Your situation and task are clear; tie the result to a metric.',
    );
    const op = new StarSummaryOperation(transport);

    const outcome = await op.aiAssisted({ answer: ANSWER }, DEST);

    expect(outcome.baseline.guidance.length).toBeGreaterThan(0);
    expect(outcome.suggestions).toHaveLength(1);
    const suggested = outcome.suggestions[0];
    expect(suggested.requiresConfirmation).toBe(true);
    // The AI fills the guidance; the S/T/A/R stay the user's own content (R28.8).
    expect(suggested.value.guidance).toBe(
      'Your situation and task are clear; tie the result to a metric.',
    );
    expect(suggested.value.situation).toBe(outcome.baseline.situation);
    expect(suggested.value.result).toBe(outcome.baseline.result);
  });
});

describe('educationalSummary — opt-in teaching artefact bound to user content (R28.6–R28.8)', () => {
  it('identifies S/T/A/R from the answer and folds in AI guidance', async () => {
    const transport = vi.fn<AssistTransport>(async () => 'Name the result metric explicitly.');

    const summary = await educationalSummary(ANSWER, DEST, transport);

    const baseline = buildTeachingSummary(ANSWER);
    expect(summary.situation).toBe(baseline.situation);
    expect(summary.task).toBe(baseline.task);
    expect(summary.action).toBe(baseline.action);
    expect(summary.result).toBe(baseline.result);
    expect(summary.guidance).toBe('Name the result metric explicitly.');
  });

  it('forbids invented facts in the prompt and references only provided content (R28.8)', async () => {
    let seenPrompt = '';
    const transport = vi.fn<AssistTransport>(async (prompt) => {
      seenPrompt = prompt;
      return 'guidance';
    });

    await educationalSummary(ANSWER, DEST, transport);

    expect(seenPrompt).toMatch(/do not add, assume, or invent any fact/i);
    expect(seenPrompt).toContain('the service was failing under load');
  });

  it('falls back NON-BLOCKINGLY to the deterministic guidance on provider failure (R28.5)', async () => {
    const transport = vi.fn<AssistTransport>(async () => {
      throw new Error('provider down');
    });

    const summary = await educationalSummary(ANSWER, DEST, transport);
    const baseline = buildTeachingSummary(ANSWER);

    expect(summary.guidance).toBe(baseline.guidance);
    expect(summary.situation).toBe(baseline.situation);
  });
});

describe('Interview_Coach assist — provider failure fallback (runAssist)', () => {
  it('falls back to the deterministic baseline with a non-blocking error', async () => {
    const transport = vi.fn<AssistTransport>(async () => {
      throw new Error('timeout');
    });
    const op = createStarQuestionsOperation(transport);

    const { outcome, error } = await runAssist(
      op,
      { role: ROLE, map: MAP },
      { mode: 'ai-assisted', capability: 'star_questions' },
      DEST,
    );

    expect(outcome.baseline.length).toBeGreaterThan(0);
    expect(outcome.suggestions).toEqual([]);
    expect(error?.message).toContain('timeout');
  });
});

const ADEQUACY_INPUT: AdequacyInput = {
  role: ROLE,
  competency: 'Resilience',
  question: 'Tell me about a time a service failed under load.',
  answersSoFar: ['the service was failing under load and i owned the fix'],
};

describe('buildAdequacyPrompt — stateless, bound to the user words (R63.2, R63.7)', () => {
  it('carries the full context and forbids invented facts', () => {
    const prompt = buildAdequacyPrompt(ADEQUACY_INPUT);
    expect(prompt).toContain('Backend Engineer');
    expect(prompt).toContain('Resilience');
    expect(prompt).toContain('Tell me about a time a service failed under load.');
    // Every answer so far is carried (the model is stateless).
    expect(prompt).toContain('the service was failing under load and i owned the fix');
    // No-Fabrication framing (R63.7).
    expect(prompt).toMatch(/do not add, assume, or invent any fact/i);
    // The follow-up is a practice prompt, never a statement of fact (R63.7).
    expect(prompt).toMatch(/practice prompt, never a statement of fact/i);
    // The strict reply format is requested.
    expect(prompt).toContain('SITUATION: covered or missing');
    expect(prompt).toContain('ENOUGH: yes or no');
    expect(prompt).toContain('FOLLOWUP:');
  });

  it('renders a placeholder when no answer has been given yet', () => {
    const prompt = buildAdequacyPrompt({ ...ADEQUACY_INPUT, answersSoFar: [] });
    expect(prompt).toContain('(no answer yet)');
  });
});

describe('parseAdequacyReply — strict reply parsing (R63.2)', () => {
  it('parses coverage, ENOUGH=no, and a follow-up question', () => {
    const reply =
      'SITUATION: covered\nTASK: covered\nACTION: missing\nRESULT: missing\n' +
      'ENOUGH: no\nFOLLOWUP: What specific actions did you take to fix it?';
    expect(parseAdequacyReply(reply)).toEqual({
      situation: 'covered',
      task: 'covered',
      action: 'missing',
      result: 'missing',
      enough: false,
      followUp: 'What specific actions did you take to fix it?',
    });
  });

  it('parses ENOUGH=yes and FOLLOWUP=none into a null follow-up', () => {
    const reply =
      'SITUATION: covered\nTASK: covered\nACTION: covered\nRESULT: covered\n' +
      'ENOUGH: yes\nFOLLOWUP: none';
    const result = parseAdequacyReply(reply);
    expect(result.enough).toBe(true);
    expect(result.followUp).toBeNull();
  });

  it('tolerates markdown-bold labels and placeholder brackets around the follow-up', () => {
    const reply =
      '**SITUATION:** covered\n**TASK:** missing\n**ACTION:** missing\n' +
      '**RESULT:** missing\n**ENOUGH:** no\n**FOLLOWUP:** <What was your specific task?>';
    expect(parseAdequacyReply(reply)).toEqual({
      situation: 'covered',
      task: 'missing',
      action: 'missing',
      result: 'missing',
      enough: false,
      followUp: 'What was your specific task?',
    });
  });

  it('defaults unknown/missing fields conservatively (missing, not-enough, no follow-up)', () => {
    const result = parseAdequacyReply('the model rambled with no format at all');
    expect(result).toEqual({
      situation: 'missing',
      task: 'missing',
      action: 'missing',
      result: 'missing',
      enough: false,
      followUp: null,
    });
  });
});

describe('assessAdequacy — gate-routed stateless operation (R63.2, R63.7)', () => {
  it('sends one gated request and returns the parsed assessment', async () => {
    const transport = vi.fn<AssistTransport>(
      async () =>
        'SITUATION: covered\nTASK: missing\nACTION: missing\nRESULT: missing\n' +
        'ENOUGH: no\nFOLLOWUP: What were you specifically responsible for?',
    );

    const assessment = await assessAdequacy(ADEQUACY_INPUT, DEST, transport);

    expect(transport).toHaveBeenCalledTimes(1);
    // Routed to the given destination.
    expect(transport.mock.calls[0][1]).toEqual(DEST);
    expect(assessment.situation).toBe('covered');
    expect(assessment.enough).toBe(false);
    expect(assessment.followUp).toBe('What were you specifically responsible for?');
  });
});

const SUMMARY_INPUT: PerQuestionSummaryInput = {
  role: ROLE,
  competency: 'Resilience',
  question: 'Tell me about a time a service failed under load.',
  fullAnswer:
    'the service was failing under load and i owned the reliability fix. ' +
    'i added autoscaling and caching, and we cut error rates by half.',
};

describe('buildPerQuestionSummaryPrompt — stateless, bound to the user words (R63.6, R63.7)', () => {
  it('carries the full context, the full answer, and forbids invented facts/skills', () => {
    const prompt = buildPerQuestionSummaryPrompt(SUMMARY_INPUT);
    expect(prompt).toContain('Backend Engineer');
    expect(prompt).toContain('Resilience');
    expect(prompt).toContain('Tell me about a time a service failed under load.');
    // The full answer is carried (the model is stateless).
    expect(prompt).toContain('i added autoscaling and caching');
    // No-Fabrication framing: summary AND skills only from the user's words (R63.7).
    expect(prompt).toMatch(/do not add, assume, or invent any fact/i);
    expect(prompt).toMatch(/MUST be drawn solely from what the\s+candidate actually said/i);
    // The strict reply format is requested.
    expect(prompt).toContain('SUMMARY:');
    expect(prompt).toContain('STAR:');
    expect(prompt).toContain('SKILLS:');
    expect(prompt).toContain('TIPS:');
  });

  it('renders a placeholder when no answer was given', () => {
    const prompt = buildPerQuestionSummaryPrompt({ ...SUMMARY_INPUT, fullAnswer: '' });
    expect(prompt).toContain('(no answer given)');
  });
});

describe('parsePerQuestionSummaryReply — strict reply parsing (R63.6)', () => {
  it('parses summary, STAR coverage, a skills list, and tips', () => {
    const reply =
      'SUMMARY: I owned the reliability fix for a service failing under load. ' +
      'I added autoscaling and caching and cut error rates by half.\n' +
      'STAR: Situation, Task, Action and Result all covered.\n' +
      'SKILLS: Reliability engineering, Autoscaling, Caching\n' +
      'TIPS: Quantify the before/after error rate. Name the team size you led.';
    expect(parsePerQuestionSummaryReply(reply)).toEqual({
      summary:
        'I owned the reliability fix for a service failing under load. ' +
        'I added autoscaling and caching and cut error rates by half.',
      star: 'Situation, Task, Action and Result all covered.',
      skills: ['Reliability engineering', 'Autoscaling', 'Caching'],
      tips: ['Quantify the before/after error rate. Name the team size you led.'],
    });
  });

  it('parses SKILLS=none into an empty list and tolerates markdown-bold labels', () => {
    const reply =
      '**SUMMARY:** I described the situation only.\n' +
      '**STAR:** Only Situation covered.\n' +
      '**SKILLS:** none\n' +
      '**TIPS:**\n- State the task you owned.\n- Describe the actions you took.';
    expect(parsePerQuestionSummaryReply(reply)).toEqual({
      summary: 'I described the situation only.',
      star: 'Only Situation covered.',
      skills: [],
      tips: ['State the task you owned.', 'Describe the actions you took.'],
    });
  });

  it('de-duplicates skills case-insensitively and supports multi-line summary', () => {
    const reply =
      'SUMMARY: First sentence.\nSecond sentence on a new line.\n' +
      'STAR: All four covered.\n' +
      'SKILLS: Leadership, leadership, Mentoring\n' +
      'TIPS: Add a metric.';
    const result = parsePerQuestionSummaryReply(reply);
    expect(result.summary).toBe('First sentence.\nSecond sentence on a new line.');
    expect(result.skills).toEqual(['Leadership', 'Mentoring']);
  });

  it('defaults missing fields to empty strings/lists', () => {
    const result = parsePerQuestionSummaryReply('the model rambled with no format');
    expect(result).toEqual({ summary: '', star: '', skills: [], tips: [] });
  });
});

describe('perQuestionSummary — gate-routed stateless operation (R63.6, R63.7)', () => {
  it('sends one gated request and returns the parsed summary', async () => {
    const transport = vi.fn<AssistTransport>(
      async () =>
        'SUMMARY: I fixed a failing service.\nSTAR: All covered.\n' +
        'SKILLS: Reliability\nTIPS: Add a metric.',
    );

    const summary = await perQuestionSummary(SUMMARY_INPUT, DEST, transport);

    expect(transport).toHaveBeenCalledTimes(1);
    // Routed to the given destination.
    expect(transport.mock.calls[0][1]).toEqual(DEST);
    expect(summary.summary).toBe('I fixed a failing service.');
    expect(summary.star).toBe('All covered.');
    expect(summary.skills).toEqual(['Reliability']);
    expect(summary.tips).toEqual(['Add a metric.']);
  });
});
