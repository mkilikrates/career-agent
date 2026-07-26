// AI career extraction (R71.1, R71.2, R71.3, R71.10) — pure helpers for the structured
// career timeline extraction from uploaded documents.
//
// This is DISTINCT from flat skill discovery (`skill-discovery.ts`):
//   * Flat discovery asks the model to NAME skills implied by the corpus.
//   * Career extraction asks the model to STRUCTURE the entire career timeline
//     into positions (with company, title, dates, skills used), education
//     (with institution, degree, dates, skills gained), and standalone skills.
//
// Trust boundary (R71.10 / No-Fabrication): the model extracts only what the
// evidence supports. It SHALL NOT invent information not present in the source.
// The caller must present the extraction to the user for review/edit/confirm
// before it enters the knowledge base (R71.6, R12).
//
// Privacy boundary (R7, R46.4): this module only BUILDS the prompt text and
// PARSES the reply — actual transmission flows through the single Egress Gate.

import matter from 'gray-matter';
import { asDocId, asItemId } from '@core/types';
import type { ExtractedItem } from '@core/types';
import { sourceLine, trailOf } from '@core/provenance';
import { stripVendorPrefix, isContainingTerm, normalizeGitHubCasing } from './ai-dedup';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A record of a post-processing transformation made by normalizeDate or
 * splitCompoundSkills during extraction normalisation (R75.1, R75.2).
 */
export interface PostProcessingTransformation {
  /** Which normalisation step produced this transformation. */
  readonly kind: 'date-normalisation' | 'skill-split';
  /** The raw value before normalisation. */
  readonly original: string;
  /** The normalised value(s) after transformation. */
  readonly normalized: string;
  /** Context: which position/education/skill this transformation relates to. */
  readonly context?: string;
}

/** An employment position extracted from a career document (R71.2a, R73.1). */
export interface ExtractedPosition {
  readonly title: string;
  readonly company: string;
  readonly location?: string; // city/region when present in document
  readonly start?: string; // ISO-ish date or partial (e.g. "2019-03", "2019")
  readonly end?: string; // undefined = current / unknown
  readonly description?: string; // brief role description
  readonly achievements?: readonly string[]; // quantified achievements
  readonly technologies: readonly string[];
}

/** An education entry extracted from a career document (R71.2b). */
export interface ExtractedEducation {
  readonly institution: string;
  readonly degree: string;
  readonly start?: string;
  readonly end?: string;
  readonly skills: readonly string[];
}

/** A standalone skill not tied to a specific position/course (R71.2c). */
export interface ExtractedStandaloneSkill {
  readonly name: string;
  readonly since?: string; // earliest year if determinable
}

/** A spoken/written language with proficiency level (R73.1). */
export interface ExtractedLanguage {
  readonly language: string;
  readonly proficiency: string;
}

/** A catch-all category for CV-relevant info not fitting other fields (R73.7). */
export interface ExtractedAdditionalInfo {
  readonly category: string;
  readonly value: string;
}

/** The complete structured extraction from a single corpus chunk (R71.1, R73.1). */
export interface CareerExtraction {
  readonly professionalSummary?: string;
  readonly positions: readonly ExtractedPosition[];
  readonly education: readonly ExtractedEducation[];
  readonly skills: readonly ExtractedStandaloneSkill[]; // backward compat alias for technicalSkills
  readonly technicalSkills: readonly ExtractedStandaloneSkill[];
  readonly coreCompetencies: readonly string[];
  readonly languages: readonly ExtractedLanguage[];
  readonly hobbies: readonly string[];
  readonly causes: readonly string[];
  readonly additionalInfo: readonly ExtractedAdditionalInfo[];
}

// ---------------------------------------------------------------------------
// Prompt builder (R71.1, R71.2, R71.10)
// ---------------------------------------------------------------------------

/**
 * The extraction prompt instruction. Asks the model to extract a structured
 * career timeline as JSON. The instruction is tolerant of varied formats and
 * languages (R71.10) and explicitly forbids inventing information not present
 * in the source (No-Fabrication Rule).
 */
export const CAREER_EXTRACTION_INSTRUCTION =
  'You are analysing a career document to extract a structured, ATS-compatible profile. ' +
  'Extract ONLY what the document explicitly states — do NOT invent or infer ' +
  'information that is not present in the source text (No-Fabrication Rule).\n\n' +
  'Return a single JSON object with this exact structure:\n' +
  '{\n' +
  '  "professional_summary": "A brief 2-3 sentence career summary drawn from the document",\n' +
  '  "positions": [\n' +
  '    { "title": "…", "company": "…", "location": "…", "start": "YYYY-MM or YYYY", "end": "YYYY-MM or YYYY or null", "description": "…", "achievements": ["…"], "technologies": ["…"] }\n' +
  '  ],\n' +
  '  "education": [\n' +
  '    { "institution": "…", "degree": "…", "start": "YYYY-MM or YYYY", "end": "YYYY-MM or YYYY or null", "skills": ["…"] }\n' +
  '  ],\n' +
  '  "technical_skills": [\n' +
  '    { "name": "…", "since": "YYYY or null" }\n' +
  '  ],\n' +
  '  "core_competencies": ["…"],\n' +
  '  "languages": [\n' +
  '    { "language": "…", "proficiency": "…" }\n' +
  '  ],\n' +
  '  "hobbies": ["…"],\n' +
  '  "causes": ["…"],\n' +
  '  "additional_info": [\n' +
  '    { "category": "…", "value": "…" }\n' +
  '  ]\n' +
  '}\n\n' +
  'Rules:\n' +
  '- For positions: extract title, company, location (city/region when present), start/end dates, a brief role description, quantified achievements (use numbers where possible), and technologies/skills used in that role. Map skills and technologies to each specific position where they were used.\n' +
  '- For technologies: list each technology as a separate, standalone item. Write \'S3\', \'Lambda\', \'DynamoDB\' — NOT \'AWS (S3, Lambda, DynamoDB)\'. Each entry should be one atomic skill name without embedded sub-skills or vendor-prefixed groupings.\n' +
  '- For education: extract institution, degree/course, start/end dates, and skills gained.\n' +
  '- For technical_skills: list standalone technical skills not tied to a specific position or course. Include an approximate start year if determinable.\n' +
  '- For core_competencies: INFER behavioural competencies from career patterns and achievements, not only literal keywords. ' +
  'Look at role progression, scope of responsibility, cross-team work, and quantified outcomes to identify competencies the candidate demonstrates even if they are not explicitly named. ' +
  'Examples of competencies to look for: Organisation, Customer Focus, Attention to Detail, Time Management, Adaptability, Problem Solving, Analytical Thinking, Teamwork, Communication, Continuous Learning, Quality Assurance, Prioritisation, Self-Motivation, Resilience, Leadership, Innovation, Stakeholder Management, Crisis Management, Strategic Planning, Mentoring, Cross-functional Collaboration, Change Management, Cost Optimization, Technical Vision, Team Building, Process Improvement. ' +
  'These examples span all seniority levels — from entry-level strengths through senior leadership. Infer competencies appropriate to the candidate\'s demonstrated level. ' +
  'Include both explicitly stated and pattern-inferred competencies distinct from technical skills.\n' +
  '- For languages: list spoken/written languages with proficiency levels (e.g. "Native", "Fluent", "Professional", "Intermediate", "Basic").\n' +
  '- For hobbies: list hobbies and interests if mentioned.\n' +
  '- For causes: list causes, volunteering, or community involvement if mentioned.\n' +
  '- For additional_info: surface any other CV-relevant categories (e.g. publications, patents, awards, memberships) that do not fit the fields above.\n' +
  '- Leave date fields as null when the document does not specify them.\n' +
  '- Omit empty arrays and null/empty string fields rather than including them as empty.\n' +
  '- Be tolerant of varied document formats and languages.\n' +
  '- Return ONLY the JSON object, no commentary or explanation.';

/** Compose the full extraction prompt for one corpus chunk (R71.1). */
export function buildCareerExtractionPrompt(corpusChunk: string): string {
  return `${CAREER_EXTRACTION_INSTRUCTION}\n\nDOCUMENT CONTENT:\n${corpusChunk}`;
}

// ---------------------------------------------------------------------------
// Parser — fence-tolerant, preamble-stripping (same strategy as parseQuestionPrompts)
// ---------------------------------------------------------------------------

/**
 * Tolerantly locate and parse the JSON extraction from a model reply.
 * Strategy (mirrors `parseQuestionsJson` in coach-assist.ts):
 *   1. Strip markdown code fences (`\`\`\`json … \`\`\``)
 *   2. Attempt to parse the widest-confidence candidate first (whole reply),
 *      then the first `{`…last `}` slice (object embedded in preamble/chatter).
 *   3. Validate shape and normalise each field tolerantly.
 *   4. Return an empty extraction if nothing parseable is found.
 */
