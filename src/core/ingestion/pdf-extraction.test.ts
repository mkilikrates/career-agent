import { describe, expect, it } from 'vitest';
import type { PdfRawExtraction } from '@adapters/pdf-extractor';
import { heuristicRunConfidence } from '@adapters/pdf-extractor';
import {
  confidenceBand,
  flagLowConfidencePdfText,
  HIGH_CONFIDENCE_THRESHOLD,
  LOW_CONFIDENCE_THRESHOLD,
} from './pdf-extraction';

const raw = (pages: PdfRawExtraction['pages']): PdfRawExtraction => ({ pages });

describe('@core/ingestion — confidenceBand (R11.1)', () => {
  it('maps scores onto High/Medium/Low bands', () => {
    expect(confidenceBand(HIGH_CONFIDENCE_THRESHOLD)).toBe('High');
    expect(confidenceBand(0.99)).toBe('High');
    expect(confidenceBand(LOW_CONFIDENCE_THRESHOLD)).toBe('Medium');
    expect(confidenceBand(0.6)).toBe('Medium');
    expect(confidenceBand(0.49)).toBe('Low');
    expect(confidenceBand(0)).toBe('Low');
  });
});

describe('@core/ingestion — flagLowConfidencePdfText (R8.5)', () => {
  it('keeps high-confidence runs and joins them into the usable text', () => {
    const result = flagLowConfidencePdfText(
      raw([
        {
          pageNumber: 1,
          runs: [
            { text: 'Led the platform migration', confidence: 0.97 },
            { text: 'across three teams', confidence: 0.95 },
          ],
        },
      ]),
    );
    expect(result.text).toBe('Led the platform migration across three teams');
    expect(result.flaggedRegions).toEqual([]);
    expect(result.pages[0].text).toContain('platform migration');
  });

  it('flags low-confidence runs and EXCLUDES them from the extracted text (R8.5)', () => {
    const result = flagLowConfidencePdfText(
      raw([
        {
          pageNumber: 2,
          runs: [
            { text: 'Confident heading', confidence: 0.95 },
            { text: 'g4rbl3d sc4n t3xt', confidence: 0.2 },
          ],
        },
      ]),
    );
    expect(result.text).toBe('Confident heading');
    expect(result.text).not.toContain('g4rbl3d');
    expect(result.flaggedRegions).toHaveLength(1);
    expect(result.flaggedRegions[0]).toMatchObject({
      pageNumber: 2,
      text: 'g4rbl3d sc4n t3xt',
      band: 'Low',
    });
    expect(result.flaggedRegions[0].reason).toMatch(/confidence/i);
  });

  it('flags an empty/no-text-layer page as an unreadable region', () => {
    const result = flagLowConfidencePdfText(
      raw([{ pageNumber: 1, runs: [{ text: '', confidence: 0 }] }]),
    );
    expect(result.text).toBe('');
    expect(result.flaggedRegions).toHaveLength(1);
    expect(result.flaggedRegions[0].reason).toMatch(/no readable text layer/i);
  });

  it('honours a custom threshold', () => {
    const input = raw([
      { pageNumber: 1, runs: [{ text: 'medium', confidence: 0.6 }] },
    ]);
    expect(flagLowConfidencePdfText(input, { lowConfidenceThreshold: 0.7 }).text).toBe('');
    expect(flagLowConfidencePdfText(input, { lowConfidenceThreshold: 0.5 }).text).toBe('medium');
  });
});

describe('@adapters/pdf-extractor — heuristicRunConfidence (R8.5)', () => {
  it('scores clean text high and replacement-char-laden text low', () => {
    expect(heuristicRunConfidence('clean digital text')).toBeGreaterThanOrEqual(0.9);
    expect(heuristicRunConfidence('\uFFFD\uFFFD\uFFFD\uFFFD')).toBeLessThan(
      LOW_CONFIDENCE_THRESHOLD,
    );
    expect(heuristicRunConfidence('')).toBe(0);
  });
});
