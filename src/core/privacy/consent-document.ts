// Consent persistence — serialize / parse / save `config/consent.md` (R42.1,
// R34.1, R34.2).
//
// The informed-consent decision (R42.1) is canonical state, so it lives in the
// Memory Store like everything else, following the Markdown-as-database pattern
// (R34.1): the structured decision is stored in frontmatter (the natural home
// for machine-read config) with a short human-readable body, and round-trips
// losslessly (R34.2) — `parseConsentState ∘ serializeConsentState` recovers the
// state.
//
// Fail-safe parsing (R42.1): any absent, partial, or malformed document parses
// back to the NOT-consented default, so a corrupt store can never silently
// enable training/improvement use.

import type { MemoryPath } from '@core/types';
import { asISODate } from '@core/types';
import { parseMarkdown, serializeMarkdown } from '@core/markdown';
import { CANONICAL_FILES } from '@core/storage';
import { DEFAULT_CONSENT_STATE, type ConsentState } from './consent';

/** Canonical Memory Store location for the consent decision (R34.1, R42.1). */
export const CONSENT_PATH: MemoryPath = CANONICAL_FILES.consent;

/** Title heading written at the top of the consent document. */
export const CONSENT_HEADING = '# Consent';

// --- Serialize --------------------------------------------------------------

/**
 * Serialize a {@link ConsentState} to the canonical `config/consent.md`
 * Markdown (R34.1, R42.1). The structured decision lives in frontmatter so it
 * is read back exactly; the body is a short human-readable summary.
 * Deterministic: the output depends only on the state.
 */
export const serializeConsentState = (state: ConsentState): string => {
  const frontmatter: Record<string, unknown> = {
    trainingUse: state.trainingUse,
  };
  if (state.decidedAt !== undefined) frontmatter.decidedAt = state.decidedAt;

  const body: string[] = [
    CONSENT_HEADING,
    '',
    `- **Training/improvement use:** ${state.trainingUse ? 'consented' : 'excluded'}`,
  ];
  if (state.decidedAt !== undefined) {
    body.push(`- **Decided at:** ${state.decidedAt}`);
  }
  body.push('');

  return serializeMarkdown({ frontmatter, ids: [], body: `${body.join('\n')}\n` });
};

// --- Parse ------------------------------------------------------------------

/**
 * Parse a `config/consent.md` document back into a {@link ConsentState} (R34.2).
 * The inverse of {@link serializeConsentState}. Fails safe (R42.1): anything
 * other than an explicit `trainingUse: true` yields the NOT-consented default,
 * so a malformed or partial document never enables training/improvement use.
 */
export const parseConsentState = (markdown: string): ConsentState => {
  const { frontmatter } = parseMarkdown(markdown);

  // Only an explicit boolean `true` grants consent; everything else excludes.
  if (frontmatter.trainingUse !== true) {
    return typeof frontmatter.decidedAt === 'string'
      ? { trainingUse: false, decidedAt: asISODate(frontmatter.decidedAt) }
      : DEFAULT_CONSENT_STATE;
  }

  return typeof frontmatter.decidedAt === 'string'
    ? { trainingUse: true, decidedAt: asISODate(frontmatter.decidedAt) }
    : { trainingUse: true };
};

// --- Persist (R42.1) --------------------------------------------------------

/** Minimal writer satisfied by both the Storage_Adapter and the MemoryTree. */
export interface ConsentWriter {
  write(path: MemoryPath, data: string): unknown;
}

/** Minimal reader satisfied by both the Storage_Adapter and the MemoryTree. */
export interface ConsentReader {
  has(path: MemoryPath): boolean;
  readText(path: MemoryPath): string;
}

/**
 * Persist the consent decision to `config/consent.md` via the supplied writer
 * (Storage_Adapter or MemoryTree). Awaits the write so a Promise-returning
 * adapter completes before the caller advances.
 */
export const saveConsentState = async (
  writer: ConsentWriter,
  state: ConsentState,
): Promise<MemoryPath> => {
  await writer.write(CONSENT_PATH, serializeConsentState(state));
  return CONSENT_PATH;
};

/**
 * Load the persisted {@link ConsentState} from `config/consent.md` via the
 * supplied reader. When no decision has been stored yet, returns the
 * NOT-consented default (R42.1) — a first-use profile is always treated as
 * withholding consent.
 */
export const loadConsentState = (reader: ConsentReader): ConsentState => {
  if (!reader.has(CONSENT_PATH)) return DEFAULT_CONSENT_STATE;
  return parseConsentState(reader.readText(CONSENT_PATH));
};
