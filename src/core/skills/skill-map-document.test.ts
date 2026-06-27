import { describe, it, expect } from 'vitest';
import type { Accomplishment, ExtractedItem, ExtractedItemType } from '@core/types';
import {
  asBulletId,
  asDocId,
  asISODate,
  asItemId,
  asSkillId,
} from '@core/types';
import { sourceLine, trailOf } from '@core/provenance';
import { MemoryTree, CANONICAL_FILES } from '@core/storage';
import {
  generate,
  addUserSkill,
  recordSelfAssessment,
  serializeSkillMap,
  parseSkillMap,
  loadSkillMap,
  saveSkillMap,
  saveConfirmedSkillMap,
  SKILL_MAP_PATH,
} from './index';
import type { SkillMap } from './index';

const DOC = asDocId('cv.pdf');
const AS_OF = asISODate('2024-01-01');

let seq = 0;
const item = (
  type: ExtractedItemType,
  fields: Record<string, unknown>,
  confidence: ExtractedItem['confidence'] = 'High',
  userConfirmed = false,
): ExtractedItem => ({
  id: asItemId(`item-${seq++}`),
  type,
  fields,
  confidence,
  provenance: trailOf(sourceLine(DOC, 1, JSON.stringify(fields))),
  userConfirmed,
  private: false,
  sourceDoc: DOC,
});

const skill = (name: string) => item('skill', { name });

/** A representative confirmed map: merged variants, a proof link, an added skill. */
const buildConfirmedMap = (): SkillMap => {
  const acc: Accomplishment = {
    id: asBulletId('BULLET-01'),
    text: 'Built a JS data pipeline',
    provenance: trailOf(sourceLine(DOC, 2, 'pipeline')),
    skills: [asSkillId('SKILL-javascript')],
  };
  const map = generate(
    [
      skill('Python'),
      skill('JavaScript'),
      skill('javascript'), // casing variant → merged (reversible MergeRecord)
      item('employment', {
        employer: 'Acme',
        title: 'Dev',
        technologies: ['Docker'],
        start: '2021-01',
        end: '2023-06',
      }),
    ],
    { asOf: AS_OF, accomplishments: [acc] },
  );
  // User review additions (task 10.4) so persistence covers those fields too.
  addUserSkill(map, { name: 'Public Speaking', roleOrProject: 'Conferences', when: '2022' });
  recordSelfAssessment(map, asSkillId('SKILL-python'), { level: 'Advanced', note: '5 years' });
  return map;
};

describe('skill-map-document — serialization (R34.1, R34.2)', () => {
  it('includes each entry stable id, both as an anchor and mirrored in frontmatter', () => {
    const map = buildConfirmedMap();
    const md = serializeSkillMap(map.entries);

    for (const entry of map.entries) {
      const id = String(entry.id);
      expect(md).toContain(`<!-- id: ${id} -->`);
    }
    // Ids mirrored into the frontmatter `ids:` list (R34.2).
    const frontmatter = md.slice(0, md.indexOf('# Skill Map'));
    for (const entry of map.entries) {
      expect(frontmatter).toContain(String(entry.id));
    }
  });

  it('serializes each entry field (R14.1): name, category, signal, evidence, recency', () => {
    const map = generate([skill('Python')], { asOf: AS_OF });
    const py = map.entries[0];
    const md = serializeSkillMap(map.entries);

    expect(md).toContain(`## ${py.name}`);
    expect(md).toContain(`- **Category:** ${py.category}`);
    expect(md).toContain(`- **Proficiency:** ${py.proficiencySignal}`);
    expect(md).toContain(`- **Recency:** ${String(py.recency)}`);
    expect(md).toContain(`\`${String(py.evidence[0].ref)}\` (${String(py.evidence[0].when)})`);
  });

  it('serializes self-assessment and the reversible merge record when present', () => {
    const map = buildConfirmedMap();
    const md = serializeSkillMap(map.entries);

    expect(md).toContain('- **Self-assessment:** Self-assessed: Advanced — 5 years');
    expect(md).toContain('**Merge** (reversible):');

    const js = map.entries.find((e) => String(e.id) === 'SKILL-javascript')!;
    expect(js.mergeRecord).toBeDefined();
    expect(md).toContain(`- Rationale: ${js.mergeRecord!.rationale}`);
    expect(md).toContain(`- At: ${String(js.mergeRecord!.at)}`);
  });
});

