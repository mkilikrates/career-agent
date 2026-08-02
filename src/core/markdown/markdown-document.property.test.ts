// Feature: career-agent, Property 11: Markdown identifier round trip and non-printing
//
// For any Markdown document containing embedded stable identifiers (anchor
// comments and/or frontmatter), parsing then re-serialising preserves every
// identifier and all content, and rendering the document to printable output
// contains none of the identifier anchors.
//
// **Validates: Requirements 34.2**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseMarkdown, serializeMarkdown, renderPrintable } from './markdown-document';
import { anchorComment, anchorPattern } from './anchor';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a stable identifier (STAR-NN or BULLET-NN). */
const arbId = fc
  .tuple(
    fc.constantFrom('STAR', 'BULLET'),
    fc.integer({ min: 1, max: 99 }),
  )
  .map(([kind, n]) => `${kind}-${String(n).padStart(2, '0')}`);

/** Generate a markdown heading line. */
const arbHeading = fc
  .stringMatching(/^[A-Za-z][A-Za-z0-9 ]{3,30}$/)
  .map((text) => `## ${text}`);

/** Generate a markdown body paragraph. */
const arbParagraph = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 .,;!?-]{10,80}$/);

/** Generate a markdown document with embedded anchor IDs. */
const arbDocWithIds = fc
  .tuple(
    fc.array(arbId, { minLength: 1, maxLength: 6 }),
    fc.array(arbHeading, { minLength: 1, maxLength: 4 }),
    fc.array(arbParagraph, { minLength: 1, maxLength: 4 }),
    fc.dictionary(
      fc.stringMatching(/^[a-z][a-z0-9_]{2,10}$/),
      fc.oneof(fc.string({ minLength: 1, maxLength: 20 }), fc.integer()),
      { minKeys: 0, maxKeys: 3 },
    ),
  )
  .map(([ids, headings, paragraphs, extraFm]) => {
    // Build a body with interleaved headings, anchors, and paragraphs
    const lines: string[] = [];
    for (let i = 0; i < Math.max(headings.length, ids.length); i++) {
      if (i < headings.length) lines.push(headings[i]);
      if (i < ids.length) lines.push(anchorComment(ids[i]));
      if (i < paragraphs.length) lines.push(paragraphs[i]);
    }
    const body = lines.join('\n\n');
    return { ids, body, extraFm };
  });

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('@core/markdown — Property 11: Markdown identifier round trip and non-printing', () => {
  it('parse → serialize → parse preserves every identifier', () => {
    fc.assert(
      fc.property(arbDocWithIds, ({ ids, body, extraFm }) => {
        const raw = `---\n${Object.entries(extraFm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\nids:\n${ids.map((id) => `  - ${id}`).join('\n')}\n---\n${body}`;

        const parsed = parseMarkdown(raw);
        const serialized = serializeMarkdown(parsed);
        const reparsed = parseMarkdown(serialized);

        // Every original ID is preserved after round trip
        for (const id of ids) {
          expect(reparsed.ids).toContain(id);
        }

        // The body content is preserved (anchor comments still present)
        for (const id of ids) {
          expect(reparsed.body).toContain(anchorComment(id));
        }
      }),
      { numRuns: 200 },
    );
  });

  it('parse → serialize is a fixpoint (double round trip is stable)', () => {
    fc.assert(
      fc.property(arbDocWithIds, ({ ids, body }) => {
        const raw = `---\nids:\n${ids.map((id) => `  - ${id}`).join('\n')}\n---\n${body}`;

        const first = serializeMarkdown(parseMarkdown(raw));
        const second = serializeMarkdown(parseMarkdown(first));

        expect(second).toBe(first);
      }),
      { numRuns: 200 },
    );
  });

  it('renderPrintable contains none of the identifier anchors', () => {
    fc.assert(
      fc.property(arbDocWithIds, ({ ids, body }) => {
        const raw = `---\nids:\n${ids.map((id) => `  - ${id}`).join('\n')}\n---\n${body}`;

        const printable = renderPrintable(raw);

        // No anchor comment pattern should remain
        expect(anchorPattern().test(printable)).toBe(false);

        // None of the specific anchor comments should appear
        for (const id of ids) {
          expect(printable).not.toContain(anchorComment(id));
        }
      }),
      { numRuns: 200 },
    );
  });

  it('renderPrintable preserves all non-identifier content', () => {
    fc.assert(
      fc.property(arbDocWithIds, ({ ids, body }) => {
        const raw = `---\nids:\n${ids.map((id) => `  - ${id}`).join('\n')}\n---\n${body}`;
        const printable = renderPrintable(raw);

        // Actual content paragraphs survive (non-anchor lines)
        const contentLines = body.split('\n').filter(
          (line) => line.trim().length > 0 && !anchorPattern().test(line),
        );
        for (const line of contentLines) {
          const cleaned = line.trim();
          if (cleaned.length > 5) {
            expect(printable).toContain(cleaned);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
