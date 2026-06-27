// Skill-map persistence — serialize / parse / save `profile/skill_map.md` (R14.4, R34.1, R34.2).
//
// Phase 2 (Skill Map) ends with the user CONFIRMING the reviewed map; on
// confirmation the Skill_Mapper SHALL save the map to the Memory Store BEFORE
// advancing to Role Discovery (R14.4). This module owns that persistence.
//
// The Memory Store is a Markdown-as-database (R34.1): every entity is plain,
// human-readable Markdown carrying its stable identifiers as HTML anchor
// comments mirrored into the frontmatter `ids:` list (see `@core/markdown`).
// Following that established pattern, a skill map is rendered as one Markdown
// section per skill — heading (user phrasing), an `<!-- id: SKILL-... -->`
// anchor, the entry's fields, its dated evidence trail, and any reversible
// merge record — and the `SKILL-*` ids are mirrored into the document
// frontmatter via {@link serializeMarkdown}.
//
// Two guarantees, mirroring the rest of the store:
//   1. Lossless round trip (R34.2): {@link parseSkillMap} ∘ {@link serializeSkillMap}
//      recovers the entries, and the serialized string is a fixpoint of
//      parse → serialize. Free-text fields are normalised to a single line on
//      render (as the session log does), which is the contract the line-based
//      Markdown store carries.
//   2. Confirmation-gated persistence (R14.4): {@link saveSkillMap} writes the
//      canonical `profile/skill_map.md` path through any Storage_Adapter /
//      MemoryTree writer, and {@link saveConfirmedSkillMap} only writes once the
//      user has confirmed the map.

import type {
  BulletId,
  DocId,
  MemoryPath,
  MergeRecord,
  SkillCategory,
  SkillEvidence,
  SkillMapEntry,
  SkillTerm,
  StarId,
} from '@core/types';
import { asBulletId, asDocId, asISODate, asSkillId, asSkillTerm, asStarId } from '@core/types';
import { anchorComment } from '@core/markdown';
import { parseMarkdown, serializeMarkdown } from '@core/markdown';
import { buildReferenceGraph, kindOf } from '@core/registry';
import { CANONICAL_FILES } from '@core/storage';
import type { SkillMap } from './skill-map';

const asString = (v: unknown): string => v as unknown as string;

/** Collapse a value to a single line so it cannot corrupt the line-based document. */
const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/** Title heading written at the top of the skill-map document. */
export const SKILL_MAP_HEADING = '# Skill Map';

// --- Brand an evidence ref back to its strongest matching id kind -----------

/**
 * Re-brand a parsed evidence ref. `STAR-NN` / `BULLET-NN` proofs are recognised
 * via the registry's classifier; anything else is a source-document ref. The
 * brand is erased at runtime, so this only restores compile-time fidelity.
 */
const asEvidenceRef = (raw: string): DocId | StarId | BulletId => {
  switch (kindOf(raw)) {
    case 'STAR':
      return asStarId(raw);
    case 'BULLET':
      return asBulletId(raw);
    default:
      return asDocId(raw);
  }
};

// --- Serialize --------------------------------------------------------------

/** Render one dated, sourced evidence row (R14.1, R18.2). */
const renderEvidence = (e: SkillEvidence): string =>
  `- \`${asString(e.ref)}\` (${asString(e.when)}) — ${oneLine(e.note)}`;

/** Render the reversible merge record block, if present (R15.2, R19.3). */
const renderMerge = (record: MergeRecord): string[] => {
  const from = record.from.map((t) => `\`${asString(t)}\``).join(', ');
  return [
    '',
    '**Merge** (reversible):',
    '',
    `- From: ${from}`,
    `- Rationale: ${oneLine(record.rationale)}`,
    `- At: ${asString(record.at)}`,
  ];
};