export function parseCareerExtraction(reply: string): CareerExtraction {
  const parsed = locateJson(reply);
  if (!parsed) return EMPTY_EXTRACTION;
  return normaliseExtraction(parsed);
}

/**
 * Parse and normalise a career extraction reply, additionally collecting all
 * post-processing transformations performed by normalizeDate and splitCompoundSkills.
 * Returns both the normalised extraction and the list of transformations (R75.1, R75.2).
 */
export function parseCareerExtractionWithTracking(reply: string): {
  extraction: CareerExtraction;
  transformations: PostProcessingTransformation[];
} {
  const parsed = locateJson(reply);
  if (!parsed) return { extraction: EMPTY_EXTRACTION, transformations: [] };
  return normaliseExtractionWithTracking(parsed);
}

/** Sentinel empty extraction — returned on unparseable replies. */
const EMPTY_EXTRACTION: CareerExtraction = Object.freeze({
  positions: [],
  education: [],
  skills: [],
  technicalSkills: [],
  coreCompetencies: [],
  languages: [],
  hobbies: [],
  causes: [],
  additionalInfo: [],
});

/**
 * Locate a JSON object in the reply text. Tolerates markdown code fences,
 * preamble text, and trailing chatter.
 */
function locateJson(reply: string): unknown | null {
  // Strip code fences so ```json … ``` blocks parse cleanly.
  const unfenced = reply.replace(/```[a-zA-Z]*\n?|```/g, '');

  // Candidate substrings to attempt, widest-confidence first.
  const candidates: string[] = [unfenced];
  const objStart = unfenced.indexOf('{');
  const objEnd = unfenced.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) {
    candidates.push(unfenced.slice(objStart, objEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Compound skill splitting (R71.11, R71.12)
// ---------------------------------------------------------------------------

/**
 * Known compound names that contain `/` or other split-triggering characters
 * but must NOT be split. Case-insensitive matching is used.
 */
const COMPOUND_ALLOWLIST: readonly string[] = [
  'CI/CD',
  'TCP/IP',
  'IDS/IPS',
  'Node.js',
  'C#',
  'C++',
  '.NET',
  'GitLab CI/CD',
];

/** Pre-computed lowercase allowlist for matching. */
const COMPOUND_ALLOWLIST_LOWER = COMPOUND_ALLOWLIST.map((s) => s.toLowerCase());

/**
 * Expand compound skill entries:
 *   - Parenthetical: `"AWS SAM (Python, Lambda)"` → `["AWS SAM", "Python", "Lambda"]`
 *   - Slash-separated: `"Terraform/Terragrunt"` → `["Terraform", "Terragrunt"]`
 *
 * Entries in the allowlist (CI/CD, TCP/IP, etc.) are preserved as-is.
 * Results are trimmed and deduplicated (case-insensitive).
 */
export function splitCompoundSkills(technologies: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const tech of technologies) {
    const expanded = expandSingleEntry(tech.trim());
    for (const item of expanded) {
      const trimmed = item.trim();
      if (trimmed.length === 0) continue;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(trimmed);
      }
    }
  }

  return result;
}

/**
 * Expand a single technology string into one or more entries.
 */
function expandSingleEntry(entry: string): string[] {
  if (entry.length === 0) return [];

  // Check if the whole entry is in the allowlist — if so, don't split at all.
  if (isAllowlisted(entry)) return [entry];

  const parts: string[] = [];

  // 1. Handle parenthetical expansion: "AWS SAM (Python, Lambda)" → ["AWS SAM", "Python", "Lambda"]
  const parenMatch = entry.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (parenMatch) {
    const prefix = parenMatch[1].trim();
    const inner = parenMatch[2];
    if (prefix.length > 0) parts.push(prefix);
    // Split the parenthetical contents by comma
    const innerParts = inner.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    parts.push(...innerParts);
    return parts;
  }

  // 2. Handle slash-separated entries: "Terraform/Terragrunt" → ["Terraform", "Terragrunt"]
  if (entry.includes('/')) {
    const slashParts = entry.split('/');
    // Only split if none of the resulting parts would break an allowlisted compound
    // AND none of the sub-expressions form an allowlisted term when recombined.
    // Check if the entry contains any allowlisted substring (e.g. "GitLab CI/CD" contains "CI/CD").
    if (containsAllowlistedSubstring(entry)) {
      return [entry];
    }
    const expanded = slashParts.map((s) => s.trim()).filter((s) => s.length > 0);
    return expanded.length > 0 ? expanded : [entry];
  }

  // 3. No expansion needed.
  return [entry];
}

/** Check if an entry exactly matches an allowlisted term (case-insensitive). */
function isAllowlisted(entry: string): boolean {
  return COMPOUND_ALLOWLIST_LOWER.includes(entry.toLowerCase());
}

/** Check if the entry contains an allowlisted term as a substring (for slash-containing allowlist items). */
function containsAllowlistedSubstring(entry: string): boolean {
  const lower = entry.toLowerCase();
  for (const allowed of COMPOUND_ALLOWLIST_LOWER) {
    if (allowed.includes('/') && lower.includes(allowed)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Normalisation helpers — tolerant of missing/malformed fields
// ---------------------------------------------------------------------------

function normaliseExtraction(raw: unknown): CareerExtraction {
  if (raw === null || typeof raw !== 'object') return EMPTY_EXTRACTION;
  const obj = raw as Record<string, unknown>;
  // Handle both old `skills` and new `technical_skills` field names for backward compat.
  const technicalSkills = normaliseStandaloneSkills(
    obj['technical_skills'] ?? obj['technicalSkills'] ?? obj['skills'],
  );
  return {
    professionalSummary: optionalString(obj['professional_summary'] ?? obj['professionalSummary']),
    positions: normalisePositions(obj['positions']),
    education: normaliseEducation(obj['education']),
    skills: technicalSkills, // backward compat alias
    technicalSkills,
    coreCompetencies: stringArray(obj['core_competencies'] ?? obj['coreCompetencies']),
    languages: normaliseLanguages(obj['languages']),
    hobbies: stringArray(obj['hobbies']),
    causes: stringArray(obj['causes']),
    additionalInfo: normaliseAdditionalInfo(obj['additional_info'] ?? obj['additionalInfo']),
  };
}

/**
 * Normalise the extraction and collect all post-processing transformations
 * made by normalizeDate and splitCompoundSkills (R75.1, R75.2, R75.6).
 */
function normaliseExtractionWithTracking(raw: unknown): {
  extraction: CareerExtraction;
  transformations: PostProcessingTransformation[];
} {
  if (raw === null || typeof raw !== 'object') {
    return { extraction: EMPTY_EXTRACTION, transformations: [] };
  }
  const obj = raw as Record<string, unknown>;
  const transformations: PostProcessingTransformation[] = [];

  // Track position normalisation (dates and skill splits).
  const positions = normalisePositionsWithTracking(obj['positions'], transformations);

  // Track education date normalisation.
  const education = normaliseEducationWithTracking(obj['education'], transformations);

  // Track standalone skill date normalisation.
  const trackedSkills = normaliseStandaloneSkillsWithTracking(
    obj['technical_skills'] ?? obj['technicalSkills'] ?? obj['skills'],
    transformations,
  );

  const extraction: CareerExtraction = {
    professionalSummary: optionalString(obj['professional_summary'] ?? obj['professionalSummary']),
    positions,
    education,
    skills: trackedSkills,
    technicalSkills: trackedSkills,
    coreCompetencies: stringArray(obj['core_competencies'] ?? obj['coreCompetencies']),
    languages: normaliseLanguages(obj['languages']),
    hobbies: stringArray(obj['hobbies']),
    causes: stringArray(obj['causes']),
    additionalInfo: normaliseAdditionalInfo(obj['additional_info'] ?? obj['additionalInfo']),
  };

  return { extraction, transformations };
}

/** Track date normalisation: returns the normalised value and appends to transformations if changed. */
function trackDateNormalisation(
  raw: unknown,
  transformations: PostProcessingTransformation[],
  context?: string,
): string | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const s = String(raw).trim();
  if (s.length === 0 || s.toLowerCase() === 'null') return undefined;
  const result = normalizeDate(s);
  // Only record a transformation if the output differs from the input (i.e. actual normalisation happened).
  if (result !== undefined && result !== s) {
    transformations.push({
      kind: 'date-normalisation',
      original: s,
      normalized: result,
      context,
    });
  }
  return result;
}

/** Track compound skill splitting: returns the split list and appends to transformations for each split. */
function trackSkillSplit(
  technologies: string[],
  transformations: PostProcessingTransformation[],
  context?: string,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const tech of technologies) {
    const trimmed = tech.trim();
    if (trimmed.length === 0) continue;
    const expanded = expandSingleEntry(trimmed);
    // Record a transformation if the entry was actually split (produced > 1 result or a different value).
    if (expanded.length > 1 || (expanded.length === 1 && expanded[0].trim() !== trimmed)) {
      transformations.push({
        kind: 'skill-split',
        original: trimmed,
        normalized: expanded.map((e) => e.trim()).filter((e) => e.length > 0).join(', '),
        context,
      });
    }
    for (const item of expanded) {
      const t = item.trim();
      if (t.length === 0) continue;
      const key = t.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(t);
      }
    }
  }

  return result;
}

function normalisePositionsWithTracking(
  raw: unknown,
  transformations: PostProcessingTransformation[],
): ExtractedPosition[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedPosition[] = [];
  for (const item of raw) {
    const pos = normalisePositionWithTracking(item, transformations);
    if (pos) out.push(pos);
  }
  return out;
}

function normalisePositionWithTracking(
  raw: unknown,
  transformations: PostProcessingTransformation[],
): ExtractedPosition | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const title = stringOrEmpty(obj['title']);
  const company = stringOrEmpty(obj['company'] ?? obj['employer'] ?? obj['organization']);
  if (!title && !company) return null;
  const context = `${title} at ${company}`;
  const rawTechnologies = stringArray(
    obj['technologies'] ?? obj['skills'] ?? obj['tech'] ?? obj['tools'],
  );
  return {
    title,
    company,
    location: optionalString(obj['location'] ?? obj['city']),
    start: trackDateNormalisation(obj['start'] ?? obj['startDate'] ?? obj['start_date'], transformations, context),
    end: trackDateNormalisation(obj['end'] ?? obj['endDate'] ?? obj['end_date'], transformations, context),
    description: optionalString(obj['description'] ?? obj['summary'] ?? obj['role_description']),
    achievements: optionalStringArray(obj['achievements'] ?? obj['accomplishments']),
    technologies: trackSkillSplit(rawTechnologies, transformations, context),
  };
}

