// @core/ingestion — the Ingestion_Engine (R8–R13).
//
// Parses the launch formats (PDF, Markdown, plain text, LinkedIn export ZIP),
// extracts structured records with confidence and provenance, detects gaps and
// conflicts, and drives the review/correction flow. The pdf.js / JSZip /
// PapaParse usage lives behind injected ports (`@adapters/pdf-extractor`,
// `@adapters/linkedin-zip`); this module is pure, framework-agnostic domain
// logic. Consumers import from a single stable path:
//
//   import { IngestionEngine, detectFormat } from '@core/ingestion';

// File abstraction.
export {
  fileBlobFromText,
  fileBlobFromBytes,
  fileBlobFromFile,
  snapshotFileBlob,
} from './file-blob';
export type { FileBlob } from './file-blob';

// DOCX text extraction (a .docx is a ZIP; word/document.xml → plain text).
export { documentXmlToText, extractDocxText } from './docx';
export type { DocxZipEntry } from './docx';

// Format detection, accept/reject, checklist (8.1).
export {
  ACCEPTED_FORMATS,
  acceptedFormats,
  detectFormat,
  extensionOf,
  isAccepted,
  rejectUnsupported,
  recommendedChecklist,
} from './formats';
export type {
  Format,
  FormatDetection,
  RejectionNotice,
  ChecklistItem,
} from './formats';

// PDF confidence policy (8.2).
export {
  LOW_CONFIDENCE_THRESHOLD,
  HIGH_CONFIDENCE_THRESHOLD,
  confidenceBand,
  flagLowConfidencePdfText,
} from './pdf-extraction';
export type {
  FlaggedRegion,
  PdfPageText,
  PdfExtractionResult,
  PdfConfidenceOptions,
} from './pdf-extraction';

// LinkedIn parsing (8.3).
export { parseLinkedInRecords } from './linkedin';
export type {
  LinkedInRecords,
  LinkedInProfile,
  LinkedInPosition,
  LinkedInSkill,
  LinkedInCertification,
} from './linkedin';

// Structured extraction (8.4).
export {
  extractFromLinkedIn,
  extractFromText,
  sequentialItemIds,
  toEmploymentRecords,
} from './extraction';
export type { EmploymentRecord, ItemIdFactory } from './extraction';

// Date helpers.
export {
  parseYearMonth,
  monthsBetween,
  formatYearMonth,
  honestMonthYear,
  isPresent,
} from './dates';
export type { YearMonth } from './dates';

// Reconciliation / conflicts (8.6).
export {
  RECENT_ROLE_MONTHS,
  reconcile,
  resolveConflict,
  filterResolvedConflicts,
  resolvedFieldSet,
  conflictResolutionLog,
} from './reconciliation';
export type { ExtractedDoc, ReconcileResult, ReconcileOptions } from './reconciliation';

// Eligibility gating (8.8).
export { computeEligibility, confirmItem, promoteLow } from './eligibility';
export type { EligibilityResult, EligibilityInput } from './eligibility';

// Review / correction, gaps, override supremacy (8.10).
export {
  GAP_THRESHOLD_MONTHS,
  NEUTRAL_GAP_FRAMING,
  groupByDocument,
  confirm,
  edit,
  remove,
  markPrivate,
  add,
  detectGaps,
  annotateGap,
  ConcernLog,
  applyUserOverride,
} from './review';
export type {
  DocumentGroup,
  UserAddedItem,
  EmploymentGap,
  OverrideConcern,
  OverrideResult,
} from './review';

// The engine itself.
export {
  IngestionEngine,
  createIngestionEngine,
  UnsupportedFormatError,
} from './ingestion-engine';
export type { IngestionResult, IngestionEngineDeps } from './ingestion-engine';

// Persistence of reviewed extractions to the Memory Store (R34.1, R35.1).
export {
  serializeRawExtractions,
  serializeRawExtractionsFromGroups,
  parseRawExtractions,
} from './raw-extractions-document';

// Persistence of full raw document text for whole-document local AI skill
// discovery, surviving resume / Memory import (R34.1, R47.1, R47.5, R49).
export { serializeRawDocuments, parseRawDocuments } from './raw-documents-document';
export type { RawDocument } from './raw-documents-document';
