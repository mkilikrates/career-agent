// Review / correction, gap handling, and user-override supremacy
// (R12.1, R12.2, R12.4, R13.1–R13.4, R39.1, R39.2).
//
// After extraction the user reviews a summary GROUPED BY DOCUMENT (R12.1) and
// may confirm / edit / delete / add items and mark any item private (R12.2,
// R12.3, R12.4). Employment gaps longer than three months are detected (R10.4)
// and presented with NEUTRAL framing (R13.1), annotatable as private or
// eligible (R13.2); the agent never invents a gap explanation (R13.3) and never
// uses misleading date formatting that conceals a gap (R13.4). Finally, on any
// user override the user's value is persisted verbatim and any agent concern is
// recorded AT MOST ONCE without ever refusing to proceed (R39.1, R39.2).

import type { DocId, ExtractedItem, ISODate, ItemId } from '@core/types';
import { trailOf, userConfirmation } from '@core/provenance';
import { confirmItem } from './eligibility';
import {
  honestMonthYear,
  monthsBetween,
  parseYearMonth,
  type YearMonth,
} from './dates';
import type { EmploymentRecord } from './extraction';

// --- Review summary grouped by document (R12.1) --------------------------

/** A document and the items extracted from it (R12.1). */
export interface DocumentGroup {
  readonly doc: DocId;
  readonly items: ExtractedItem[];
}

/** Group extracted items by their source document for the review summary (R12.1). */
export const groupByDocument = (items: readonly ExtractedItem[]): DocumentGroup[] => {
  const order: DocId[] = [];
  const byDoc = new Map<string, ExtractedItem[]>();
  for (const item of items) {
    const key = item.sourceDoc as unknown as string;
    if (!byDoc.has(key)) {
      byDoc.set(key, []);
      order.push(item.sourceDoc);
    }
    byDoc.get(key)!.push(item);
  }
  return order.map((doc) => ({ doc, items: byDoc.get(doc as unknown as string)! }));
};

// --- Review / correction operations (R12.2, R12.3, R12.4) ----------------

/** Replace the item with `id` using `update`, returning a new array (pure). */
const mapItem = (
  items: readonly ExtractedItem[],
  id: ItemId,
  update: (item: ExtractedItem) => ExtractedItem,
): ExtractedItem[] => items.map((item) => (item.id === id ? update(item) : item));

/** Confirm an item: highest reliability + user-confirmation provenance (R12.4). */
export const confirm = (
  items: readonly ExtractedItem[],
  id: ItemId,
  at: ISODate,
  note?: string,
): ExtractedItem[] => mapItem(items, id, (item) => confirmItem(item, at, note));

/**
 * Edit an item's fields (R12.2). The edited item is recorded as user-confirmed
 * and raised to highest reliability with a user-confirmation provenance record
 * (R12.4).
 */
export const edit = (
  items: readonly ExtractedItem[],
  id: ItemId,
  fields: Record<string, unknown>,
  at: ISODate,
  note = 'User edited during ingestion review.',
): ExtractedItem[] =>
  mapItem(items, id, (item) => ({
    ...item,
    fields: { ...item.fields, ...fields },
    userConfirmed: true,
    provenance: [...item.provenance, userConfirmation(at, note)],
  }));

/** Delete an item the user rejects (R12.2). */
export const remove = (items: readonly ExtractedItem[], id: ItemId): ExtractedItem[] =>
  items.filter((item) => item.id !== id);

/** Mark (or unmark) an item private so it is stored but never output (R12.3). */
export const markPrivate = (
  items: readonly ExtractedItem[],
  id: ItemId,
  isPrivate = true,
): ExtractedItem[] => mapItem(items, id, (item) => ({ ...item, private: isPrivate }));

/** Fields the user supplies when adding information not present in any document. */
export interface UserAddedItem {
  readonly id: ItemId;
  readonly type: ExtractedItem['type'];
  readonly fields: Record<string, unknown>;
  readonly sourceDoc: DocId;
  readonly private?: boolean;
}

