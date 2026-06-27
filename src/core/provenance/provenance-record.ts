// Provenance attachment helpers (R38.1) — the "attach a provenance record to
// every fact at creation time" half of the Provenance / Citation Service.
//
// These are small, pure constructors that mint the three citation kinds from
// the canonical `Provenance` union (see `@core/types`) plus helpers that bundle
// them into the non-empty `ProvenanceTrail` every fact must carry. Keeping the
// constructors here means callers never hand-build the discriminated-union
// shape (and therefore cannot accidentally omit the `kind` tag or attach an
// empty trail).

import type { DocId, ISODate, StarId } from '@core/types';
import type { Provenance, ProvenanceTrail } from '@core/types';

/**
 * Cite a specific line of a source document (R38.1).
 *
 * @param doc   the document the claim was extracted from
 * @param line  1-based line number within that document
 * @param quote the exact source text supporting the claim
 */
export const sourceLine = (doc: DocId, line: number, quote: string): Provenance => ({
  kind: 'source_line',
  doc,
  line,
  quote,
});

/**
 * Cite an explicit user confirmation (R12.4, R38.1). A user-confirmed fact
 * carries the highest reliability.
 *
 * @param at   when the user confirmed (ISO-8601)
 * @param note free-text describing what was confirmed
 */
export const userConfirmation = (at: ISODate, note: string): Provenance => ({
  kind: 'user_confirmation',
  at,
  note,
});

/**
 * Cite a confirmed interview answer by its stable STAR id (R38.1).
 *
 * @param star the talking-point id the claim is drawn from
 */
export const interviewAnswer = (star: StarId): Provenance => ({
  kind: 'interview_answer',
  star,
});

/**
 * Bundle one-or-more provenance records into a non-empty `ProvenanceTrail`.
 * The first argument is required, so the result is statically non-empty and
 * satisfies the "provenance >= 1 always" invariant (R38.1).
 */
export const trailOf = (first: Provenance, ...rest: Provenance[]): ProvenanceTrail => [
  first,
  ...rest,
];

/**
 * Runtime guard for the non-empty invariant. Useful at trust boundaries (e.g.
 * after deserialising a Markdown store) where the static type cannot be relied
 * upon. Narrows a plain `Provenance[]` to a `ProvenanceTrail` when non-empty.
 */
export const isProvenanceTrail = (
  records: readonly Provenance[],
): records is ProvenanceTrail => records.length >= 1;
