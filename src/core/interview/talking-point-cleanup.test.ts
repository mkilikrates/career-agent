import { describe, it, expect } from 'vitest';
import {
  cleanPolishedField,
  cleanStarElementField,
  parseInterview,
  serializeInterview,
} from './index';
import { asSkillId, asStarId } from '@core/types';
import type { TalkingPoint } from '@core/types';

// --- cleanStarElementField ---------------------------------------------------

describe('cleanStarElementField — removes inline nested/duplicated content (R28.6)', () => {
  it('returns undefined unchanged', () => {
    expect(cleanStarElementField(undefined)).toEqual({ value: undefined });
  });

  it('returns empty string unchanged', () => {
    expect(cleanStarElementField('')).toEqual({ value: '' });
  });

  it('returns clean text unchanged', () => {
    const text = 'I built a CI/CD pipeline at Finoa using GitLab and AWS CodeBuild.';
    expect(cleanStarElementField(text)).toEqual({ value: text });
  });

  it('strips duplicated content after "skills SKILL-x polished" marker', () => {
    const raw =
      'I was in a situation where all SDLC were only partially automated running only unit tests ' +
      'and in some cases some integration or behavior tests using python behave and localstack ' +
      'the release process was manually handout between developer devops security and managers ' +
      'skills SKILL-problem-solving SKILL-continuous-improvement polished ' +
      'I was in a situation where all SDLC were only partially automated running only unit tests ' +
      'and in some cases some integration or behavior tests using python behave and localstack ' +
      'the release process was manually handout between developer devops security and managers';
    const result = cleanStarElementField(raw);
    expect(result.value).toBe(
      'I was in a situation where all SDLC were only partially automated running only unit tests ' +
      'and in some cases some integration or behavior tests using python behave and localstack ' +
      'the release process was manually handout between developer devops security and managers',
    );
    expect(result.skills).toEqual(['SKILL-problem-solving', 'SKILL-continuous-improvement']);
  });

  it('does not strip content when "skills" appears as a normal word mid-sentence', () => {
    const text = 'I used my communication skills to align the team on the roadmap.';
    expect(cleanStarElementField(text)).toEqual({ value: text });
  });
});

// --- cleanPolishedField ------------------------------------------------------

describe('cleanPolishedField — strips nested markdown from polished text (R28.6)', () => {
  it('returns empty string unchanged', () => {
    expect(cleanPolishedField('')).toBe('');
  });

  it('returns a clean polished sentence unchanged', () => {
    const text = 'I built a fully automated CI/CD pipeline at Finoa, reducing release time from days to minutes.';
    expect(cleanPolishedField(text)).toBe(text);
  });

  it('returns empty for polished that starts with "I - **Situation:**"', () => {
    const corrupted =
      'I - **Situation:** i was in a situation where at finoa all sdlc were only partially automated...';
    expect(cleanPolishedField(corrupted)).toBe('');
  });

  it('returns empty for polished that starts with "I was in a situation where - **"', () => {
    const corrupted =
      'I was in a situation where - **Skills:** SKILL-foo, SKILL-bar - **Polished:** some text';
    expect(cleanPolishedField(corrupted)).toBe('');
  });

  it('truncates polished at embedded " - **Skills:**" marker', () => {
    const corrupted =
      'I built a CI/CD pipeline reducing release time from days to minutes - **Skills:** SKILL-ci-cd - **Polished:** repeated content here';
    expect(cleanPolishedField(corrupted)).toBe(
      'I built a CI/CD pipeline reducing release time from days to minutes',
    );
  });

  it('truncates polished at embedded " - **Situation:**" marker', () => {
    const corrupted =
      'I led the initiative to automate the SDLC at Finoa - **Situation:** raw user text here again';
    expect(cleanPolishedField(corrupted)).toBe(
      'I led the initiative to automate the SDLC at Finoa',
    );
  });
});

// --- Integration: parseInterview cleans up corrupted talking points -----------