/** Render a single skill entry as a Markdown section. */
const renderEntry = (entry: SkillMapEntry): string[] => {
  const lines: string[] = [
    `## ${oneLine(entry.name)}`,
    '',
    anchorComment(asString(entry.id)),
    '',
    `- **Category:** ${entry.category}`,
    `- **Proficiency:** ${oneLine(entry.proficiencySignal)}`,
  ];
  if (entry.selfAssessment !== undefined) {
    lines.push(`- **Self-assessment:** ${oneLine(entry.selfAssessment)}`);
  }
  lines.push(`- **Recency:** ${asString(entry.recency)}`);
  if (entry.brokenReference === true) {
    lines.push('- **Broken reference:** yes');
  }

  lines.push('', '**Evidence:**', '');
  if (entry.evidence.length === 0) {
    lines.push('_No evidence recorded._');
  } else {
    for (const e of entry.evidence) lines.push(renderEvidence(e));
  }

  if (entry.mergeRecord !== undefined) {
    lines.push(...renderMerge(entry.mergeRecord));
  }
  return lines;
};

/**
 * Serialize skill-map entries to the canonical `skill_map.md` Markdown (R34.1).
 * Each entry becomes a human-readable section carrying its stable `SKILL-*` id
 * as an anchor comment; the ids are mirrored into the document frontmatter
 * (R34.2). Deterministic: the output depends only on the entries.
 */
export const serializeSkillMap = (entries: readonly SkillMapEntry[]): string => {
  const body: string[] = [SKILL_MAP_HEADING, ''];
  for (const entry of entries) {
    body.push(...renderEntry(entry), '');
  }
  const ids = entries.map((e) => asString(e.id));
  return serializeMarkdown({ frontmatter: {}, ids, body: `${body.join('\n')}\n` });
};

// --- Parse ------------------------------------------------------------------

