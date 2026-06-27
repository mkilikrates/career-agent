// Stable-ID registry and assignment (R18.1, R18.4, R23.1, R23.2, R23.3).
//
// Accomplishments are identified by `BULLET-NN` and confirmed talking points by
// `STAR-NN`. Two hard guarantees govern these identifiers:
//
//   * **Unique & monotonic** — a number, once handed out for a kind, is never
//     handed out again. The registry holds a per-kind counter that only ever
//     increases (R18.4, R23.2).
//   * **Never reused or renumbered, even across reloads** — on resume the
//     registry is *seeded* from the identifiers already present in the Memory
//     Store so its counter resumes past the highest existing number; retired
//     and edited identifiers therefore stay allocated and are never reissued
//     (R18.4, R23.2, R23.3).
//
// Retirement marks an entry rather than removing it (R23.3): a retired id stays
// allocated so it can never be minted again.

import type { BulletId, StarId } from '@core/types';
import { asBulletId, asStarId } from '@core/types';

/** The two kinds of stable identifier the registry mints. */
export type IdKind = 'STAR' | 'BULLET';

/** On-disk prefix for each id kind. */
const PREFIX: Record<IdKind, string> = { STAR: 'STAR', BULLET: 'BULLET' };

/** Minimum zero-padding width for the numeric suffix (`STAR-01`). */
const PAD_WIDTH = 2;

/** Parse a raw identifier into its kind and number, or `undefined` if invalid. */
export const parseId = (id: string): { kind: IdKind; n: number } | undefined => {
  const match = /^(STAR|BULLET)-(\d+)$/.exec(id);
  if (!match) return undefined;
  return { kind: match[1] as IdKind, n: Number(match[2]) };
};

/** Classify an arbitrary id string as a `STAR` / `BULLET` kind (or undefined). */
export const kindOf = (id: string): IdKind | undefined => parseId(id)?.kind;

/** Format a `kind` + number into the canonical id spelling. */
export const formatId = (kind: IdKind, n: number): string =>
  `${PREFIX[kind]}-${String(n).padStart(PAD_WIDTH, '0')}`;

interface RegistryEntry {
  kind: IdKind;
  n: number;
  retired: boolean;
}

/**
 * Monotonic, append-only registry of stable identifiers. Mints new ids, seeds
 * from existing ones on resume, and tracks retirement — never deleting or
 * renumbering an allocated id.
 */
export class IdRegistry {
  /** Highest number issued per kind; the next mint uses `counter + 1`. */
  private readonly counters: Record<IdKind, number> = { STAR: 0, BULLET: 0 };
  /** Every id ever known to the registry, keyed by its canonical spelling. */
  private readonly entries = new Map<string, RegistryEntry>();

  /**
   * Seed the registry from identifiers already present in the Memory Store so
   * subsequent mints continue past the highest existing number (R18.4, R23.2).
   * Unknown-format strings are ignored. Already-known ids are left untouched
   * (duplicate *detection* is the healing pass's job, not the registry's).
   */
  seed(ids: Iterable<string>): this {
    for (const raw of ids) {
      const parsed = parseId(raw);
      if (!parsed) continue;
      const id = formatId(parsed.kind, parsed.n);
      if (!this.entries.has(id)) {
        this.entries.set(id, { kind: parsed.kind, n: parsed.n, retired: false });
      }
      if (parsed.n > this.counters[parsed.kind]) {
        this.counters[parsed.kind] = parsed.n;
      }
    }
    return this;
  }

  /** Mint the next unique identifier of a kind (R18.1, R23.1). */
  mint(kind: IdKind): string {
    const n = ++this.counters[kind];
    const id = formatId(kind, n);
    // Defensive: the monotonic counter guarantees this is fresh, but never
    // clobber an existing entry if a caller seeded an out-of-band id.
    if (this.entries.has(id)) {
      return this.mint(kind);
    }
    this.entries.set(id, { kind, n, retired: false });
    return id;
  }

  /** Mint the next `STAR-NN` talking-point id (R23.1). */
  mintStarId(): StarId {
    return asStarId(this.mint('STAR'));
  }

  /** Mint the next `BULLET-NN` accomplishment id (R18.1). */
  mintBulletId(): BulletId {
    return asBulletId(this.mint('BULLET'));
  }

  /**
   * Mark an identifier retired rather than deleting it (R23.3). A previously
   * unknown id is recorded (and counter advanced) before being retired so it
   * still can never be reused. Returns the registry for chaining.
   */
  retire(id: string): this {
    const parsed = parseId(id);
    if (!parsed) return this;
    const canonical = formatId(parsed.kind, parsed.n);
    const existing = this.entries.get(canonical);
    if (existing) {
      existing.retired = true;
    } else {
      this.seed([canonical]);
      this.entries.get(canonical)!.retired = true;
    }
    return this;
  }

  /** Whether the id has ever been allocated (active or retired). */
  isAllocated(id: string): boolean {
    const parsed = parseId(id);
    return parsed ? this.entries.has(formatId(parsed.kind, parsed.n)) : false;
  }

  /** Whether the id is allocated and marked retired (R23.3). */
  isRetired(id: string): boolean {
    const parsed = parseId(id);
    return parsed ? this.entries.get(formatId(parsed.kind, parsed.n))?.retired === true : false;
  }

  /** Whether the id is allocated and not retired. */
  isActive(id: string): boolean {
    return this.isAllocated(id) && !this.isRetired(id);
  }

  /** Every allocated id (active and retired), in ascending kind/number order. */
  allIds(): string[] {
    return this.sortedIds(() => true);
  }

  /** Allocated, non-retired ids. */
  activeIds(): string[] {
    return this.sortedIds((e) => !e.retired);
  }

  /** Allocated, retired ids (R23.3). */
  retiredIds(): string[] {
    return this.sortedIds((e) => e.retired);
  }

  /** Total allocated ids. */
  get size(): number {
    return this.entries.size;
  }

  private sortedIds(predicate: (e: RegistryEntry) => boolean): string[] {
    return [...this.entries.values()]
      .filter(predicate)
      .sort((a, b) => (a.kind === b.kind ? a.n - b.n : a.kind.localeCompare(b.kind)))
      .map((e) => formatId(e.kind, e.n));
  }
}
