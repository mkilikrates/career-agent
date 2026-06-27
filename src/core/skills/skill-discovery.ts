// AI skill discovery (R42.1, R47) — pure helpers for the opt-in "discover skills
// with AI" flow.
//
// This is DISTINCT from the deterministic, evidence-derived `generate` (R14):
//   * `generate` builds the map ONLY from skills already structurally present
//     in the extractions (explicit `skill` items, employment `technologies`,
//     languages). It is conservative and every entry traces to a source line.
//   * Skill *discovery* asks the model to READ the full career corpus and
//     PROPOSE skills a structural parser cannot see — skills implied by what the
//     user actually did, described in prose, or scattered across bullets and
//     summaries (e.g. "led the billing-system migration" → distributed systems,
//     system design, stakeholder management).
//
// Trust boundary (R42.1 / No-Fabrication): the model only *proposes*. Nothing it
// returns is trusted until the user explicitly confirms it; the caller turns
// each accepted name into a user-confirmed skill item carrying user-confirmation
// provenance. Discovery never writes to outputs directly.
//
// Privacy boundary (R7, R46.4): this module only BUILDS the prompt text — the
// actual transmission still flows through the single Egress Gate. What goes into
// the corpus depends on the chosen chat provider:
//   * LOCAL (keyless, on-device) provider → the call has no third-party egress
//     (R7.6), so the corpus may include PRIVATE items: the user has opted into
//     sending their full evidence to a model on their own machine.
//   * CLOUD provider → private items are excluded (R46.4) and the Egress Gate
//     PII-screens the payload before it leaves the device (R6).
// The `includePrivate` flag below encodes exactly that decision.

import type { ExtractedItem } from '@core/types';

/**
 * Default per-chunk character budget. The full corpus is split into chunks no
 * larger than this so a large profile is never truncated (the previous flow
 * hard-truncated at 6000 chars, silently dropping evidence) and each prompt
 * stays within a small local model's context window.
 */
export const DEFAULT_DISCOVERY_CHUNK_CHARS = 6000;

/** Options controlling how the discovery corpus is assembled. */
export interface DiscoveryCorpusOptions {
  /**
   * Include items the user marked private. This is `true` ONLY when the chosen
   * chat provider is a keyless local on-device provider (no third-party egress,
   * R7.6); it is `false` for any cloud provider so private items are excluded
   * from the payload entirely (R46.4).
   */
  readonly includePrivate: boolean;
  /** Per-chunk character budget (defaults to {@link DEFAULT_DISCOVERY_CHUNK_CHARS}). */
  readonly maxCharsPerChunk?: number;
}

/**
 * Render one extracted item as a single, field-flattened line for the corpus,
 * e.g. `employment; title: SRE; employer: Acme; technologies: Kubernetes, Go`.
 * Empty/blank fields are skipped. Arrays are comma-joined.
 */
export function itemToLine(item: ExtractedItem): string {
  const parts: string[] = [item.type];
  for (const [key, value] of Object.entries(item.fields)) {
    if (value === undefined || value === null || value === '') continue;
    const text = Array.isArray(value) ? value.join(', ') : String(value);
    if (text.trim().length === 0) continue;
    parts.push(`${key}: ${text}`);
  }
  return parts.join('; ');
}

/**
 * Greedily pack non-empty lines into chunks no larger than `budget` characters.
 * Nothing is dropped — a single line longer than the budget becomes its own
 * chunk rather than being truncated. Shared by the structured-item corpus and
 * the raw-document corpus so both chunk identically.
 */
