// Fact-fidelity checking for the No-Fabrication Rule (R37.5, R37.6, R40.2b).
//
// Resolving a claim's id to a provenance record proves the claim is *backed* by
// a source (R40.2a). It does NOT prove the emitted text is *faithful* to that
// source: a generator could keep a resolved id while inflating a metric,
// shifting a date, or inventing an employer. R37.5 forbids exactly that — a new
// metric, date, title, or employer that appears under a resolved id but is not
// present in the source behind it is a fabrication, even though the id resolves.
//
// This module supplies the second verification stage (R40.2b): a *fact-token
// subset* check. It is deliberately NOT a text/hash match. The user is the owner
// and judge of their own facts and is free to rephrase, so we only guard the
// net-new *fact-bearing* tokens — numbers, percentages, currency amounts, dates,
// and proper-noun / employer / title spans. Prose rewording that introduces no
// new fact token passes; a token that is not grounded in the source fails.
//
// The extractor is pure and deterministic: the same text always yields the same
// tokens in the same order. It is framework-agnostic — no storage, network, or
// React — operating only over strings and the provenance trail.

import type { Provenance, ProvenanceTrail, StarId } from '@core/types';

/**
 * A single fact-bearing token lifted from a piece of text. {@link kind} records
 * why it was treated as a fact so a {@link FidelityResult} can explain a failure
 * ("new metric 40%", "new employer Acme Corp").
 */
export interface FactToken {
  /** Normalised comparison form (lower-cased, punctuation-trimmed). */
  readonly norm: string;
  /** The category of fact the token carries (R37.2 / R37.5). */
  readonly kind: FactTokenKind;
  /** The token exactly as it appeared, for human-readable diagnostics. */
  readonly raw: string;
}

/** The categories of fact the fidelity check guards (R37.5). */
export type FactTokenKind = 'metric' | 'date' | 'entity';

/** The outcome of comparing an emitted text's fact tokens against a source. */
export interface FidelityResult {
  /** True when every emitted fact token is grounded in the source text. */
  readonly faithful: boolean;
  /**
   * Emitted fact tokens with no match in the source — the fabrications that fail
   * the output under R37.5. Empty when {@link faithful} is true.
   */
  readonly unfaithfulTokens: readonly FactToken[];
}

// --- Fact-token extraction --------------------------------------------------
//
// Three token families are guarded, chosen so that rewording is always free but
// a newly introduced fact never slips through:
//
//   * metric — a number, optionally with a percent sign or a leading currency
//     symbol/thousands separators ("40", "40%", "$1,200", "3.5"). Numbers are
//     unambiguous facts regardless of position.
//   * date   — a 4-digit year or a month(-year) token ("2021", "Jan 2020").
//   * entity — a *proper-noun / employer / title* word. Capitalisation is the
//     only positional signal available, and sentence-initial capitalisation is
//     grammatical, not a proper noun ("Reduced latency…" starts with a capital
//     but "Reduced" is a verb). So a capitalised word is treated as an entity
//     ONLY when it is NOT the first word of its line and NOT the first word after
//     sentence-ending punctuation; an ALL-CAPS acronym (len >= 2) counts anywhere.
//     This is what lets pure rephrasing pass (a reworded sentence's leading verb
//     is excluded) while a mid-sentence employer/title such as "… at Globex" or
//     "Senior Engineer — Acme" is still caught.

// A number with optional currency prefix / percent suffix / thousands separators.
const METRIC_RE = /[$€£R]?\$?\d[\d.,]*\s?%?/g;

// A bare 4-digit year, or a month-year token. Years are caught structurally so a
// shifted date is reported as a date divergence, not just a numeric one.
const YEAR_RE = /\b(?:19|20)\d{2}\b/g;
const MONTH_RE =
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s?(?:19|20)?\d{0,4}/gi;

/** A word that is a capitalised proper-noun candidate (initial cap or ALL-CAPS). */
const CAPITALISED = /^[A-Z][A-Za-z0-9&.]*$/;
/** An ALL-CAPS acronym of length >= 2 ("AWS", "SQL"): a fact token anywhere. */
const ACRONYM = /^[A-Z0-9&.]{2,}$/;

/** Normalise a token for comparison: lower-case and strip surrounding noise. */
const normalise = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[\s]+/g, ' ')
    .replace(/[.,;:]+$/g, '')
    .replace(/^[.,;:]+/g, '')
    .trim();

/** Deduplicate tokens by their normalised form, preserving first-seen order. */
const dedupe = (tokens: readonly FactToken[]): FactToken[] => {
  const seen = new Set<string>();
  const out: FactToken[] = [];
  for (const t of tokens) {
    if (t.norm.length === 0 || seen.has(t.norm)) continue;
    seen.add(t.norm);
    out.push(t);
  }
  return out;
};

const collect = (text: string, re: RegExp, kind: FactTokenKind): FactToken[] => {
  const out: FactToken[] = [];
  for (const match of text.matchAll(re)) {
    const raw = match[0].trim();
    const norm = normalise(raw);
    if (norm.length === 0) continue;
    out.push({ raw, norm, kind });
  }
  return out;
};

/**
 * Collect proper-noun/employer/title *entity* tokens, excluding sentence-initial
 * capitalisation. A line is split into words; the first word (and any word that
 * directly follows sentence-ending punctuation `. ! ?`) is treated as potentially
 * sentence-initial and skipped unless it is an ALL-CAPS acronym. Every other
 * capitalised word is an entity token.
 */
