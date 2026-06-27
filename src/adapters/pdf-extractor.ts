// PDF text-extraction boundary — the `pdf.js` web-worker adapter (R8.5).
//
// The pdf.js worker is an EXTERNAL boundary, exactly like the storage handles
// and provider clients: `@core` never imports `pdfjs-dist` directly. Instead it
// depends on the small {@link PdfTextExtractor} port defined here, which yields
// per-run text annotated with a 0..1 confidence score. `@core/ingestion` then
// applies the trust policy (flag + exclude low-confidence text) over that raw
// extraction deterministically, so the policy is unit-testable with a fake
// extractor and never needs a real PDF or worker (design §Testing Strategy).
//
// The concrete {@link PdfJsTextExtractor} lazily imports `pdfjs-dist` so the
// heavy worker module is only loaded when a real PDF is actually parsed, and
// derives a confidence heuristic from the text layer (digital text → high;
// empty pages or runs dominated by the Unicode replacement character, typical
// of a poor scan with no usable text layer → low). This keeps R8.5's "scanned
// with low extraction confidence" detection on the adapter side of the boundary.

/** A single text run extracted from a PDF page, with a 0..1 confidence score. */
export interface PdfTextRun {
  /** The extracted text of this run. */
  readonly text: string;
  /** Extraction confidence in `[0, 1]`; lower means less certain (R8.5). */
  readonly confidence: number;
}

/** The text runs extracted from a single 1-based PDF page. */
export interface PdfPageContent {
  /** 1-based page number. */
  readonly pageNumber: number;
  /** Text runs, in reading order. */
  readonly runs: readonly PdfTextRun[];
}

/** The raw, confidence-annotated result of extracting a whole PDF. */
export interface PdfRawExtraction {
  readonly pages: readonly PdfPageContent[];
}

/**
 * The port `@core/ingestion` depends on. Implementations turn PDF bytes into
 * confidence-annotated text runs; the trust policy (flag + exclude) lives in
 * core (R8.5).
 */
export interface PdfTextExtractor {
  /** Extract confidence-annotated text runs from PDF bytes. */
  extract(bytes: Uint8Array): Promise<PdfRawExtraction>;
}

/** Tuning options for the pdf.js-backed extractor. */
export interface PdfJsTextExtractorOptions {
  /**
   * Optional factory that creates a real, bundler-instantiated module Worker
   * for pdf.js (the Vite `?worker` import). This is the PREFERRED option: it
   * hands pdf.js a ready `workerPort`, so pdf.js never has to resolve a worker
   * URL itself and never falls back to its "fake worker" path, which loads the
   * worker by dynamically importing the `.mjs` from the asset URL. That fallback
   * fails on a statically served bundle (e.g. nginx) with "Setting up fake
   * worker failed: Failed to fetch dynamically imported module" whenever the
   * served `.mjs` cannot be imported as a module. A bundled worker avoids that
   * entirely and works identically in dev and from the static bundle.
   *
   * The factory is invoked lazily on first extraction and the resulting port is
   * reused for the lifetime of the extractor.
   */
  readonly createWorker?: () => Worker;
  /**
   * Optional worker source URL/path forwarded to `pdf.js`, used only when
   * {@link createWorker} is not provided. When both are omitted the caller is
   * responsible for having configured `GlobalWorkerOptions.workerSrc`, or pdf.js
   * falls back to its default resolution.
   */
  readonly workerSrc?: string;
}

/**
 * Heuristic per-run confidence from a digital-PDF text item (R8.5). A clean
 * text run scores high; a run dominated by replacement characters (a hallmark
 * of a scanned page with a broken/absent text layer) scores low so the core
 * policy flags and excludes it.
 */
export const heuristicRunConfidence = (text: string): number => {
  if (text.length === 0) return 0;
  const bad = (text.match(/\uFFFD/g) ?? []).length;
  const badRatio = bad / text.length;
  if (badRatio === 0) return 0.97;
  if (badRatio < 0.1) return 0.7;
  if (badRatio < 0.3) return 0.45;
  return 0.1;
};

/**
 * `pdf.js`-backed {@link PdfTextExtractor}. Loads `pdfjs-dist` lazily so the
 * worker module is only pulled in when a real PDF is parsed. Each page's text
 * items become {@link PdfTextRun}s with a heuristic confidence; pages that yield
 * no text layer at all surface as a single empty, zero-confidence run so the
 * core policy can flag the page as unreadable rather than silently dropping it.
 */
export class PdfJsTextExtractor implements PdfTextExtractor {
  constructor(private readonly options: PdfJsTextExtractorOptions = {}) {}

  /** Set once, on first extraction, so the worker is created lazily and reused. */
  private workerConfigured = false;

  async extract(bytes: Uint8Array): Promise<PdfRawExtraction> {
    const pdfjs = await import('pdfjs-dist');
    if (!this.workerConfigured) {
      if (this.options.createWorker) {
        // Hand pdf.js a real, bundler-instantiated worker. This avoids the
        // fake-worker dynamic-import fallback that breaks on statically served
        // `.mjs` bundles.
        pdfjs.GlobalWorkerOptions.workerPort = this.options.createWorker();
      } else if (this.options.workerSrc) {
        pdfjs.GlobalWorkerOptions.workerSrc = this.options.workerSrc;
      }
      this.workerConfigured = true;
    }

    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    const pages: PdfPageContent[] = [];

    try {
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        const runs: PdfTextRun[] = [];

        for (const item of content.items) {
          // pdf.js text items expose `str`; marked-content items do not.
          const str = (item as { str?: unknown }).str;
          if (typeof str !== 'string' || str.length === 0) continue;
          runs.push({ text: str, confidence: heuristicRunConfidence(str) });
        }

        // A page with no usable text layer is reported as a single empty,
        // zero-confidence run so the core policy flags it (R8.5).
        pages.push({
          pageNumber,
          runs: runs.length > 0 ? runs : [{ text: '', confidence: 0 }],
        });
        page.cleanup();
      }
    } finally {
      await doc.destroy();
    }

    return { pages };
  }
}

/** Convenience factory mirroring the other adapters' DI-friendly style. */
export const createPdfTextExtractor = (
  options?: PdfJsTextExtractorOptions,
): PdfTextExtractor => new PdfJsTextExtractor(options);
