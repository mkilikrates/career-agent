// Ingestion_Engine — orchestrates the launch-format ingestion pipeline (R8–R13).
//
// The engine wires together the pure ingestion modules and the three external
// boundaries (pdf.js, JSZip, PapaParse) it depends on as injected PORTS, never
// as direct library imports. This keeps the engine deterministic and unit-
// testable with fake ports (design §Testing Strategy).
//
// Pipeline (design "Ingestion_Engine"): format detection → text/record
// extraction (pdf.js / PapaParse / plain read) → per-field record building →
// confidence scoring → provenance attachment → (multi-doc) reconciliation /
// conflict detection. Single-file `ingest` reports the items, the grouped-by-
// document summary, and any low-confidence PDF regions; `reconcile` handles the
// cross-document merge.

import type { DocId, ExtractedItem } from '@core/types';
import { asDocId } from '@core/types';
import type { PdfTextExtractor } from '@adapters/pdf-extractor';
import type { ZipReader, CsvParser } from '@adapters/linkedin-zip';

import type { FileBlob } from './file-blob';
import {
  acceptedFormats,
  detectFormat,
  recommendedChecklist,
  rejectUnsupported,
  type ChecklistItem,
  type Format,
  type RejectionNotice,
} from './formats';
import { flagLowConfidencePdfText, type FlaggedRegion } from './pdf-extraction';
import { parseLinkedInRecords, type LinkedInRecords } from './linkedin';
import { extractFromLinkedIn, extractFromText, sequentialItemIds } from './extraction';
import { extractDocxText } from './docx';
import { reconcile, type ExtractedDoc, type ReconcileResult } from './reconciliation';
import {
  detectGaps,
  groupByDocument,
  type DocumentGroup,
  type EmploymentGap,
} from './review';
import type { EmploymentRecord } from './extraction';

/** The result of ingesting a single file (R8, R10, R12.1). */
export interface IngestionResult {
  /** The document id derived from the file name. */
  readonly doc: DocId;
  /** The detected launch format. */
  readonly format: Format;
  /** Extracted items, each carrying confidence + provenance (R10, R11, R38). */
  readonly items: ExtractedItem[];
  /**
   * The full document text fed to extraction (PDF confident text, or the raw
   * Markdown/plain-text file content). Empty for formats with no single text
   * body (e.g. a LinkedIn ZIP of structured CSVs). Retained so an opt-in,
   * local-only AI skill-discovery pass can read the WHOLE document — finding
   * skills the structured extractor misses — rather than only the parsed items
   * (R47.1/R47.5). It is persisted to the user-owned Memory Store
   * (`profile/raw_documents.md`) — which never leaves the device (R7.1) — so
   * whole-document local discovery survives session resume / Memory import
   * (R49); it is never included in a cloud payload (R46.4).
   */
  readonly rawText: string;
  /** Conflicts (always empty for a single document; see {@link reconcile}). */
  readonly conflicts: ReconcileResult['conflicts'];
  /** Low-confidence PDF regions flagged and excluded (R8.5). */
  readonly lowConfidencePdfText: FlaggedRegion[];
  /** Items grouped by source document for the review summary (R12.1). */
  readonly groupedByDocument: DocumentGroup[];
}

/** Thrown when an out-of-scope format is ingested (R8.3). */
export class UnsupportedFormatError extends Error {
  constructor(public readonly notice: RejectionNotice) {
    super(notice.message);
    this.name = 'UnsupportedFormatError';
  }
}

/** The external boundaries the engine depends on, injected as ports. */
export interface IngestionEngineDeps {
  /** pdf.js-backed text extractor (R8.5). */
  readonly pdfExtractor: PdfTextExtractor;
  /** JSZip-backed ZIP reader (R8.2). */
  readonly zipReader: ZipReader;
  /** PapaParse-backed CSV parser (R8.2). */
  readonly csvParser: CsvParser;
}

/** Derive a stable {@link DocId} from a file name. */
const docIdOf = (file: FileBlob): DocId => asDocId(file.name);

/**
 * The Ingestion_Engine (design "Ingestion_Engine"). Construct once with the
 * external-boundary ports; all methods are otherwise pure with respect to the
 * injected collaborators.
 */
export class IngestionEngine {
  private readonly pdfExtractor: PdfTextExtractor;
  private readonly zipReader: ZipReader;
  private readonly csvParser: CsvParser;

