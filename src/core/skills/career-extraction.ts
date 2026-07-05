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

import { asDocId, asItemId } from '@core/types';
import type { ExtractedItem } from '@core/types';
import { sourceLine, trailOf } from '@core/provenance';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  '- For education: extract institution, degree/course, start/end dates, and skills gained.\n' +
  '- For technical_skills: list standalone technical skills not tied to a specific position or course. Include an approximate start year if determinable.\n' +
  '- For core_competencies: list soft skills, leadership skills, and domain competencies distinct from technical skills.\n' +
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
    technologies: stringArray(
      obj['technologies'] ?? obj['skills'] ?? obj['tech'] ?? obj['tools'],
    ),
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
  if (s.length === 0 || s.toLowerCase() === 'null' || s.toLowerCase() === 'present') {
    return undefined;
  }
  return s;
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
