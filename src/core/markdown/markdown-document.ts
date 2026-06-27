// Markdown-as-database serializer / parser (R34.1, R34.2).
//
// The Memory Store is plain, human-readable Markdown. Each file is modelled as
// a `MarkdownDocument`: a frontmatter object, the canonical list of stable
// identifiers it declares, and the raw Markdown body (which carries the
// identifiers inline as anchor comments — see `./anchor`).
//
// Two guarantees this module provides:
//   1. Lossless round trip (R34.2): `parse → serialize → parse` is a fixpoint,
//      preserving every identifier and all body content byte-for-byte. Bodies
//      are stored verbatim; only the frontmatter is (re)emitted, and the `ids`
//      list is always kept mirrored to the anchors actually present.
//   2. Non-printing identifiers (R34.2): `renderPrintable` strips frontmatter
//      and every anchor comment via the Markdown AST, so identifiers never
//      reach printed/PDF output.
//
// Frontmatter handling uses `gray-matter`; printable rendering uses
// `remark`/`mdast` so anchor stripping is structural rather than text-hacking.

import matter from 'gray-matter';
import { remark } from 'remark';
import { visit, SKIP } from 'unist-util-visit';
import type { Root } from 'mdast';
import { anchorPattern, parseAnchorIds } from './anchor';

/** A single Markdown-as-database file (R34.1). */
export interface MarkdownDocument {
  /** Frontmatter key/values other than the mirrored `ids` list. */
  frontmatter: Record<string, unknown>;
  /**
   * Canonical, de-duplicated list of stable identifiers declared by this
   * document, mirrored into the frontmatter `ids:` list on serialize (R34.2).
   */
  ids: string[];
  /** Raw Markdown body (frontmatter removed); carries anchor comments inline. */
  body: string;
}

/** Coerce an arbitrary frontmatter `ids` value into a clean `string[]`. */
const readFrontmatterIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** De-duplicate preserving first-seen order. */
const dedupe = (ids: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
};

/**
 * Parse a raw Markdown string into a {@link MarkdownDocument} (R34.1). The
 * identifier list is the union of the frontmatter `ids:` list and the anchor
 * comments found in the body (frontmatter order first, then body-only ids), so
 * no identifier from either source is dropped.
 */
export const parseMarkdown = (raw: string): MarkdownDocument => {
  const parsed = matter(raw);
  const body = parsed.content;

  const frontmatter: Record<string, unknown> = { ...(parsed.data as Record<string, unknown>) };
  const frontmatterIds = readFrontmatterIds(frontmatter.ids);
  delete frontmatter.ids;

  const ids = dedupe([...frontmatterIds, ...parseAnchorIds(body)]);

  return { frontmatter, ids, body };
};

/**
 * Serialize a {@link MarkdownDocument} back to a Markdown string (R34.1). The
 * `ids` list is mirrored into the frontmatter whenever the document declares
 * identifiers; a document with neither identifiers nor other frontmatter emits
 * a bare body with no frontmatter fence.
 */
export const serializeMarkdown = (doc: MarkdownDocument): string => {
  const data: Record<string, unknown> = { ...doc.frontmatter };
  if (doc.ids.length > 0) {
    data.ids = [...doc.ids];
  }

  if (Object.keys(data).length === 0) {
    return doc.body;
  }

  return matter.stringify(doc.body, data);
};

/** True when a node value is composed solely of anchor comments / whitespace. */
const isAnchorOnly = (value: string): boolean =>
  value.replace(anchorPattern(), '').trim().length === 0;

/**
 * Render a document (or raw Markdown string) to printable Markdown with every
 * stable-identifier anchor removed (R34.2). Frontmatter is dropped and anchor
 * comments are stripped structurally over the Markdown AST, so the result is
 * safe to hand to a Markdown → PDF/print pipeline with no identifiers leaking
 * into the printed page.
 */
export const renderPrintable = (input: string | MarkdownDocument): string => {
  const body = typeof input === 'string' ? parseMarkdown(input).body : input.body;

  const processor = remark();
  const tree = processor.parse(body) as Root;

  visit(tree, 'html', (node, index, parent) => {
    if (!parent || typeof index !== 'number') return;

    if (isAnchorOnly(node.value)) {
      // The whole HTML node is just anchor(s) → remove it entirely.
      parent.children.splice(index, 1);
      return [SKIP, index];
    }

    // HTML node mixes anchors with other markup → strip only the anchors.
    node.value = node.value.replace(anchorPattern(), '');
    return undefined;
  });

  return processor.stringify(tree);
};

/**
 * Convenience accessor for every stable identifier a document declares (the
 * union of frontmatter and anchors), in canonical order.
 */
export const extractIds = (input: string | MarkdownDocument): string[] =>
  typeof input === 'string' ? parseMarkdown(input).ids : dedupe(input.ids);
