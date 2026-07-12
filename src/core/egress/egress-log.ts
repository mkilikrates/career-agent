// Egress log model (R74.1, R74.2, R74.3).
//
// Records every outbound provider request/response pair so the user can inspect
// exactly what was sent and received. Stored as `log/egress_log.md` in the
// Memory Store, following the same Markdown list-entry pattern as the session
// log. Each entry captures the timestamp, operation kind, provider, the prompt
// text sent, the response text received, and whether redaction was applied.

import type { ISODate } from '@core/types';
import { asISODate } from '@core/types';
import type { EgressOperationKind } from './egress-gate';

/**
 * A single egress log entry recording one outbound request/response pair.
 * Written to `log/egress_log.md` after every successful `request()` or
 * `requestIngestion()` call (R74.1, R74.2).
 */
export interface EgressLogEntry {
  /** When the request completed (ISO-8601). */
  readonly at: ISODate;
  /** The kind of outbound operation (R74.1). */
  readonly operation: EgressOperationKind;
  /** The provider the payload was sent to. */
  readonly provider: string;
  /** The prompt/text that was sent (post-redaction). */
  readonly promptText: string;
  /** The response text received from the provider. */
  readonly responseText: string;
  /** Whether PII redaction was applied before sending. */
  readonly redacted: boolean;
}

/**
 * Raw data passed to the egress log callback from within the gate. The gate
 * cannot access the opaque ProviderResponse text directly (it lives in
 * @adapters), so it passes the opaque response and lets the callback
 * implementation (wired in the @ui runtime) extract the text.
 */
export interface EgressLogCallbackData {
  /** When the request completed (ISO-8601). */
  readonly at: ISODate;
  /** The kind of outbound operation (R74.1). */
  readonly operation: EgressOperationKind;
  /** The provider the payload was sent to. */
  readonly provider: string;
  /** The prompt/text that was sent (post-redaction). */
  readonly promptText: string;
  /** The opaque provider response — the callback can extract text from it. */
  readonly response: unknown;
  /** Whether PII redaction was applied before sending. */
  readonly redacted: boolean;
}

/**
 * Callback signature for egress logging (R74.2). Injected into the gate so it
 * can report every completed request without having Memory Store access itself.
 * Receives raw data including the opaque response; the implementation at the
 * runtime composition root extracts the response text.
 */
export type EgressLogCallback = (data: EgressLogCallbackData) => void;

// ---------------------------------------------------------------------------
// Serialization — Markdown list format (mirrors session-log.ts)
// ---------------------------------------------------------------------------

/** Markdown heading written at the top of the egress log file. */
export const EGRESS_LOG_HEADING = '# Egress Log';

/**
 * Separator between the entry metadata line and the prompt/response content.
 * Uses indented fenced blocks so multi-line content stays parseable.
 */

const ENTRY_META_PATTERN =
  /^- \[([^\]]+)\] \*\*(llm-chat|stt-transcribe)\*\* → ([^ ]+)(?: \(redacted\))?$/;

/** Render one egress log entry as Markdown list items. */
export function renderEgressLogEntry(entry: EgressLogEntry): string {
  const redactedTag = entry.redacted ? ' (redacted)' : '';
  const meta = `- [${entry.at}] **${entry.operation}** → ${entry.provider}${redactedTag}`;
  // Indent prompt/response as sub-items with fenced content.
  const prompt = `  - **Prompt:** ${oneLine(entry.promptText)}`;
  const response = `  - **Response:** ${oneLine(entry.responseText)}`;
  return `${meta}\n${prompt}\n${response}`;
}

/** Render a full egress log file from its entries (R74.3). */
export function renderEgressLog(entries: readonly EgressLogEntry[]): string {
  const lines = [EGRESS_LOG_HEADING, ''];
  for (const entry of entries) {
    lines.push(renderEgressLogEntry(entry));
  }
  return `${lines.join('\n')}\n`;
}

/** Parse an egress log file back into its entries (R74.5). */
export function parseEgressLog(raw: string): EgressLogEntry[] {
  const entries: EgressLogEntry[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const metaMatch = ENTRY_META_PATTERN.exec(lines[i].trim());
    if (!metaMatch) continue;
    const at = asISODate(metaMatch[1]);
    const operation = metaMatch[2] as EgressOperationKind;
    const provider = metaMatch[3];
    const redacted = lines[i].trim().endsWith('(redacted)');
    // Next two lines should be prompt and response sub-items.
    let promptText = '';
    let responseText = '';
    if (i + 1 < lines.length) {
      const promptLine = lines[i + 1].trim();
      const promptPrefix = '- **Prompt:** ';
      if (promptLine.startsWith(promptPrefix)) {
        promptText = promptLine.slice(promptPrefix.length);
      }
    }
    if (i + 2 < lines.length) {
      const responseLine = lines[i + 2].trim();
      const responsePrefix = '- **Response:** ';
      if (responseLine.startsWith(responsePrefix)) {
        responseText = responseLine.slice(responsePrefix.length);
      }
    }
    entries.push({ at, operation, provider, promptText, responseText, redacted });
    i += 2; // Skip the two content lines we just consumed.
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collapse a message to a single line so it cannot corrupt the line-based log. */
const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
