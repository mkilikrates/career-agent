import { describe, expect, it } from 'vitest';
import {
  acceptedFormats,
  detectFormat,
  extensionOf,
  isAccepted,
  recommendedChecklist,
  rejectUnsupported,
} from './formats';
import { fileBlobFromBytes, fileBlobFromText } from './file-blob';

describe('@core/ingestion — accepted formats (R8.1)', () => {
  it('lists exactly the launch formats', () => {
    expect(acceptedFormats()).toEqual([
      'pdf',
      'markdown',
      'plain-text',
      'linkedin-zip',
      'docx',
    ]);
  });

  it('returns a fresh array each call (no shared mutation)', () => {
    const a = acceptedFormats();
    a.push('pdf');
    expect(acceptedFormats()).toHaveLength(5);
  });
});

describe('@core/ingestion — detectFormat by extension (R8.1)', () => {
  it.each([
    ['cv.pdf', 'pdf'],
    ['notes.md', 'markdown'],
    ['readme.markdown', 'markdown'],
    ['history.txt', 'plain-text'],
    ['LinkedInExport.zip', 'linkedin-zip'],
  ])('classifies %s as %s', (name, expected) => {
    const detection = detectFormat(fileBlobFromText(name, 'x'));
    expect(detection.accepted).toBe(true);
    if (detection.accepted) expect(detection.format).toBe(expected);
  });
});

describe('@core/ingestion — detectFormat by MIME type (R8.1)', () => {
  it('prefers a supported MIME type even when the extension is missing', () => {
    const detection = detectFormat(fileBlobFromText('cv', 'x', 'application/pdf'));
    expect(detection.accepted).toBe(true);
    if (detection.accepted) expect(detection.format).toBe('pdf');
  });

  it('handles a MIME type with parameters', () => {
    const detection = detectFormat(fileBlobFromText('a.md', 'x', 'text/markdown; charset=utf-8'));
    expect(detection.accepted).toBe(true);
    if (detection.accepted) expect(detection.format).toBe('markdown');
  });
});

describe('@core/ingestion — rejection of out-of-scope formats (R8.3)', () => {
  it('accepts DOCX by extension and by MIME type', () => {
    const byExt = detectFormat(fileBlobFromBytes('resume.docx', new Uint8Array([1, 2])));
    expect(byExt.accepted).toBe(true);
    if (byExt.accepted) expect(byExt.format).toBe('docx');

    const byMime = detectFormat(
      fileBlobFromBytes(
        'resume',
        new Uint8Array([1, 2]),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    );
    expect(byMime.accepted).toBe(true);
    if (byMime.accepted) expect(byMime.format).toBe('docx');
  });

  it('still rejects legacy .doc with a deferred-to-a-later-phase notice', () => {
    const detection = detectFormat(fileBlobFromBytes('resume.doc', new Uint8Array([1, 2])));
    expect(detection.accepted).toBe(false);
    if (!detection.accepted) {
      expect(detection.rejection.reason).toBe('deferred');
      expect(detection.rejection.detectedKind.toLowerCase()).toContain('.doc');
      expect(detection.rejection.message.toLowerCase()).toContain('deferred to a later phase');
    }
  });

  it('rejects images (OCR is deferred)', () => {
    expect(isAccepted(fileBlobFromBytes('scan.png', new Uint8Array([1])))).toBe(false);
    expect(isAccepted(fileBlobFromBytes('scan.tiff', new Uint8Array([1])))).toBe(false);
  });

  it('rejects an unknown/extensionless file as unknown', () => {
    const notice = rejectUnsupported(fileBlobFromText('mystery', 'x'));
    expect(notice.detectedKind).toBe('unknown');
    expect(notice.reason).toBe('deferred');
  });

  it('points loose CSV uploads at the full LinkedIn ZIP', () => {
    const notice = rejectUnsupported(fileBlobFromText('Positions.csv', 'x'));
    expect(notice.message).toContain('LinkedIn export ZIP');
  });
});

describe('@core/ingestion — extensionOf', () => {
  it('lower-cases and strips directories', () => {
    expect(extensionOf('/path/to/CV.PDF')).toBe('pdf');
    expect(extensionOf('no-extension')).toBe('');
    expect(extensionOf('.hidden')).toBe('');
  });
});

describe('@core/ingestion — recommended document checklist (R8.4)', () => {
  it('returns a localisable list with recommended flags', () => {
    const checklist = recommendedChecklist('en');
    expect(checklist.length).toBeGreaterThan(0);
    expect(checklist.some((c) => c.id === 'most_recent_cv' && c.recommended)).toBe(true);
    expect(checklist.some((c) => c.id === 'linkedin_export' && c.recommended)).toBe(true);
    for (const item of checklist) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
    }
  });

  it('localises labels to Brazilian Portuguese for a pt-BR locale', () => {
    const en = recommendedChecklist('en');
    const pt = recommendedChecklist('pt-BR');
    expect(pt.map((c) => c.id)).toEqual(en.map((c) => c.id));
    expect(pt.find((c) => c.id === 'most_recent_cv')?.label).not.toBe(
      en.find((c) => c.id === 'most_recent_cv')?.label,
    );
    expect(pt.find((c) => c.id === 'most_recent_cv')?.label).toContain('currículo');
  });

  it('falls back to English for an unknown locale', () => {
    const en = recommendedChecklist('en');
    const xx = recommendedChecklist('de-DE');
    expect(xx.find((c) => c.id === 'most_recent_cv')?.label).toBe(
      en.find((c) => c.id === 'most_recent_cv')?.label,
    );
  });
});
