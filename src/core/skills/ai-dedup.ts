// Post-extraction dedup pass for AI-extracted skill variants (R15.4, Problem D).
//
// After the AI extracts skills from career documents, this module groups obvious
// duplicates and presents SUGGESTIONS (never auto-merges) to the user. Two
// heuristics detect high-confidence relationships:
//
//   1. Parenthetical stripping: "DNS (Route 53)" shares base "DNS" with a
//      standalone "DNS" entry → suggest merge.
//   2. Vendor-qualified detection: "AWS Lambda" vs "Lambda" — when one term is
//      exactly `<vendor> <base>` and another is `<base>` → suggest merge.
//
// Conservative by design: only triggers on exact structural matches, never on
// fuzzy similarity. Confusable pairs (Java/JavaScript) are never suggested.

/** A single merge suggestion presented to the user (R15.4). */
export interface DedupSuggestion {
  /** The shorter/simpler form to keep as canonical. */
  readonly canonical: string;
  /** The variant(s) that appear to duplicate the canonical. */
  readonly variants: readonly string[];
  /** Reason for the suggestion (shown to user). */
  readonly reason: string;
}

/** Well-known vendor prefixes used to detect vendor-qualified duplicates. Sorted longest-first so multi-word prefixes match before single-word ones. */
const VENDOR_PREFIXES: readonly string[] = [
  'google cloud',
  'red hat',
  'amazon',
  'azure',
  'cloudflare',
  'atlassian',
  'datadog',
  'elastic',
  'github',
  'gitlab',
  'google',
  'hashicorp',
  'ibm',
  'jetbrains',
  'microsoft',
  'oracle',
  'vmware',
  'aws',
  'gcp',
].sort((a, b) => b.length - a.length);

/**
 * Strip parenthetical suffixes from a skill name to obtain the base form.
 * e.g. "DNS (Route 53)" → "DNS", "Terraform (IaC)" → "Terraform".
 * Only strips trailing parentheticals; leading text is preserved.
 */
export function stripParenthetical(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * If the name is vendor-qualified (e.g. "AWS Lambda"), return the base
 * without the vendor prefix (e.g. "Lambda"). Returns `null` if no known
 * vendor prefix is detected.
 */
export function stripVendorPrefix(name: string): string | null {
  const lower = name.toLowerCase();
  for (const prefix of VENDOR_PREFIXES) {
    if (lower.startsWith(prefix + ' ') && name.length > prefix.length + 1) {
      const base = name.slice(prefix.length + 1).trim();
      if (base.length > 0) return base;
    }
  }
  return null;
}

/**
 * Analyse a set of AI-extracted skills and produce conservative dedup
 * suggestions (R15.4). These are NEVER auto-merges — the caller presents
 * them to the user for confirmation.
 *
 * Two detection strategies:
 * 1. Parenthetical: skills sharing the same base after stripping `(...)` suffix
 * 2. Vendor-qualified: `"AWS Lambda"` alongside `"Lambda"` (exact base match)
 */
export function suggestAiDedups(
  skills: ReadonlyArray<{ readonly name: string; readonly since?: string }>,
): DedupSuggestion[] {
  const suggestions: DedupSuggestion[] = [];
  const names = skills.map((s) => s.name);

  // Build a lowercase lookup set for quick membership checks.
  const lowerSet = new Set(names.map((n) => n.toLowerCase()));

  // --- Strategy 1: Parenthetical stripping ---
  // Group skills by their base name (after stripping parentheticals).
  const parentheticalGroups = new Map<string, string[]>();
  for (const name of names) {
    const base = stripParenthetical(name);
    // Only relevant if the name actually had a parenthetical stripped.
    if (base.toLowerCase() === name.toLowerCase()) continue;
    const key = base.toLowerCase();
    const group = parentheticalGroups.get(key) ?? [];
    group.push(name);
    parentheticalGroups.set(key, group);
  }

  // For each group, check if there's also a standalone version matching the base.
  const suggestedPairs = new Set<string>();
  for (const [baseKey, variants] of parentheticalGroups) {
    // Find a standalone skill that matches the base exactly (case-insensitive).
    const standalone = names.find(
      (n) => n.toLowerCase() === baseKey && !variants.includes(n),
    );
    if (standalone) {
      const canonical = standalone;
      const pairKey = [canonical.toLowerCase(), ...variants.map((v) => v.toLowerCase())].sort().join('|');
      if (!suggestedPairs.has(pairKey)) {
        suggestedPairs.add(pairKey);
        suggestions.push({
          canonical,
          variants,
          reason: `"${variants.join('", "')}" appears to be a qualified form of "${canonical}" (parenthetical variant).`,
        });
      }
    }
  }

  // --- Strategy 2: Vendor-qualified detection ---
  for (const name of names) {
    const base = stripVendorPrefix(name);
    if (!base) continue;
    // Check if the unqualified base exists as a standalone skill.
    if (!lowerSet.has(base.toLowerCase())) continue;
    // Find the exact-cased standalone entry.
    const standalone = names.find((n) => n.toLowerCase() === base.toLowerCase());
    if (!standalone || standalone.toLowerCase() === name.toLowerCase()) continue;

    // Avoid suggesting if already covered by parenthetical strategy.
    const pairKey = [standalone.toLowerCase(), name.toLowerCase()].sort().join('|');
    if (suggestedPairs.has(pairKey)) continue;
    suggestedPairs.add(pairKey);

    suggestions.push({
      canonical: standalone,
      variants: [name],
      reason: `"${name}" appears to be a vendor-qualified form of "${standalone}".`,
    });
  }

  return suggestions;
}