describe('skill-map-document — round trip (R34.2)', () => {
  it('serialize → parse recovers the entries exactly', () => {
    const map = buildConfirmedMap();
    const parsed = parseSkillMap(serializeSkillMap(map.entries));
    expect(parsed).toEqual(map.entries);
  });

  it('parse → serialize is a fixpoint (string stable across a re-write)', () => {
    const map = buildConfirmedMap();
    const once = serializeSkillMap(map.entries);
    const twice = serializeSkillMap(parseSkillMap(once));
    expect(twice).toBe(once);
  });

  it('loadSkillMap rebuilds the bi-directional proof graph from the document', () => {
    const map = buildConfirmedMap();
    const loaded = loadSkillMap(serializeSkillMap(map.entries));
    expect(loaded.entries).toEqual(map.entries);
    // The JS→BULLET-01 proof link survives the round trip (R18.3).
    expect(loaded.graph.accomplishmentsFor(asSkillId('SKILL-javascript'))).toEqual([
      asBulletId('BULLET-01'),
    ]);
    expect(loaded.graph.skillsFor(asBulletId('BULLET-01'))).toEqual([
      asSkillId('SKILL-javascript'),
    ]);
  });

  it('round-trips an entry flagged with a broken reference (R36.2)', () => {
    const map = generate([skill('Python')], { asOf: AS_OF });
    map.entries[0].brokenReference = true;
    const parsed = parseSkillMap(serializeSkillMap(map.entries));
    expect(parsed[0].brokenReference).toBe(true);
    expect(parsed).toEqual(map.entries);
  });
});

describe('skill-map-document — persistence (R14.4)', () => {
  it('saveSkillMap writes the serialized map to the canonical profile path', async () => {
    const map = buildConfirmedMap();
    const tree = new MemoryTree();

    const path = await saveSkillMap(tree, map);

    expect(path).toBe(CANONICAL_FILES.skillMap);
    expect(SKILL_MAP_PATH).toBe(CANONICAL_FILES.skillMap);
    expect(tree.has('profile/skill_map.md')).toBe(true);
    expect(tree.readText('profile/skill_map.md')).toBe(serializeSkillMap(map.entries));
    // What was persisted reloads back to the same entries (R34.2).
    expect(parseSkillMap(tree.readText('profile/skill_map.md'))).toEqual(map.entries);
  });

  it('accepts a bare entries array as well as a full SkillMap', async () => {
    const map = buildConfirmedMap();
    const tree = new MemoryTree();
    await saveSkillMap(tree, map.entries);
    expect(tree.readText('profile/skill_map.md')).toBe(serializeSkillMap(map.entries));
  });

  it('persists through a Promise-returning Storage_Adapter writer', async () => {
    const map = buildConfirmedMap();
    const writes: { path: string; data: string }[] = [];
    const adapter = {
      write: async (path: typeof SKILL_MAP_PATH, data: string) => {
        writes.push({ path: String(path), data });
      },
    };

    await saveSkillMap(adapter, map);

    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('profile/skill_map.md');
    expect(parseSkillMap(writes[0].data)).toEqual(map.entries);
  });

  it('saveConfirmedSkillMap only writes once the user confirms (R14.4)', async () => {
    const map = buildConfirmedMap();
    const tree = new MemoryTree();

    const notSaved = await saveConfirmedSkillMap(tree, map, false);
    expect(notSaved).toBeUndefined();
    expect(tree.has('profile/skill_map.md')).toBe(false);

    const saved = await saveConfirmedSkillMap(tree, map, true);
    expect(saved).toBe(CANONICAL_FILES.skillMap);
    expect(tree.has('profile/skill_map.md')).toBe(true);
  });
});
