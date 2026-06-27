// Multi-document reconciliation and conflict detection (R9).
//
// When several documents describe the same role, ingestion must MERGE the
// richest description rather than discard alternatives (R9.1), RECORD every
// differing field as a conflict listing all candidate values with their source
// documents (R9.2), DEFAULT the recommendation by the most-recent-for-recent /
// most-detailed-for-older rule (R9.3), treat a USER-ENTERED value as
// authoritative (R9.5), and LOG resolutions so a resolved conflict is not
// re-presented on the next ingestion (R9.4).
//
// Roles are matched by a normalised (employer, title) key. Non-employment items
// pass through untouched — skill de-duplication/normalisation is the
// Skill_Mapper's responsibility, not the Ingestion_Engine's.

import type {
  ConflictRecord,
  DocId,
  ExtractedItem,
  ISODate,
} from '@core/types';
import { asISODate } from '@core/types';
import type { SessionLogEntry } from '@core/storage';
import { parseYearMonth, monthsBetween, type YearMonth } from './dates';

/** A document's extracted items, tagged with the document's own date (R9.3). */
export interface ExtractedDoc {
  readonly docId: DocId;
  /** When the document was produced — drives the recency recommendation (R9.3). */
  readonly date?: ISODate;
  readonly items: readonly ExtractedItem[];
}

/** The result of reconciling several documents (R9.1, R9.2). */
export interface ReconcileResult {
  /** One merged item per role (richest description) plus pass-through items. */
  readonly merged: ExtractedItem[];
  /** Every field that differed across documents (R9.2). */
  readonly conflicts: ConflictRecord[];
}

/** A role within how many months of the reference date counts as "recent" (R9.3). */
export const RECENT_ROLE_MONTHS = 24;

/** Options for {@link reconcile}. */
export interface ReconcileOptions {
  /** Clock used for recency when no document date is newer. Defaults to system. */
  readonly now?: () => YearMonth;
}

const norm = (v: unknown): string =>
  String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Normalised role key: the same role across documents is matched by employer +
 * start date. The title is deliberately NOT part of the key — a title is often
 * the very field that differs across CV versions (a promotion or a rephrasing),
 * so keying on it would hide title conflicts (R9.2). When no start date is
 * present the key falls back to the employer alone.
 */
const roleKey = (item: ExtractedItem): string =>
  `${norm(item.fields.employer)}|${norm(item.fields.start)}`;

/** Richness of a field value (used to pick the most-detailed value, R9.3). */
const detailOf = (value: unknown): number => {
  if (value === undefined || value === null) return 0;
  if (Array.isArray(value)) return value.reduce((sum, v) => sum + String(v).length, 0);
  if (typeof value === 'string') return value.length;
  return 1;
};

/** Stable equality key for distinct-value comparison. */
const valueKey = (value: unknown): string => JSON.stringify(value ?? null);

/** Whether an item represents a user-entered/confirmed value (authoritative, R9.5). */
const isUserEntered = (item: ExtractedItem): boolean =>
  item.userConfirmed || item.provenance.some((p) => p.kind === 'user_confirmation');

interface GroupMember {
  readonly item: ExtractedItem;
  readonly docDate?: YearMonth;
}

interface FieldCandidate {
  readonly value: unknown;
  readonly doc: DocId;
  readonly detail: number;
  readonly userEntered: boolean;
  readonly docDate?: YearMonth;
}

/** Reference year-month for recency: the newest doc date, or "now". */
const referencePoint = (members: GroupMember[], now: () => YearMonth): YearMonth => {
  let ref = now();
  for (const m of members) {
    if (m.docDate && monthsBetween(ref, m.docDate) > 0) ref = m.docDate;
  }
  return ref;
};

/** A role is recent if it is ongoing or ended within {@link RECENT_ROLE_MONTHS}. */
const isRecentRole = (members: GroupMember[], ref: YearMonth): boolean => {
  let latestEnd: YearMonth | undefined;
  for (const { item } of members) {
    const end = item.fields.end;
    if (end === undefined || end === null || String(end).trim().length === 0) {
      return true; // ongoing role → recent
    }
    const ym = parseYearMonth(String(end));
    if (ym && (!latestEnd || monthsBetween(latestEnd, ym) > 0)) latestEnd = ym;
  }
  if (!latestEnd) return true; // no parseable end → treat as recent (don't bury)
  return monthsBetween(latestEnd, ref) <= RECENT_ROLE_MONTHS;
};

/** Pick the recommended value for a field per R9.3 / R9.5. */
const recommendValue = (candidates: FieldCandidate[], recent: boolean): unknown => {
  // R9.5: a user-entered value is always authoritative.
  const userEntered = candidates.find((c) => c.userEntered);
  if (userEntered) return userEntered.value;

  if (recent) {
    // Most recent document wins for recent roles (R9.3).
    return [...candidates].sort((a, b) => {
      const am = a.docDate ? a.docDate.year * 12 + a.docDate.month : -Infinity;
      const bm = b.docDate ? b.docDate.year * 12 + b.docDate.month : -Infinity;
      if (bm !== am) return bm - am;
      return b.detail - a.detail;
    })[0].value;
  }

  // Most detailed document wins for older roles (R9.3).
  return [...candidates].sort((a, b) => b.detail - a.detail)[0].value;
};

/** Collect all field names present across a role group's items. */
const fieldNamesOf = (members: GroupMember[]): string[] => {
  const names = new Set<string>();
  for (const { item } of members) {
    for (const key of Object.keys(item.fields)) names.add(key);
  }
  return [...names];
};

