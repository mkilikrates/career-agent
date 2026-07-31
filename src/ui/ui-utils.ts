// @ui/ui-utils — shared UI utility functions.
//
// Small, pure utility functions shared across multiple screens.

import type { EgressDestination } from '@core/assist';

/**
 * Split a comma- or newline-separated list into trimmed, de-duped entries.
 * Used by RoleDiscoveryScreen and SkillMapScreen for free-text skill/role input.
 */
export function parseCommaSeparatedList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Build an {@link EgressDestination} from the provider/local props every screen
 * receives. Returns null when no provider is configured. Shared across all
 * screens that wire AI-assist.
 */
export function buildEgressDest(
  chatProvider: string | null | undefined,
  chatIsLocal: boolean,
): EgressDestination | null {
  return chatProvider
    ? { provider: chatProvider, kind: chatIsLocal ? 'keyless-local' : 'keyed-cloud' }
    : null;
}
