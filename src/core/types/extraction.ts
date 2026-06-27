// Ingestion data models (R9, R10, R11, R12, R38).

import type { DocId, ISODate, ItemId } from './brands';
import type { Confidence, ProvenanceTrail } from './provenance';

/** Category of a structured record extracted from source documents (R10). */
export type ExtractedItemType =
  | 'employment'
  | 'education'
  | 'certification'
  | 'skill'
  | 'quantified_result'
  | 'language'
  | 'gap';

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
