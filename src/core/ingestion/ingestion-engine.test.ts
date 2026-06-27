import { describe, expect, it } from 'vitest';
import { asDocId, asISODate } from '@core/types';
import type { PdfRawExtraction, PdfTextExtractor } from '@adapters/pdf-extractor';
import type { CsvParser, ZipReader, ZipTextEntry } from '@adapters/linkedin-zip';
import {
  IngestionEngine,
  UnsupportedFormatError,
  type IngestionEngineDeps,
} from './ingestion-engine';
import { fileBlobFromBytes, fileBlobFromText } from './file-blob';
import type { EmploymentRecord } from './extraction';
import type { ExtractedDoc } from './reconciliation';

// --- Fake external-boundary ports (deterministic, no real libraries) -----

const fakePdf = (raw: PdfRawExtraction): PdfTextExtractor => ({
  extract: async () => raw,
});

const fakeZip = (entries: ZipTextEntry[]): ZipReader => ({
  readTextEntries: async () => entries,
});

const fakeCsv: CsvParser = {
  parse(csv: string): Record<string, string>[] {
    const [headerLine, ...rows] = csv.trim().split('\n');
    const headers = headerLine.split(',').map((h) => h.trim());
    return rows
      .filter((r) => r.trim().length > 0)
      .map((row) => {
        const cells = row.split(',').map((c) => c.trim());
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => (obj[h] = cells[i] ?? ''));
        return obj;
      });
  },
};

const makeEngine = (overrides: Partial<IngestionEngineDeps> = {}): IngestionEngine =>
  new IngestionEngine({
    pdfExtractor: fakePdf({ pages: [] }),
    zipReader: fakeZip([]),
    csvParser: fakeCsv,
    ...overrides,
  });

describe('IngestionEngine — surface (R8.1, R8.4)', () => {
  it('exposes the accepted formats and the recommended checklist', () => {
    const engine = makeEngine();
    expect(engine.acceptedFormats()).toEqual([
      'pdf',
      'markdown',
      'plain-text',
      'linkedin-zip',
      'docx',
    ]);
    expect(engine.recommendedChecklist('en').length).toBeGreaterThan(0);
  });
});

describe('IngestionEngine — ingest text formats (R10, R12.1)', () => {
  it('ingests Markdown, extracting items grouped by document', async () => {
    const engine = makeEngine();
    const file = fileBlobFromText('cv.md', 'Skills\nTypeScript, Go\n\nEnglish (native)');
    const result = await engine.ingest(file);

    expect(result.format).toBe('markdown');
    expect(result.doc).toBe(asDocId('cv.md'));
    expect(result.items.some((i) => i.type === 'skill')).toBe(true);
    expect(result.items.some((i) => i.type === 'language')).toBe(true);
    expect(result.groupedByDocument).toHaveLength(1);
    expect(result.lowConfidencePdfText).toEqual([]);
  });

  it('ingests plain text', async () => {
    const result = await makeEngine().ingest(
      fileBlobFromText('notes.txt', 'Reduced costs by 25%'),
    );
    expect(result.format).toBe('plain-text');
    expect(result.items.some((i) => i.type === 'quantified_result')).toBe(true);
  });

  it('ingests DOCX by reading word/document.xml via the ZipReader port', async () => {
    const documentXml =
      '<w:document><w:body>' +
      '<w:p><w:r><w:t>Skills</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>TypeScript, Go</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    const engine = makeEngine({
      zipReader: fakeZip([
        { name: 'document.xml', path: 'word/document.xml', text: documentXml },
      ]),
    });
    const result = await engine.ingest(fileBlobFromBytes('cv.docx', new Uint8Array([1, 2, 3])));

    expect(result.format).toBe('docx');
    expect(result.doc).toBe(asDocId('cv.docx'));
    expect(result.items.some((i) => i.type === 'skill')).toBe(true);
    // The recovered body text is retained for the local-only AI discovery pass.
    expect(result.rawText).toContain('TypeScript');
  });
});

describe('IngestionEngine — ingest PDF with confidence flagging (R8.5)', () => {
  it('extracts confident text and flags low-confidence regions', async () => {
    const engine = makeEngine({
      pdfExtractor: fakePdf({
        pages: [
          {
            pageNumber: 1,
            runs: [
              { text: 'Reduced deployment time by 40%', confidence: 0.97 },
              { text: '\uFFFD\uFFFD\uFFFD garbled', confidence: 0.1 },
            ],
          },
        ],
      }),
    });

    const result = await engine.ingest(fileBlobFromBytes('cv.pdf', new Uint8Array([1])));
    expect(result.format).toBe('pdf');
    expect(result.lowConfidencePdfText).toHaveLength(1);
    expect(result.items.some((i) => i.type === 'quantified_result')).toBe(true);
    // The garbled text never reached extraction.
    expect(JSON.stringify(result.items)).not.toContain('garbled');
  });
});

describe('IngestionEngine — LinkedIn ZIP (R8.2)', () => {
  it('parses and extracts LinkedIn records via the injected ports', async () => {
    const engine = makeEngine({
      zipReader: fakeZip([
        { name: 'Positions.csv', path: 'Positions.csv', text: 'Company Name,Title\nAcme,Engineer' },
        { name: 'Skills.csv', path: 'Skills.csv', text: 'Name\nTypeScript' },
      ]),
    });

    const records = await engine.parseLinkedInZip(
      fileBlobFromBytes('export.zip', new Uint8Array([1])),
    );
    expect(records.positions[0]).toMatchObject({ companyName: 'Acme', title: 'Engineer' });

    const result = await engine.ingest(fileBlobFromBytes('export.zip', new Uint8Array([1])));
    expect(result.format).toBe('linkedin-zip');
    expect(result.items.some((i) => i.type === 'employment' && i.confidence === 'High')).toBe(true);
  });
});

describe('IngestionEngine — rejection of out-of-scope formats (R8.3)', () => {
  it('throws UnsupportedFormatError with a deferred notice', async () => {
    const engine = makeEngine();
    const file = fileBlobFromBytes('resume.doc', new Uint8Array([1]));
    await expect(engine.ingest(file)).rejects.toBeInstanceOf(UnsupportedFormatError);
    expect(engine.rejectUnsupported(file).reason).toBe('deferred');
  });
});

describe('IngestionEngine — reconcile and detectGaps delegation (R9, R10.4)', () => {
  it('reconciles documents through the engine', () => {
    const docs: ExtractedDoc[] = [
      {
        docId: asDocId('a.md'),
        date: asISODate('2024-01'),
        items: [
          {
            id: asDocId('a.md#emp') as never,
            type: 'employment',
            fields: { employer: 'Acme', title: 'Engineer' },
            confidence: 'High',
            provenance: [{ kind: 'source_line', doc: asDocId('a.md'), line: 1, quote: 'x' }],
            userConfirmed: false,
            private: false,
            sourceDoc: asDocId('a.md'),
          },
        ],
      },
    ];
    expect(makeEngine().reconcile(docs).merged).toHaveLength(1);
  });

  it('detects employment gaps through the engine', () => {
    const history: EmploymentRecord[] = [
      { employer: 'A', title: 'Eng', start: '2015-01', end: '2018-06' },
      { employer: 'B', title: 'Eng', start: '2019-01' },
    ];
    expect(makeEngine().detectGaps(history)).toHaveLength(1);
  });
});
