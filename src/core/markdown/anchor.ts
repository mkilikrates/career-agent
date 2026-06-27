// Stable-ID anchor comments (R34.2).
//
// Stable identifiers are embedded in human-readable Markdown as HTML anchor
// comments placed adjacent to their content, e.g.
//
//   ## Led migration to event-driven pipeline
//   <!-- id: STAR-01 -->
//
// HTML comments survive a Markdown → PDF/print pipeline without rendering
// (R34.2), and the same identifiers are mirrored into the document frontmatter
// `ids: [...]` list so the healing pass gets an O(1) index without re-parsing
// bodies. This module owns the canonical anchor *format* (write) and its
// recognition (read); everything else in `@core/markdown` builds on these.

/** The literal key used inside an anchor comment (`<!-- id: ... -->`). */
export const ANCHOR_KEY = 'id';

/**
 * Recognises a stable identifier token such as `STAR-01` or `BULLET-12`.
 * One-or-more letters, a hyphen, then one-or-more digits. Anchored so a token
 * must match in full when validating a single id.
 */
export const ID_TOKEN = /[A-Za-z]+-\d+/;

/** Whole-string id validation (e.g. `STAR-01`). */
export const isIdToken = (value: string): boolean =>
  new RegExp(`^${ID_TOKEN.source}$`).test(value);

/**
 * Global matcher for an anchor comment, capturing the id token in group 1.
 * Tolerant of surrounding whitespace: `<!--id:STAR-01-->` and
 * `<!--   id: STAR-01   -->` both match. A fresh RegExp is returned on each call
 * so callers never share `lastIndex` state.
 */
export const anchorPattern = (): RegExp =>
  new RegExp(`<!--\\s*${ANCHOR_KEY}:\\s*(${ID_TOKEN.source})\\s*-->`, 'g');

/**
 * Render the canonical anchor comment for an identifier. This is the single
 * place the on-disk anchor spelling is defined, so writers stay consistent.
 */
export const anchorComment = (id: string): string => `<!-- ${ANCHOR_KEY}: ${id} -->`;

/**
 * Extract every identifier embedded as an anchor comment in `text`, in document
 * order. Duplicates are preserved (the healing pass relies on seeing repeats to
 * detect duplicate-id declarations); callers that want a unique set should
 * dedupe themselves.
 */
export const parseAnchorIds = (text: string): string[] => {
  const ids: string[] = [];
  const re = anchorPattern();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return ids;
};

/** True when `text` contains at least one anchor comment. */
export const hasAnchor = (text: string): boolean => anchorPattern().test(text);

/**
 * Remove every anchor comment from a raw string. Used as a fast-path string
 * strip; the AST-based {@link renderPrintable} in `markdown-document` performs
 * the structural strip used for printable output. Collapses whitespace left
 * dangling by a removed anchor on its own line.
 */
export const stripAnchorsFromText = (text: string): string =>
  text
    // Anchor alone on a line → drop the whole line.
    .replace(new RegExp(`^[ \\t]*${anchorPattern().source}[ \\t]*$\\n?`, 'gm'), '')
    // Any remaining inline anchors → drop the anchor and a leading space.
    .replace(new RegExp(`[ \\t]*${anchorPattern().source}`, 'g'), '');