  constructor(deps: IngestionEngineDeps) {
    this.pdfExtractor = deps.pdfExtractor;
    this.zipReader = deps.zipReader;
    this.csvParser = deps.csvParser;
  }

  /** The launch-supported formats (R8.1). */
  acceptedFormats(): Format[] {
    return acceptedFormats();
  }

  /** The recommended document checklist shown before ingestion (R8.4). */
  recommendedChecklist(locale: string): ChecklistItem[] {
    return recommendedChecklist(locale);
  }

  /** Build the rejection notice for an out-of-scope file (R8.3). */
  rejectUnsupported(file: FileBlob): RejectionNotice {
    return rejectUnsupported(file);
  }

  /** Detect employment gaps longer than three months (R10.4, R13.1). */
  detectGaps(history: readonly EmploymentRecord[]): EmploymentGap[] {
    return detectGaps(history);
  }

  /** Reconcile several documents: merge richest, flag conflicts (R9). */
  reconcile(docs: readonly ExtractedDoc[]): ReconcileResult {
    return reconcile(docs);
  }

  /**
   * Parse a LinkedIn export ZIP into structured records (R8.2). Reads the ZIP
   * via the injected {@link ZipReader} and parses each CSV via the injected
   * {@link CsvParser}.
   */
  async parseLinkedInZip(file: FileBlob): Promise<LinkedInRecords> {
    const bytes = await file.bytes();
    const entries = await this.zipReader.readTextEntries(bytes);
    return parseLinkedInRecords(entries, this.csvParser);
  }

  /**
   * Ingest a single file (R8, R10). Rejects out-of-scope formats up front
   * (R8.3, throwing {@link UnsupportedFormatError}); otherwise extracts items
   * with confidence + provenance and reports the grouped-by-document summary
   * and any flagged low-confidence PDF regions (R8.5, R12.1).
   *
   * Source-language independence (R41.4): extraction is deliberately decoupled
   * from the Session Language. This method takes ONLY the source file — there
   * is no locale/language parameter on the extraction path — so a document in
   * any language is extracted the same way regardless of the UI/session
   * language the user selected. The only locale-aware ingestion surface is the
   * presentational {@link recommendedChecklist} (which localises labels shown
   * to the user); the structured extraction itself (`extractFromText` /
   * `extractFromLinkedIn`) is purely a function of the source content.
   */
  async ingest(file: FileBlob): Promise<IngestionResult> {
    const detection = detectFormat(file);
    if (!detection.accepted) {
      throw new UnsupportedFormatError(detection.rejection);
    }

    const doc = docIdOf(file);
    const nextId = sequentialItemIds(doc);
    let items: ExtractedItem[] = [];
    let lowConfidencePdfText: FlaggedRegion[] = [];
    // The full document text fed to extraction — retained for the opt-in,
    // local-only AI skill-discovery pass (R47.1/R47.5). Empty for LinkedIn ZIPs,
    // which carry structured CSV records rather than a single prose body.
    let rawText = '';

    switch (detection.format) {
      case 'pdf': {
        const raw = await this.pdfExtractor.extract(await file.bytes());
        const extraction = flagLowConfidencePdfText(raw);
        lowConfidencePdfText = [...extraction.flaggedRegions];
        rawText = extraction.text;
        items = extractFromText(extraction.text, doc, nextId);
        break;
      }
      case 'markdown':
      case 'plain-text': {
        const text = await file.text();
        rawText = text;
        items = extractFromText(text, doc, nextId);
        break;
      }
      case 'docx': {
        // A .docx is a ZIP (OOXML); read its entries through the same ZipReader
        // port used for the LinkedIn export, pull the plain text out of
        // word/document.xml locally (no new dependency), then extract from it
        // exactly like a Markdown/plain-text body.
        const entries = await this.zipReader.readTextEntries(await file.bytes());
        const text = extractDocxText(entries);
        rawText = text;
        items = extractFromText(text, doc, nextId);
        break;
      }
      case 'linkedin-zip': {
        const records = await this.parseLinkedInZip(file);
        items = extractFromLinkedIn(records, doc, nextId);
        break;
      }
    }

    return {
      doc,
      format: detection.format,
      items,
      rawText,
      conflicts: [],
      lowConfidencePdfText,
      groupedByDocument: groupByDocument(items),
    };
  }
}

/** Convenience factory mirroring the codebase's DI-friendly `create*` style. */
export const createIngestionEngine = (deps: IngestionEngineDeps): IngestionEngine =>
  new IngestionEngine(deps);
