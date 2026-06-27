// Provenance / citation model (R38) — every fact points to its source.
//
// Provenance is mandatory, not optional: every fact carries a citation from the
// moment of extraction, and output generation can only emit facts that carry
// provenance (R37, R38). The non-empty-array invariant below makes "a fact
// always has at least one provenance record" unrepresentable-otherwise at the
// type level.

import type { DocId, ISODate, StarId } from './brands';

/**
 * A non-empty array: at least one element is required by the type. Used to
 * encode the "provenance >= 1 always" invariant (R38.1) so an empty provenance
 * list is not assignable.
 */
export type NonEmptyArray<T> = [T, ...T[]];

/** Discriminated union of citation kinds (R38.1). */
export type Provenance =
  | { kind: 'source_line'; doc: DocId; line: number; quote: string } // R38.1
  | { kind: 'user_confirmation'; at: ISODate; note: string }         // R12.4, R38.1
  | { kind: 'interview_answer'; star: StarId };                      // R38.1

/**
 * A fact always carries at least one provenance record (R38.1). Domain records
 * use this rather than `Provenance[]` so an empty list is a type error.
 */
export type ProvenanceTrail = NonEmptyArray<Provenance>;

/** Evidence-confidence level for an extracted item (R11.1). */
export type Confidence = 'High' | 'Medium' | 'Low';
