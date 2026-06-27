// Persist the full raw text of each ingested document to the canonical
// `profile/raw_documents.md` (R34.1, R47.1, R47.5, R49).
//
// Whole-document local AI skill discovery (R47.1) reads the FULL decoded text
// of each document — not just the structured items — so it can surface skills
// the deterministic extractor missed (R47.5). Until now that raw text lived in
// React in-session state only, so after a reload, session resume, or Memory
// import the discovery corpus silently fell back to the structured items. This
// module persists the raw text as a normal Memory Store file so whole-document
// discovery survives resume/import.
//
// PRIVACY BOUNDARY (R7.1, R46.4, R47.1): the Memory Store stays entirely on the
// user's device and is NEVER transmitted to any provider (R7.1), so persisting
// raw text here does not put it on any wire. The raw text is only ever read by
// the KEYLESS LOCAL on-device discovery path; the cloud discovery path keeps
// using structured non-private items and never reads this file (see
// `skill-assist.ts`).
//
// Following the Markdown-as-database pattern (R34.1) — and mirroring
// `raw-extractions-document.ts` — the file has a human-readable section per
// document PLUS a machine-readable fenced JSON block carrying the raw texts
// verbatim, so the corpus round-trips losslessly on resume/import (R49).

const HEADING = '# Raw Documents';
const MACHINE_FENCE = '<!-- machine-readable raw document text; do not edit below -->';

/** One ingested document's full decoded text, keyed by its document name. */
export interface RawDocument {
  /** The source document name (the {@link DocId} string, e.g. `cv.md`). */
  readonly doc: string;
  /** The full decoded document text fed to extraction (whole-document content). */
  readonly text: string;
}

/**
 * Serialize the raw document texts to Markdown. The document has two parts:
 *   1. a HUMAN-READABLE section per source document carrying its full decoded
 *      text inside a fenced block, so the file reads cleanly;
 *   2. a MACHINE-READABLE fenced JSON block carrying the full `{ doc, text }[]`
 *      list verbatim, so the local discovery corpus rehydrates losslessly on
 *      resume / Memory import (R49).
 *
 * Documents with empty/whitespace-only text (e.g. a LinkedIn export ZIP, which
 * has no single prose body) are dropped — there is nothing for whole-document
 * discovery to read.
 */
export const serializeRawDocuments = (docs: readonly RawDocument[]): string => {
  const kept = docs.filter((d) => typeof d.text === 'string' && d.text.trim().length > 0);
  const lines: string[] = [HEADING, ''];
  if (kept.length === 0) {
    lines.push('_No raw documents yet._', '');
  } else {
    for (const { doc, text } of kept) {
      lines.push(`## ${doc}`, '', '```text', text, '```', '');
    }
  }
  // Machine-readable block for lossless rehydration (R49).
  lines.push(MACHINE_FENCE, '', '```json', JSON.stringify(kept, null, 2), '```', '');
  return lines.join('\n');
};

/**
 * Parse the {@link RawDocument} list back from a `raw_documents.md` produced by
 * {@link serializeRawDocuments}, reading the embedded machine-readable JSON
 * block (R49). Returns an empty list when no block is present or it cannot be
 * parsed (a hand-written or older file degrades gracefully).
 *
 * Parsing anchors on the machine-fence marker and then slices between the
 * opening ```` ```json ```` fence and the LAST closing ```` ``` ````, so that
 * triple-backtick code fences inside the document text (common in Markdown CVs)
 * never confuse the parse — the machine block is always the only content after
 * the marker.
 */
export const parseRawDocuments = (markdown: string): RawDocument[] => {
  const markerAt = markdown.lastIndexOf(MACHINE_FENCE);
  if (markerAt < 0) return [];
  const tail = markdown.slice(markerAt + MACHINE_FENCE.length);
  const openAt = tail.indexOf('```json');
  if (openAt < 0) return [];
  const afterOpen = tail.slice(openAt + '```json'.length);
  const closeAt = afterOpen.lastIndexOf('```');
  if (closeAt < 0) return [];
  try {
    const parsed = JSON.parse(afterOpen.slice(0, closeAt).trim()) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (d): d is RawDocument =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as RawDocument).doc === 'string' &&
        typeof (d as RawDocument).text === 'string',
    );
  } catch {
    return [];
  }
};