const HEADING = /^## (.*)$/;
const ANCHOR = /^<!--\s*id:\s*(\S+)\s*-->$/;
const CATEGORY = /^- \*\*Category:\*\* (.*)$/;
const PROFICIENCY = /^- \*\*Proficiency:\*\* (.*)$/;
const SELF_ASSESS = /^- \*\*Self-assessment:\*\* (.*)$/;
const RECENCY = /^- \*\*Recency:\*\* (.*)$/;
const BROKEN = /^- \*\*Broken reference:\*\* (.*)$/;
const EVIDENCE = /^- `([^`]*)` \(([^)]*)\) — (.*)$/;
const MERGE_FROM = /^- From: (.*)$/;
const MERGE_RATIONALE = /^- Rationale: (.*)$/;
const MERGE_AT = /^- At: (.*)$/;
const BACKTICKED = /`([^`]*)`/g;

/** Mutable accumulator for an entry being parsed. */
interface PartialEntry {
  id?: string;
  name: string;
  category: SkillCategory;
  proficiencySignal: string;
  selfAssessment?: string;
  recency: string;
  brokenReference?: boolean;
  evidence: SkillEvidence[];
  merge?: { from: SkillTerm[]; rationale: string; at: string };
}

const newPartial = (name: string): PartialEntry => ({
  name,
  category: 'Domain',
  proficiencySignal: '',
  recency: '',
  evidence: [],
});

/** Finalise a partial into a {@link SkillMapEntry} (ids defaulted defensively). */
const finalise = (p: PartialEntry): SkillMapEntry => {
  const entry: SkillMapEntry = {
    id: asSkillId(p.id ?? `SKILL-${p.name}`),
    name: p.name,
    category: p.category,
    proficiencySignal: p.proficiencySignal,
    evidence: p.evidence,
    recency: asISODate(p.recency),
  };
  if (p.selfAssessment !== undefined) entry.selfAssessment = p.selfAssessment;
  if (p.brokenReference === true) entry.brokenReference = true;
  if (p.merge !== undefined) {
    entry.mergeRecord = {
      from: p.merge.from,
      into: asSkillTerm(p.name),
      rationale: p.merge.rationale,
      at: asISODate(p.merge.at),
      reversible: true,
    };
  }
  return entry;
};

/**
 * Parse a `skill_map.md` document back into its entries (R34.2). The exact
 * inverse of {@link serializeSkillMap} for the single-line-field contract the
 * store carries; lines that match no rule are ignored, so the printable
 * heading and section spacing never confuse the parse.
 */
export const parseSkillMap = (markdown: string): SkillMapEntry[] => {
  const { body } = parseMarkdown(markdown);
  const entries: SkillMapEntry[] = [];
  let current: PartialEntry | undefined;
  let inMerge = false;

  const flush = (): void => {
    if (current) entries.push(finalise(current));
  };

  for (const raw of body.split('\n')) {
    const line = raw.trim();

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      current = newPartial(heading[1]);
      inMerge = false;
      continue;
    }
    if (!current) continue;

    if (line === '**Merge** (reversible):') {
      current.merge = { from: [], rationale: '', at: '' };
      inMerge = true;
      continue;
    }

    const anchor = ANCHOR.exec(line);
    if (anchor) {
      current.id = anchor[1];
      continue;
    }
    const category = CATEGORY.exec(line);
    if (category) {
      current.category = category[1] as SkillCategory;
      continue;
    }
    const proficiency = PROFICIENCY.exec(line);
    if (proficiency) {
      current.proficiencySignal = proficiency[1];
      continue;
    }
    const self = SELF_ASSESS.exec(line);
    if (self) {
      current.selfAssessment = self[1];
      continue;
    }
    const recency = RECENCY.exec(line);
    if (recency) {
      current.recency = recency[1];
      continue;
    }
    const broken = BROKEN.exec(line);
    if (broken) {
      current.brokenReference = true;
      continue;
    }

    if (inMerge && current.merge) {
      const from = MERGE_FROM.exec(line);
      if (from) {
        current.merge.from = [...from[1].matchAll(BACKTICKED)].map((m) => asSkillTerm(m[1]));
        continue;
      }
      const rationale = MERGE_RATIONALE.exec(line);
      if (rationale) {
        current.merge.rationale = rationale[1];
        continue;
      }
      const at = MERGE_AT.exec(line);
      if (at) {
        current.merge.at = at[1];
        continue;
      }
    }

    const evidence = EVIDENCE.exec(line);
    if (evidence) {
      current.evidence.push({
        ref: asEvidenceRef(evidence[1]),
        when: asISODate(evidence[2]),
        note: evidence[3],
      });
    }
  }
  flush();
  return entries;
};

/**
 * Parse a `skill_map.md` document back into a full {@link SkillMap}, rebuilding
 * the bi-directional skill ↔ proof graph from the recovered entries (R18.3) —
 * the load-side counterpart of {@link serializeSkillMap}.
 */
export const loadSkillMap = (markdown: string): SkillMap => {
  const entries = parseSkillMap(markdown);
  return { entries, graph: buildReferenceGraph({ skills: entries }) };
};

// --- Persist (R14.4) --------------------------------------------------------

/** Canonical Memory Store location for the skill map (R34.1). */
export const SKILL_MAP_PATH: MemoryPath = CANONICAL_FILES.skillMap;

/** A confirmed skill map, accepted either as the full map or just its entries. */
export type PersistableSkillMap = SkillMap | readonly SkillMapEntry[];

/** Minimal writer satisfied by both the Storage_Adapter and the MemoryTree. */
export interface SkillMapWriter {
  write(path: MemoryPath, data: string): unknown;
}

const entriesOf = (map: PersistableSkillMap): readonly SkillMapEntry[] =>
  Array.isArray(map) ? map : (map as SkillMap).entries;

/**
 * Persist the confirmed skill map to `profile/skill_map.md` via the supplied
 * writer (Storage_Adapter or MemoryTree). Serialization is shared with
 * {@link serializeSkillMap}, so the written file round-trips losslessly
 * (R34.2). Awaits the write so a Promise-returning adapter completes before the
 * caller advances (R14.4).
 */
export const saveSkillMap = async (
  writer: SkillMapWriter,
  map: PersistableSkillMap,
): Promise<MemoryPath> => {
  await writer.write(SKILL_MAP_PATH, serializeSkillMap(entriesOf(map)));
  return SKILL_MAP_PATH;
};

/**
 * Confirmation-gated persistence (R14.4): save the map ONLY when the user has
 * confirmed it, BEFORE the pipeline advances. Returns the written path when the
 * map was saved, or `undefined` when `confirmed` is false (nothing is written).
 */
export const saveConfirmedSkillMap = async (
  writer: SkillMapWriter,
  map: PersistableSkillMap,
  confirmed: boolean,
): Promise<MemoryPath | undefined> => {
  if (!confirmed) return undefined;
  return saveSkillMap(writer, map);
};
