// Provenance index and trace lookup (R38.1, R38.2) — the "resolve any claim ref
// to its source trace" half of the Provenance / Citation Service.
//
// The index is the in-memory projection of the auditability traces the Memory
// Store persists (R38.1). It maps a claim reference (any stable domain id) to
// the non-empty provenance trail backing that claim, and exposes a trace lookup
// the UI inspector renders when the user inspects an output claim (R38.2).
//
// This module is framework-agnostic and has no dependency on storage, the
// network, or React — it operates purely over the domain types in `@core/types`.

import type {
  Accomplishment,
  BulletId,
  ExtractedItem,
  ItemId,
  Provenance,
  ProvenanceTrail,
  SkillId,
  StarId,
} from '@core/types';
import { isProvenanceTrail } from './provenance-record';

/**
 * Any stable identifier that can be cited as a claim. All of these are branded
 * strings at runtime, so the index keys on their underlying string value.
 */
export type ClaimRef = ItemId | BulletId | StarId | SkillId;

/**
 * The result of a trace lookup (R38.2). Carries the resolved claim reference
 * together with its non-empty provenance trail, ready for the UI inspector to
 * render each citation.
 */
export interface SourceTrace {
  ref: ClaimRef;
  /** >= 1 always (R38.1). */
  provenance: ProvenanceTrail;
}

/** A claim paired with the provenance trail attached to it at creation time. */
export interface ProvenanceFact {
  ref: ClaimRef;
  provenance: ProvenanceTrail;
}

/** The set of provenance-bearing records the index can be built from. */
export interface ProvenanceSources {
  /** Extracted items, each carrying provenance from the moment of extraction. */
  items?: readonly ExtractedItem[];
  /** Confirmed accomplishments, each carrying its provenance trail. */
  accomplishments?: readonly Accomplishment[];
  /** Any additional already-attached claim/provenance pairs. */
  facts?: readonly ProvenanceFact[];
}

/** Convert a branded claim reference to its underlying map key. */
const keyOf = (ref: ClaimRef): string => ref as unknown as string;

/**
 * In-memory provenance index (R38). Resolves any claim reference to its source
 * trace and detects unresolved claims (the basis of the No-Fabrication harness,
 * task 18). The index never throws on lookup: an unknown or empty claim simply
 * resolves to `undefined`, which callers treat as "unresolved".
 */
export class ProvenanceIndex {
  private readonly traces = new Map<string, { ref: ClaimRef; records: Provenance[] }>();

  /**
   * Attach provenance to a claim (R38.1). Call this at fact-creation time. If
   * the claim is already known, the new records are appended so a single claim
   * can accumulate citations from multiple sources. Accepts a single record or
   * a list (including a `ProvenanceTrail`). Empty input is a no-op.
   */
  attach(ref: ClaimRef, provenance: Provenance | readonly Provenance[]): this {
    const incoming = Array.isArray(provenance) ? provenance : [provenance as Provenance];
    if (incoming.length === 0) return this;

    const key = keyOf(ref);
    const existing = this.traces.get(key);
    if (existing) {
      existing.records.push(...incoming);
    } else {
      this.traces.set(key, { ref, records: [...incoming] });
    }
    return this;
  }

  /**
   * Resolve a claim reference to its source trace for the UI inspector (R38.2).
   * Returns `undefined` when the claim has no attached provenance (unresolved).
   */
  resolve(ref: ClaimRef): SourceTrace | undefined {
    const entry = this.traces.get(keyOf(ref));
    if (!entry || !isProvenanceTrail(entry.records)) return undefined;
    // Return a defensive copy so inspector consumers cannot mutate the index.
    return { ref: entry.ref, provenance: [...entry.records] as ProvenanceTrail };
  }

  /**
   * Trace lookup alias intended for the UI inspector (R38.2). Identical to
   * {@link resolve}; named to read naturally at the inspection call site.
   */
  lookup(ref: ClaimRef): SourceTrace | undefined {
    return this.resolve(ref);
  }

  /** Whether the claim resolves to at least one provenance record (R38.1). */
  isResolved(ref: ClaimRef): boolean {
    return this.resolve(ref) !== undefined;
  }

  /** Whether the claim has an entry in the index at all (resolved or not). */
  has(ref: ClaimRef): boolean {
    return this.traces.has(keyOf(ref));
  }

  /** Every claim reference currently held by the index. */
  refs(): ClaimRef[] {
    return [...this.traces.values()].map((entry) => entry.ref);
  }

  /** Number of distinct claims tracked by the index. */
  get size(): number {
    return this.traces.size;
  }

  /**
   * Given a set of claim references, return those that do not resolve to any
   * provenance. This is the unresolved-claim detection the No-Fabrication
   * harness builds upon (Property 1 / task 18).
   */
  unresolved(refs: readonly ClaimRef[]): ClaimRef[] {
    return refs.filter((ref) => !this.isResolved(ref));
  }
}

/**
 * Build a provenance index from the provenance-bearing domain records (R38.1).
 * Extracted items are keyed by their `ItemId` and accomplishments by their
 * `BulletId`; any extra pre-attached facts are added as-is.
 */
export const buildProvenanceIndex = (sources: ProvenanceSources = {}): ProvenanceIndex => {
  const index = new ProvenanceIndex();

  for (const item of sources.items ?? []) {
    index.attach(item.id, item.provenance);
  }
  for (const acc of sources.accomplishments ?? []) {
    index.attach(acc.id, acc.provenance);
  }
  for (const fact of sources.facts ?? []) {
    index.attach(fact.ref, fact.provenance);
  }

  return index;
};