function normaliseEducationWithTracking(
  raw: unknown,
  transformations: PostProcessingTransformation[],
): ExtractedEducation[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedEducation[] = [];
  for (const item of raw) {
    const edu = normaliseEducationEntryWithTracking(item, transformations);
    if (edu) out.push(edu);
  }
  return out;
}

function normaliseEducationEntryWithTracking(
  raw: unknown,
  transformations: PostProcessingTransformation[],
): ExtractedEducation | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const institution = stringOrEmpty(obj['institution'] ?? obj['school'] ?? obj['university']);
  const degree = stringOrEmpty(obj['degree'] ?? obj['course'] ?? obj['program'] ?? obj['qualification']);
  if (!institution && !degree) return null;
  const context = `${degree} at ${institution}`;
  return {
    institution,
    degree,
    start: trackDateNormalisation(obj['start'] ?? obj['startDate'] ?? obj['start_date'], transformations, context),
    end: trackDateNormalisation(obj['end'] ?? obj['endDate'] ?? obj['end_date'], transformations, context),
    skills: stringArray(obj['skills'] ?? obj['technologies'] ?? obj['subjects']),
  };
}

function normaliseStandaloneSkillsWithTracking(
  raw: unknown,
  transformations: PostProcessingTransformation[],
): ExtractedStandaloneSkill[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedStandaloneSkill[] = [];
  for (const item of raw) {
    const skill = normaliseStandaloneSkillWithTracking(item, transformations);
    if (skill) out.push(skill);
  }
  return out;
}

function normaliseStandaloneSkillWithTracking(
  raw: unknown,
  transformations: PostProcessingTransformation[],
): ExtractedStandaloneSkill | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const name = stringOrEmpty(obj['name'] ?? obj['skill']);
  if (!name) return null;
  return {
    name,
    since: trackDateNormalisation(obj['since'] ?? obj['start'] ?? obj['year'], transformations, `skill: ${name}`),
  };
}

function normalisePositions(raw: unknown): ExtractedPosition[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedPosition[] = [];
  for (const item of raw) {
    const pos = normalisePosition(item);
    if (pos) out.push(pos);
  }
  return out;
}

function normalisePosition(raw: unknown): ExtractedPosition | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const title = stringOrEmpty(obj['title']);
  const company = stringOrEmpty(obj['company'] ?? obj['employer'] ?? obj['organization']);
  // Must have at least a title or company to be meaningful.
  if (!title && !company) return null;
  return {
    title,
    company,
    location: optionalString(obj['location'] ?? obj['city']),
    start: optionalDateString(obj['start'] ?? obj['startDate'] ?? obj['start_date']),
    end: optionalDateString(obj['end'] ?? obj['endDate'] ?? obj['end_date']),
    description: optionalString(obj['description'] ?? obj['summary'] ?? obj['role_description']),
    achievements: optionalStringArray(obj['achievements'] ?? obj['accomplishments']),
    technologies: splitCompoundSkills(stringArray(
      obj['technologies'] ?? obj['skills'] ?? obj['tech'] ?? obj['tools'],
    )),
  };
}

function normaliseEducation(raw: unknown): ExtractedEducation[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedEducation[] = [];
  for (const item of raw) {
    const edu = normaliseEducationEntry(item);
    if (edu) out.push(edu);
  }
  return out;
}

function normaliseEducationEntry(raw: unknown): ExtractedEducation | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const institution = stringOrEmpty(obj['institution'] ?? obj['school'] ?? obj['university']);
  const degree = stringOrEmpty(obj['degree'] ?? obj['course'] ?? obj['program'] ?? obj['qualification']);
  // Must have at least an institution or degree.
  if (!institution && !degree) return null;
  return {
    institution,
    degree,
    start: optionalDateString(obj['start'] ?? obj['startDate'] ?? obj['start_date']),
    end: optionalDateString(obj['end'] ?? obj['endDate'] ?? obj['end_date']),
    skills: stringArray(obj['skills'] ?? obj['technologies'] ?? obj['subjects']),
  };
}

function normaliseStandaloneSkills(raw: unknown): ExtractedStandaloneSkill[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedStandaloneSkill[] = [];
  for (const item of raw) {
    const skill = normaliseStandaloneSkill(item);
    if (skill) out.push(skill);
  }
  return out;
}

function normaliseStandaloneSkill(raw: unknown): ExtractedStandaloneSkill | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const name = stringOrEmpty(obj['name'] ?? obj['skill']);
  if (!name) return null;
  return {
    name,
    since: optionalDateString(obj['since'] ?? obj['start'] ?? obj['year']),
  };
}

/** Coerce to a trimmed string or empty string. */
function stringOrEmpty(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  return '';
}

/** Coerce to an optional date-like string (YYYY, YYYY-MM, etc.) or undefined. */
function optionalDateString(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const s = String(v).trim();
  // Accept anything that looks like a year or date fragment.
  if (s.length === 0 || s.toLowerCase() === 'null') {
    return undefined;
  }
  return normalizeDate(s);
}

// ---------------------------------------------------------------------------
// Date normalisation (R71.8, R71.9, R70.1, R70.2)
// ---------------------------------------------------------------------------

/** Month name → 1-based index mappings for English and Portuguese. */
const MONTH_MAP: Record<string, number> = {
  // English
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  // Portuguese
  janeiro: 1, fevereiro: 2, março: 3, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  // Portuguese abbreviations
  fev: 2, abr: 4, mai: 5, ago: 8, set: 9, out: 10, dez: 12,
};

/**
 * Normalise a raw date string into ISO format (`YYYY-MM` or `YYYY`).
 *
 * Handles:
 * - Written month names (English, Portuguese): "March 2020" → "2020-03"
 * - Date ranges (extract start only): "Jan 2020 - Dec 2022" → "2020-01"
 * - "Present", "current", "atual", null/undefined/empty → undefined
 * - Already-ISO passthrough: "2020-03" → "2020-03", "2020" → "2020"
 * - Numeric month/year formats: "01/2020" → "2020-01", "03.2019" → "2019-03"
 *
 * @returns ISO date string (YYYY-MM or YYYY) or undefined when the value
 *          represents an ongoing/missing date.
 */
export function normalizeDate(raw: string): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  // "Present", "current", "atual" (PT), "now", "ongoing" → undefined
  const lower = trimmed.toLowerCase();
  if (/^(present|current|atual|atualmente|now|ongoing|em andamento)$/i.test(lower)) {
    return undefined;
  }

  // For date ranges (contains " - ", " – ", " — ", " to "), extract the start part only.
  const rangeSep = trimmed.match(/\s+[-–—]\s+|\s+to\s+/i);
  const candidate = rangeSep ? trimmed.slice(0, rangeSep.index!).trim() : trimmed;

  return parseSingleDate(candidate);
}

