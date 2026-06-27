// Structured extraction with confidence scoring and provenance (R10, R11, R38).
//
// Turns parsed source material — LinkedIn export records and/or raw document
// text — into {@link ExtractedItem}s. Every item:
//   * is one of the structured types (employment, education, certification,
//     skill, quantified_result, language) (R10.1, R10.2, R10.3);
//   * carries a {@link Confidence} band — High for explicit structured fields,
//     Medium for text-section inferences, Low for speculative matches (R11.1);
//   * carries a non-empty provenance trail citing the source doc + line (R38.1).
//
// The extractors are pure and deterministic so they are unit-testable without a
// network, a PDF worker, or any external service.
//
// Source-language independence (R41.4): these extractors take ONLY the source
// content (text or LinkedIn records) and a document id — there is NO Session
// Language / locale parameter on the extraction path. A document in any
// language is therefore extracted identically regardless of the UI/session
// language the user selected; the Session Language affects only how results are
// PRESENTED downstream (messages, prompts, output formatting), never how source
// content is read. Keep this seam intact: do not couple extraction to the
// Session Language.

import type { DocId, ExtractedItem, ItemId } from '@core/types';
import { asItemId } from '@core/types';
import { sourceLine, trailOf } from '@core/provenance';
import { parseYearMonth, formatYearMonth, isPresent } from './dates';
import type {
  LinkedInRecords,
  LinkedInPosition,
  LinkedInCertification,
} from './linkedin';

/** A normalised employment record used for gap detection and reconciliation. */
export interface EmploymentRecord {
  readonly employer: string;
  readonly title: string;
  /** Canonical `YYYY-MM` start, when a date was present. */
  readonly start?: string;
  /** Canonical `YYYY-MM` end; absent means ongoing/current. */
  readonly end?: string;
  readonly location?: string;
  readonly responsibilities?: string[];
  readonly achievements?: string[];
  readonly technologies?: string[];
}

/** Mints unique {@link ItemId}s for extracted items within one document. */
export type ItemIdFactory = (hint: string) => ItemId;

/** A per-document, monotonic {@link ItemIdFactory} (e.g. `cv.pdf#emp-0`). */
export const sequentialItemIds = (doc: DocId): ItemIdFactory => {
  let n = 0;
  return (hint: string) => asItemId(`${doc as unknown as string}#${hint}-${n++}`);
};

/** Build a base item with a source-line provenance trail (R38.1). */
const itemFrom = (
  id: ItemId,
  type: ExtractedItem['type'],
  doc: DocId,
  line: number,
  quote: string,
  fields: Record<string, unknown>,
  confidence: ExtractedItem['confidence'],
): ExtractedItem => ({
  id,
  type,
  fields,
  confidence,
  provenance: trailOf(sourceLine(doc, line, quote)),
  userConfirmed: false,
  private: false,
  sourceDoc: doc,
});

const normalizeDate = (raw: string | undefined): string | undefined => {
  if (raw === undefined || isPresent(raw)) return undefined;
  const ym = parseYearMonth(raw);
  return ym ? formatYearMonth(ym) : raw.trim() || undefined;
};

// --- LinkedIn structured extraction (explicit → High confidence) ---------

const employmentFromPosition = (
  position: LinkedInPosition,
  doc: DocId,
  line: number,
  nextId: ItemIdFactory,
): ExtractedItem => {
  const fields: Record<string, unknown> = {
    employer: position.companyName,
    title: position.title,
    start: normalizeDate(position.startedOn),
    end: normalizeDate(position.finishedOn),
    location: position.location,
    responsibilities: position.description ? [position.description] : undefined,
  };
  return itemFrom(
    nextId('emp'),
    'employment',
    doc,
    line,
    `${position.title} @ ${position.companyName}`.trim(),
    fields,
    'High',
  );
};