/**
 * Add information not present in the documents (R12.2). A user-added item is
 * user-confirmed at highest reliability and carries a user-confirmation
 * provenance record from creation (R12.4, R38.1) — it has no source line.
 */
export const add = (
  items: readonly ExtractedItem[],
  added: UserAddedItem,
  at: ISODate,
  note = 'User added during ingestion review.',
): ExtractedItem[] => [
  ...items,
  {
    id: added.id,
    type: added.type,
    fields: added.fields,
    confidence: 'High',
    provenance: trailOf(userConfirmation(at, note)),
    userConfirmed: true,
    private: added.private ?? false,
    sourceDoc: added.sourceDoc,
  },
];

// --- Employment gap detection and handling (R10.4, R13) ------------------

/** The minimum gap length, in months, that is surfaced to the user (R10.4). */
export const GAP_THRESHOLD_MONTHS = 3;

/** Neutral, non-judgemental framing for a detected gap (R13.1). */
export const NEUTRAL_GAP_FRAMING =
  'A gap between roles was detected. Gaps are normal and are noted only so you ' +
  'can optionally add context; no explanation is assumed or required.';

/** A detected employment gap presented with neutral framing (R10.4, R13.1). */
export interface EmploymentGap {
  /** Employer of the role immediately before the gap. */
  readonly afterEmployer: string;
  /** Employer of the role immediately after the gap. */
  readonly beforeEmployer: string;
  /** Honest "Month YYYY" label for the gap start (end of the prior role) (R13.4). */
  readonly startLabel: string;
  /** Honest "Month YYYY" label for the gap end (start of the next role) (R13.4). */
  readonly endLabel: string;
  /** Gap length in whole months (> {@link GAP_THRESHOLD_MONTHS}). */
  readonly months: number;
  /** Neutral framing shown to the user (R13.1). */
  readonly framing: string;
  /** Optional user annotation (never agent-invented, R13.3). */
  readonly note?: string;
  /** Whether the user marked the annotation private (vs. output-eligible) (R13.2). */
  readonly private?: boolean;
}

/** A role with a parsed start (and optional end) used for gap detection. */
interface DatedRole {
  readonly record: EmploymentRecord;
  readonly start: YearMonth;
  readonly end?: YearMonth;
}

/**
 * Detect employment gaps longer than three months between consecutive roles
 * (R10.4, R13.1). Roles are sorted chronologically by start date; only intervals
 * STRICTLY greater than {@link GAP_THRESHOLD_MONTHS} are reported (a gap of three
 * months or less is not), and overlapping roles never produce a gap. Detected
 * gaps carry neutral framing and honest month-year labels (R13.1, R13.4); no
 * explanation is invented (R13.3).
 */
export const detectGaps = (history: readonly EmploymentRecord[]): EmploymentGap[] => {
  const dated: DatedRole[] = [];
  for (const record of history) {
    const start = parseYearMonth(record.start);
    if (!start) continue; // a role with no parseable start cannot bound a gap
    dated.push({ record, start, end: parseYearMonth(record.end) });
  }

  // Chronological order by start, then by end.
  dated.sort((a, b) => {
    const byStart = monthsBetween(b.start, a.start);
    if (byStart !== 0) return byStart;
    const ae = a.end ? a.end.year * 12 + a.end.month : Infinity;
    const be = b.end ? b.end.year * 12 + b.end.month : Infinity;
    return ae - be;
  });

  const gaps: EmploymentGap[] = [];
  // Track the furthest end reached so far so overlapping roles don't false-positive.
  let coveredUntil: YearMonth | undefined;

  for (let i = 0; i < dated.length; i += 1) {
    const role = dated[i];
    if (i === 0) {
      coveredUntil = role.end;
      continue;
    }

    const prevEnd = coveredUntil;
    // An ongoing previous role (no end) covers everything after it → no gap.
    if (prevEnd === undefined) {
      if (role.end === undefined) coveredUntil = undefined;
      else coveredUntil = role.end;
      continue;
    }

    const months = monthsBetween(prevEnd, role.start);
    if (months > GAP_THRESHOLD_MONTHS) {
      const prevRole = dated[i - 1].record;
      gaps.push({
        afterEmployer: prevRole.employer,
        beforeEmployer: role.record.employer,
        startLabel: honestMonthYear(prevEnd),
        endLabel: honestMonthYear(role.start),
        months,
        framing: NEUTRAL_GAP_FRAMING,
      });
    }

    // Advance coverage to the later of the two ends.
    if (role.end === undefined) coveredUntil = undefined;
    else if (!coveredUntil || monthsBetween(coveredUntil, role.end) > 0) {
      coveredUntil = role.end;
    }
  }

  return gaps;
};

