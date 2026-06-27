// LinkedIn export parsing (R8.2).
//
// A LinkedIn data export is a ZIP of CSV files. The ZIP read and CSV parse are
// external concerns handled by the `@adapters/linkedin-zip` ports; this module
// is the pure domain logic that locates the Profile / Positions / Skills /
// Certifications CSVs (case-insensitively, ignoring archive sub-folders) and
// maps their rows onto typed records. Column names follow LinkedIn's export
// headers but are matched leniently so minor header variations still resolve.

import type { ZipTextEntry, CsvParser } from '@adapters/linkedin-zip';

/** The user's LinkedIn profile summary (from `Profile.csv`). */
export interface LinkedInProfile {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly headline?: string;
  readonly summary?: string;
  readonly industry?: string;
  readonly location?: string;
}

/** A single position / role (from `Positions.csv`). */
export interface LinkedInPosition {
  readonly companyName: string;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly startedOn?: string;
  readonly finishedOn?: string;
}

/** A named skill (from `Skills.csv`). */
export interface LinkedInSkill {
  readonly name: string;
}

/** A certification (from `Certifications.csv`). */
export interface LinkedInCertification {
  readonly name: string;
  readonly authority?: string;
  readonly startedOn?: string;
  readonly finishedOn?: string;
  readonly licenseNumber?: string;
  readonly url?: string;
}

/** The structured records parsed from a LinkedIn export ZIP (R8.2). */
export interface LinkedInRecords {
  readonly profile?: LinkedInProfile;
  readonly positions: LinkedInPosition[];
  readonly skills: LinkedInSkill[];
  readonly certifications: LinkedInCertification[];
}

/**
 * Look up a value in a CSV row by trying several candidate header names,
 * case- and whitespace-insensitively. Returns `undefined` when none match or
 * the matched value is blank.
 */
const pick = (row: Record<string, string>, ...candidates: string[]): string | undefined => {
  const normalizedRow = new Map<string, string>();
  for (const [key, value] of Object.entries(row)) {
    normalizedRow.set(key.toLowerCase().replace(/\s+/g, ' ').trim(), value);
  }
  for (const candidate of candidates) {
    const value = normalizedRow.get(candidate.toLowerCase().replace(/\s+/g, ' ').trim());
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return undefined;
};

/** Find the first archive entry whose base name matches `fileName` (case-insensitive). */
const findEntry = (
  entries: readonly ZipTextEntry[],
  fileName: string,
): ZipTextEntry | undefined =>
  entries.find((e) => e.name.toLowerCase() === fileName.toLowerCase());

const parseProfile = (
  entries: readonly ZipTextEntry[],
  csv: CsvParser,
): LinkedInProfile | undefined => {
  const entry = findEntry(entries, 'Profile.csv');
  if (!entry) return undefined;
  const [row] = csv.parse(entry.text);
  if (!row) return undefined;
  const profile: LinkedInProfile = {
    firstName: pick(row, 'First Name'),
    lastName: pick(row, 'Last Name'),
    headline: pick(row, 'Headline'),
    summary: pick(row, 'Summary'),
    industry: pick(row, 'Industry'),
    location: pick(row, 'Geo Location', 'Location'),
  };
  // Drop a profile with no usable fields.
  return Object.values(profile).some((v) => v !== undefined) ? profile : undefined;
};

const parsePositions = (
  entries: readonly ZipTextEntry[],
  csv: CsvParser,
): LinkedInPosition[] => {
  const entry = findEntry(entries, 'Positions.csv');
  if (!entry) return [];
  const positions: LinkedInPosition[] = [];
  for (const row of csv.parse(entry.text)) {
    const companyName = pick(row, 'Company Name');
    const title = pick(row, 'Title');
    if (!companyName && !title) continue;
    positions.push({
      companyName: companyName ?? '',
      title: title ?? '',
      description: pick(row, 'Description'),
      location: pick(row, 'Location'),
      startedOn: pick(row, 'Started On'),
      finishedOn: pick(row, 'Finished On'),
    });
  }
  return positions;
};

const parseSkills = (entries: readonly ZipTextEntry[], csv: CsvParser): LinkedInSkill[] => {
  const entry = findEntry(entries, 'Skills.csv');
  if (!entry) return [];
  const skills: LinkedInSkill[] = [];
  for (const row of csv.parse(entry.text)) {
    const name = pick(row, 'Name', 'Skill');
    if (name) skills.push({ name });
  }
  return skills;
};

const parseCertifications = (
  entries: readonly ZipTextEntry[],
  csv: CsvParser,
): LinkedInCertification[] => {
  const entry = findEntry(entries, 'Certifications.csv');
  if (!entry) return [];
  const certifications: LinkedInCertification[] = [];
  for (const row of csv.parse(entry.text)) {
    const name = pick(row, 'Name');
    if (!name) continue;
    certifications.push({
      name,
      authority: pick(row, 'Authority'),
      startedOn: pick(row, 'Started On'),
      finishedOn: pick(row, 'Finished On'),
      licenseNumber: pick(row, 'License Number'),
      url: pick(row, 'Url', 'URL'),
    });
  }
  return certifications;
};

/**
 * Parse the contents of a LinkedIn export ZIP — already read into text entries
 * by the {@link ZipReader} — into structured records (R8.2). The Profile,
 * Positions, Skills, and Certifications CSVs are located case-insensitively;
 * missing CSVs simply yield empty collections.
 */
export const parseLinkedInRecords = (
  entries: readonly ZipTextEntry[],
  csv: CsvParser,
): LinkedInRecords => ({
  profile: parseProfile(entries, csv),
  positions: parsePositions(entries, csv),
  skills: parseSkills(entries, csv),
  certifications: parseCertifications(entries, csv),
});