const certificationItem = (
  cert: LinkedInCertification,
  doc: DocId,
  line: number,
  nextId: ItemIdFactory,
): ExtractedItem =>
  itemFrom(
    nextId('cert'),
    'certification',
    doc,
    line,
    cert.name,
    {
      name: cert.name,
      authority: cert.authority,
      start: normalizeDate(cert.startedOn),
      end: normalizeDate(cert.finishedOn),
      licenseNumber: cert.licenseNumber,
      url: cert.url,
    },
    'High',
  );

/**
 * Extract structured items from parsed LinkedIn records (R8.2, R10.1, R10.2).
 * LinkedIn fields are explicit structured data, so positions, skills, and
 * certifications are scored **High** confidence.
 */
export const extractFromLinkedIn = (
  records: LinkedInRecords,
  doc: DocId,
  nextId: ItemIdFactory = sequentialItemIds(doc),
): ExtractedItem[] => {
  const items: ExtractedItem[] = [];

  records.positions.forEach((position, i) => {
    items.push(employmentFromPosition(position, doc, i + 1, nextId));
  });

  records.skills.forEach((skill, i) => {
    items.push(
      itemFrom(nextId('skill'), 'skill', doc, i + 1, skill.name, { name: skill.name }, 'High'),
    );
  });

  records.certifications.forEach((cert, i) => {
    items.push(certificationItem(cert, doc, i + 1, nextId));
  });

  return items;
};

// --- Free-text extraction (inferred → Medium / speculative → Low) --------

/** Levels that count as an explicitly stated language proficiency (R10.2). */
const LANGUAGE_LEVELS =
  '(native|mother tongue|bilingual|fluent|full professional|professional working|' +
  'limited working|conversational|advanced|intermediate|elementary|basic)';

const LANGUAGE_PATTERN = new RegExp(
  `^([A-Z][A-Za-zÀ-ÿ]+(?:\\s[A-Z][A-Za-zÀ-ÿ]+)?)\\s*[\\(:\\-–—]\\s*${LANGUAGE_LEVELS}`,
  'i',
);

/** Detect a quantified result: a line carrying a percentage, currency, or magnitude. */
const QUANTIFIED_PATTERN =
  /(\d[\d,.]*\s?%|[$£€R]\$?\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:x|×|k|m|bn|billion|million|thousand|hours?|days?|users?|customers?|requests?)\b)/i;

/** A Markdown ATX heading line. */
const MD_HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * An inline skills line, e.g. `Skills: TypeScript, Go` or `Technologies — A, B`.
 * Captures the list after the separator.
 */
const SKILLS_INLINE =
  /^(?:technical\s+|core\s+)?(?:skills|competenc(?:e|es|ies)|technologies|tech\s+stack)\s*[:\-–—]\s*(.+)$/i;

/**
 * Recognised CV section names. Only a Markdown heading OR one of these exact
 * names switches the active section — a plain content line (e.g. a single skill
 * like `TypeScript` on its own line) is NOT treated as a heading, so vertical
 * skill lists under a heading are captured rather than swallowed.
 */
const KNOWN_SECTION =
  /^(?:work\s+experience|professional\s+experience|experience|employment(?:\s+history)?|education|skills|technical\s+skills|core\s+competenc(?:e|es|ies)|technologies|tech\s+stack|summary|profile|about|projects?|certifications?|licen[sc]es?|languages?|interests?|references?|awards?|publications?|volunteering)$/i;

const isSkillsHeading = (h: string): boolean =>
  /^(technical\s+)?(core\s+)?(skills|competenc(?:e|ies|ies)|technologies|tech\s+stack)$/i.test(
    h.trim(),
  );

const isEducationHeading = (h: string): boolean => /^education$/i.test(h.trim());

