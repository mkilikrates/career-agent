// Session log model (R34.3, R9.4).
//
// The Memory Store records what the agent did, what the user confirmed, and how
// every conflict was resolved in a single human-readable Markdown file at
// `log/session_log.md`. This module owns the entry shape and the (lossless for
// the fields it carries) render/parse pair so the log round-trips with the rest
// of the store.

import type { ISODate } from '@core/types';
import { asISODate } from '@core/types';

/** The three event categories the session log captures (R34.3). */
export type SessionLogEventType = 'action' | 'confirmation' | 'conflict-resolution';

/** A single timestamped session-log line. */
export interface SessionLogEntry {
  /** When the event happened (ISO-8601). */
  at: ISODate;
  /** Which category of event this is (R34.3). */
  type: SessionLogEventType;
  /** Human-readable, single-line summary of the event. */
  message: string;
}

/** Markdown heading written at the top of the session log file. */
export const SESSION_LOG_HEADING = '# Session Log';

const ENTRY_PATTERN = /^- \[([^\]]+)\] \*\*(action|confirmation|conflict-resolution)\*\*: (.*)$/;

/** Collapse a message to a single line so it cannot corrupt the line-based log. */
const oneLine = (message: string): string => message.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/** Render one entry as a Markdown list item. */
export const renderEntry = (entry: SessionLogEntry): string =>
  `- [${entry.at}] **${entry.type}**: ${oneLine(entry.message)}`;

/** Render a full session log file from its entries (R34.3). */
export const renderSessionLog = (entries: readonly SessionLogEntry[]): string => {
  const lines = [SESSION_LOG_HEADING, ''];
  for (const entry of entries) {
    lines.push(renderEntry(entry));
  }
  // Trailing newline keeps the file POSIX-friendly and stable across writes.
  return `${lines.join('\n')}\n`;
};

/** Parse a session log file back into its entries, ignoring non-entry lines. */
export const parseSessionLog = (raw: string): SessionLogEntry[] => {
  const entries: SessionLogEntry[] = [];
  for (const line of raw.split('\n')) {
    const match = ENTRY_PATTERN.exec(line.trim());
    if (!match) continue;
    entries.push({
      at: asISODate(match[1]),
      type: match[2] as SessionLogEventType,
      message: match[3],
    });
  }
  return entries;
};
