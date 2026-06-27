// AI-assist preference persistence — serialize / parse / save / load
// `config/assist_preference.md` (R34.1, R34.2).
//
// The user chooses the AI-assist mode (script-only / ai-assisted / ai-only) ONCE,
// up front (at ingestion, before saving), and that choice becomes the default
// applied across the whole pipeline (Skill Map, Role Discovery, Coaching,
// Output). Because it is a pipeline-wide decision that must survive a reload /
// resume / Memory import, it is canonical state and lives in the Memory Store
// following the Markdown-as-database pattern (R34.1): the structured mode is in
// frontmatter (the natural home for machine-read config) with a short
// human-readable body, and it round-trips losslessly (R34.2) —
// `parseAssistMode ∘ serializeAssistMode` recovers the mode.
//
// Fail-safe parsing: any absent, partial, or malformed document parses back to
// the trust-preserving `script-only` default, so a corrupt store never silently
// enables a provider call.

import type { MemoryPath } from '@core/types';
import { parseMarkdown, serializeMarkdown } from '@core/markdown';
import { CANONICAL_FILES } from '@core/storage';
import type { AssistMode } from './assist';

/** Canonical Memory Store location for the AI-assist preference (R34.1). */
export const ASSIST_PREFERENCE_PATH: MemoryPath = CANONICAL_FILES.assistPreference;

/** Title heading written at the top of the preference document. */
export const ASSIST_PREFERENCE_HEADING = '# AI Assist Preference';

/** The trust-preserving default when no preference has been stored yet. */
export const DEFAULT_ASSIST_MODE: AssistMode = 'script-only';

/** The set of valid persisted modes (used to fail safe on a malformed value). */
const VALID_MODES: readonly AssistMode[] = ['script-only', 'ai-assisted', 'ai-only'];

// --- Serialize --------------------------------------------------------------

/**
 * Serialize an {@link AssistMode} to the canonical `config/assist_preference.md`
 * Markdown (R34.1). The structured mode lives in frontmatter so it is read back
 * exactly; the body is a short human-readable summary. Deterministic: the output
 * depends only on the mode.
 */
export const serializeAssistMode = (mode: AssistMode): string => {
  const body = [
    ASSIST_PREFERENCE_HEADING,
    '',
    `- **Mode applied across the pipeline:** ${mode}`,
    '',
  ].join('\n');
  return serializeMarkdown({ frontmatter: { assistMode: mode }, ids: [], body: `${body}\n` });
};

// --- Parse ------------------------------------------------------------------

/**
 * Parse a `config/assist_preference.md` document back into an {@link AssistMode}
 * (R34.2). The inverse of {@link serializeAssistMode}. Fails safe: anything other
 * than one of the known modes yields the `script-only` default, so a malformed
 * or partial document never silently enables a provider call.
 */
export const parseAssistMode = (markdown: string): AssistMode => {
  try {
    const { frontmatter } = parseMarkdown(markdown);
    const raw = (frontmatter as { assistMode?: unknown }).assistMode;
    return typeof raw === 'string' && (VALID_MODES as readonly string[]).includes(raw)
      ? (raw as AssistMode)
      : DEFAULT_ASSIST_MODE;
  } catch {
    return DEFAULT_ASSIST_MODE;
  }
};

// --- Persist ----------------------------------------------------------------

/** Minimal writer satisfied by both the Storage_Adapter and the MemoryTree. */
export interface AssistPreferenceWriter {
  write(path: MemoryPath, data: string): unknown;
}

/** Minimal reader satisfied by both the Storage_Adapter and the MemoryTree. */
export interface AssistPreferenceReader {
  has(path: MemoryPath): boolean;
  readText(path: MemoryPath): string;
}

/**
 * Persist the AI-assist preference to `config/assist_preference.md` via the
 * supplied writer (Storage_Adapter or MemoryTree). Awaits the write so a
 * Promise-returning adapter completes before the caller advances.
 */
export const saveAssistMode = async (
  writer: AssistPreferenceWriter,
  mode: AssistMode,
): Promise<MemoryPath> => {
  await writer.write(ASSIST_PREFERENCE_PATH, serializeAssistMode(mode));
  return ASSIST_PREFERENCE_PATH;
};

/**
 * Load the persisted {@link AssistMode} from `config/assist_preference.md` via
 * the supplied reader. When no preference has been stored yet, returns the
 * `script-only` default — a first-use profile never starts with AI selected.
 */
export const loadAssistMode = (reader: AssistPreferenceReader): AssistMode => {
  if (!reader.has(ASSIST_PREFERENCE_PATH)) return DEFAULT_ASSIST_MODE;
  return parseAssistMode(reader.readText(ASSIST_PREFERENCE_PATH));
};
