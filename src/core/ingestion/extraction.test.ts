import { describe, expect, it } from 'vitest';
import { asDocId } from '@core/types';
import {
  extractFromLinkedIn,
  extractFromText,
  sequentialItemIds,
  toEmploymentRecords,
} from './extraction';
import type { LinkedInRecords } from './linkedin';

const doc = asDocId('cv.md');

describe('@core/ingestion — extractFromLinkedIn (R10.1, R10.2, R11.1, R38.1)', () => {
  const records: LinkedInRecords = {
    profile: { firstName: 'Ada' },
    positions: [
      {
        companyName: 'Acme',
        title: 'Staff Engineer',
        startedOn: 'Jan 2020',
        finishedOn: 'Present',
        description: 'Led platform migration',
        location: 'Remote',
      },
    ],
    skills: [{ name: 'TypeScript' }],
    certifications: [{ name: 'CKA', authority: 'CNCF', startedOn: '2021' }],
  };

  it('extracts employment, skills, and certifications as High confidence', () => {
    const items = extractFromLinkedIn(records, asDocId('linkedin.zip'));
    const employment = items.find((i) => i.type === 'employment');
    const skill = items.find((i) => i.type === 'skill');
    const cert = items.find((i) => i.type === 'certification');

    expect(employment?.confidence).toBe('High');
    expect(employment?.fields).toMatchObject({ employer: 'Acme', title: 'Staff Engineer' });
    expect(employment?.fields.start).toBe('2020-01');
    expect(employment?.fields.end).toBeUndefined(); // "Present" → ongoing
    expect(skill?.fields).toMatchObject({ name: 'TypeScript' });
    expect(cert?.fields).toMatchObject({ name: 'CKA', authority: 'CNCF' });
  });

  it('attaches a source-line provenance record to every item (R38.1)', () => {
    const items = extractFromLinkedIn(records, asDocId('linkedin.zip'));
    for (const item of items) {
      expect(item.provenance.length).toBeGreaterThanOrEqual(1);
      expect(item.provenance[0].kind).toBe('source_line');
      expect(item.userConfirmed).toBe(false);
      expect(item.private).toBe(false);
    }
  });
});

describe('@core/ingestion — extractFromText (R10.2, R10.3)', () => {
  it('extracts an explicit language proficiency as High confidence', () => {
    const items = extractFromText('English (native)\nPortuguese (fluent)', doc);
    const langs = items.filter((i) => i.type === 'language');
    expect(langs).toHaveLength(2);
    expect(langs[0].confidence).toBe('High');
    expect(langs[0].fields).toMatchObject({ language: 'English', proficiency: 'native' });
  });

  it('extracts quantified results preserving surrounding context (R10.3)', () => {
    const items = extractFromText('Reduced build time by 40% across CI pipelines', doc);
    const result = items.find((i) => i.type === 'quantified_result');
    expect(result).toBeDefined();
    expect(result?.confidence).toBe('Medium');
    expect(result?.fields.context).toBe('Reduced build time by 40% across CI pipelines');
  });

  it('extracts explicitly named skills under a Skills section (R10.2)', () => {
    const items = extractFromText('Skills\nTypeScript, Kubernetes; Go', doc);
    const skills = items.filter((i) => i.type === 'skill').map((i) => i.fields.name);
    expect(skills).toEqual(['TypeScript', 'Kubernetes', 'Go']);
  });

  it('extracts a vertical skill list under a plain (non-Markdown) heading', () => {
    const items = extractFromText('SKILLS\nTypeScript\nGo\nDocker', doc);
    const skills = items.filter((i) => i.type === 'skill').map((i) => i.fields.name);
    expect(skills).toEqual(['TypeScript', 'Go', 'Docker']);
  });

  it('extracts an inline "Skills:" line', () => {
    const items = extractFromText('Skills: TypeScript, Go, PostgreSQL', doc);
    const skills = items.filter((i) => i.type === 'skill').map((i) => i.fields.name);
    expect(skills).toEqual(['TypeScript', 'Go', 'PostgreSQL']);
  });

  it('does not treat a single-word skill line as a section heading', () => {
    // A bare skill like "Experience"-adjacent words must not silently switch
    // sections; a real section name (EXPERIENCE) does, and the following skills
    // section is still captured.
    const items = extractFromText('EXPERIENCE\nAcme Corp\n\nTechnical Skills\nReact\nNode.js', doc);
    const skills = items.filter((i) => i.type === 'skill').map((i) => i.fields.name);
    expect(skills).toEqual(['React', 'Node.js']);
  });

  it('extracts education entries under an Education section', () => {
    const items = extractFromText('Education\nBSc Computer Science, MIT', doc);
    const edu = items.find((i) => i.type === 'education');
    expect(edu?.fields.entry).toBe('BSc Computer Science, MIT');
  });

  it('every text-derived item carries provenance citing its line', () => {
    const items = extractFromText('English (native)', doc);
    expect(items[0].provenance[0]).toMatchObject({ kind: 'source_line', line: 1 });
  });
});

describe('@core/ingestion — sequentialItemIds + toEmploymentRecords', () => {
  it('mints unique ids within a document', () => {
    const next = sequentialItemIds(doc);
    expect(next('emp')).not.toBe(next('emp'));
  });

  it('projects employment items into employment records', () => {
    const records: LinkedInRecords = {
      positions: [{ companyName: 'Acme', title: 'Engineer', startedOn: '2019', finishedOn: '2021' }],
      skills: [],
      certifications: [],
    };
    const items = extractFromLinkedIn(records, doc);
    const employment = toEmploymentRecords(items);
    expect(employment).toEqual([
      expect.objectContaining({ employer: 'Acme', title: 'Engineer', start: '2019-01', end: '2021-01' }),
    ]);
  });
});
