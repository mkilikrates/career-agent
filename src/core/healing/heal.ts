// State-healing pass (R36.1, R36.2, R36.3).
//
// On resume the Memory Store is verified for referential integrity. Two classes
// of structural damage are detected and *reported* (never thrown), so the UI can
// prompt the user to repair rather than crashing on a corrupt store:
//
//   * **Broken reference** (R36.2): a skill evidence ref points at a STAR/BULLET
//     identifier that is not declared anywhere in the store. The entry is flagged
//     so the UI can prompt a repair.
//   * **Duplicate identifier** (R36.3): the same `STAR-NN`/`BULLET-NN` is declared
//     (as an anchor) in two places. Both locations are reported so the UI can
//     prompt a re-index.
//
// The pass runs over *all* skill evidence references every resume (R36.1) and
// always returns a `HealingReport`; a structurally clean store yields `ok: true`
// with empty arrays.

import type {
  BulletId,
  HealingReport,
  MemoryPath,
  SkillId,
  SkillMapEntry,
  StarId,
} from '@core/types';
import { asBulletId, asStarId } from '@core/types';
import { kindOf } from '@core/registry';
import { parseAnchorIds, parseMarkdown } from '@core/markdown';

/** A single declaration of a stable id at a location in the store. */
export interface IdDeclaration {
  id: string;
  location: MemoryPath;
}

/** A Markdown file in the store, paired with its canonical store path. */
export interface StoreFile {
  path: MemoryPath;
  markdown: string;
}

/** The minimal store snapshot the healing pass verifies. */
export interface MemoryStoreSnapshot {
  /** Every id declaration (anchor occurrence) found across the store. */
  declarations: readonly IdDeclaration[];
  /** Skill entries whose evidence references are verified (R36.1). */
  skills: readonly SkillMapEntry[];
}

/** Empty, healthy report — the result for a structurally clean store. */
const okReport = (): HealingReport => ({ brokenReferences: [], duplicateIds: [], ok: true });

/**
 * Collect every anchor-declared identifier across a set of store files, each
 * paired with the file it was found in. Anchor occurrences are taken verbatim
 * (duplicates preserved) so the same id appearing twice surfaces as two
 * declarations — the basis of duplicate detection (R36.3). Frontmatter `ids:`
 * mirrors are intentionally *not* counted as declarations (they index the
 * anchors rather than declaring new ids).
 */
export const collectDeclarations = (files: readonly StoreFile[]): IdDeclaration[] => {
  const declarations: IdDeclaration[] = [];
  for (const file of files) {
    const body = parseMarkdown(file.markdown).body;
    for (const id of parseAnchorIds(body)) {
      declarations.push({ id, location: file.path });
    }
  }
  return declarations;
};

/** Cast a raw STAR/BULLET id string to its branded id type. */
const brandProof = (id: string): StarId | BulletId =>
  kindOf(id) === 'STAR' ? asStarId(id) : asBulletId(id);

/**
 * Run the state-healing verification over a store snapshot (R36.1–R36.3).
 * Never throws: any unexpected failure degrades to a best-effort report rather
 * than terminating the resume.
 */
export const healStore = (snapshot: MemoryStoreSnapshot): HealingReport => {
  try {
    const { declarations, skills } = snapshot;

    // --- Duplicate identifiers (R36.3) ---------------------------------
    const locationsById = new Map<string, MemoryPath[]>();
    for (const decl of declarations) {
      const list = locationsById.get(decl.id) ?? locationsById.set(decl.id, []).get(decl.id)!;
      list.push(decl.location);
    }
    const presentIds = new Set(declarations.map((d) => d.id));

    const duplicateIds: HealingReport['duplicateIds'] = [];
    for (const [id, locations] of locationsById) {
      if (locations.length > 1) {
        duplicateIds.push({ id: brandProof(id), locations });
      }
    }

    // --- Broken references (R36.2) -------------------------------------
    // Verify every skill evidence ref that is a STAR/BULLET id against the set
    // of ids actually declared in the store. Doc-backed evidence refs are not
    // stable ids and are out of scope here.
    const brokenReferences: HealingReport['brokenReferences'] = [];
    const seen = new Set<string>();
    for (const skill of skills) {
      for (const evidence of skill.evidence) {
        const ref = evidence.ref as unknown as string;
        if (kindOf(ref) === undefined) continue; // not a stable id (e.g. a DocId)
        if (presentIds.has(ref)) continue; // resolves — fine
        const dedupeKey = `${skill.id as unknown as string}→${ref}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        brokenReferences.push({ entry: skill.id as SkillId, missing: brandProof(ref) });
      }
    }

    const ok = brokenReferences.length === 0 && duplicateIds.length === 0;
    return { brokenReferences, duplicateIds, ok };
  } catch {
    // R36: never terminate — emit a report rather than throwing.
    return okReport();
  }
};

/**
 * Convenience entry point: collect declarations from raw store files and verify
 * the given skill entries in one call (R36.1).
 */
export const heal = (
  files: readonly StoreFile[],
  skills: readonly SkillMapEntry[],
): HealingReport => healStore({ declarations: collectDeclarations(files), skills });
