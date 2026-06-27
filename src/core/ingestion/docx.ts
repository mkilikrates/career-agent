// DOCX text extraction (launch format, beyond the original Phase-1 set).
//
// A `.docx` is a ZIP (OOXML) whose main body lives in `word/document.xml`. The
// Ingestion_Engine already reads ZIP entries through the injected ZipReader (the
// same port used for the LinkedIn export), so DOCX needs NO new dependency and
// no backend: we read the entries, pull `word/document.xml`, and convert its
// WordprocessingML to plain text HERE, then feed that text through the SAME
// `extractFromText` path the Markdown/PDF bodies use.
//
// This module is pure and deterministic (no DOM, no network, no library), so it
// is unit-testable with a literal `document.xml` string. It deliberately
// recovers only TEXT and paragraph structure — enough for evidence extraction —
// and never executes or trusts anything in the archive.

/** Minimal shape of a ZIP entry this module needs (decoupled from the adapter). */
export interface DocxZipEntry {
  /** The entry's full path within the archive (e.g. `word/document.xml`). */
  readonly path: string;
  /** The decoded UTF-8 text content of the entry. */
  readonly text: string;
}

/** Decode the five predefined XML entities plus numeric character references. */
const decodeXmlEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    // Ampersand last so a literal "&amp;lt;" is not double-decoded.
    .replace(/&amp;/g, '&');

/**
 * Convert WordprocessingML (`word/document.xml`) body markup to plain text.
 *
 * Recovers text and paragraph structure: paragraph ends (`</w:p>`), line breaks
 * (`<w:br/>`, `<w:cr/>`) become newlines and tabs (`<w:tab/>`) become tabs;
 * field-instruction runs (`<w:instrText>` — e.g. HYPERLINK field codes) are
 * dropped so they do not pollute the text; all remaining tags are stripped,
 * leaving the run text (`<w:t>` content), and XML entities are decoded. Blank
 * runs of lines are collapsed. Pure and deterministic.
 */
export const documentXmlToText = (xml: string): string => {
  let s = xml;
  // Drop field instruction runs (HYPERLINK/REF codes etc.) before stripping tags.
  s = s.replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '');
  // Structural markup → whitespace.
  s = s.replace(/<w:tab\b[^>]*\/?>/g, '\t');
  s = s.replace(/<w:(?:br|cr)\b[^>]*\/?>/g, '\n');
  s = s.replace(/<w:p\b[^>]*\/>/g, '\n'); // empty self-closing paragraph
  s = s.replace(/<\/w:p>/g, '\n'); // paragraph end
  // Remove every remaining tag, leaving the run text content.
  s = s.replace(/<[^>]+>/g, '');
  // Decode XML entities in the recovered text.
  s = decodeXmlEntities(s);
  // Normalise: trim trailing whitespace per line, collapse 3+ blank lines to 1,
  // and trim leading/trailing blank lines.
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
  return s;
};

/**
 * Extract the plain-text body of a DOCX from its ZIP entries (R8.1, extended).
 * Locates `word/document.xml` (case-insensitively) and converts it via
 * {@link documentXmlToText}. Returns `''` when the archive has no main document
 * part, so the caller surfaces an empty extraction rather than throwing.
 */
export const extractDocxText = (entries: readonly DocxZipEntry[]): string => {
  const doc =
    entries.find((e) => e.path === 'word/document.xml') ??
    entries.find((e) => e.path.toLowerCase() === 'word/document.xml');
  return doc ? documentXmlToText(doc.text) : '';
};
