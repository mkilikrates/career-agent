import { describe, expect, it } from 'vitest';
import { asDocId, asItemId, type ExtractedItem } from '@core/types';
import { sourceLine, trailOf, userConfirmation } from '@core/provenance';
import { asISODate } from '@core/types';
import { serializeRawExtractions, parseRawExtractions } from './raw-extractions-document';

const item = (over: Partial<ExtractedItem>): ExtractedItem => ({
  id: asItemId('cv.md#skill-0'),
  type: 'skill',
  fields: { name: 'TypeScript' },
  confidence: 'High',
  provenance: trailOf(sourceLine(asDocId('cv.md'), 1, 'TypeScript')),
  userConfirmed: false,
  private: false,
  sourceDoc: asDocId('cv.md'),
  ...over,
});

describe('serializeRawExtractions', () => {
  it('renders an empty-state document when there are no extractions', () => {
    const md = serializeRawExtractions([]);
    expect(md).toContain('# Raw Extractions');
    expect(md).toContain('_No extractions yet._');
  });

  it('groups items by document with type, flags and a field summary', () => {
    const items = [
      item({ id: asItemId('cv.md#skill-0'), fields: { name: 'TypeScript' } }),
      item({
        id: asItemId('cv.md#emp-0'),
        type: 'employment',
        fields: { employer: 'Acme', title: 'Engineer', start: '2020-01' },
        userConfirmed: true,
        provenance: trailOf(userConfirmation(asISODate('2024-01-01T00:00:00.000Z'), 'ok')),
      }),
    ];
    const md = serializeRawExtractions(items);

    expect(md).toContain('## cv.md');
    expect(md).toContain('- **skill** [High] — name: TypeScript');
    expect(md).toMatch(/- \*\*employment\*\* \[High, confirmed\] —.*employer: Acme/);
  });

  it('marks private items in the flags', () => {
    const md = serializeRawExtractions([item({ private: true })]);
    expect(md).toContain('[High, private]');
  });

  it('round-trips the full item list through the embedded machine block (R35.1)', () => {
    const items = [
      item({ id: asItemId('cv.md#skill-0'), fields: { name: 'TypeScript' } }),
      item({
        id: asItemId('linkedin.zip#emp-0'),
        type: 'employment',
        fields: { employer: 'Acme', title: 'Engineer', technologies: ['Go', 'SQL'] },
        sourceDoc: asDocId('linkedin.zip'),
        confidence: 'Medium',
      }),
      item({ id: asItemId('cv.md#skill-1'), fields: { name: 'Secret' }, private: true }),
    ];
    const restored = parseRawExtractions(serializeRawExtractions(items));
    expect(restored).toEqual(items);
  });

  it('parseRawExtractions returns [] when there is no machine block', () => {
    expect(parseRawExtractions('# Raw Extractions\n\njust prose, no json.')).toEqual([]);
  });
});
