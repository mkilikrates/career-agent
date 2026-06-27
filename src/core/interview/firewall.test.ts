import { describe, it, expect } from 'vitest';
import { asQuestionId } from '@core/types';
import type { StarAnswer, StarElement } from '@core/types';
import {
  STAR_ORDER,
  DEFAULT_DELIVERY_LEXICON,
  contentTokens,
  normaliseContent,
  analyse,
  contentContribution,
  newAnswer,
} from './index';

const QID = asQuestionId('Q-01');

/**
 * Build a complete STAR answer from the four element strings. Defaults give a
 * coherent, content-bearing answer; callers override individual elements.
 */
const answerOf = (elements: Partial<Record<StarElement, string>>): StarAnswer => ({
  ...newAnswer(QID),
  ...elements,
  status: 'complete',
});

describe('content/delivery firewall — fillers, hesitations, disfluencies (R27.2)', () => {
  it('ignores single-word filler words', () => {
    const clean = 'I led the migration to the new platform';
    const noisy = 'so I basically led the migration to the new platform honestly';
    expect(normaliseContent(noisy)).toBe(normaliseContent(clean));
  });

  it('ignores hesitation tokens', () => {
    const clean = 'I reduced latency across the service';
    const noisy = 'um I uh reduced erm latency across the service ah';
    expect(normaliseContent(noisy)).toBe(normaliseContent(clean));
  });

  it('collapses repeated / stuttered words', () => {
    const clean = 'the the team shipped it';
    const noisy = 'the-the-the team shipped shipped it';
    expect(normaliseContent(noisy)).toBe(normaliseContent(clean));
    // Both reduce to a single canonical content string.
    expect(normaliseContent(noisy)).toBe('the team shipped it');
  });

  it('removes multi-word filler phrases', () => {
    const clean = 'we improved the onboarding flow';
    const noisy = 'we improved, you know, the onboarding flow, sort of';
    expect(normaliseContent(noisy)).toBe(normaliseContent(clean));
  });

  it('strips bracketed and parenthetical transcription artefacts', () => {
    const clean = 'I owned the release process end to end';
    const noisy = 'I owned [inaudible] the release process (background noise) end to end';
    expect(normaliseContent(noisy)).toBe(normaliseContent(clean));
  });

  it('preserves genuine parenthetical content that is not an artefact', () => {
    const text = 'I shipped the API (version two) on time';
    // The parenthetical is real content, so it is preserved (not stripped).
    expect(contentTokens(text)).toContain('two');
    expect(contentTokens(text)).toContain('version');
  });

  it('preserves interior punctuation of real content tokens', () => {
    expect(contentTokens('I wrote it in C++ and C#')).toEqual([
      'i',
      'wrote',
      'it',
      'in',
      'c++',
      'and',
      'c#',
    ]);
  });

  it('a fully delivery-augmented transcript equals the clean transcript', () => {
    const clean = 'I migrated the database and cut query time';
    const noisy =
      'um so, you know, I-I migrated [pause] the database and, uh, basically cut cut query time honestly';
    expect(normaliseContent(noisy)).toBe(normaliseContent(clean));
  });
});

describe('content/delivery firewall — accent / dialect neutrality (R27.2)', () => {
  it('treats contractions like "gonna" as "going to"', () => {
    expect(normaliseContent('I am gonna own it')).toBe(
      normaliseContent('I am going to own it'),
    );
  });

  it('treats British and American spellings identically', () => {
    expect(normaliseContent('I organised the colour analysis')).toBe(
      normaliseContent('I organized the color analysis'),
    );
  });

  it('neutralises a mix of dialect markers across a sentence', () => {
    const british = 'I wanna optimise and prioritise the behaviour';
    const american = 'I want to optimize and prioritize the behavior';
    expect(normaliseContent(british)).toBe(normaliseContent(american));
  });
});

