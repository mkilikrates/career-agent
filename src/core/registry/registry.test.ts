import { describe, expect, it } from 'vitest';
import {
  asBulletId,
  asDocId,
  asISODate,
  asSkillId,
  asStarId,
  type Accomplishment,
  type SkillMapEntry,
  type TalkingPoint,
} from '@core/types';
import { interviewAnswer } from '@core/provenance';
import {
  IdRegistry,
  buildReferenceGraph,
  formatId,
  kindOf,
  parseId,
  ReferenceGraph,
} from './index';

describe('@core/registry — id parsing/formatting', () => {
  it('parses and classifies valid ids', () => {
    expect(parseId('STAR-01')).toEqual({ kind: 'STAR', n: 1 });
    expect(parseId('BULLET-12')).toEqual({ kind: 'BULLET', n: 12 });
    expect(kindOf('STAR-03')).toBe('STAR');
    expect(kindOf('BULLET-03')).toBe('BULLET');
  });

  it('rejects malformed ids', () => {
    expect(parseId('STAR')).toBeUndefined();
    expect(parseId('SKILL-01')).toBeUndefined();
    expect(kindOf('nope')).toBeUndefined();
  });

  it('formats with zero-padding', () => {
    expect(formatId('STAR', 1)).toBe('STAR-01');
    expect(formatId('BULLET', 123)).toBe('BULLET-123');
  });
});

