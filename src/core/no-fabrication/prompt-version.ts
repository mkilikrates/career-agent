// No-Fabrication system-prompt versioning (R40.4).
//
// R40.4 requires the no-fabrication system prompt to be versioned *together with*
// its evaluation results, so that any change to the prompt can be regression-
// tested: when the prompt text changes its content hash changes, the version is
// bumped, and the harness re-runs the fixture library to produce a fresh set of
// evaluation results bound to that exact prompt. This module owns the prompt
// text, its version, a deterministic content hash, and the record that binds a
// prompt version to the {@link VerificationReport}s it was evaluated against.
//
// The hash is a small, dependency-free FNV-1a digest — enough to detect that the
// prompt text changed (and therefore that recorded results are stale), without
// pulling in a crypto dependency or breaking the framework-agnostic boundary.

import type { VerificationReport } from './verify';

/** Current version of the no-fabrication system prompt (R40.4). Bump on edit. */
export const NO_FABRICATION_PROMPT_VERSION = '1.0.0';

/**
 * The no-fabrication system prompt (R37, R40.4). It instructs the generator to
 * emit only sourced or user-confirmed facts and never to infer skills/tools from
 * a job title. It is versioned alongside its evaluation results so that editing
 * it forces a regression run (the hash, and therefore any stale binding, changes).
 */
export const NO_FABRICATION_SYSTEM_PROMPT = [
  'You generate professional materials under a strict No-Fabrication Rule.',
  '',
  '1. Include a skill only if it appears in verified source material or the user',
  '   explicitly confirmed it. Never add a skill that is merely implied by a job',
  '   title, seniority, or industry (R37.1, R37.3).',
  '2. Include a metric, date, job title, or employer name only if it is found in',
  '   source material or explicitly confirmed by the user (R37.2).',
  '3. Every item must be traceable to a source document line, an explicit user',
  '   confirmation, or a confirmed interview answer before it appears in a final',
  '   output (R37.4, R38.1).',
  '4. If evidence is missing, omit the claim or ask the user — never invent it.',
].join('\n');

/**
 * A prompt version bound to the evaluation results it produced (R40.4). Recording
 * the {@link hash} alongside {@link results} makes a stale binding detectable:
 * if the live prompt's hash no longer matches a record's hash, the recorded
 * results predate a prompt change and must be regenerated.
 */
export interface PromptVersionRecord {
  /** The semantic version of the prompt at evaluation time (R40.4). */
  readonly version: string;
  /** The exact prompt text that was evaluated. */
  readonly prompt: string;
  /** A deterministic content hash of {@link prompt} (stale-binding detector). */
  readonly hash: string;
  /** The fixture evaluation results bound to this prompt version (R40.4). */
  readonly results?: readonly VerificationReport[];
}

/**
 * Deterministic, dependency-free 32-bit FNV-1a content hash, hex-encoded. Equal
 * inputs always hash equally and any single-character change changes the digest,
 * which is all R40.4 needs to detect that recorded results are stale.
 */
export const promptHash = (text: string): string => {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // FNV prime multiply in 32-bit space (Math.imul keeps it exact).
    hash = Math.imul(hash, 0x01000193);
  }
  // Coerce to unsigned and pad to a stable 8-hex-digit string.
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/**
 * Build the current {@link PromptVersionRecord} (R40.4), optionally binding the
 * evaluation results just produced for it. Without results it is the bare,
 * version-stamped, hashed prompt; with results it is the regression-testable
 * binding the harness records after evaluating the fixture library.
 */
export const currentPromptVersion = (
  results?: readonly VerificationReport[],
): PromptVersionRecord => {
  const record: PromptVersionRecord = {
    version: NO_FABRICATION_PROMPT_VERSION,
    prompt: NO_FABRICATION_SYSTEM_PROMPT,
    hash: promptHash(NO_FABRICATION_SYSTEM_PROMPT),
  };
  if (results !== undefined) {
    return { ...record, results };
  }
  return record;
};