describe('content/delivery firewall — analyse() is delivery-invariant (R27.1, R27.2)', () => {
  const clean = answerOf({
    situation: 'Our checkout service was failing under peak load',
    task: 'I had to stabilise it before the holiday rush',
    action: 'I profiled the hot paths and added caching',
    result: 'We cut error rates by ninety percent',
  });

  const noisy = answerOf({
    situation: 'so um Our checkout service was, you know, failing under peak peak load',
    task: 'I uh had to stabilise it, sort of, before the the holiday rush honestly',
    action: 'basically I-I profiled the hot paths [pause] and added caching',
    result: 'we, I mean, cut cut error rates by ninety percent (background noise)',
  });

  it('produces an identical ContentAnalysis for clean vs delivery-augmented', () => {
    expect(analyse(noisy)).toEqual(analyse(clean));
  });

  it('produces identical per-element content across all STAR elements', () => {
    const a = analyse(clean);
    const b = analyse(noisy);
    for (const element of STAR_ORDER) {
      expect(b.elements[element]).toBe(a.elements[element]);
    }
  });

  it('carries no delivery signal — only a content word count', () => {
    const a = analyse(clean);
    expect(a.contentWordCount).toBe(a.tokens.length);
    expect(a).not.toHaveProperty('fillerCount');
    expect(a).not.toHaveProperty('disfluencyScore');
  });
});

describe('content/delivery firewall — contentContribution is delivery-invariant (R27.1)', () => {
  const clean = answerOf({
    situation: 'The team had no deployment pipeline',
    task: 'I was asked to automate releases',
    action: 'I built a continuous delivery workflow',
    result: 'Deploys went from weekly to on demand',
  });

  const noisy = answerOf({
    situation: 'um so The team had, you know, no deployment pipeline right',
    task: 'I was uh asked to, sort of, automate automate releases',
    action: 'basically I-I built a continuous delivery workflow [inaudible]',
    result: 'so Deploys went from weekly to on demand honestly (pause)',
  });

  it('yields an identical contribution for clean vs delivery-augmented', () => {
    expect(contentContribution(noisy)).toEqual(contentContribution(clean));
  });

  it('preserves the contributing questionId', () => {
    expect(contentContribution(clean).questionId).toBe(QID);
  });

  it('contributes per-STAR-element content equal across delivery variation', () => {
    const a = contentContribution(clean);
    const b = contentContribution(noisy);
    for (const element of STAR_ORDER) {
      expect(b.elements[element]).toBe(a.elements[element]);
    }
  });
});

describe('content/delivery firewall — sanity: real content still differs (R27.1)', () => {
  it('genuinely different content produces a different analysis', () => {
    const a = answerOf({ situation: 'I led a database migration project' });
    const b = answerOf({ situation: 'I designed a mobile onboarding flow' });
    expect(analyse(a)).not.toEqual(analyse(b));
    expect(analyse(a).content).not.toBe(analyse(b).content);
  });

  it('does not collapse content to empty when only delivery is removed', () => {
    const a = analyse(
      answerOf({ situation: 'Our checkout service was failing under peak load' }),
    );
    expect(a.contentWordCount).toBeGreaterThan(0);
    expect(a.content.length).toBeGreaterThan(0);
  });

  it('an answer of pure delivery noise normalises to empty content', () => {
    const a = analyse(answerOf({ situation: 'um uh you know basically, honestly so' }));
    expect(a.content).toBe('');
    expect(a.contentWordCount).toBe(0);
  });

  it('the shipped lexicon exposes all delivery categories used by the firewall', () => {
    expect(DEFAULT_DELIVERY_LEXICON.fillers.length).toBeGreaterThan(0);
    expect(DEFAULT_DELIVERY_LEXICON.hesitations.length).toBeGreaterThan(0);
    expect(DEFAULT_DELIVERY_LEXICON.fillerPhrases.length).toBeGreaterThan(0);
    expect(DEFAULT_DELIVERY_LEXICON.transcriptionArtefacts.length).toBeGreaterThan(0);
    expect(Object.keys(DEFAULT_DELIVERY_LEXICON.dialectVariants).length).toBeGreaterThan(0);
  });
});
