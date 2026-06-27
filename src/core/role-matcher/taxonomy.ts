// Skill taxonomy and ontological satisfaction for the Role_Matcher
// (R17.1, R17.2, R17.3, R20.3).
//
// The taxonomy expresses `implements`/`extends` relationships between skills
// (e.g. PostgreSQL *implements* a "SQL Database", TypeScript *extends*
// JavaScript). It lives entirely in an EXTERNAL resource file
// (`config/taxonomy.yaml`) so the relationships can be EXTENDED WITHOUT a code
// change (R17.1). This module only parses that file and answers the single
// question ontological match scoring asks:
//
//   * `satisfies(required, owned)` — does some owned skill satisfy the required
//     skill, either directly or because it is a child (transitively) of the
//     required parent in the taxonomy? (R17.2, R20.3)
//
// IMPORTANT: the taxonomy affects SCORING ONLY. It never rewrites the user's
// skill terms or CV phrasing — `satisfies` is a pure predicate that reads skill
// terms and returns a boolean; it never mutates or returns rephrased terms
// (R17.3). The user's original phrasing (`SkillMapEntry.name`) is preserved
// elsewhere and is untouched here.
//
// YAML is parsed with the project's existing YAML dependency (`gray-matter`,
// which wraps js-yaml) — the same approach used by `@core/skills/confusables` —
// rather than a bespoke parser, so the file accepts the full YAML the design
// documents.

import matter from 'gray-matter';
import type { SkillTerm } from '@core/types';
import { canonicalTerm } from '@core/skills';

/** The kind of relationship a child skill has to its parent (R17.1). */
export type RelationType = 'implements' | 'extends';

/**
 * A single taxonomy edge: `child` is a more specific skill that satisfies the
 * more general `parent` skill via `type` (R17.1). For example
 * `{ child: PostgreSQL, parent: "SQL Database", type: implements }`.
 */
export interface TaxonomyRelation {
  readonly child: string;
  readonly parent: string;
  readonly type: RelationType;
}

/**
 * The shape of `config/taxonomy.yaml` (R17.1). A flat list of relations so the
 * file stays human-editable and extensible without code changes:
 *
 * ```yaml
 * relations:
 *   - { child: PostgreSQL, parent: "SQL Database", type: implements }
 *   - { child: MySQL,      parent: "SQL Database", type: implements }
 *   - { child: TypeScript, parent: JavaScript,     type: extends }
 * ```
 */
export interface TaxonomyConfig {
  /** The `implements`/`extends` relations (R17.1). */
  readonly relations?: ReadonlyArray<TaxonomyRelation>;
}

/** A loaded, queryable taxonomy resource. */
export interface Taxonomy {
  /**
   * True iff `owned` contains a skill that satisfies the `required` skill —
   * either by being the same skill, or by being a child (transitively, through
   * `implements`/`extends` edges) of the `required` parent (R17.2, R20.3).
   *
   * Pure: reads skill terms, returns a boolean, never rewrites phrasing (R17.3).
   */
  satisfies(required: SkillTerm | string, owned: ReadonlyArray<SkillTerm | string>): boolean;
  /**
   * True iff `child` is a descendant of `parent` in the taxonomy — i.e. there
   * is a chain of `implements`/`extends` edges from `child` up to `parent`
   * (R17.2). A skill is not considered a descendant of itself.
   */
  isDescendantOf(child: SkillTerm | string, parent: SkillTerm | string): boolean;
  /** The normalised relations the taxonomy was built from (R17.1). */
  readonly relations: ReadonlyArray<TaxonomyRelation>;
}

/**
 * Build a queryable {@link Taxonomy} from a parsed config. Edges are
 * canonicalised once up front (case/whitespace-insensitive, via the shared
 * {@link canonicalTerm}) and stored as a child→parents adjacency map so lookups
 * are allocation-light. Self-edges and malformed edges are dropped. Cycles in a
 * (mis-authored) taxonomy are tolerated: ancestor traversal tracks visited
 * nodes and terminates.
 */
