import { describe, expect, it } from 'vitest';
import {
  anchorComment,
  extractIds,
  hasAnchor,
  isIdToken,
  parseAnchorIds,
  parseMarkdown,
  renderPrintable,
  serializeMarkdown,
  stripAnchorsFromText,
  type MarkdownDocument,
} from './index';

describe('@core/markdown — anchor format (R34.2)', () => {
  it('renders the canonical anchor comment for an id', () => {
    expect(anchorComment('STAR-01')).toBe('<!-- id: STAR-01 -->');
    expect(anchorComment('BULLET-12')).toBe('<!-- id: BULLET-12 -->');
  });

  it('validates id tokens', () => {
    expect(isIdToken('STAR-01')).toBe(true);
    expect(isIdToken('BULLET-123')).toBe(true);
    expect(isIdToken('STAR')).toBe(false);
    expect(isIdToken('not an id')).toBe(false);
  });

  it('extracts anchor ids in document order, preserving duplicates', () => {
    const text = [
      anchorComment('STAR-01'),
      'some prose',
      anchorComment('BULLET-02'),
      anchorComment('STAR-01'), // duplicate kept
    ].join('\n');
    expect(parseAnchorIds(text)).toEqual(['STAR-01', 'BULLET-02', 'STAR-01']);
  });

  it('tolerates loose whitespace inside anchors', () => {
    expect(parseAnchorIds('<!--id:STAR-09-->')).toEqual(['STAR-09']);
    expect(parseAnchorIds('<!--   id:   STAR-09   -->')).toEqual(['STAR-09']);
  });

  it('detects presence of anchors', () => {
    expect(hasAnchor('text only')).toBe(false);
    expect(hasAnchor(`text ${anchorComment('STAR-01')}`)).toBe(true);
  });

  it('strips anchors from a raw string', () => {
    const text = `## Title\n${anchorComment('STAR-01')}\nbody line`;
    const out = stripAnchorsFromText(text);
    expect(out).not.toMatch(/<!--\s*id:/);
    expect(out).toContain('## Title');
    expect(out).toContain('body line');
  });
});

describe('@core/markdown — parse / serialize (R34.1)', () => {
  const sample = `---
ids:
  - STAR-01
  - STAR-02
title: Led migration
---
## Led migration to event-driven pipeline
<!-- id: STAR-01 -->
**Situation:** legacy batch pipeline

Second point <!-- id: STAR-02 --> inline.
`;

  it('parses frontmatter, body and the union of ids', () => {
    const doc = parseMarkdown(sample);
    expect(doc.frontmatter).toEqual({ title: 'Led migration' });
    expect(doc.ids).toEqual(['STAR-01', 'STAR-02']);
    expect(doc.body).toContain('## Led migration to event-driven pipeline');
    // ids must not linger inside the frontmatter object.
    expect('ids' in doc.frontmatter).toBe(false);
  });

  it('unions frontmatter ids with body anchors, deduped in order', () => {
    const raw = `---
ids:
  - STAR-01
---
${anchorComment('STAR-01')}
${anchorComment('BULLET-05')}
body
`;
    const doc = parseMarkdown(raw);
    // STAR-01 (frontmatter + anchor) deduped, BULLET-05 (anchor only) appended.
    expect(doc.ids).toEqual(['STAR-01', 'BULLET-05']);
  });

  it('emits no frontmatter fence when there is nothing to mirror', () => {
    const doc: MarkdownDocument = { frontmatter: {}, ids: [], body: 'plain body\n' };
    expect(serializeMarkdown(doc)).toBe('plain body\n');
  });

  it('mirrors the ids list into frontmatter on serialize', () => {
    const doc: MarkdownDocument = {
      frontmatter: { title: 'X' },
      ids: ['STAR-01', 'STAR-02'],
      body: 'body\n',
    };
    const out = serializeMarkdown(doc);
    const reparsed = parseMarkdown(out);
    expect(reparsed.ids).toEqual(['STAR-01', 'STAR-02']);
    expect(reparsed.frontmatter).toEqual({ title: 'X' });
  });
});

describe('@core/markdown — lossless round trip (R34.2)', () => {
  const docs: string[] = [
    `---
ids:
  - STAR-01
  - STAR-02
title: Led migration
---
## Heading
<!-- id: STAR-01 -->
**Situation:** content stays exactly

Second <!-- id: STAR-02 --> inline.
`,
    `# No frontmatter doc
${anchorComment('BULLET-01')}
- a bullet
- another bullet
`,
    'plain markdown, no ids and no frontmatter\n',
  ];

  it('preserves every identifier and all body content across parse → serialize → parse', () => {
    for (const raw of docs) {
      const first = parseMarkdown(raw);
      const serialized = serializeMarkdown(first);
      const second = parseMarkdown(serialized);

      // Every identifier is preserved.
      expect(second.ids).toEqual(first.ids);
      // All body content is preserved byte-for-byte.
      expect(second.body).toBe(first.body);
      expect(second.frontmatter).toEqual(first.frontmatter);
    }
  });

  it('serialize is a fixpoint (serialize ∘ parse ∘ serialize === serialize)', () => {
    for (const raw of docs) {
      const once = serializeMarkdown(parseMarkdown(raw));
      const twice = serializeMarkdown(parseMarkdown(once));
      expect(twice).toBe(once);
    }
  });
});

describe('@core/markdown — printable rendering strips anchors (R34.2)', () => {
  const sample = `---
ids:
  - STAR-01
  - STAR-02
---
## Led migration
<!-- id: STAR-01 -->
**Situation:** did things

Para two <!-- id: STAR-02 --> inline.
`;

  it('contains none of the identifier anchors in printable output', () => {
    const printable = renderPrintable(sample);
    expect(printable).not.toMatch(/<!--\s*id:/);
    expect(printable).not.toContain('STAR-01');
    expect(printable).not.toContain('STAR-02');
  });

  it('keeps the human-readable content', () => {
    const printable = renderPrintable(sample);
    expect(printable).toContain('Led migration');
    expect(printable).toContain('Situation');
    expect(printable).toContain('Para two');
  });

  it('drops frontmatter from printable output', () => {
    const printable = renderPrintable(sample);
    expect(printable).not.toContain('ids:');
    expect(printable.startsWith('---')).toBe(false);
  });

  it('accepts a MarkdownDocument as well as a raw string', () => {
    const doc = parseMarkdown(sample);
    expect(renderPrintable(doc)).toBe(renderPrintable(sample));
  });
});

describe('@core/markdown — extractIds', () => {
  it('returns the canonical id union for a raw string', () => {
    const raw = `---
ids:
  - STAR-01
---
${anchorComment('BULLET-09')}
`;
    expect(extractIds(raw)).toEqual(['STAR-01', 'BULLET-09']);
  });
});
