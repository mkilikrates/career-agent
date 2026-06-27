// The content/delivery firewall (R27).
//
// Requirement 27 is a TRUST guarantee: a user's answers must be judged on their
// substance, never on how they were delivered. Accent, dialect, hesitations,
// verbal tics, non-standard phrasing, and transcription artefacts must never
// lower assessed quality (R27.2), and ONLY content analysis may flow into the
// skill map and CV outputs (R27.1).
//
// The design makes this a HARD STRUCTURAL BOUNDARY rather than a scoring model:
// `analyse()` operates only on transcript text classified as *content*; delivery
// signals (fillers, hesitations, accent, dialect, disfluencies, transcription
// artefacts) are never computed in Phase 1 and so can never enter the skill map
// or CV path. This module realises that boundary by NORMALISING an answer to its
// content — stripping/neutralising delivery — and exposing only the normalised
// content. No delivery metric (filler count, pace, disfluency score, …) is ever
// computed or stored: delivery is simply removed and ignored, never scored.
//
// The structural consequence (design Property 15, metamorphic, reserved for the
// optional test 12.5) is that augmenting any transcript with delivery-only
// variation — filler words, hesitations, dialect/accent markers, transcription
// artefacts — yields an IDENTICAL {@link ContentAnalysis} and an identical
// {@link ContentContribution} to the skill map and CV path. Because both the
// base and the augmented transcript pass through the SAME normaliser and the
// normaliser removes exactly the delivery lexicon below, the two collapse to the
// same canonical content.
//
// The delivery lexicon ({@link DEFAULT_DELIVERY_LEXICON}) is the single,
// extensible source of truth for what counts as delivery; it is exported so it
// can be extended without code change and so tests draw delivery noise from the
// same place the firewall removes it. Everything here is pure and deterministic:
// framework-agnostic, no I/O, no providers.

import type {
  ContentAnalysis,
  ContentContribution,
  StarAnswer,
  StarElement,
} from '@core/types';
import { STAR_ORDER } from './coach';

// --- The delivery lexicon (the single source of truth for "delivery") -------

/**
 * The extensible catalogue of DELIVERY signals the firewall neutralises (R27.2).
 * Anything here is treated as neutral with respect to content quality: it is
 * removed (fillers/hesitations/artefacts) or rewritten to a canonical content
 * form (dialect/accent variants) before any content analysis. Extend these
 * lists to recognise more delivery noise without touching the algorithm.
 */
export interface DeliveryLexicon {
  /** Single-word filler / verbal-tic tokens, e.g. "like", "basically". */
  readonly fillers: readonly string[];
  /** Hesitation tokens, e.g. "um", "uh", "erm". */
  readonly hesitations: readonly string[];
  /** Multi-word filler phrases, e.g. "you know", "sort of". */
  readonly fillerPhrases: readonly string[];
  /**
   * Transcription-artefact marker words. They appear inside bracketed
   * annotations a transcriber inserts — `[inaudible]`, `(pause)`, `[laughter]`
   * — which are stripped whole.
   */
  readonly transcriptionArtefacts: readonly string[];
  /**
   * Dialect / accent / non-standard-phrasing variants mapped to a canonical
   * content form, e.g. `gonna` → `going to`, `colour` → `color`. Both spellings
   * therefore analyse identically, so dialect and accent are neutral (R27.2).
   */
  readonly dialectVariants: Readonly<Record<string, string>>;
}

/**
 * The shipped delivery lexicon (R27.2). Conservative and extensible: it lists
 * common verbal tics, hesitations, transcription markers, and dialect/spelling
 * variants. Callers may pass their own {@link DeliveryLexicon} to extend it.
 */
