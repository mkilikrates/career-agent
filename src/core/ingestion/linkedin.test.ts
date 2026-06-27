import { describe, expect, it } from 'vitest';
import type { CsvParser, ZipTextEntry } from '@adapters/linkedin-zip';
import { parseLinkedInRecords } from './linkedin';

/**
 * Deterministic fake CSV parser: a real header-keyed parser sufficient for the
 * domain mapping under test (the PapaParse boundary itself is exercised by the
 * adapter, not here).
 */
const fakeCsvParser: CsvParser = {
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

const entry = (name: string, text: string): ZipTextEntry => ({ name, path: name, text });

describe('@core/ingestion — parseLinkedInRecords (R8.2)', () => {
  it('parses Profile, Positions, Skills, and Certifications CSVs', () => {
    const entries: ZipTextEntry[] = [
      entry('Profile.csv', 'First Name,Last Name,Headline\nAda,Lovelace,Engineer'),
      entry(
        'Positions.csv',
        'Company Name,Title,Started On,Finished On,Description\n' +
          'Acme,Staff Engineer,Jan 2020,Present,Led platform work\n' +
          'Globex,Engineer,2017,2019,Built services',
      ),
      entry('Skills.csv', 'Name\nTypeScript\nKubernetes'),
      entry(
        'Certifications.csv',
        'Name,Authority,Started On\nCKA,CNCF,2021',
      ),
    ];

    const records = parseLinkedInRecords(entries, fakeCsvParser);

    expect(records.profile).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      headline: 'Engineer',
    });
    expect(records.positions).toHaveLength(2);
    expect(records.positions[0]).toMatchObject({
      companyName: 'Acme',
      title: 'Staff Engineer',
      startedOn: 'Jan 2020',
      finishedOn: 'Present',
    });
    expect(records.skills.map((s) => s.name)).toEqual(['TypeScript', 'Kubernetes']);
    expect(records.certifications[0]).toMatchObject({ name: 'CKA', authority: 'CNCF' });
  });

  it('matches CSV file names case-insensitively and ignores sub-folders', () => {
    const records = parseLinkedInRecords(
      [{ name: 'skills.csv', path: 'Basic_LinkedInDataExport/skills.csv', text: 'Name\nGo' }],
      fakeCsvParser,
    );
    expect(records.skills.map((s) => s.name)).toEqual(['Go']);
  });

  it('yields empty collections when CSVs are missing', () => {
    const records = parseLinkedInRecords([], fakeCsvParser);
    expect(records.profile).toBeUndefined();
    expect(records.positions).toEqual([]);
    expect(records.skills).toEqual([]);
    expect(records.certifications).toEqual([]);
  });

  it('skips position rows with neither a company nor a title', () => {
    const records = parseLinkedInRecords(
      [entry('Positions.csv', 'Company Name,Title\n,\nAcme,Engineer')],
      fakeCsvParser,
    );
    expect(records.positions).toHaveLength(1);
  });
});
