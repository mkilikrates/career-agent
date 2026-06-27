// Unit tests for DOCX text extraction (word/document.xml → plain text).

import { describe, it, expect } from 'vitest';
import { documentXmlToText, extractDocxText, type DocxZipEntry } from './docx';

const para = (...runs: string[]): string =>
  `<w:p><w:r>${runs.map((t) => `<w:t>${t}</w:t>`).join('')}</w:r></w:p>`;

describe('documentXmlToText', () => {
  it('recovers paragraph text with one paragraph per line', () => {
    const xml =
      `<w:document><w:body>${para('Jane Doe')}${para('Senior Engineer')}</w:body></w:document>`;
    expect(documentXmlToText(xml)).toBe('Jane Doe\nSenior Engineer');
  });

  it('joins multiple runs within a paragraph and honours tabs and breaks', () => {
    const xml =
      `<w:p><w:r><w:t>Skills:</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Go</w:t></w:r>` +
      `<w:r><w:br/></w:r><w:r><w:t>TypeScript</w:t></w:r></w:p>`;
    expect(documentXmlToText(xml)).toBe('Skills:\tGo\nTypeScript');
  });

  it('decodes XML entities in run text', () => {
    const xml = para('R&amp;D &lt;lead&gt; &quot;2024&quot;');
    expect(documentXmlToText(xml)).toBe('R&D <lead> "2024"');
  });

  it('drops field-instruction runs (e.g. HYPERLINK codes)', () => {
    const xml =
      `<w:p><w:r><w:instrText> HYPERLINK "https://x" </w:instrText></w:r>` +
      `<w:r><w:t>my site</w:t></w:r></w:p>`;
    expect(documentXmlToText(xml)).toBe('my site');
  });

  it('collapses runs of blank paragraphs', () => {
    const xml = `${para('A')}<w:p/><w:p/>${para('B')}`;
    expect(documentXmlToText(xml)).toBe('A\n\nB');
  });
});

describe('extractDocxText', () => {
  it('extracts from word/document.xml among the archive entries', () => {
    const entries: DocxZipEntry[] = [
      { path: '[Content_Types].xml', text: '<Types/>' },
      { path: 'word/document.xml', text: para('Hello CV') },
      { path: 'word/styles.xml', text: '<w:styles/>' },
    ];
    expect(extractDocxText(entries)).toBe('Hello CV');
  });

  it('returns empty string when there is no main document part', () => {
    expect(extractDocxText([{ path: 'word/styles.xml', text: '<w:styles/>' }])).toBe('');
  });
});
