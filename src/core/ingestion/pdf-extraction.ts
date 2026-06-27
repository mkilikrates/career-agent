// PDF extraction confidence policy (R8.5).
//
// The pdf.js boundary (`@adapters/pdf-extractor`) hands core a confidence-
// annotated {@link PdfRawExtraction}. This module applies the trust policy:
// runs at or above the low-confidence threshold are kept and joined into the
// usable text; runs below it are EXCLUDED from the extracted text and surfaced
// as explicit {@link FlaggedRegion}s instead (R8.5 — "flag the affected text
// explicitly and SHALL NOT silently include uncertain text in extractions").
//
// The policy is pure and deterministic, so it is unit-tested with a fake
// extractor result and never needs a real PDF or worker.

import type { Confidence } from '@core/types';
import type { PdfRawExtraction } from '@adapters/pdf-extractor';

/**
 * A low-confidence PDF region that was flagged and EXCLUDED from the extracted
 * text (R8.5). Carries enough context for the review UI to show the user what
 * was withheld and why.
 */
export interface FlaggedRegion {
  /** 1-based page the uncertain text was found on. */
  readonly pageNumber: number;
  /** The uncertain text (shown to the user, never silently merged into output). */
  readonly text: string;
  /** The numeric confidence (0..1) the extractor assigned. */
  readonly confidence: number;
  /** The confidence band the score falls into (always `Low` for flagged text). */
  readonly band: Confidence;
  /** Human-readable reason the region was flagged. */
  readonly reason: string;
}

/** Text confidently extracted from a single page. */
export interface PdfPageText {
  readonly pageNumber: number;
  readonly text: string;
}

/** The outcome of applying the confidence policy to a PDF extraction (R8.5). */
export interface PdfExtractionResult {
  /** All confidently-extracted text, page-joined (uncertain text excluded). */
  readonly text: string;
  /** Per-page confident text. */
  readonly pages: readonly PdfPageText[];
  /** Low-confidence regions flagged and excluded from `text` (R8.5). */
  readonly flaggedRegions: readonly FlaggedRegion[];
}

/** Options for {@link flagLowConfidencePdfText}. */
export interface PdfConfidenceOptions {
  /** Runs scoring below this (0..1) are flagged and excluded. Default 0.5. */
  readonly lowConfidenceThreshold?: number;
}

/** Default threshold below which extracted text is considered uncertain (R8.5). */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;
/** At/above this score a run is treated as High confidence. */
export const HIGH_CONFIDENCE_THRESHOLD = 0.85;

/** Map a 0..1 score onto the {@link Confidence} band (R11.1). */
export const confidenceBand = (score: number): Confidence => {
  if (score >= HIGH_CONFIDENCE_THRESHOLD) return 'High';
  if (score >= LOW_CONFIDENCE_THRESHOLD) return 'Medium';
  return 'Low';
};

/**
 * Apply the PDF confidence policy (R8.5): keep runs scoring at/above the
 * threshold (joined into the usable text) and EXCLUDE lower-scoring runs,
 * reporting them as explicit {@link FlaggedRegion}s. Empty/whitespace runs are
 * ignored unless their low score makes them a flagged unreadable region.
 */
export const flagLowConfidencePdfText = (
  raw: PdfRawExtraction,
  options: PdfConfidenceOptions = {},
): PdfExtractionResult => {
  const threshold = options.lowConfidenceThreshold ?? LOW_CONFIDENCE_THRESHOLD;
  const pages: PdfPageText[] = [];
  const flaggedRegions: FlaggedRegion[] = [];

  for (const page of raw.pages) {
    const confidentParts: string[] = [];

    for (const run of page.runs) {
      if (run.confidence >= threshold) {
        if (run.text.trim().length > 0) {
          confidentParts.push(run.text);
        }
        continue;
      }

      // Below threshold → flag and exclude (R8.5). Empty runs signal an
      // unreadable region (e.g. a scanned page with no text layer).
      flaggedRegions.push({
        pageNumber: page.pageNumber,
        text: run.text,
        confidence: run.confidence,
        band: confidenceBand(run.confidence),
        reason:
          run.text.trim().length === 0
            ? 'No readable text layer was found in this region (likely a scan).'
            : 'Extraction confidence was below the threshold; this text was excluded.',
      });
    }

    pages.push({ pageNumber: page.pageNumber, text: confidentParts.join(' ').trim() });
  }

  const text = pages
    .map((p) => p.text)
    .filter((t) => t.length > 0)
    .join('\n\n');

  return { text, pages, flaggedRegions };
};