export const loadTaxonomy = (config: TaxonomyConfig): Taxonomy => {
  // Keep the original relations (already normalised by parse) for inspection.
  const relations: TaxonomyRelation[] = [];
  // canonical child -> set of canonical parents.
  const childToParents = new Map<string, Set<string>>();

  for (const relation of config.relations ?? []) {
    if (relation == null) continue;
    const child = canonicalTerm(relation.child ?? '');
    const parent = canonicalTerm(relation.parent ?? '');
    const type = relation.type;
    if (child.length === 0 || parent.length === 0 || child === parent) continue;
    if (type !== 'implements' && type !== 'extends') continue;

    relations.push({ child: String(relation.child), parent: String(relation.parent), type });

    let parents = childToParents.get(child);
    if (parents === undefined) {
      parents = new Set<string>();
      childToParents.set(child, parents);
    }
    parents.add(parent);
  }

  /** All canonical ancestors of a canonical term, via BFS over child→parent. */
  const ancestorsOf = (start: string): Set<string> => {
    const seen = new Set<string>();
    const queue: string[] = [start];
    while (queue.length > 0) {
      const node = queue.shift() as string;
      const parents = childToParents.get(node);
      if (parents === undefined) continue;
      for (const parent of parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return seen;
  };

  const isDescendantOf: Taxonomy['isDescendantOf'] = (child, parent) =>
    ancestorsOf(canonicalTerm(child)).has(canonicalTerm(parent));

  const satisfies: Taxonomy['satisfies'] = (required, owned) => {
    const canonRequired = canonicalTerm(required);
    if (canonRequired.length === 0) return false;
    for (const skill of owned) {
      const canonOwned = canonicalTerm(skill);
      // Direct match: the user already owns exactly this skill.
      if (canonOwned === canonRequired) return true;
      // Ontological match: an owned child skill satisfies the required parent.
      if (ancestorsOf(canonOwned).has(canonRequired)) return true;
    }
    return false;
  };

  return { satisfies, isDescendantOf, relations };
};

/**
 * Parse the raw text of `config/taxonomy.yaml` into a {@link TaxonomyConfig}
 * (R17.1). The YAML body is parsed through `gray-matter` (the project's existing
 * YAML dependency) by framing it as a front-matter block; malformed or missing
 * sections degrade to an empty relation list rather than throwing, so a corrupt
 * resource file never crashes role matching.
 */
export const parseTaxonomy = (yamlText: string): TaxonomyConfig => {
  let data: Record<string, unknown> = {};
  try {
    const framed = `---\n${yamlText.replace(/\r\n/g, '\n')}\n---\n`;
    data = (matter(framed).data ?? {}) as Record<string, unknown>;
  } catch {
    data = {};
  }

  const relations: TaxonomyRelation[] = [];
  if (Array.isArray(data.relations)) {
    for (const entry of data.relations) {
      if (entry == null || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const child = record.child;
      const parent = record.parent;
      const type = record.type;
      if (child == null || parent == null) continue;
      if (type !== 'implements' && type !== 'extends') continue;
      relations.push({ child: String(child), parent: String(parent), type });
    }
  }

  return { relations };
};

/** Convenience: parse and load `config/taxonomy.yaml` in one step (R17.1). */
export const loadTaxonomyFromYaml = (yamlText: string): Taxonomy =>
  loadTaxonomy(parseTaxonomy(yamlText));

/**
 * The default taxonomy shipped as the seed for `config/taxonomy.yaml` (mirrors
 * the design's example). It is written to the Memory Store on first run; users
 * extend the file directly afterwards (R17.1).
 */
export const DEFAULT_TAXONOMY_YAML = `# config/taxonomy.yaml (R17.1) — scoring only, never rewrites user phrasing
relations:
  - { child: PostgreSQL, parent: "SQL Database", type: implements }
  - { child: MySQL,      parent: "SQL Database", type: implements }
  - { child: TypeScript, parent: JavaScript,     type: extends }
`;
