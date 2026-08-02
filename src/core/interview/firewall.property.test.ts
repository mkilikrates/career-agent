// Feature: career-agent, Property 15: Content/delivery firewall (metamorphic)
//
// For any answer transcript, augmenting it with delivery-only variations (filler
// words, hesitations, dialect or accent markers, transcription artefacts) yields
// an identical content analysis and an identical contribution to the skill map
// and CV path.
//
// **Validates: Requirements 27.1, 27.2**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { StarAnswer } from '@core/types';
import { asQuestionId } from '@core/types';
import { analyse, contentContribution, DEFAULT_DELIVERY_LEXICON } from './firewall';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const QID = asQuestionId('Q-01');

/** Generate content text (non-filler words, lowercase alphabetic). */
const arbContentWord = fc.stringMatching(/^[a-z]{3,10}$/);

/** Generate a content sentence (3-8 content words). */
const arbContentSentence = fc
  .array(arbContentWord, { minLength: 3, maxLength: 8 })
  .map((words) => words.join(' '));

/** Pick random filler words from the delivery lexicon. */
const arbFillers = fc.subarray([...DEFAULT_DELIVERY_LEXICON.fillers], { minLength: 1, maxLength: 5 });

/** Pick random hesitation words. */
const arbHesitations = fc.subarray([...DEFAULT_DELIVERY_LEXICON.hesitations], { minLength: 1, maxLength: 4 });

/** Pick random filler phrases. */
const arbFillerPhrases = fc.subarray([...DEFAULT_DELIVERY_LEXICON.fillerPhrases], { minLength: 0, maxLength: 3 });

/** Pick random transcription artefacts (bracketed). */
const arbArtefacts = fc
  .subarray([...DEFAULT_DELIVERY_LEXICON.transcriptionArtefacts], { minLength: 0, maxLength: 3 })
  .map((arts) => arts.map((a) => `[${a}]`));

/**
 * Augment a content text with delivery noise: intersperse fillers, hesitations,
 * and artefacts at random positions. Dialect variants are NOT injected because
 * they are replaced (not stripped) — the property is that fillers/hesitations/
 * artefacts are invisible to content analysis.
 */
const arbAugmented = (content: string) =>
  fc
    .tuple(arbFillers, arbHesitations, arbArtefacts, arbFillerPhrases)
    .map(([fillers, hesitations, artefacts, phrases]) => {
      const words = content.split(' ');
      const noise: string[] = [
        ...fillers,
        ...hesitations,
        ...artefacts,
        ...phrases,
      ];
      // Intersperse noise around content words
      const result: string[] = [];
      for (let i = 0; i < words.length; i++) {
        if (noise.length > 0 && i % 2 === 0) {
          result.push(noise.shift()!);
        }
        result.push(words[i]);
      }
      // Append remaining noise
      result.push(...noise);
      return result.join(' ');
    });

/** Generate a StarAnswer from content sentences. */
const arbAnswer = fc
  .tuple(arbContentSentence, arbContentSentence, arbContentSentence, arbContentSentence)
  .map(([s, t, a, r]): StarAnswer => ({
    questionId: QID,
    situation: s,
    task: t,
    action: a,
    result: r,
    flags: [],
    status: 'complete',
  }));

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('@core/interview — Property 15: Content/delivery firewall (metamorphic)', () => {
  it('augmenting with delivery noise yields an identical ContentAnalysis', () => {
    fc.assert(
      fc.property(
        arbAnswer.chain((answer) =>
          fc.tuple(
            fc.constant(answer),
            arbAugmented(answer.situation ?? ''),
            arbAugmented(answer.task ?? ''),
            arbAugmented(answer.action ?? ''),
            arbAugmented(answer.result ?? ''),
          ),
        ),
        ([clean, noisySit, noisyTask, noisyAction, noisyResult]) => {
          const noisy: StarAnswer = {
            ...clean,
            situation: noisySit,
            task: noisyTask,
            action: noisyAction,
            result: noisyResult,
          };

          const cleanAnalysis = analyse(clean);
          const noisyAnalysis = analyse(noisy);

          // Content analysis is identical regardless of delivery noise
          expect(noisyAnalysis.content).toBe(cleanAnalysis.content);
          expect(noisyAnalysis.tokens).toEqual(cleanAnalysis.tokens);
          expect(noisyAnalysis.elements).toEqual(cleanAnalysis.elements);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('augmenting with delivery noise yields an identical ContentContribution', () => {
    fc.assert(
      fc.property(
        arbAnswer.chain((answer) =>
          fc.tuple(
            fc.constant(answer),
            arbAugmented(answer.situation ?? ''),
            arbAugmented(answer.action ?? ''),
          ),
        ),
        ([clean, noisySit, noisyAction]) => {
          const noisy: StarAnswer = {
            ...clean,
            situation: noisySit,
            action: noisyAction,
          };

          const cleanContrib = contentContribution(clean);
          const noisyContrib = contentContribution(noisy);

          expect(noisyContrib.content).toBe(cleanContrib.content);
          expect(noisyContrib.tokens).toEqual(cleanContrib.tokens);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('genuinely different content produces different analyses', () => {
    fc.assert(
      fc.property(arbContentSentence, arbContentSentence, (a, b) => {
        if (a === b) return;
        const answerA: StarAnswer = { questionId: QID, situation: a, flags: [], status: 'in_progress' };
        const answerB: StarAnswer = { questionId: QID, situation: b, flags: [], status: 'in_progress' };
        const analysisA = analyse(answerA);
        const analysisB = analyse(answerB);
        // Different real content should (very likely) produce different tokens
        // This is a sanity check, not 100% guaranteed for all random pairs
        if (analysisA.content !== analysisB.content) {
          expect(analysisA.tokens).not.toEqual(analysisB.tokens);
        }
      }),
      { numRuns: 100 },
    );
  });
});
