// Ingestion data models (R9, R10, R11, R12, R38).

import type { DocId, ISODate, ItemId } from './brands';
import type { Confidence, ProvenanceTrail } from './provenance';

/**
 * Category of a structured record extracted from source documents (R10, R73).
 *
 * Expected `fields` shapes per type:
 * - `employment`: employer, title, startDate, endDate, location, responsibilities, achievements, technologies
 * - `education`: entry (institution + degree), details
 * - `certification`: name, issuer, date
 * - `skill`: name, since?
 * - `quantified_result`: metric, context
 * - `language`: name, proficiency?
 * - `gap`: startDate, endDate, explanation?
 * - `core_competency`: `{ name: string }` — a soft skill or leadership competency distinct from technical skills (R73.1a)
 * - `hobby`: `{ name: string, description?: string }` — a hobby or interest (R73.1c)
 * - `cause`: `{ name: string, description?: string }` — a cause or volunteer activity (R73.1d)
 * - `language_proficiency`: `{ language: string, proficiency: string }` — spoken/written language ability (R73.1e)
 * - `professional_summary`: `{ text: string }` — a brief career summary or profile statement (R73.1f)
 * - `additional_info`: `{ category: string, value: string }` — extensible bucket for unrecognised CV categories (R73.6)
 */
export type ExtractedItemType =
  | 'employment'
  | 'education'
  | 'certification'
  | 'skill'
  | 'quantified_result'
  | 'language'
  | 'gap'
  | 'core_competency'
  | 'hobby'
  | 'cause'
  | 'language_proficiency'
  | 'professional_summary'
  | 'additional_info';

/** A structured record extracted from a source document (R10, R11, R12, R38). */
export interface ExtractedItem {
  id: ItemId;
  type: ExtractedItemType;
  fields: Record<string, unknown>;
  confidence: Confidence; // R11.1
  /** >= 1 always (R38.1) — every fact carries provenance from extraction. */
  provenance: ProvenanceTrail;
  userConfirmed: boolean; // R12.4 raises to highest reliability
  private: boolean; // R12.3 stored, never output
  sourceDoc: DocId; // R12.1 grouping
}

/** A field whose value differs across documents (R9.2). */
export interface ConflictRecord {
  field: string;
  candidates: { value: unknown; doc: DocId }[];
  recommended: unknown; // R9.3 recency vs detail heuristic
  resolved?: { value: unknown; by: 'user' | 'default'; at: ISODate }; // R9.4 logged
}