/**
 * Parse a single date fragment (not a range) into YYYY-MM or YYYY.
 */
function parseSingleDate(input: string): string | undefined {
  const s = input.trim();
  if (s.length === 0) return undefined;

  // Already ISO: YYYY-MM or YYYY-MM-DD → return YYYY-MM
  const isoFull = s.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (isoFull) {
    const month = parseInt(isoFull[2], 10);
    if (month >= 1 && month <= 12) return `${isoFull[1]}-${isoFull[2]}`;
  }

  // Year only: "2020"
  if (/^\d{4}$/.test(s)) return s;

  // Numeric MM/YYYY or MM.YYYY
  const numericMonthYear = s.match(/^(\d{1,2})[/.](\d{4})$/);
  if (numericMonthYear) {
    const month = parseInt(numericMonthYear[1], 10);
    const year = numericMonthYear[2];
    if (month >= 1 && month <= 12) return `${year}-${String(month).padStart(2, '0')}`;
  }

  // Written month + year: "March 2020", "Mar 2020", "Março 2020", "2020 March"
  const monthYearMatch = s.match(/^([a-záàâãéêíóôõúç]+)\s+(\d{4})$/i)
    || s.match(/^(\d{4})\s+([a-záàâãéêíóôõúç]+)$/i);
  if (monthYearMatch) {
    const [, first, second] = monthYearMatch;
    // Determine which part is the month name and which is the year.
    const monthName = /^\d{4}$/.test(first) ? second : first;
    const year = /^\d{4}$/.test(first) ? first : second;
    const monthNum = MONTH_MAP[monthName.toLowerCase()];
    if (monthNum && /^\d{4}$/.test(year)) {
      return `${year}-${String(monthNum).padStart(2, '0')}`;
    }
  }

  // Month/Year with punctuation: "Mar. 2020", "Set. 2019"
  const monthDotYear = s.match(/^([a-záàâãéêíóôõúç]+)\.\s*(\d{4})$/i);
  if (monthDotYear) {
    const monthNum = MONTH_MAP[monthDotYear[1].toLowerCase()];
    if (monthNum) return `${monthDotYear[2]}-${String(monthNum).padStart(2, '0')}`;
  }

  // Day Month Year: "15 March 2020", "1 Jan 2019"
  const dayMonthYear = s.match(/^(\d{1,2})\s+([a-záàâãéêíóôõúç]+)\s+(\d{4})$/i);
  if (dayMonthYear) {
    const monthNum = MONTH_MAP[dayMonthYear[2].toLowerCase()];
    if (monthNum) return `${dayMonthYear[3]}-${String(monthNum).padStart(2, '0')}`;
  }

  // Month Day, Year: "March 15, 2020"
  const monthDayYear = s.match(/^([a-záàâãéêíóôõúç]+)\s+\d{1,2},?\s+(\d{4})$/i);
  if (monthDayYear) {
    const monthNum = MONTH_MAP[monthDayYear[1].toLowerCase()];
    if (monthNum) return `${monthDayYear[2]}-${String(monthNum).padStart(2, '0')}`;
  }

  // If it contains a 4-digit year somewhere, extract just the year as fallback.
  const yearFallback = s.match(/\b(\d{4})\b/);
  if (yearFallback) return yearFallback[1];

  // Unrecognised → undefined (don't keep garbage data).
  return undefined;
}

/** Coerce to a string array, filtering out non-strings and empties. */
function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) {
    // Tolerate comma-separated string.
    if (typeof v === 'string' && v.includes(',')) {
      return v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    return [];
  }
  return v
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((s) => s.length > 0);
}

/** Coerce to an optional non-empty string or undefined. */
function optionalString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : undefined;
}

/** Coerce to an optional string array (undefined when empty/absent). */
function optionalStringArray(v: unknown): readonly string[] | undefined {
  const arr = stringArray(v);
  return arr.length > 0 ? arr : undefined;
}

/** Normalise a languages array. */
function normaliseLanguages(raw: unknown): ExtractedLanguage[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedLanguage[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const language = stringOrEmpty(obj['language'] ?? obj['name']);
    const proficiency = stringOrEmpty(obj['proficiency'] ?? obj['level']);
    if (!language) continue;
    out.push({ language, proficiency: proficiency || 'Unknown' });
  }
  return out;
}