/**
 * Annotate a gap with a user-supplied note and privacy choice (R13.2). The note
 * is always the user's own text; the agent never invents a gap explanation
 * (R13.3).
 */
export const annotateGap = (
  gap: EmploymentGap,
  note: string,
  isPrivate: boolean,
): EmploymentGap => ({ ...gap, note, private: isPrivate });

// --- User-override supremacy (R39.1, R39.2) ------------------------------

/** A single recorded agent concern about a user override (R39.2). */
export interface OverrideConcern {
  readonly itemId: ItemId;
  readonly field: string;
  readonly concern: string;
}

/** Accumulates override concerns, recording each (item, field) at most once (R39.2). */
export class ConcernLog {
  private readonly seen = new Set<string>();
  private readonly entries: OverrideConcern[] = [];

  /** Key identifying a unique (item, field) concern. */
  private static keyOf(itemId: ItemId, field: string): string {
    return `${itemId as unknown as string}::${field}`;
  }

  /**
   * Record a concern for `(itemId, field)` once. Subsequent identical concerns
   * are ignored, so the agent never re-raises the same concern (R39.2). Returns
   * `true` when the concern was newly recorded, `false` when suppressed.
   */
  record(itemId: ItemId, field: string, concern: string): boolean {
    const key = ConcernLog.keyOf(itemId, field);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.entries.push({ itemId, field, concern });
    return true;
  }

  /** Whether a concern for `(itemId, field)` has already been recorded. */
  has(itemId: ItemId, field: string): boolean {
    return this.seen.has(ConcernLog.keyOf(itemId, field));
  }

  /** All recorded concerns, in first-seen order. */
  all(): OverrideConcern[] {
    return [...this.entries];
  }
}

/** The outcome of applying a user override (R39.1, R39.2). */
export interface OverrideResult {
  /** Items with the user's value persisted verbatim (R39.1). */
  readonly items: ExtractedItem[];
  /** Whether a concern was newly recorded for this override (R39.2). */
  readonly concernRecorded: boolean;
}

/**
 * Apply a user override to an item's fields (R39.1, R39.2). The user's value is
 * persisted verbatim and the item is recorded as user-confirmed (authoritative).
 * If `concern` is supplied it is recorded in `concernLog` AT MOST ONCE for the
 * given (item, field) pair; the override always proceeds and is NEVER refused
 * (R39.2).
 */
export const applyUserOverride = (
  items: readonly ExtractedItem[],
  id: ItemId,
  fields: Record<string, unknown>,
  at: ISODate,
  options: { concern?: { field: string; message: string }; concernLog?: ConcernLog } = {},
): OverrideResult => {
  const updated = mapItem(items, id, (item) => ({
    ...item,
    fields: { ...item.fields, ...fields },
    userConfirmed: true,
    provenance: [
      ...item.provenance,
      userConfirmation(at, 'User override accepted as authoritative.'),
    ],
  }));

  let concernRecorded = false;
  if (options.concern && options.concernLog) {
    concernRecorded = options.concernLog.record(
      id,
      options.concern.field,
      options.concern.message,
    );
  }

  return { items: updated, concernRecorded };
};
