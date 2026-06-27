import { describe, expect, it } from 'vitest';
import {
  serializeRawDocuments,
  parseRawDocuments,
  type RawDocument,
} from './raw-documents-document';

describe('serializeRawDocuments', () => {
  it('renders an empty-state document when there are no raw documents', () => {
    const md = serializeRawDocuments([]);
    expect(md).toContain('# Raw Documents');
    expect(md).toContain('_No raw documents yet._');
  });

  it('renders one human-readable section per document with its full text', () => {
    const docs: RawDocument[] = [
      { doc: 'cv.md', text: 'Staff Engineer at Acme. Skills: TypeScript, Go.' },
      { doc: 'resume.pdf', text: 'Led the platform team. SQL, Kubernetes.' },
    ];
    const md = serializeRawDocuments(docs);
    expect(md).toContain('## cv.md');
    expect(md).toContain('Staff Engineer at Acme. Skills: TypeScript, Go.');
    expect(md).toContain('## resume.pdf');
    expect(md).toContain('Led the platform team. SQL, Kubernetes.');
  });

  it('drops documents whose text is empty or whitespace-only (e.g. a LinkedIn ZIP)', () => {
    const docs: RawDocument[] = [
      { doc: 'cv.md', text: 'real content' },
      { doc: 'linkedin.zip', text: '' },
      { doc: 'blank.txt', text: '   \n  ' },
    ];
    const restored = parseRawDocuments(serializeRawDocuments(docs));
    expect(restored).toEqual([{ doc: 'cv.md', text: 'real content' }]);
  });

  it('round-trips the full raw-text list through the embedded machine block (R49)', () => {
    const docs: RawDocument[] = [
      { doc: 'cv.md', text: 'TypeScript\nGo\n```fenced``` and # markdown chars' },
      { doc: 'resume.pdf', text: 'Line 1\n\nLine 2 with json-ish {"a":1} content' },
    ];
    const restored = parseRawDocuments(serializeRawDocuments(docs));
    expect(restored).toEqual(docs);
  });

  it('parseRawDocuments returns [] when there is no machine block', () => {
    expect(parseRawDocuments('# Raw Documents\n\njust prose, no json.')).toEqual([]);
  });
});
