// Serialize reviewed extractions to the canonical `profile/raw_extractions.md`
// (R10, R11, R12, R34.1).
//
// Following the Markdown-as-database pattern (R34.1), all extracted items are
// persisted as human-readable Markdown grouped by source document, carrying
// their confidence band and the confirmed/private review flags so the store
// reflects exactly what the user reviewed. This is a presentational, lossy-by-
// design summary intended for the user-owned Memory Store; the structured
// in-memory items remain the working representation during a session.

import type { ExtractedItem } from '@core/types';
import { groupByDocument, type DocumentGroup } from './review';

const HEADING = '# Raw Extractions';
const MACHINE_FENCE = '<!-- machine-readable extractions; do not edit below -->';

/** A short, human-readable one-line summary of an item's fields. */
const summariseFields = (item: ExtractedItem): string => {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(item.fields)) {
    if (value === undefined || value === null || value === '') continue;
    const text = Array.isArray(value) ? value.join(', ') : String(value);
    if (text.trim().length === 0) continue;
    parts.push(`${key}: ${text}`);
  }
  return parts.join('; ');
};

/** Bracketed review flags, e.g. `[High, confirmed]` or `[Low, private]`. */
const flagsOf = (item: ExtractedItem): string => {
  const flags: string[] = [item.confidence];
  if (item.userConfirmed) flags.push('confirmed');
  if (item.private) flags.push('private');
  return `[${flags.join(', ')}]`;
};

/**
 * Serialize the reviewed extractions to Markdown. The document has two parts:
 *   1. a HUMAN-READABLE summary, grouped by document — one section per source
 *      document, one bullet per item with its type, review flags, and a
 *      one-line field summary;
 *   2. a MACHINE-READABLE fenced JSON block carrying the full {@link ExtractedItem}
 *      list verbatim, so the session can be rehydrated losslessly on resume
 *      (R35.1) without re-running ingestion.
 *
 * Keeping both in one human-readable `.md` honours the Markdown-as-database
 * principle (R34.1): the file reads cleanly, and the embedded block lets the app
 * restore exactly what the user reviewed.
 */
export const serializeRawExtractions = (items: readonly ExtractedItem[]): string => {
  const groups = groupByDocument(items);
  const lines: string[] = [HEADING, ''];
  if (groups.length === 0) {
    lines.push('_No extractions yet._', '');
  } else {
    for (const group of groups) {
      lines.push(`## ${group.doc as unknown as string}`, '');
      for (const item of group.items) {
        const summary = summariseFields(item);
        const tail = summary.length > 0 ? ` — ${summary}` : '';
        lines.push(`- **${item.type}** ${flagsOf(item)}${tail}`);
      }
      lines.push('');
    }
  }
  // Machine-readable block for lossless rehydration (R35.1).
  lines.push(MACHINE_FENCE, '', '```json', JSON.stringify(items, null, 2), '```', '');
  return lines.join('\n');
};

/**
 * Parse the {@link ExtractedItem} list back from a `raw_extractions.md` produced
 * by {@link serializeRawExtractions}, reading the embedded machine-readable JSON
 * block (R35.1). Returns an empty list when no block is present or it cannot be
 * parsed (a hand-written or older file degrades gracefully).
 */
export const parseRawExtractions = (markdown: string): ExtractedItem[] => {
  const match = markdown.match(/```json\s*([\s\S]*?)```/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return Array.isArray(parsed) ? (parsed as ExtractedItem[]) : [];
  } catch {
    return [];
  }
};

/**
 * Serialize from pre-grouped documents (kept for callers that already grouped).
 * Equivalent to {@link serializeRawExtractions} over the flattened items.
 */
export const serializeRawExtractionsFromGroups = (
  groups: readonly DocumentGroup[],
): string => serializeRawExtractions(groups.flatMap((g) => g.items));