describe('parseInterview — clean-up migration for corrupted talking points (R28.6)', () => {
  it('parses a talking point with duplicated Situation + inline skills marker and produces clean fields', () => {
    const rawAnswer = 'i was in a situation where at finoa all sdlc were only partially automated running only unit tests';
    const corrupted = `---
role: backend-engineer
title: Backend Engineer
ids:
  - STAR-01
---
# Interview

## Questions

## Talking Points

### Talking Point — STAR-01

<!-- id: STAR-01 -->

- **Status:** active
- **Situation:** ${rawAnswer} skills SKILL-problem-solving SKILL-continuous-improvement polished ${rawAnswer}
- **Skills:** SKILL-mentoring, SKILL-coaching
- **Polished:** I - **Situation:** ${rawAnswer}
`;

    const file = parseInterview(corrupted);
    expect(file.talkingPoints).toHaveLength(1);
    const tp = file.talkingPoints![0];

    // Situation should contain ONLY the raw answer (one copy, no inline skills/polished).
    expect(tp.situation).toBe(rawAnswer);

    // Skills should merge the explicit list with those extracted from the inline marker.
    const skillIds = tp.skills.map((s) => s as unknown as string);
    expect(skillIds).toContain('SKILL-mentoring');
    expect(skillIds).toContain('SKILL-coaching');
    expect(skillIds).toContain('SKILL-problem-solving');
    expect(skillIds).toContain('SKILL-continuous-improvement');

    // Polished should be empty (entirely corrupted — started with "I - **Situation:**").
    expect(tp.polished).toBe('');
  });

  it('round-trips a clean talking point unchanged', () => {
    const tp: TalkingPoint = {
      id: asStarId('STAR-01'),
      flags: [],
      polished: 'I built a CI/CD pipeline at Finoa reducing release cycles from days to minutes.',
      skills: [asSkillId('SKILL-ci-cd'), asSkillId('SKILL-aws-codebuild')],
      situation: 'At Finoa, the SDLC was only partially automated.',
      task: 'Automate the full CI/CD pipeline.',
      action: 'I created a PoC and iterated with stakeholders.',
      result: 'Release time dropped from days to minutes.',
    };
    const file = {
      roleSlug: 'backend-engineer' as never,
      roleTitle: 'Backend Engineer',
      questions: [],
      talkingPoints: [tp],
    };
    const serialized = serializeInterview(file);
    const parsed = parseInterview(serialized);
    expect(parsed.talkingPoints).toHaveLength(1);
    const round = parsed.talkingPoints![0];
    expect(round.situation).toBe(tp.situation);
    expect(round.task).toBe(tp.task);
    expect(round.action).toBe(tp.action);
    expect(round.result).toBe(tp.result);
    expect(round.polished).toBe(tp.polished);
    expect(round.skills.map((s) => s as unknown as string).sort()).toEqual(
      tp.skills.map((s) => s as unknown as string).sort(),
    );
  });

  it('serialization of a corrupted talking point produces clean output', () => {
    const rawAnswer = 'i was in a situation where at finoa the sdlc was only partially automated with basic unit tests';
    const corruptedTp: TalkingPoint = {
      id: asStarId('STAR-02'),
      flags: [],
      // Corrupted: situation has inline skills marker and repeated content
      situation: `${rawAnswer} skills SKILL-problem-solving SKILL-ci-cd polished ${rawAnswer}`,
      polished: `I - **Situation:** ${rawAnswer}`,
      skills: [asSkillId('SKILL-devops')],
    };
    const file = {
      roleSlug: 'backend-engineer' as never,
      roleTitle: 'Backend Engineer',
      questions: [],
      talkingPoints: [corruptedTp],
    };
    const serialized = serializeInterview(file);

    // The serialized output should NOT contain the duplicated content.
    const situationLine = serialized.split('\n').find((l) => l.startsWith('- **Situation:**'));
    expect(situationLine).toBeDefined();
    // Should not contain "skills SKILL-" inline marker.
    expect(situationLine).not.toMatch(/skills SKILL-/);
    // The polished line should be empty (corrupted input cleaned to '').
    const polishedLine = serialized.split('\n').find((l) => l.startsWith('- **Polished:**'));
    expect(polishedLine).toBe('- **Polished:** ');
  });
});