const collectEntities = (text: string): FactToken[] => {
  const out: FactToken[] = [];
  for (const line of text.split(/[\r\n]+/)) {
    const words = line.split(/\s+/).filter((w) => w.length > 0);
    let sentenceStart = true;
    for (const word of words) {
      // Strip leading/trailing punctuation to classify the bare word.
      const bare = word.replace(/^[^A-Za-z0-9&.]+/, '').replace(/[^A-Za-z0-9&.]+$/, '');
      const endsSentence = /[.!?]$/.test(word);
      if (bare.length === 0) {
        if (endsSentence) sentenceStart = true;
        continue;
      }
      const isAcronym = ACRONYM.test(bare);
      const isCap = CAPITALISED.test(bare);
      // Count as an entity when it is a mid-sentence capitalised word, or an
      // ALL-CAPS acronym anywhere (acronyms are not grammatical capitalisation).
      if ((isCap && !sentenceStart) || isAcronym) {
        const norm = normalise(bare);
        if (norm.length > 0) out.push({ raw: bare, norm, kind: 'entity' });
      }
      sentenceStart = endsSentence;
    }
  }
  return out;
};

/**
 * Extract the fact-bearing tokens from a piece of generated text (R37.5). Pure
 * and deterministic. The result is the set of numbers/percentages/currency
 * amounts (`metric`), years and month-year tokens (`date`), and proper-noun /
 * employer / title words (`entity`) the text asserts. Ordinary prose words — and
 * sentence-initial capitalisation — carry no fact and are intentionally ignored,
 * so rephrasing that introduces no new fact token yields a subset of the source
 * token set.
 */
export const extractFactTokens = (text: string): FactToken[] => {
  if (!text) return [];
  // Dates first so a 4-digit year is classified as `date`, not `metric` (both
  // regexes match it; dedupe keeps the first-seen kind).
  return dedupe([
    ...collect(text, YEAR_RE, 'date'),
    ...collect(text, MONTH_RE, 'date'),
    ...collect(text, METRIC_RE, 'metric'),
    ...collectEntities(text),
  ]);
};

// --- Source text from the provenance trail ----------------------------------

/**
 * The confirmed source *content* a provenance record points at, when available.
 *
 *   * `source_line` carries the verbatim `quote` from a user document — genuine
 *     source content to compare against.
 *   * `interview_answer` carries only a `StarId`; its confirmed answer text must
 *     be supplied via `starText` (R40.2b, option b).
 *   * `user_confirmation` is NOT source content — it is an *attestation* that the
 *     user (the owner and judge of their own facts, R12.4) approved the claim.
 *     Its `note` is a meta-remark ("confirmed in review"), not a restatement of
 *     the fact, so it never constrains fidelity. A claim backed solely by user
 *     confirmation therefore degrades to resolution-only: the user already
 *     judged it faithful.
 */
const recordText = (
  record: Provenance,
  starText?: ReadonlyMap<StarId, string>,
): string | undefined => {
  switch (record.kind) {
    case 'source_line':
      return record.quote;
    case 'interview_answer':
      return starText?.get(record.star);
    case 'user_confirmation':
      return undefined; // attestation, not source content (R12.4).
  }
};

/**
 * Join every piece of confirmed source text reachable from a provenance trail
 * into one comparison corpus (R40.2b). Returns `undefined` when NO record in the
 * trail exposes comparable text (e.g. an interview-answer-only trail with no
 * `starText` supplied) — the caller then degrades to resolution-only for that
 * claim, preserving backward compatibility.
 */
export const sourceTextOf = (
  trail: ProvenanceTrail,
  starText?: ReadonlyMap<StarId, string>,
): string | undefined => {
  const parts = trail
    .map((record) => recordText(record, starText))
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
  return parts.length > 0 ? parts.join(' \n ') : undefined;
};

// --- Fidelity comparison ----------------------------------------------------

/**
 * Compare the fact tokens of an emitted text against its confirmed source text
 * (R37.5). The output is *faithful* when every emitted fact token is present in
 * the source token set. Rephrasing is allowed because only fact-bearing tokens
 * are compared; a net-new metric, date, title, or employer that the source does
 * not contain is reported as unfaithful.
 */
export const checkFidelity = (
  emitted: string,
  sourceText: string,
): FidelityResult => {
  const sourceTokens = new Set(extractFactTokens(sourceText).map((t) => t.norm));
  const unfaithfulTokens = extractFactTokens(emitted).filter(
    (t) => !sourceTokens.has(t.norm),
  );
  return { faithful: unfaithfulTokens.length === 0, unfaithfulTokens };
};

/**
 * Audit a free-form AI-generated draft (e.g. a tailored CV in Markdown) against
 * the confirmed-evidence text it was derived from (R37.5, R37.6). The confirmed
 * baseline is the deterministic output built purely from confirmed evidence; any
 * fact-bearing token the AI draft introduces that the baseline does not contain
 * is a candidate fabrication the user must confirm *before* the draft becomes a
 * final output (R37.6, R39). This is the live-app counterpart to
 * {@link checkFidelity}: the harness compares per-claim against the provenance
 * trail (hard-fail in CI), while the app compares the whole draft against its
 * confirmed baseline and surfaces the divergence for the user to judge — never
 * silently emitting or silently discarding it.
 *
 * Pure and deterministic. Returns `faithful: true` with no tokens when the draft
 * introduces no new fact (rephrasing is allowed), so a clean draft shows no
 * warning.
 */
export const auditDraftFidelity = (
  draft: string,
  confirmedBaseline: string,
): FidelityResult => checkFidelity(draft, confirmedBaseline);