export const DEFAULT_DELIVERY_LEXICON: DeliveryLexicon = {
  fillers: [
    'like',
    'so',
    'well',
    'right',
    'okay',
    'ok',
    'basically',
    'actually',
    'literally',
    'honestly',
    'seriously',
    'obviously',
    'essentially',
    'anyway',
    'anyhow',
    'anyways',
    'yeah',
    'yep',
    'hmm',
  ],
  hesitations: [
    'um',
    'umm',
    'ummm',
    'uh',
    'uhh',
    'uhhh',
    'er',
    'err',
    'erm',
    'ah',
    'ahh',
    'eh',
    'mm',
    'mmm',
    'hm',
  ],
  fillerPhrases: [
    'you know',
    'i mean',
    'sort of',
    'kind of',
    'you see',
    'i guess',
    'or something',
    'and stuff',
    'and so on',
  ],
  transcriptionArtefacts: [
    'inaudible',
    'unintelligible',
    'crosstalk',
    'pause',
    'silence',
    'laughs',
    'laughter',
    'sighs',
    'coughs',
    'background',
    'noise',
    'music',
    'applause',
  ],
  dialectVariants: {
    gonna: 'going to',
    wanna: 'want to',
    gotta: 'got to',
    gimme: 'give me',
    lemme: 'let me',
    kinda: 'kind of',
    sorta: 'sort of',
    outta: 'out of',
    colour: 'color',
    colours: 'colors',
    behaviour: 'behavior',
    organise: 'organize',
    organised: 'organized',
    organisation: 'organization',
    analyse: 'analyze',
    analysed: 'analyzed',
    recognise: 'recognize',
    optimise: 'optimize',
    optimised: 'optimized',
    prioritise: 'prioritize',
    prioritised: 'prioritized',
    centre: 'center',
  },
};

// --- Normalisation primitives ----------------------------------------------

/** Escape a literal string for safe interpolation into a `RegExp`. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Punctuation treated as NOISE when it sits at a token's edge (R27.2). Trimmed
 * from each side of a token; characters interior to a token (e.g. the `+` in
 * `C++`, the `#` in `C#`, the `-` in `well-being`) are preserved so content is
 * not corrupted.
 */
const EDGE_PUNCTUATION =
  /^[\s.,;:!?…"'`´()[\]{}<>«»\-–—*_~|/\\]+|[\s.,;:!?…"'`´()[\]{}<>«»\-–—*_~|/\\]+$/g;

/** Trim edge punctuation/whitespace from a single token. */
const trimToken = (token: string): string => token.replace(EDGE_PUNCTUATION, '');

/**
 * Strip transcription artefacts (R27.2). Square-bracket annotations are removed
 * wholesale (`[inaudible]`, `[crosstalk]`); a parenthetical is removed only when
 * every word inside it is an artefact marker (`(pause)`, `(background noise)`),
 * so genuine parenthetical content is preserved.
 */
const stripArtefacts = (text: string, lexicon: DeliveryLexicon): string => {
  const markers = new Set(lexicon.transcriptionArtefacts.map((m) => m.toLowerCase()));
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\(([^)]*)\)/g, (whole, inner: string) => {
      const words = inner.toLowerCase().trim().split(/\s+/).filter(Boolean);
      return words.length > 0 && words.every((w) => markers.has(trimToken(w))) ? ' ' : whole;
    });
};