/** Merge a single role group into one item plus any conflict records. */
const mergeGroup = (
  key: string,
  members: GroupMember[],
  now: () => YearMonth,
): { merged: ExtractedItem; conflicts: ConflictRecord[] } => {
  const ref = referencePoint(members, now);
  const recent = isRecentRole(members, ref);
  const fields: Record<string, unknown> = {};
  const conflicts: ConflictRecord[] = [];

  for (const field of fieldNamesOf(members)) {
    const candidates: FieldCandidate[] = members
      .map(({ item, docDate }) => ({
        value: item.fields[field],
        doc: item.sourceDoc,
        detail: detailOf(item.fields[field]),
        userEntered: isUserEntered(item),
        docDate,
      }))
      .filter((c) => c.value !== undefined);

    if (candidates.length === 0) continue;

    const recommended = recommendValue(candidates, recent);
    fields[field] = recommended;

    // Conflict iff the present candidates carry more than one distinct value.
    const distinct = new Set(candidates.map((c) => valueKey(c.value)));
    if (distinct.size > 1) {
      conflicts.push({
        field: `${key}::${field}`,
        candidates: candidates.map((c) => ({ value: c.value, doc: c.doc })),
        recommended,
      });
    }
  }

  // The merged item adopts the richest item's identity/flags; provenance is the
  // union of every contributing item's trail (so nothing loses its citation).
  const richest = [...members].sort(
    (a, b) =>
      fieldNamesOf([b]).reduce((s, f) => s + detailOf(b.item.fields[f]), 0) -
      fieldNamesOf([a]).reduce((s, f) => s + detailOf(a.item.fields[f]), 0),
  )[0].item;

  const mergedProvenance = members.flatMap((m) => m.item.provenance);
  const merged: ExtractedItem = {
    id: richest.id,
    type: 'employment',
    fields,
    confidence: members.some((m) => m.item.confidence === 'High')
      ? 'High'
      : members.some((m) => m.item.confidence === 'Medium')
        ? 'Medium'
        : 'Low',
    provenance: [mergedProvenance[0], ...mergedProvenance.slice(1)],
    userConfirmed: members.some((m) => m.item.userConfirmed),
    private: members.some((m) => m.item.private),
    sourceDoc: richest.sourceDoc,
  };

  return { merged, conflicts };
};

/**
 * Reconcile several documents (R9.1–R9.3, R9.5). Employment items describing
 * the same role are merged into one richest-description item; every field that
 * differs across documents becomes a {@link ConflictRecord} listing all
 * candidate values with their sources and a default recommendation. Non-
 * employment items pass through unchanged.
 */
export const reconcile = (
  docs: readonly ExtractedDoc[],
  options: ReconcileOptions = {},
): ReconcileResult => {
  const now =
    options.now ??
    (() => {
      const d = new Date();
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
    });

  const groups = new Map<string, GroupMember[]>();
  const passthrough: ExtractedItem[] = [];

  for (const doc of docs) {
    const docDate = parseYearMonth(doc.date as unknown as string | undefined);
    for (const item of doc.items) {
      if (item.type !== 'employment') {
        passthrough.push(item);
        continue;
      }
      const key = roleKey(item);
      (groups.get(key) ?? groups.set(key, []).get(key)!).push({ item, docDate });
    }
  }

  const merged: ExtractedItem[] = [];
  const conflicts: ConflictRecord[] = [];

  for (const [key, members] of groups) {
    if (members.length === 1) {
      merged.push(members[0].item);
      continue;
    }
    const result = mergeGroup(key, members, now);
    merged.push(result.merged);
    conflicts.push(...result.conflicts);
  }

  merged.push(...passthrough);
  return { merged, conflicts };
};

// --- Resolution logging (R9.4) -------------------------------------------

/** Record a user's (or default) resolution onto a conflict (R9.4). */
export const resolveConflict = (
  conflict: ConflictRecord,
  value: unknown,
  by: 'user' | 'default',
  at: ISODate,
): ConflictRecord => ({ ...conflict, resolved: { value, by, at } });

/**
 * Drop conflicts already resolved in a prior session so they are not
 * re-presented on the next ingestion (R9.4). A conflict is considered resolved
 * if its `field` appears in `resolvedFields`.
 */
export const filterResolvedConflicts = (
  conflicts: readonly ConflictRecord[],
  resolvedFields: ReadonlySet<string>,
): ConflictRecord[] =>
  conflicts.filter((c) => !(c.resolved !== undefined || resolvedFields.has(c.field)));

/** The set of fields already resolved across a list of conflict records (R9.4). */
export const resolvedFieldSet = (conflicts: readonly ConflictRecord[]): Set<string> => {
  const set = new Set<string>();
  for (const c of conflicts) {
    if (c.resolved !== undefined) set.add(c.field);
  }
  return set;
};

/** Render resolved conflicts as session-log entries for `log/session_log.md` (R9.4). */
export const conflictResolutionLog = (
  conflicts: readonly ConflictRecord[],
): SessionLogEntry[] =>
  conflicts
    .filter((c): c is ConflictRecord & { resolved: NonNullable<ConflictRecord['resolved']> } =>
      c.resolved !== undefined,
    )
    .map((c) => ({
      at: c.resolved.at ?? asISODate(new Date().toISOString()),
      type: 'conflict-resolution' as const,
      message: `Resolved conflict on "${c.field}" → ${JSON.stringify(
        c.resolved.value,
      )} (by ${c.resolved.by}).`,
    }));