/** Split a skills line into individual named skills. */
const splitSkills = (line: string): string[] =>
  line
    .replace(/^[-*•]\s*/, '')
    .split(/[,;|•]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * Extract structured items from free document text (Markdown / plain text / the
 * confident text of a PDF) (R10.2, R10.3). Text-derived items are scored
 * **Medium** (inferred from a recognised section/pattern) or **Low** when only
 * speculatively matched. Quantified results preserve their surrounding line as
 * context (R10.3).
 */
export const extractFromText = (
  text: string,
  doc: DocId,
  nextId: ItemIdFactory = sequentialItemIds(doc),
): ExtractedItem[] => {
  const items: ExtractedItem[] = [];
  const lines = text.split(/\r?\n/);
  let section: 'skills' | 'education' | 'other' = 'other';

  lines.forEach((raw, index) => {
    const line = raw.trim();
    const lineNo = index + 1;
    if (line.length === 0) return;

    // Inline skills list (e.g. "Skills: TypeScript, Go, Docker"). Captures the
    // list after the separator and also enters the skills section.
    const inlineSkills = SKILLS_INLINE.exec(line);
    if (inlineSkills) {
      section = 'skills';
      for (const name of splitSkills(inlineSkills[1])) {
        items.push(itemFrom(nextId('skill'), 'skill', doc, lineNo, name, { name }, 'Medium'));
      }
      return;
    }

    // Language proficiency (explicit level → High; R10.2).
    const lang = LANGUAGE_PATTERN.exec(line);
    if (lang) {
      items.push(
        itemFrom(
          nextId('lang'),
          'language',
          doc,
          lineNo,
          line,
          { language: lang[1].trim(), proficiency: lang[2].trim() },
          'High',
        ),
      );
      return;
    }

    // Quantified result (R10.3): keep the number and its surrounding context.
    if (QUANTIFIED_PATTERN.test(line)) {
      items.push(
        itemFrom(
          nextId('result'),
          'quantified_result',
          doc,
          lineNo,
          line,
          { context: line },
          'Medium',
        ),
      );
      return;
    }

    // Section heading: a Markdown ATX heading OR a recognised CV section name.
    // A plain content line (a single skill, an education line) is intentionally
    // NOT a heading, so vertical lists under a heading are captured (R10.2).
    const md = MD_HEADING.exec(line);
    const bare = (md ? md[2] : line).replace(/\s*:?\s*$/, '').trim();
    if (md !== null || KNOWN_SECTION.test(bare)) {
      if (isSkillsHeading(bare)) section = 'skills';
      else if (isEducationHeading(bare)) section = 'education';
      else section = 'other';
      return;
    }

    if (section === 'skills') {
      for (const name of splitSkills(line)) {
        items.push(
          itemFrom(nextId('skill'), 'skill', doc, lineNo, name, { name }, 'Medium'),
        );
      }
      return;
    }

    if (section === 'education') {
      items.push(
        itemFrom(
          nextId('edu'),
          'education',
          doc,
          lineNo,
          line,
          { entry: line.replace(/^[-*•]\s*/, '') },
          'Medium',
        ),
      );
    }
  });

  return items;
};

/**
 * Project the employment {@link ExtractedItem}s into {@link EmploymentRecord}s
 * for gap detection and reconciliation (R10.4). Non-employment items are
 * ignored.
 */
export const toEmploymentRecords = (items: readonly ExtractedItem[]): EmploymentRecord[] =>
  items
    .filter((item) => item.type === 'employment')
    .map((item) => {
      const f = item.fields;
      return {
        employer: String(f.employer ?? ''),
        title: String(f.title ?? ''),
        start: typeof f.start === 'string' ? f.start : undefined,
        end: typeof f.end === 'string' ? f.end : undefined,
        location: typeof f.location === 'string' ? f.location : undefined,
        responsibilities: Array.isArray(f.responsibilities)
          ? (f.responsibilities as string[])
          : undefined,
        achievements: Array.isArray(f.achievements) ? (f.achievements as string[]) : undefined,
        technologies: Array.isArray(f.technologies) ? (f.technologies as string[]) : undefined,
      };
    });