function packLines(lines: readonly string[], budget: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const add = line.length + 1; // +1 for the joining newline
    if (current.length > 0 && currentLen + add > budget) {
      chunks.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += add;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

/**
 * Build the full discovery corpus as an ordered list of chunks. Every eligible
 * item contributes one line; lines are packed greedily into chunks no larger
 * than the budget. Nothing is dropped — an oversized single line becomes its own
 * chunk rather than being truncated. Private items are included only when
 * `includePrivate` is set (local on-device provider, R7.6 / R46.4).
 */
export function buildDiscoveryCorpus(
  items: readonly ExtractedItem[],
  options: DiscoveryCorpusOptions,
): string[] {
  const budget = Math.max(500, options.maxCharsPerChunk ?? DEFAULT_DISCOVERY_CHUNK_CHARS);
  const lines = items
    .filter((it) => options.includePrivate || !it.private)
    .map(itemToLine);
  return packLines(lines, budget);
}

/**
 * Build the discovery corpus from the RAW document text (the whole file content,
 * not the parsed items) as ordered chunks. This is the high-recall, local-only
 * path: the model reads the entire document — prose, section headings the
 * structured extractor does not recognise, skills implied by described work —
 * rather than only what extraction captured (R47.1/R47.5). Multiple documents
 * are separated by a blank line. Used ONLY for a keyless local on-device
 * provider, since raw text carries no per-item private flag and so cannot honour
 * the per-item private-exclusion required for a cloud destination (R46.4).
 */
export function buildRawDiscoveryCorpus(
  rawTexts: readonly string[],
  options: { readonly maxCharsPerChunk?: number } = {},
): string[] {
  const budget = Math.max(500, options.maxCharsPerChunk ?? DEFAULT_DISCOVERY_CHUNK_CHARS);
  const lines = rawTexts
    .filter((t) => typeof t === 'string' && t.trim().length > 0)
    .join('\n\n')
    .split(/\r?\n/);
  return packLines(lines, budget);
}

/**
 * The discovery-oriented instruction. Unlike the defensive assist prompt
 * ("no skills that are not evidenced"), this asks the model for high recall —
 * including soft / leadership skills strongly implied by the work — because the
 * user confirms every result before it counts (R42.1). It still forbids pure
 * invention and pins the output to a parseable, comma-separated list.
 */
export const DISCOVERY_PROMPT_INSTRUCTION =
  'You are analysing a person\'s career evidence to identify their professional ' +
  'skills. List every distinct skill that is demonstrated or strongly implied by ' +
  'the evidence below — include technical skills, tools, methodologies, domains, ' +
  'and soft/leadership skills that the described work clearly required. Do not ' +
  'invent skills that the evidence does not support. Return ONLY a comma-separated ' +
  'list of concise skill names, with no commentary, numbering, or explanation.';

/** Compose the full prompt for one corpus chunk. */
export function buildDiscoveryPrompt(corpusChunk: string): string {
  return `${DISCOVERY_PROMPT_INSTRUCTION}\n\nCAREER EVIDENCE:\n${corpusChunk}`;
}

/**
 * The review/refine instruction used by the "Both" mode (script + AI review).
 * The model is given the skills a basic deterministic parser already detected
 * and asked to REVIEW them against the evidence — keep the supported ones
 * (correcting wording/casing), drop the unsupported ones, and add clearly
 * evidenced skills the parser missed — then return the COMPLETE refined list.
 * It still forbids invention and pins the output to a parseable comma list.
 */
export const REVIEW_PROMPT_INSTRUCTION =
  'A basic keyword parser detected the SKILLS listed below from a person\'s ' +
  'career evidence. Review that list against the EVIDENCE: keep every skill the ' +
  'evidence supports (correct the wording or casing if needed), drop any the ' +
  'evidence does not support, and add any additional skills the evidence clearly ' +
  'demonstrates or implies that the parser missed. Do not invent skills the ' +
  'evidence does not support. Return ONLY the COMPLETE refined comma-separated ' +
  'list of skill names, with no commentary, numbering, or explanation.';

/** Compose the review/refine prompt for one corpus chunk plus the parser's skills. */
export function buildReviewPrompt(
  scriptSkills: readonly string[],
  corpusChunk: string,
): string {
  const detected = scriptSkills.length > 0 ? scriptSkills.join(', ') : '(none detected)';
  return `${REVIEW_PROMPT_INSTRUCTION}\n\nSKILLS DETECTED BY THE PARSER:\n${detected}\n\nCAREER EVIDENCE:\n${corpusChunk}`;
}

/**
 * Parse a model reply into a clean, de-duplicated list of candidate skill names.
 * Splits on commas / newlines / semicolons / bullets, strips list markers and
 * trailing punctuation, drops empties and over-long fragments (likely prose, not
 * a skill), and skips anything already present in `existing` (case-insensitive).
 * `existing` is the set of lower-cased names already known (map entries + already
 * suggested), enabling cumulative de-dupe across multiple chunk replies.
 */
export function parseDiscoveredSkills(
  reply: string,
  existing: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set(existing);
  for (const raw of reply.split(/[\n,;•]/)) {
    const name = raw
      .replace(/^\s*(?:[-*]|\d+\.)\s*/, '')
      .replace(/\.$/, '')
      .trim();
    if (name.length === 0 || name.length > 60) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
