import { describe, it, expect } from 'vitest';
import { asISODate } from '@core/types';
import type { ExtractedItem } from '@core/types';
import { generate } from '@core/skills';
import {
  suggestRoles,
  capturePreferences,
  serializeRolePreferences,
  parseRolePreferences,
  saveConfirmedRolePreferences,
  ROLE_PREFERENCES_PATH,
} from './index';

const mk = (id: string, name: string): ExtractedItem =>
  ({
    id: id as never,
    type: 'skill',
    fields: { name },
    confidence: 'High',
    userConfirmed: true,
    private: false,
    sourceDoc: 'doc1' as never,
    provenance: [{ kind: 'source-line', sourceDoc: 'doc1' as never, line: 1 }] as never,
  }) as unknown as ExtractedItem;

describe('role preference capture + persistence', () => {
  const map = generate([mk('i1', 'PostgreSQL'), mk('i2', 'TypeScript'), mk('i3', 'JavaScript')], {
    asOf: asISODate('2024-05-01'),
  });
  const suggestions = suggestRoles(map);

  it('accepts, rejects, adds, ranks and tags (R21.1, R21.2)', () => {
    const first = suggestions[0];
    const prefs = capturePreferences(
      suggestions,
      [
        { slug: String(first.slug), accepted: true, rank: 2, tag: 'exploring' },
        { slug: 'does-not-exist', accepted: true },
        {
          added: { title: 'AI Researcher', description: 'Research role', requiredSkills: ['Python'] },
          rank: 1,
          tag: 'actively_applying',
        },
      ],
      { map },
    );
    expect(prefs.map((p) => p.title)).toEqual(['AI Researcher', first.title]);
    expect(prefs.map((p) => p.rank)).toEqual([1, 2]);
    expect(prefs[0].tag).toBe('actively_applying');
  });

  it('round-trips through role_preferences.md (R21.3, R34.2)', () => {
    const prefs = capturePreferences(suggestions, [
      { slug: String(suggestions[0].slug), rank: 1, tag: 'actively_applying' },
      { slug: String(suggestions[1].slug), rank: 2, tag: 'practice_only' },
    ]);
    const md = serializeRolePreferences(prefs);
    const parsed = parseRolePreferences(md);
    expect(parsed).toEqual(prefs);
    expect(serializeRolePreferences(parsed)).toBe(md);
  });

  it('confirmation-gates persistence (R21.3)', async () => {
    const writes: Record<string, string> = {};
    const writer = { write: (p: never, d: string) => void (writes[String(p)] = d) };
    expect(await saveConfirmedRolePreferences(writer, [], false)).toBeUndefined();
    expect(Object.keys(writes)).toHaveLength(0);
    const prefs = capturePreferences(suggestions, [{ slug: String(suggestions[0].slug), rank: 1 }]);
    const path = await saveConfirmedRolePreferences(writer, prefs, true);
    expect(path).toBe(ROLE_PREFERENCES_PATH);
    expect(writes[String(ROLE_PREFERENCES_PATH)]).toContain('# Role Preferences');
  });
});