/** Rewrite dialect/accent variants to their canonical content form (R27.2). */
const expandDialect = (text: string, lexicon: DeliveryLexicon): string => {
  let out = text;
  for (const [variant, canonical] of Object.entries(lexicon.dialectVariants)) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(variant)}\\b`, 'gi'), canonical);
  }
  return out;
};

/** Remove multi-word filler phrases (R27.2). */
const removeFillerPhrases = (text: string, lexicon: DeliveryLexicon): string => {
  let out = text;
  for (const phrase of lexicon.fillerPhrases) {
    const spaced = phrase.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
    out = out.replace(new RegExp(`\\b${spaced}\\b`, 'gi'), ' ');
  }
  return out;
};

/**
 * Collapse same-word disfluency stutters (R27.2): `I-I-I` → `I`, `the-the` →
 * `the`. Only identical whole words joined by hyphens collapse, so genuine
 * hyphenated terms (`well-being`) are untouched.
 */
const collapseStutters = (text: string): string =>
  text.replace(/\b(\w+)(?:-\1\b)+/gi, '$1');

/**
 * Reduce a transcript to its canonical content TOKENS (R27.1, R27.2). The
 * pipeline removes every delivery signal in {@link lexicon}:
 *   1. strip transcription-artefact annotations;
 *   2. collapse same-word stutters;
 *   3. lower-case (casing is delivery noise here);
 *   4. expand dialect/accent variants to a canonical form;
 *   5. remove multi-word filler phrases;
 *   6. tokenise, trimming edge-punctuation noise;
 *   7. drop single-word fillers and hesitations;
 *   8. collapse consecutive duplicate tokens.
 * The result is the answer's content with delivery removed — never scored.
 */
export const contentTokens = (
  text: string,
  lexicon: DeliveryLexicon = DEFAULT_DELIVERY_LEXICON,
): string[] => {
  if (!text) return [];

  const fillers = new Set(lexicon.fillers.map((f) => f.toLowerCase()));
  const hesitations = new Set(lexicon.hesitations.map((h) => h.toLowerCase()));

  const prepared = removeFillerPhrases(
    expandDialect(collapseStutters(stripArtefacts(text, lexicon)).toLowerCase(), lexicon),
    lexicon,
  );

  const tokens: string[] = [];
  for (const raw of prepared.split(/\s+/)) {
    const token = trimToken(raw);
    if (token.length === 0) continue;
    if (fillers.has(token) || hesitations.has(token)) continue;
    // Collapse a token identical to the one just kept (e.g. "the the").
    if (tokens.length > 0 && tokens[tokens.length - 1] === token) continue;
    tokens.push(token);
  }
  return tokens;
};

/**
 * The canonical, delivery-stripped content text of a transcript (R27.1, R27.2):
 * {@link contentTokens} joined by single spaces. Two transcripts differing only
 * in delivery normalise to the same string.
 */
export const normaliseContent = (
  text: string,
  lexicon: DeliveryLexicon = DEFAULT_DELIVERY_LEXICON,
): string => contentTokens(text, lexicon).join(' ');

// --- The firewall (analyse + contribution) ---------------------------------

/**
 * Analyse an answer's CONTENT only (R27.1, R27.2) — the content/delivery
 * firewall. Each STAR element is reduced to its canonical content via
 * {@link normaliseContent}; the whole-answer tokens are the elements'
 * content tokens in STAR order. The result carries NO delivery signal of any
 * kind, so two answers differing only in delivery (fillers, hesitations,
 * accent, dialect, non-standard phrasing, transcription artefacts) produce an
 * identical {@link ContentAnalysis} (design Property 15). Pure; never mutates
 * the input.
 */
export const analyse = (
  answer: StarAnswer,
  lexicon: DeliveryLexicon = DEFAULT_DELIVERY_LEXICON,
): ContentAnalysis => {
  const elements = {} as Record<StarElement, string>;
  const tokens: string[] = [];
  for (const element of STAR_ORDER) {
    const elementTokens = contentTokens(answer[element] ?? '', lexicon);
    elements[element] = elementTokens.join(' ');
    tokens.push(...elementTokens);
  }
  return {
    tokens,
    content: tokens.join(' '),
    elements,
    contentWordCount: tokens.length,
  };
};

/**
 * Produce the delivery-invariant CONTENT an answer contributes to the skill map
 * and CV path (R27.1) — the single firewall boundary downstream skill-map
 * updates (R29) and talking-point refinement (R28) consume. Derived entirely
 * from {@link analyse}, so the contribution is, by construction, identical for
 * two transcripts that differ only in delivery (design Property 15): delivery
 * can never influence the skill map or CV path. Pure; never mutates the input.
 */
export const contentContribution = (
  answer: StarAnswer,
  lexicon: DeliveryLexicon = DEFAULT_DELIVERY_LEXICON,
): ContentContribution => {
  const { content, tokens, elements } = analyse(answer, lexicon);
  return {
    questionId: answer.questionId,
    content,
    tokens,
    elements,
  };
};