/** Normalise an additional_info array. */
function normaliseAdditionalInfo(raw: unknown): ExtractedAdditionalInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedAdditionalInfo[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const category = stringOrEmpty(obj['category'] ?? obj['type']);
    const value = stringOrEmpty(obj['value'] ?? obj['description'] ?? obj['text']);
    if (!category || !value) continue;
    out.push({ category, value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merge: combine results from multiple chunks (de-duplicated)
// ---------------------------------------------------------------------------

/**
 * Merge multiple chunk extractions into a single de-duplicated extraction.
 * De-duplication strategy:
 *   - Positions: by (company + title + start date) — same role mentioned in
 *     multiple chunks is kept once, with the richest data (longest tech list).
 *   - Education: by (institution + degree) — same qualification is kept once.
 *   - Skills: by name (case-insensitive) — kept once with earliest `since`.
 */
export function mergeCareerExtractions(chunks: readonly CareerExtraction[]): CareerExtraction {
  if (chunks.length === 0) return EMPTY_EXTRACTION;
  if (chunks.length === 1) return chunks[0];

  const technicalSkills = mergeStandaloneSkills(chunks);
  return {
    professionalSummary: mergeProfessionalSummary(chunks),
    positions: mergePositions(chunks),
    education: mergeEducationEntries(chunks),
    skills: technicalSkills, // backward compat alias
    technicalSkills,
    coreCompetencies: mergeStringArrays(chunks.map((c) => c.coreCompetencies)),
    languages: mergeLanguages(chunks),
    hobbies: mergeStringArrays(chunks.map((c) => c.hobbies)),
    causes: mergeStringArrays(chunks.map((c) => c.causes)),
    additionalInfo: mergeAdditionalInfo(chunks),
  };
}

function mergePositions(chunks: readonly CareerExtraction[]): ExtractedPosition[] {
  const map = new Map<string, ExtractedPosition>();
  for (const chunk of chunks) {
    for (const pos of chunk.positions) {
      const key = positionKey(pos);
      const existing = map.get(key);
      if (!existing || positionRichness(pos) > positionRichness(existing)) {
        map.set(key, pos);
      }
    }
  }
  return [...map.values()];
}

/** Score how rich a position entry is (more fields filled = richer). */
function positionRichness(pos: ExtractedPosition): number {
  let score = pos.technologies.length;
  if (pos.location) score += 1;
  if (pos.description) score += 2;
  if (pos.achievements) score += pos.achievements.length;
  return score;
}

function positionKey(pos: ExtractedPosition): string {
  return [
    pos.company.toLowerCase().trim(),
    pos.title.toLowerCase().trim(),
    (pos.start ?? '').toLowerCase().trim(),
  ].join('|');
}

function mergeEducationEntries(chunks: readonly CareerExtraction[]): ExtractedEducation[] {
  const map = new Map<string, ExtractedEducation>();
  for (const chunk of chunks) {
    for (const edu of chunk.education) {
      const key = educationKey(edu);
      const existing = map.get(key);
      if (!existing || edu.skills.length > existing.skills.length) {
        map.set(key, edu);
      }
    }
  }
  return [...map.values()];
}

function educationKey(edu: ExtractedEducation): string {
  return [
    edu.institution.toLowerCase().trim(),
    edu.degree.toLowerCase().trim(),
  ].join('|');
}

function mergeStandaloneSkills(chunks: readonly CareerExtraction[]): ExtractedStandaloneSkill[] {
  const map = new Map<string, ExtractedStandaloneSkill>();
  for (const chunk of chunks) {
    for (const skill of chunk.technicalSkills) {
      const key = skill.name.toLowerCase().trim();
      const existing = map.get(key);
      if (!existing) {
        map.set(key, skill);
      } else if (skill.since && (!existing.since || skill.since < existing.since)) {
        // Keep the one with the earliest `since` date.
        map.set(key, skill);
      }
    }
  }
  return [...map.values()];
}

/** Pick the longest non-empty professional summary from multiple chunks. */
function mergeProfessionalSummary(chunks: readonly CareerExtraction[]): string | undefined {
  let best: string | undefined;
  for (const chunk of chunks) {
    if (chunk.professionalSummary && (!best || chunk.professionalSummary.length > best.length)) {
      best = chunk.professionalSummary;
    }
  }
  return best;
}

/** Merge string arrays from multiple chunks, de-duplicating case-insensitively. */
function mergeStringArrays(arrays: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const arr of arrays) {
    for (const item of arr) {
      const key = item.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(item);
      }
    }
  }
  return out;
}

/** Merge languages, de-duplicating by language name (case-insensitive). */
function mergeLanguages(chunks: readonly CareerExtraction[]): ExtractedLanguage[] {
  const map = new Map<string, ExtractedLanguage>();
  for (const chunk of chunks) {
    for (const lang of chunk.languages) {
      const key = lang.language.toLowerCase().trim();
      if (!map.has(key)) {
        map.set(key, lang);
      }
    }
  }
  return [...map.values()];
}

/** Merge additional_info entries, de-duplicating by category+value. */
function mergeAdditionalInfo(chunks: readonly CareerExtraction[]): ExtractedAdditionalInfo[] {
  const seen = new Set<string>();
  const out: ExtractedAdditionalInfo[] = [];
  for (const chunk of chunks) {
    for (const info of chunk.additionalInfo) {
      const key = `${info.category.toLowerCase().trim()}|${info.value.toLowerCase().trim()}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(info);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cross-chunk consolidation pass (R71.15, R71.16, R71.17)
// ---------------------------------------------------------------------------

/** Known vendor prefixes for skill deduplication (same list as ai-dedup). */
const VENDOR_PREFIXES_FOR_CONSOLIDATION: readonly string[] = [
  'google cloud',
  'red hat',
  'amazon',
  'azure',
  'cloudflare',
  'atlassian',
  'datadog',
  'elastic',
  'github',
  'gitlab',
  'google',
  'hashicorp',
  'ibm',
  'jetbrains',
  'microsoft',
  'oracle',
  'vmware',
  'aws',
  'gcp',
].sort((a, b) => b.length - a.length);

/**
 * Default competency synonyms YAML content (R71.17).
 * The first entry in each group is the canonical form.
 * Shipped inline following the same pattern as DEFAULT_CONFUSABLES_YAML.
 */
export const DEFAULT_COMPETENCY_SYNONYMS_YAML = `# config/competency_synonyms.yaml — synonym groups for core competency consolidation (R71.17)
# Within each group, the FIRST entry is the canonical form.
# This file can be extended without code changes.
synonym_groups:
  - ["Leadership", "Team Leadership", "People Leadership"]
  - ["Communication", "Effective Communication", "Written Communication"]
  - ["Problem Solving", "Problem-Solving", "Analytical Problem Solving"]
  - ["Stakeholder Management", "Stakeholder Engagement"]
  - ["Change Management", "Organisational Change Management"]
  - ["Innovation", "Creative Innovation"]
  - ["Mentoring", "Coaching & Mentoring"]
  - ["Collaboration", "Cross-functional Collaboration"]
`;

/**
 * Load competency synonym groups from YAML text and return a map from
 * lowercase synonym → canonical form (first entry in each group).
 * Uses gray-matter (project's existing YAML dependency) for parsing (R71.17).
 */
export function loadCompetencySynonyms(yamlText: string): Map<string, string> {
  const map = new Map<string, string>();
  let data: Record<string, unknown> = {};
  try {
    // gray-matter expects front-matter delimiters; wrap content if needed.
    const wrapped = yamlText.trimStart().startsWith('---')
      ? yamlText
      : `---\n${yamlText}\n---`;
    const parsed = matter(wrapped);
    data = (parsed.data ?? {}) as Record<string, unknown>;
  } catch {
    return map;
  }

  const groups = data['synonym_groups'];
  if (!Array.isArray(groups)) return map;

  for (const group of groups) {
    if (!Array.isArray(group) || group.length < 2) continue;
    const canonical = String(group[0]).trim();
    if (!canonical) continue;
    // Map every entry (including the canonical itself) to the canonical form.
    for (const entry of group) {
      const key = String(entry).trim().toLowerCase();
      if (key) map.set(key, canonical);
    }
  }

  return map;
}

/** Common abbreviation equivalences for fuzzy position matching (R71.16). */
const ABBREVIATION_MAP: ReadonlyArray<readonly [string, string]> = [
  ['sr.', 'senior'],
  ['sr', 'senior'],
  ['jr.', 'junior'],
  ['jr', 'junior'],
  ['eng.', 'engineer'],
  ['eng', 'engineer'],
  ['sre', 'site reliability engineer'],
  ['dev', 'developer'],
  ['mgr', 'manager'],
];

/**
 * Strip all non-letter/digit characters from a string (R76.1, R76.2).
 * Used for OCR-garbled name matching: "T RIP A DVISOR" → "tripadvisor".
 */
export function stripNonAlpha(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

/**
 * Normalise a string for fuzzy position matching: lowercase, collapse
 * whitespace, expand common abbreviations, then strip all non-alpha chars
 * for OCR-garbled resilience (R71.16, R76.1).
 */
function fuzzyNormalize(input: string): string {
  let s = input.toLowerCase().replace(/\s+/g, ' ').trim();
  // Expand abbreviations — handle dotted abbreviations first (longest match).
  // Use word-boundary-aware replacement that accounts for dots.
  for (const [abbr, full] of ABBREVIATION_MAP) {
    if (abbr.includes('.')) {
      // For dotted abbreviations like "sr.", match as standalone token.
      // The dot makes \b unreliable, so use a lookahead/lookbehind approach.
      const escaped = abbr.replace(/\./g, '\\.');
      const pattern = new RegExp(`(?<=^|\\s)${escaped}(?=\\s|$)`, 'gi');
      s = s.replace(pattern, full);
    } else {
      // For plain abbreviations, use word boundaries.
      const pattern = new RegExp(`\\b${abbr}\\b`, 'gi');
      s = s.replace(pattern, full);
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  // Final pass: strip all non-alphanumeric for OCR-garbled resilience (R76.1).
  return stripNonAlpha(s);
}

/**
 * Check if two date ranges overlap. A missing end date is treated as "present"
 * (i.e. extends to infinity). Date strings are ISO-ish (YYYY or YYYY-MM) and
 * are compared lexicographically. Returns true if intervals intersect (R71.16).
 */
function datesOverlap(
  start1?: string,
  end1?: string,
  start2?: string,
  end2?: string,
): boolean {
  // If both positions have no start date, we cannot determine overlap — assume they might overlap.
  if (!start1 && !start2) return true;
  // Treat missing end as far-future.
  const effectiveEnd1 = end1 ?? '9999';
  const effectiveEnd2 = end2 ?? '9999';
  // Treat missing start as far-past.
  const effectiveStart1 = start1 ?? '0000';
  const effectiveStart2 = start2 ?? '0000';
  // Two intervals [s1, e1] and [s2, e2] overlap iff s1 <= e2 AND s2 <= e1.
  return effectiveStart1 <= effectiveEnd2 && effectiveStart2 <= effectiveEnd1;
}

/**
 * Score how "rich" a position entry is for choosing the best duplicate (R71.16).
 */
function positionRichnessScore(pos: ExtractedPosition): number {
  let score = pos.technologies.length;
  if (pos.description) score += pos.description.length;
  if (pos.achievements) score += pos.achievements.length * 10;
  return score;
}

/**
 * Sub-pass 1: Vendor-prefix skill deduplication (R71.15).
 *
 * For each skill, applies multiple dedup strategies in order:
 *   a) Vendor-prefix collapse: "AWS S3" + "S3" → keep "S3"
 *   b) Containing-term: "GitHub Enterprise" + "GitHub" → keep "GitHub"
 *   c) Slash-compound preference: "IDS" + "IDS/IPS" → keep "IDS/IPS" (richer term)
 *   d) GitHub normalization: normalise casing variants and keep most specific form
 *
 * All strategies keep the earliest `since` date.
 */
function deduplicateVendorPrefixSkills(
  skills: readonly ExtractedStandaloneSkill[],
): ExtractedStandaloneSkill[] {
  if (skills.length === 0) return [];

  // Normalize GitHub casing first.
  const normalized = skills.map((s) => ({
    ...s,
    name: normalizeGitHubCasing(s.name),
  }));

  // Build a map from lowercase name → skill entry (keeping earliest since).
  const map = new Map<string, ExtractedStandaloneSkill>();
  for (const skill of normalized) {
    const key = skill.name.toLowerCase().trim();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, skill);
    } else if (skill.since && (!existing.since || skill.since < existing.since)) {
      map.set(key, skill);
    }
  }

  // --- Strategy (a): Vendor-prefix duplicates ---
  const toRemove = new Set<string>();
  for (const [key, skill] of map) {
    const base = stripVendorPrefix(skill.name);
    if (!base) continue;
    const baseKey = base.toLowerCase().trim();
    if (map.has(baseKey) && baseKey !== key) {
      // The base form exists — collapse the vendor-qualified entry into the base.
      const baseSkill = map.get(baseKey)!;
      if (skill.since && (!baseSkill.since || skill.since < baseSkill.since)) {
        map.set(baseKey, { name: baseSkill.name, since: skill.since });
      }
      toRemove.add(key);
    }
  }

  // Also handle the substring-tail match case: "AWS Lambda" contains "Lambda".
  for (const [key, skill] of map) {
    if (toRemove.has(key)) continue;
    const lower = skill.name.toLowerCase().trim();
    for (const [otherKey, otherSkill] of map) {
      if (otherKey === key || toRemove.has(otherKey)) continue;
      const otherLower = otherSkill.name.toLowerCase().trim();
      if (lower.length > otherLower.length) {
        const prefixCandidate = lower.slice(0, lower.length - otherLower.length).trim();
        if (lower.endsWith(otherLower) && isKnownVendorPrefix(prefixCandidate)) {
          const otherEntry = map.get(otherKey)!;
          if (skill.since && (!otherEntry.since || skill.since < otherEntry.since)) {
            map.set(otherKey, { name: otherEntry.name, since: skill.since });
          }
          toRemove.add(key);
          break;
        }
      }
    }
  }

  // --- Strategy (c): Slash-compound preference ---
  // If both "IDS" and "IDS/IPS" exist, keep the compound (richer) form.
  for (const [key, skill] of map) {
    if (toRemove.has(key)) continue;
    const lower = skill.name.toLowerCase().trim();
    // Check if this is a simple term that is a component of a slash-compound in the map.
    if (lower.includes('/')) continue; // Skip compound terms themselves
    for (const [otherKey, otherSkill] of map) {
      if (otherKey === key || toRemove.has(otherKey)) continue;
      const otherLower = otherSkill.name.toLowerCase().trim();
      if (!otherLower.includes('/')) continue;
      // Check if the simple term is a slash-component of the compound term.
      const parts = otherLower.split('/').map((p) => p.trim());
      if (parts.includes(lower)) {
        // The simple term is a component — prefer the compound form.
        const otherEntry = map.get(otherKey)!;
        if (skill.since && (!otherEntry.since || skill.since < otherEntry.since)) {
          map.set(otherKey, { name: otherEntry.name, since: skill.since });
        }
        toRemove.add(key);
        break;
      }
    }
  }

  // --- Strategy (b): Containing-term detection ---
  // When one skill fully contains another as prefix/suffix, keep the shorter form.
  // But if the longer form is more specific GitHub variant, handle via GitHub pass below.
  for (const [key, skill] of map) {
    if (toRemove.has(key)) continue;
    for (const [otherKey, otherSkill] of map) {
      if (otherKey === key || toRemove.has(otherKey)) continue;
      const shorter = skill.name.length <= otherSkill.name.length ? skill : otherSkill;
      const longer = skill.name.length <= otherSkill.name.length ? otherSkill : skill;
      const shorterKey = shorter.name.toLowerCase().trim();
      const longerKey = longer.name.toLowerCase().trim();

      if (shorterKey === longerKey) continue;
      if (!isContainingTerm(shorter.name, longer.name)) continue;

      // Containing-term detected — collapse longer into shorter.
      const longerMapKey = longerKey;
      if (toRemove.has(longerMapKey)) continue;

      const shorterEntry = map.get(shorterKey)!;
      const longerEntry = map.get(longerMapKey)!;
      if (longerEntry.since && (!shorterEntry.since || longerEntry.since < shorterEntry.since)) {
        map.set(shorterKey, { name: shorterEntry.name, since: longerEntry.since });
      }
      toRemove.add(longerMapKey);
    }
  }

  // --- Strategy (d): GitHub variant normalization ---
  // Among remaining GitHub-prefixed skills, keep the most specific form.
  // e.g. if "GitHub" and "GitHub Actions" both exist, keep both (they're distinct).
  // But "Enterprise GitHub" and "GitHub Enterprise" → normalize to "GitHub Enterprise".
  // Normalize "Enterprise GitHub" → "GitHub Enterprise" pattern
  for (const [key, skill] of map) {
    if (toRemove.has(key)) continue;
    const lower = skill.name.toLowerCase().trim();
    if (lower.endsWith(' github') && !lower.startsWith('github')) {
      // Flip to "GitHub <Prefix>" form
      const prefix = skill.name.slice(0, skill.name.length - ' github'.length).trim();
      const canonical = `GitHub ${prefix}`;
      const canonicalKey = canonical.toLowerCase().trim();
      if (map.has(canonicalKey) && canonicalKey !== key) {
        // Both forms exist — remove the reversed one
        const canonEntry = map.get(canonicalKey)!;
        if (skill.since && (!canonEntry.since || skill.since < canonEntry.since)) {
          map.set(canonicalKey, { name: canonEntry.name, since: skill.since });
        }
        toRemove.add(key);
      } else if (!map.has(canonicalKey)) {
        // Only reversed form exists — rename it
        map.delete(key);
        map.set(canonicalKey, { name: canonical, since: skill.since });
      }
    }
  }

  for (const key of toRemove) {
    map.delete(key);
  }

  return [...map.values()];
}

/**
 * Deduplicate a technologies string array using vendor-prefix, containing-term,
 * and slash-compound logic (R71.15, R76.1).
 * Returns the deduplicated array keeping shorter canonical forms (or richer
 * compound forms for slash-compounds).
 */
function deduplicateVendorPrefixTechnologies(technologies: readonly string[]): string[] {
  if (technologies.length === 0) return [];

  // Normalize GitHub casing first.
  const seen = new Map<string, string>(); // lowercase → original casing
  for (const tech of technologies) {
    const normalized = normalizeGitHubCasing(tech);
    const key = normalized.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.set(key, normalized);
    }
  }

  const toRemove = new Set<string>();

  // Vendor-prefix collapse.
  for (const [key, tech] of seen) {
    if (toRemove.has(key)) continue;
    const base = stripVendorPrefix(tech);
    if (!base) continue;
    const baseKey = base.toLowerCase().trim();
    if (seen.has(baseKey) && baseKey !== key) {
      toRemove.add(key);
    }
  }

  // Substring-tail match (vendor-prefix in tail position).
  for (const [key, tech] of seen) {
    if (toRemove.has(key)) continue;
    const lower = tech.toLowerCase().trim();
    for (const [otherKey, _otherTech] of seen) {
      if (otherKey === key || toRemove.has(otherKey)) continue;
      const otherLower = _otherTech.toLowerCase().trim();
      if (lower.length > otherLower.length) {
        const prefixCandidate = lower.slice(0, lower.length - otherLower.length).trim();
        if (lower.endsWith(otherLower) && isKnownVendorPrefix(prefixCandidate)) {
          toRemove.add(key);
          break;
        }
      }
    }
  }

  // Slash-compound preference: "IDS" + "IDS/IPS" → keep "IDS/IPS".
  for (const [key, tech] of seen) {
    if (toRemove.has(key)) continue;
    const lower = tech.toLowerCase().trim();
    if (lower.includes('/')) continue;
    for (const [otherKey, otherTech] of seen) {
      if (otherKey === key || toRemove.has(otherKey)) continue;
      const otherLower = otherTech.toLowerCase().trim();
      if (!otherLower.includes('/')) continue;
      const parts = otherLower.split('/').map((p) => p.trim());
      if (parts.includes(lower)) {
        toRemove.add(key);
        break;
      }
    }
  }

  // Containing-term: "GitHub Enterprise" + "GitHub" → keep "GitHub".
  for (const [key, tech] of seen) {
    if (toRemove.has(key)) continue;
    for (const [otherKey, otherTech] of seen) {
      if (otherKey === key || toRemove.has(otherKey)) continue;
      const shorter = tech.length <= otherTech.length ? tech : otherTech;
      const longer = tech.length <= otherTech.length ? otherTech : tech;
      const longerKey = longer.toLowerCase().trim();
      if (toRemove.has(longerKey)) continue;
      if (!isContainingTerm(shorter, longer)) continue;
      toRemove.add(longerKey);
    }
  }

  for (const k of toRemove) {
    seen.delete(k);
  }

  return [...seen.values()];
}

/** Check if a string is a known vendor prefix (case-insensitive). */
function isKnownVendorPrefix(candidate: string): boolean {
  const lower = candidate.toLowerCase().trim();
  return VENDOR_PREFIXES_FOR_CONSOLIDATION.includes(lower);
}

/**
 * Sub-pass 2: Fuzzy position deduplication (R71.16).
 *
 * When two positions share a fuzzy match on (company + title) AND overlapping
 * date ranges, keep the entry with the richest data.
 */
function deduplicatePositionsFuzzy(
  positions: readonly ExtractedPosition[],
): ExtractedPosition[] {
  if (positions.length <= 1) return [...positions];

  // Build normalized keys for comparison.
  const entries = positions.map((pos) => ({
    pos,
    normalizedCompany: fuzzyNormalize(pos.company),
    normalizedTitle: fuzzyNormalize(pos.title),
  }));

  const removed = new Set<number>();

  for (let i = 0; i < entries.length; i++) {
    if (removed.has(i)) continue;
    for (let j = i + 1; j < entries.length; j++) {
      if (removed.has(j)) continue;
      const a = entries[i];
      const b = entries[j];

      // Check fuzzy match on company AND title.
      if (a.normalizedCompany !== b.normalizedCompany) continue;
      if (a.normalizedTitle !== b.normalizedTitle) continue;

      // Check date overlap.
      if (!datesOverlap(a.pos.start, a.pos.end, b.pos.start, b.pos.end)) continue;

      // Keep the richer entry.
      const scoreA = positionRichnessScore(a.pos);
      const scoreB = positionRichnessScore(b.pos);
      if (scoreB > scoreA) {
        removed.add(i);
        break; // i is removed, skip to next i
      } else {
        removed.add(j);
      }
    }
  }

  return entries
    .filter((_, idx) => !removed.has(idx))
    .map((e) => e.pos);
}

/**
 * Sub-pass 3: Synonym competency deduplication (R71.17).
 *
 * Replaces each core competency with its group's canonical form (first entry)
 * and deduplicates.
 */
function deduplicateCompetencySynonyms(
  competencies: readonly string[],
  synonymMap: Map<string, string>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const competency of competencies) {
    const key = competency.toLowerCase().trim();
    // Replace with canonical form if found in synonym map.
    const canonical = synonymMap.get(key) ?? competency;
    const canonicalKey = canonical.toLowerCase().trim();
    if (!seen.has(canonicalKey)) {
      seen.add(canonicalKey);
      result.push(canonical);
    }
  }

  return result;
}

/**
 * Cross-chunk consolidation pass (R71.15, R71.16, R71.17).
 *
 * Runs three sub-passes on a merged CareerExtraction to eliminate duplicates
 * that survived the basic merge:
 *   1. Vendor-prefix skill dedup (R71.15)
 *   2. Fuzzy position dedup (R71.16)
 *   3. Synonym competency dedup (R71.17)
 *
 * Called after `mergeCareerExtractions()` and before `careerExtractionToItems()`.
 */
export function consolidateExtraction(extraction: CareerExtraction): CareerExtraction {
  // Sub-pass 1: Vendor-prefix skill deduplication.
  const consolidatedSkills = deduplicateVendorPrefixSkills(extraction.technicalSkills);
  const consolidatedPositions = extraction.positions.map((pos) => ({
    ...pos,
    technologies: deduplicateVendorPrefixTechnologies(pos.technologies),
  }));

  // Sub-pass 2: Fuzzy position deduplication.
  const dedupedPositions = deduplicatePositionsFuzzy(consolidatedPositions);

  // Sub-pass 3: Synonym competency deduplication.
  const synonymMap = loadCompetencySynonyms(DEFAULT_COMPETENCY_SYNONYMS_YAML);
  const dedupedCompetencies = deduplicateCompetencySynonyms(
    extraction.coreCompetencies,
    synonymMap,
  );

  return {
    ...extraction,
    technicalSkills: consolidatedSkills,
    skills: consolidatedSkills, // backward compat alias
    positions: dedupedPositions,
    coreCompetencies: dedupedCompetencies,
  };
}

// ---------------------------------------------------------------------------
// AI Consolidation prompt (R71.15, R71.16, R71.17, R71.18)
// ---------------------------------------------------------------------------

/**
 * Build a consolidation prompt that asks the model to identify and merge
 * duplicate positions, skills, and competencies in a merged CareerExtraction.
 * The model must return the same JSON schema so `parseCareerExtraction` can
 * parse the response. Only positions, skills, and competencies are included
 * (not education, languages, etc.) to keep the prompt concise.
 */
export function buildConsolidationPrompt(extraction: CareerExtraction): string {
  const payload = {
    positions: extraction.positions.map((p) => ({
      title: p.title,
      company: p.company,
      ...(p.location ? { location: p.location } : {}),
      ...(p.start ? { start: p.start } : {}),
      ...(p.end ? { end: p.end } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(p.achievements && p.achievements.length > 0 ? { achievements: p.achievements } : {}),
      technologies: p.technologies,
    })),
    technical_skills: extraction.technicalSkills.map((s) => ({
      name: s.name,
      ...(s.since ? { since: s.since } : {}),
    })),
    core_competencies: extraction.coreCompetencies,
  };

  const json = JSON.stringify(payload, null, 2);

  return (
    'You are deduplicating a structured career extraction. The following JSON contains ' +
    'positions, technical skills, and core competencies that may have duplicates from OCR noise, ' +
    'company-name variants, vendor-qualified skill forms, or synonymous competencies.\n\n' +
    'Your task:\n' +
    '1. MERGE duplicate positions: same role at the same company expressed differently ' +
    '(e.g. "Sr. Engineer" vs "Senior Engineer", "Acme Corp" vs "Acme Corporation", OCR typos). ' +
    'When merging, keep the RICHEST entry (most technologies, longest description, most achievements) ' +
    'and preserve the earliest start date.\n' +
    '2. MERGE duplicate skills: vendor-qualified variants (e.g. "AWS S3" and "S3" → keep "S3"), ' +
    'semantic duplicates (e.g. "Kubernetes" and "K8s" → keep "Kubernetes"). ' +
    'When merging, preserve the EARLIEST `since` date.\n' +
    '3. COLLAPSE synonymous competencies to the shorter canonical form ' +
    '(e.g. "Team Leadership" and "Leadership" → "Leadership", "Cross-functional Collaboration" → "Collaboration").\n\n' +
    'Return ONLY a JSON object with this structure (same schema as input):\n' +
    '{\n' +
    '  "positions": [{ "title": "…", "company": "…", "location": "…", "start": "…", "end": "…", "description": "…", "achievements": ["…"], "technologies": ["…"] }],\n' +
    '  "technical_skills": [{ "name": "…", "since": "…" }],\n' +
    '  "core_competencies": ["…"]\n' +
    '}\n\n' +
    'Rules:\n' +
    '- Do NOT invent new entries. Only merge/collapse existing ones.\n' +
    '- Do NOT remove entries that are genuinely distinct.\n' +
    '- Preserve all fields from the richest entry when merging positions.\n' +
    '- Return ONLY the JSON, no commentary.\n\n' +
    'INPUT:\n' +
    json
  );
}

/**
 * Reduced-scope deterministic consolidation (R71.16, R71.17, R71.18).
 *
 * Performs ONLY exact case-insensitive duplicate collapsing as a lightweight
 * safety net after AI consolidation. Does NOT apply:
 *   - Vendor-prefix stripping (handled by AI)
 *   - Fuzzy position matching (handled by AI)
 *   - Synonym resolution (handled by AI)
 *
 * Also used in script-only mode where no AI consolidation runs.
 */
export function consolidateExtractionReduced(extraction: CareerExtraction): CareerExtraction {
  // Exact case-insensitive dedup for technicalSkills.
  const skillsSeen = new Map<string, ExtractedStandaloneSkill>();
  for (const skill of extraction.technicalSkills) {
    const key = skill.name.toLowerCase().trim();
    const existing = skillsSeen.get(key);
    if (!existing) {
      skillsSeen.set(key, skill);
    } else if (skill.since && (!existing.since || skill.since < existing.since)) {
      skillsSeen.set(key, { name: existing.name, since: skill.since });
    }
  }
  const dedupedSkills = [...skillsSeen.values()];

  // Exact case-insensitive dedup for positions (same company+title+start).
  const positionsSeen = new Map<string, ExtractedPosition>();
  for (const pos of extraction.positions) {
    const key = [
      pos.company.toLowerCase().trim(),
      pos.title.toLowerCase().trim(),
      (pos.start ?? '').toLowerCase().trim(),
    ].join('|');
    const existing = positionsSeen.get(key);
    if (!existing || positionRichnessScore(pos) > positionRichnessScore(existing)) {
      positionsSeen.set(key, pos);
    }
  }
  const dedupedPositions = [...positionsSeen.values()];

  // Exact case-insensitive dedup for per-position technologies.
  const dedupedPositionsWithTech = dedupedPositions.map((pos) => {
    const techSeen = new Set<string>();
    const techs: string[] = [];
    for (const tech of pos.technologies) {
      const key = tech.toLowerCase().trim();
      if (!techSeen.has(key)) {
        techSeen.add(key);
        techs.push(tech);
      }
    }
    return { ...pos, technologies: techs };
  });

  // Exact case-insensitive dedup for coreCompetencies.
  const compSeen = new Set<string>();
  const dedupedCompetencies: string[] = [];
  for (const comp of extraction.coreCompetencies) {
    const key = comp.toLowerCase().trim();
    if (!compSeen.has(key)) {
      compSeen.add(key);
      dedupedCompetencies.push(comp);
    }
  }

  return {
    ...extraction,
    technicalSkills: dedupedSkills,
    skills: dedupedSkills,
    positions: dedupedPositionsWithTech,
    coreCompetencies: dedupedCompetencies,
  };
}

/**
 * Apply AI consolidation response to a merged extraction (R71.15, R71.18).
 *
 * Parses the AI response (same JSON schema), then overlays the AI-deduplicated
 * positions, skills, and competencies onto the original extraction (preserving
 * education, languages, hobbies, causes, additionalInfo from the original since
 * those are not sent to the AI for dedup).
 */
export function applyAiConsolidation(
  original: CareerExtraction,
  aiReply: string,
): CareerExtraction {
  const parsed = parseCareerExtraction(aiReply);

  // If the AI returned an empty/unparseable result, return the original.
  if (
    parsed.positions.length === 0 &&
    parsed.technicalSkills.length === 0 &&
    parsed.coreCompetencies.length === 0
  ) {
    throw new Error('AI consolidation returned empty result');
  }

  return {
    ...original,
    positions: parsed.positions,
    technicalSkills: parsed.technicalSkills,
    skills: parsed.technicalSkills,
    coreCompetencies: parsed.coreCompetencies,
    // Preserve professionalSummary from parsed if present, else from original
    professionalSummary: parsed.professionalSummary ?? original.professionalSummary,
  };
}

// ---------------------------------------------------------------------------
// Conversion: CareerExtraction → ExtractedItem[] (R71.3)
// ---------------------------------------------------------------------------

/** The canonical doc ID used for AI-extraction provenance. */
const AI_DOC = asDocId('ai-extraction.md');

/**
 * Slugify a string for use in deterministic ItemId generation.
 * Mirrors the project convention: lowercase, special chars mapped, joined by hyphens.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/#/g, 'sharp')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Create AI-extraction provenance — a source_line record pointing to the
 * ai-extraction.md document with a descriptive quote.
 */
function aiExtractionProvenance(quote: string) {
  return trailOf(sourceLine(AI_DOC, 1, quote));
}

/**
 * Convert a CareerExtraction into ExtractedItem[] for the ingestion pipeline.
 *
 * - Professional summary → type 'professional_summary'
 * - Positions → type 'employment'
 * - Education → type 'education'
 * - Standalone skills → type 'skill' (with `since` inferred from positions if missing)
 * - Core competencies → type 'core_competency'
 * - Languages → type 'language_proficiency'
 * - Hobbies → type 'hobby'
 * - Causes → type 'cause'
 * - Additional info → type 'additional_info'
 *
 * All items carry `confidence: 'Medium'` and `userConfirmed: false` because AI
 * extractions require user review before entering the knowledge base (R12, R71.6, R73.9).
 */
export function careerExtractionToItems(extraction: CareerExtraction): ExtractedItem[] {
  const items: ExtractedItem[] = [];

  // --- Professional summary item (R73.2) ---
  if (extraction.professionalSummary) {
    const id = asItemId('ai-extraction.md#professional-summary');
    items.push({
      id,
      type: 'professional_summary',
      fields: { text: extraction.professionalSummary },
      confidence: 'Medium',
      provenance: aiExtractionProvenance('professional summary'),
      userConfirmed: false,
      private: false,
      sourceDoc: AI_DOC,
    });
  }

  // --- Employment items ---
  for (const pos of extraction.positions) {
    const slug = slugify(`${pos.title}-${pos.company}`);
    const id = asItemId(`ai-extraction.md#employment-${slug}`);
    const fields: Record<string, unknown> = {
      title: pos.title,
      employer: pos.company,
      start: pos.start,
      end: pos.end,
      technologies: pos.technologies,
    };
    if (pos.location) fields.location = pos.location;
    if (pos.description) fields.description = pos.description;
    if (pos.achievements && pos.achievements.length > 0) fields.achievements = pos.achievements;
    items.push({
      id,
      type: 'employment',
      fields,
      confidence: 'Medium',
      provenance: aiExtractionProvenance(`employment: ${pos.title} at ${pos.company}`),
      userConfirmed: false,
      private: false,
      sourceDoc: AI_DOC,
    });
  }

  // --- Education items ---
  for (const edu of extraction.education) {
    const slug = slugify(`${edu.degree}-${edu.institution}`);
    const id = asItemId(`ai-extraction.md#education-${slug}`);
    items.push({
      id,
      type: 'education',
      fields: {
        degree: edu.degree,
        institution: edu.institution,
        start: edu.start,
        end: edu.end,
        skills: edu.skills,
      },
      confidence: 'Medium',
      provenance: aiExtractionProvenance(`education: ${edu.degree} at ${edu.institution}`),
      userConfirmed: false,
      private: false,
      sourceDoc: AI_DOC,
    });
  }

  // --- Skill items (with since-inference from positions) ---
  for (const skill of extraction.skills) {
    const since = skill.since ?? inferSinceFromPositions(skill.name, extraction.positions);
    const slug = slugify(skill.name);
    const id = asItemId(`ai-extraction.md#skill-${slug}`);
    items.push({
      id,
      type: 'skill',
      fields: {
        name: skill.name,
        since,
      },
      confidence: 'Medium',
      provenance: aiExtractionProvenance(`skill: ${skill.name}`),
      userConfirmed: false,
      private: false,
      sourceDoc: AI_DOC,
    });
  }

  // --- Core competency items (R73.2) ---
  for (const competency of extraction.coreCompetencies) {
    const slug = slugify(competency);
    const id = asItemId(`ai-extraction.md#core-competency-${slug}`);
    items.push({
      id,
      type: 'core_competency',
      fields: { name: competency },
      confidence: 'Medium',
      provenance: aiExtractionProvenance(`core competency: ${competency}`),
      userConfirmed: false,
      private: false,
      sourceDoc: AI_DOC,
    });
  }

  // --- Language proficiency items (R73.2) ---
  for (const lang of extraction.languages) {
    const slug = slugify(lang.language);
    const id = asItemId(`ai-extraction.md#language-${slug}`);
    items.push({
      id,
      type: 'language_proficiency',
      fields: { language: lang.language, proficiency: lang.proficiency },
      confidence: 'Medium',
      provenance: aiExtractionProvenance(`language: ${lang.language}`),
      userConfirmed: false,
      private: false,
      sourceDoc: AI_DOC,
    });
  }

  // --- Hobby items (R73.2) ---
  for (const hobby of extraction.hobbies) {
    const slug = slugify(hobby);
    const id = asItemId(`ai-extraction.md#hobby-${slug}`);
    items.push({
      id,
      type: 'hobby',
      fields: { name: hobby },
      confidence: 'Medium',
      provenance: aiExtractionProvenance(`hobby: ${hobby}`),
      userConfirmed: false,
      private: false,
      sourceDoc: AI_DOC,
    });
  }

  // --- Cause items (R73.2) ---
  for (const cause of extraction.causes) {
    const slug = slugify(cause);
    const id = asItemId(`ai-extraction.md#cause-${slug}`);
    items.push({
      id,
      type: 'cause',
      fields: { name: cause },
      confidence: 'Medium',
      provenance: aiExtractionProvenance(`cause: ${cause}`),
      userConfirmed: false,
      private: false,
      sourceDoc: AI_DOC,
    });
  }

  // --- Additional info items (R73.6) ---
  for (const info of extraction.additionalInfo) {
    const slug = slugify(`${info.category}-${info.value}`);
    const id = asItemId(`ai-extraction.md#additional-info-${slug}`);
    items.push({
      id,
      type: 'additional_info',
      fields: { category: info.category, value: info.value },
      confidence: 'Medium',
      provenance: aiExtractionProvenance(`additional info: ${info.category}`),
      userConfirmed: false,
      private: false,
      sourceDoc: AI_DOC,
    });
  }

  return items;
}

/**
 * Infer the `since` date for a standalone skill by finding the earliest
 * position that lists it in technologies. Comparison is case-insensitive.
 * Returns undefined if no position uses the skill.
 */
function inferSinceFromPositions(
  skillName: string,
  positions: readonly ExtractedPosition[],
): string | undefined {
  const lower = skillName.toLowerCase();
  let earliest: string | undefined;

  for (const pos of positions) {
    if (!pos.start) continue;
    const uses = pos.technologies.some((t) => t.toLowerCase() === lower);
    if (uses && (!earliest || pos.start < earliest)) {
      earliest = pos.start;
    }
  }

  return earliest;
}
