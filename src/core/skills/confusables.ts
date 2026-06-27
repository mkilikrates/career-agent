// Confusable-pair list and synonym knowledge for conservative skill merging
// (R16.1–R16.4, supports R15.1).
//
// The never-merge list and the synonym/abbreviation knowledge live entirely in
// an EXTERNAL resource file (`config/confusables.yaml`) so the list can be
// extended WITHOUT a code change (R16.4). This module only parses that file and
// answers two questions the Conservative Merge algorithm asks:
//
//   * `isConfusable(a, b)` — are these a listed never-merge pair? (R16.3)
//   * `isUmbrella(t)`      — is this a generic umbrella term? (R16.1, R16.2)
//
// plus it exposes the canonicalised synonym/abbreviation groups that license a
// merge (R15.1). YAML is parsed with the project's existing YAML dependency
// (`gray-matter`, which wraps js-yaml) rather than a bespoke parser, so the
// file accepts the full YAML the design documents.

import matter from 'gray-matter';
import type { SkillTerm } from '@core/types';

/**
 * The shape of `config/confusables.yaml` (R16.3, R16.4). Every section is a
 * plain list so the file stays human-editable and extensible without code
 * changes:
 *
 * ```yaml
 * pairs:                 # never merge these on string similarity alone (R16.3)
 *   - [Java, JavaScript]
 *   - [C, "C#"]
 * synonyms:              # terms that ARE the same skill — merge allowed (R15.1)
 *   - [JavaScript, ECMAScript]
 * abbreviations:         # abbreviation ⇄ full name — merge allowed (R15.1)
 *   - [k8s, Kubernetes]
 * umbrellas:             # generic umbrella terms kept separate (R16.1, R16.2)
 *   - Cloud
 * ```
 */
export interface ConfusablesConfig {
  /** Never-merge pairs (R16.3). */
  readonly pairs?: ReadonlyArray<readonly [string, string]>;
  /** Groups of true synonyms of the same skill (R15.1). */
  readonly synonyms?: ReadonlyArray<ReadonlyArray<string>>;
  /** Groups of abbreviation/full-name variants of the same skill (R15.1). */
  readonly abbreviations?: ReadonlyArray<ReadonlyArray<string>>;
  /** Generic umbrella terms — added separately, never a merge target (R16.1). */
  readonly umbrellas?: ReadonlyArray<string>;
}

/** A loaded, queryable confusables resource. */
export interface Confusables {
  /** True iff `a` and `b` are a listed never-merge pair (R16.3). */
  isConfusable(a: SkillTerm | string, b: SkillTerm | string): boolean;
  /** True iff `t` is a listed generic umbrella term (R16.1, R16.2). */
  isUmbrella(t: SkillTerm | string): boolean;
  /** Canonicalised synonym groups that license a merge (R15.1). */
  readonly synonymGroups: ReadonlyArray<ReadonlySet<string>>;
  /** Canonicalised abbreviation groups that license a merge (R15.1). */
  readonly abbreviationGroups: ReadonlyArray<ReadonlySet<string>>;
}

/**
 * Canonical comparison key for a skill term: lower-cased, with surrounding and
 * repeated internal whitespace collapsed. Punctuation is deliberately PRESERVED
 * so that `C`, `C++`, and `C#` remain distinct canonical forms — only casing
 * and whitespace are treated as insignificant when deciding whether two surface
 * terms are spelling/casing variants of the same skill (R15.1).
 */
export const canonicalTerm = (term: SkillTerm | string): string =>
  String(term).toLowerCase().replace(/\s+/g, ' ').trim();

/** Stable key for an unordered pair of canonical terms. */
const pairKey = (a: string, b: string): string =>
  a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`;

/**
 * Build a queryable {@link Confusables} from a parsed config. Pairs and umbrella
 * terms are canonicalised once up front so lookups are case/whitespace
 * insensitive and allocation-free per query.
 */
export const loadConfusables = (config: ConfusablesConfig): Confusables => {
  const pairKeys = new Set<string>();
  for (const pair of config.pairs ?? []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const a = canonicalTerm(pair[0]);
    const b = canonicalTerm(pair[1]);
    if (a.length === 0 || b.length === 0 || a === b) continue;
    pairKeys.add(pairKey(a, b));
  }

  const toGroups = (
    groups: ReadonlyArray<ReadonlyArray<string>> | undefined,
  ): ReadonlySet<string>[] =>
    (groups ?? [])
      .map((group) => new Set(group.map(canonicalTerm).filter((t) => t.length > 0)))
      .filter((set) => set.size >= 2);

  const umbrellas = new Set(
    (config.umbrellas ?? []).map(canonicalTerm).filter((t) => t.length > 0),
  );

  return {
    isConfusable: (a, b) => pairKeys.has(pairKey(canonicalTerm(a), canonicalTerm(b))),
    isUmbrella: (t) => umbrellas.has(canonicalTerm(t)),
    synonymGroups: toGroups(config.synonyms),
    abbreviationGroups: toGroups(config.abbreviations),
  };
};

/**
 * Parse the raw text of `config/confusables.yaml` into a {@link ConfusablesConfig}
 * (R16.4). The YAML body is parsed through `gray-matter` (the project's existing
 * YAML dependency) by framing it as a front-matter block; malformed or missing
 * sections degrade to empty lists rather than throwing, so a corrupt resource
 * file never crashes skill mapping.
 */
export const parseConfusables = (yamlText: string): ConfusablesConfig => {
  let data: Record<string, unknown> = {};
  try {
    const framed = `---\n${yamlText.replace(/\r\n/g, '\n')}\n---\n`;
    data = (matter(framed).data ?? {}) as Record<string, unknown>;
  } catch {
    data = {};
  }

  const asPairs = (value: unknown): Array<[string, string]> => {
    if (!Array.isArray(value)) return [];
    const pairs: Array<[string, string]> = [];
    for (const entry of value) {
      if (Array.isArray(entry) && entry.length >= 2) {
        pairs.push([String(entry[0]), String(entry[1])]);
      }
    }
    return pairs;
  };

  const asGroups = (value: unknown): string[][] => {
    if (!Array.isArray(value)) return [];
    const groups: string[][] = [];
    for (const entry of value) {
      if (Array.isArray(entry)) groups.push(entry.map((t) => String(t)));
    }
    return groups;
  };

  const asList = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((t) => String(t)) : [];

  return {
    pairs: asPairs(data.pairs),
    synonyms: asGroups(data.synonyms),
    abbreviations: asGroups(data.abbreviations),
    umbrellas: asList(data.umbrellas),
  };
};

/** Convenience: parse and load `config/confusables.yaml` in one step (R16.4). */
export const loadConfusablesFromYaml = (yamlText: string): Confusables =>
  loadConfusables(parseConfusables(yamlText));

/**
 * The default never-merge list shipped as the seed for `config/confusables.yaml`
 * (mirrors the design's example). It is written to the Memory Store on first
 * run; users extend the file directly afterwards (R16.4).
 */
export const DEFAULT_CONFUSABLES_YAML = `# config/confusables.yaml (R16.3, R16.4) — never merge on string similarity alone
pairs:
  - [Java, JavaScript]
  - [C, C++]
  - [C, "C#"]
  - [React, React Native]
  - [Python, Jython]
  - ["Go (Golang)", "Google Go-to-market"]
  - ["Spark (Apache)", "Spark (Adobe)"]
`;