describe('IdRegistry — monotonic unique assignment (R18.1, R18.4, R23.1, R23.2)', () => {
  it('mints sequential, unique ids per kind', () => {
    const reg = new IdRegistry();
    expect(reg.mintStarId()).toBe('STAR-01');
    expect(reg.mintStarId()).toBe('STAR-02');
    expect(reg.mintBulletId()).toBe('BULLET-01');
    expect(reg.mintStarId()).toBe('STAR-03');
    expect(reg.mintBulletId()).toBe('BULLET-02');
  });

  it('never reuses a number even after seeding from an existing store', () => {
    const reg = new IdRegistry();
    reg.seed(['STAR-01', 'STAR-05', 'BULLET-03']);
    // Counter must resume past the highest existing number, never reissuing.
    expect(reg.mintStarId()).toBe('STAR-06');
    expect(reg.mintBulletId()).toBe('BULLET-04');
  });

  it('ignores malformed ids when seeding', () => {
    const reg = new IdRegistry();
    reg.seed(['STAR-02', 'garbage', 'SKILL-99']);
    expect(reg.mintStarId()).toBe('STAR-03');
    expect(reg.allIds()).toEqual(['STAR-02', 'STAR-03']);
  });

  it('produces no collisions across many mints', () => {
    const reg = new IdRegistry();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = i % 2 === 0 ? reg.mintStarId() : reg.mintBulletId();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});

describe('IdRegistry — retirement marks rather than deletes (R23.3)', () => {
  it('keeps retired ids allocated and never reissues them', () => {
    const reg = new IdRegistry();
    const a = reg.mintStarId();
    const b = reg.mintStarId();
    reg.retire(a);

    expect(reg.isAllocated(a)).toBe(true); // still present
    expect(reg.isRetired(a)).toBe(true);
    expect(reg.isActive(a)).toBe(false);
    expect(reg.isActive(b)).toBe(true);

    // Next mint continues forward — the retired number is not reissued.
    expect(reg.mintStarId()).toBe('STAR-03');
    expect(reg.retiredIds()).toEqual([a]);
    expect(reg.activeIds()).toEqual([b, 'STAR-03']);
  });

  it('retiring an unknown id records it as allocated+retired', () => {
    const reg = new IdRegistry();
    reg.retire('BULLET-07');
    expect(reg.isAllocated('BULLET-07')).toBe(true);
    expect(reg.isRetired('BULLET-07')).toBe(true);
    // And the counter advanced so it cannot be reissued.
    expect(reg.mintBulletId()).toBe('BULLET-08');
  });

  it('a create / edit / retire sequence keeps every id allocated', () => {
    const reg = new IdRegistry();
    const ids = [reg.mintBulletId(), reg.mintBulletId(), reg.mintBulletId()];
    reg.retire(ids[1]); // "edit then retire" the middle one
    const next = reg.mintBulletId();

    expect(new Set(reg.allIds())).toEqual(new Set([...ids, next]));
    expect(reg.size).toBe(4);
  });
});

describe('ReferenceGraph — bi-directional consistency (R18.3)', () => {
  it('records links in both directions', () => {
    const graph = new ReferenceGraph();
    const skill = asSkillId('SKILL-1');
    const bullet = asBulletId('BULLET-01');
    graph.addLink(skill, bullet);

    expect(graph.accomplishmentsFor(skill)).toEqual([bullet]);
    expect(graph.skillsFor(bullet)).toEqual([skill]);
    expect(graph.hasLink(skill, bullet)).toBe(true);
  });

  it('ignores proofs that are not STAR/BULLET ids', () => {
    const graph = new ReferenceGraph();
    const skill = asSkillId('SKILL-1');
    // DocId masquerading as a proof ref must not enter the proof graph.
    graph.addLink(skill, asBulletId('cv.pdf'));
    expect(graph.proofsFor(skill)).toEqual([]);
  });

  it('separates accomplishment proofs from talking-point proofs', () => {
    const graph = new ReferenceGraph();
    const skill = asSkillId('SKILL-1');
    graph.addLink(skill, asBulletId('BULLET-02'));
    graph.addLink(skill, asStarId('STAR-04'));

    expect(graph.accomplishmentsFor(skill)).toEqual([asBulletId('BULLET-02')]);
    expect(graph.talkingPointsFor(skill)).toEqual([asStarId('STAR-04')]);
    expect(graph.proofsFor(skill)).toHaveLength(2);
  });
});

describe('buildReferenceGraph — from store records (R18.2, R18.3)', () => {
  const skill: SkillMapEntry = {
    id: asSkillId('SKILL-ci'),
    name: 'CI/CD',
    category: 'Technical',
    proficiencySignal: 'evidenced by pipeline migration',
    evidence: [
      { ref: asBulletId('BULLET-01'), when: asISODate('2024-01-01'), note: 'pipeline' },
      { ref: asDocId('cv.pdf'), when: asISODate('2023-01-01'), note: 'doc evidence' },
    ],
    recency: asISODate('2024-01-01'),
  };

  const accomplishment: Accomplishment = {
    id: asBulletId('BULLET-01'),
    text: 'Cut build time 40%',
    provenance: [interviewAnswer(asStarId('STAR-01'))],
    skills: [asSkillId('SKILL-ci')],
  };

  const talkingPoint: TalkingPoint = {
    id: asStarId('STAR-01'),
    flags: [],
    polished: 'I cut build time by 40%.',
    skills: [asSkillId('SKILL-ci')],
  };

  it('builds a consistent bi-directional graph and skips doc evidence', () => {
    const graph = buildReferenceGraph({
      skills: [skill],
      accomplishments: [accomplishment],
      talkingPoints: [talkingPoint],
    });

    // skill resolves to the accomplishments and talking points that prove it.
    expect(graph.accomplishmentsFor(skill.id)).toEqual([asBulletId('BULLET-01')]);
    expect(graph.talkingPointsFor(skill.id)).toEqual([asStarId('STAR-01')]);

    // each proof resolves back to the skill it evidences (reverse consistent).
    expect(graph.skillsFor(asBulletId('BULLET-01'))).toEqual([skill.id]);
    expect(graph.skillsFor(asStarId('STAR-01'))).toEqual([skill.id]);

    // doc evidence ref is excluded from the proof graph.
    expect(graph.proofsFor(skill.id)).not.toContain(asDocId('cv.pdf'));
  });

  it('every skill→proof link has a resolving reverse proof→skill link', () => {
    const graph = buildReferenceGraph({
      skills: [skill],
      accomplishments: [accomplishment],
      talkingPoints: [talkingPoint],
    });

    for (const [s, proof] of graph.links()) {
      expect(graph.skillsFor(proof)).toContain(s);
      expect(graph.proofsFor(s)).toContain(proof);
    }
  });
});
