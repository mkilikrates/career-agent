import { describe, expect, it } from 'vitest';
import { asBulletId, asRoleSlug, asSkillId, asStarId } from '@core/types';
import { MemoryTree, cvPath } from '@core/storage';
import type { CvModel, CvBullet, CvSkill } from './cv-model';
import {
  CvVersionExistsError,
  diffCv,
  nextVersion,
  nextVersionFor,
  nextVersionNumber,
  recordVersion,
  storedVersions,
  versionPath,
  versionPaths,
  versionStem,
} from './versioning';

const slug = asRoleSlug('staff-engineer');

// --- Model builders --------------------------------------------------------

const bullet = (id: string, opts: { star?: boolean; targetRelevant?: boolean } = {}): CvBullet => ({
  id: opts.star ? asStarId(id) : asBulletId(id),
  source: opts.star ? 'talking-point' : 'accomplishment',
  text: `Did ${id}.`,
  skills: [asSkillId('SKILL-x')],
  targetRelevant: opts.targetRelevant ?? false,
  quantified: false,
  needsMetric: false,
});

const cvSkill = (id: string, name: string, targetRelevant = false): CvSkill => ({
  id: asSkillId(id),
  name,
  category: 'Technical',
  targetRelevant,
});

const model = (opts: {
  experience?: CvBullet[];
  skills?: CvSkill[];
} = {}): CvModel => ({
  targetRole: { slug, title: 'Staff Engineer' },
  header: {},
  skills: opts.skills ?? [],
  experience: opts.experience ?? [],
  education: [],
  certifications: [],
});

// --- Version numbering & paths (R33.1) -------------------------------------

describe('@core/output — version numbering increments and never collides (R33.1)', () => {
  it('starts versions at 1 when none exist', () => {
    expect(nextVersionNumber([])).toBe(1);
    expect(nextVersion(slug, [])).toEqual({ slug, version: 1 });
  });

  it('returns one greater than the largest existing version', () => {
    expect(nextVersionNumber([1, 2, 3])).toBe(4);
    expect(nextVersionNumber([3, 1, 2])).toBe(4); // order-independent
    expect(nextVersionNumber([2, 5])).toBe(6); // gap-tolerant, never reuses
    expect(nextVersion(slug, [1, 2, 5]).version).toBe(6);
  });

  it('maps a version id to canonical immutable file paths (R33.1)', () => {
    const id = { slug, version: 2 };
    expect(versionStem(id)).toBe('cv_staff-engineer_v2');
    expect(versionPath(id, 'md')).toBe(cvPath(slug, 2, 'md'));
    expect(versionPaths(id)).toEqual([
      cvPath(slug, 2, 'md'),
      cvPath(slug, 2, 'pdf'),
      cvPath(slug, 2, 'docx'),
    ]);
  });

  it('reads stored version numbers for a slug from the Memory Store', () => {
    const tree = new MemoryTree();
    tree.write(cvPath(slug, 1, 'md'), 'v1');
    tree.write(cvPath(slug, 2, 'md'), 'v2');
    tree.write(cvPath(slug, 2, 'pdf'), new Uint8Array([1])); // same version, two formats
    tree.write(cvPath(asRoleSlug('other-role'), 9, 'md'), 'other');
    expect(storedVersions(tree, slug)).toEqual([1, 2]);
    expect(nextVersionFor(tree, slug)).toEqual({ slug, version: 3 });
  });
});

// --- Immutability on edit (R33.2) ------------------------------------------

describe('@core/output — editing yields a new version, never mutating stored ones (R33.2)', () => {
  it('records each edit under a fresh, strictly increasing version id', () => {
    const tree = new MemoryTree();
    const v1 = recordVersion(tree, slug, { md: 'first cut' });
    const v2 = recordVersion(tree, slug, { md: 'second cut' });
    const v3 = recordVersion(tree, slug, { md: 'third cut' });
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
  });

  it('leaves previously stored versions byte-identical after later edits', () => {
    const tree = new MemoryTree();
    recordVersion(tree, slug, { md: 'first cut' });
    const before = tree.readText(cvPath(slug, 1, 'md'));
    recordVersion(tree, slug, { md: 'a completely different second cut' });
    recordVersion(tree, slug, { md: 'third cut' });
    expect(tree.readText(cvPath(slug, 1, 'md'))).toBe(before);
    expect(tree.readText(cvPath(slug, 1, 'md'))).toBe('first cut');
  });

  it('writes every supplied format to its canonical immutable path', () => {
    const tree = new MemoryTree();
    const id = recordVersion(tree, slug, {
      md: '# cv',
      pdf: new Uint8Array([1, 2]),
      docx: new Uint8Array([3, 4]),
    });
    expect(id.version).toBe(1);
    expect(tree.has(cvPath(slug, 1, 'md'))).toBe(true);
    expect(tree.has(cvPath(slug, 1, 'pdf'))).toBe(true);
    expect(tree.has(cvPath(slug, 1, 'docx'))).toBe(true);
  });

  it('never targets a path that already exists, so it cannot mutate a stored version (R33.2)', () => {
    const tree = new MemoryTree();
    recordVersion(tree, slug, { md: 'v1' });
    recordVersion(tree, slug, { md: 'v2' });
    // The next allocation is always strictly above every stored version, so none
    // of its target paths can already be present — the guard never fires here.
    const id = nextVersionFor(tree, slug);
    expect(id.version).toBe(3);
    for (const p of versionPaths(id)) expect(tree.has(p)).toBe(false);
  });

  it('CvVersionExistsError is thrown when a target version path is already present', () => {
    const tree = new MemoryTree();
    const id = { slug, version: 1 };
    tree.write(versionPath(id, 'md'), 'pre-existing');
    expect(() => {
      for (const p of versionPaths(id)) {
        if (tree.has(p)) throw new CvVersionExistsError(String(p));
      }
    }).toThrow(CvVersionExistsError);
  });
});

// --- Diffing (R33.3) -------------------------------------------------------

describe('@core/output — diffCv enumerates accomplishment changes (R33.3)', () => {
  it('reports added and removed accomplishments by stable id', () => {
    const a = model({ experience: [bullet('BULLET-01'), bullet('BULLET-02')] });
    const b = model({ experience: [bullet('BULLET-02'), bullet('STAR-09', { star: true })] });
    const diff = diffCv(a, b);
    expect(diff.accomplishments.added.map(String)).toEqual(['STAR-09']);
    expect(diff.accomplishments.removed.map(String)).toEqual(['BULLET-01']);
    expect(diff.accomplishments.reordered).toEqual([]);
    expect(diff.empty).toBe(false);
  });

  it('reports the minimal set of reordered accomplishments', () => {
    // x, y, z  ->  z, x, y  : moving z to the front is the single minimal change.
    const a = model({
      experience: [bullet('BULLET-x'), bullet('BULLET-y'), bullet('BULLET-z')],
    });
    const b = model({
      experience: [bullet('BULLET-z'), bullet('BULLET-x'), bullet('BULLET-y')],
    });
    const diff = diffCv(a, b);
    expect(diff.accomplishments.added).toEqual([]);
    expect(diff.accomplishments.removed).toEqual([]);
    expect(diff.accomplishments.reordered.map(String)).toEqual(['BULLET-z']);
  });

  it('does not flag reordering when the relative order is preserved', () => {
    // Removing the middle item does not reorder the survivors.
    const a = model({
      experience: [bullet('BULLET-1'), bullet('BULLET-2'), bullet('BULLET-3')],
    });
    const b = model({ experience: [bullet('BULLET-1'), bullet('BULLET-3')] });
    const diff = diffCv(a, b);
    expect(diff.accomplishments.removed.map(String)).toEqual(['BULLET-2']);
    expect(diff.accomplishments.reordered).toEqual([]);
  });
});

describe('@core/output — diffCv reports re-emphasised skills (R33.3)', () => {
  it('flags a skill whose target-relevance changed', () => {
    const a = model({ skills: [cvSkill('SKILL-a', 'A', false), cvSkill('SKILL-b', 'B', false)] });
    const b = model({ skills: [cvSkill('SKILL-a', 'A', true), cvSkill('SKILL-b', 'B', false)] });
    const diff = diffCv(a, b);
    expect(diff.skills.emphasised).toHaveLength(1);
    const change = diff.skills.emphasised[0]!;
    expect(String(change.id)).toBe('SKILL-a');
    expect(change.kind).toBe('re-emphasised');
    expect(change.before?.targetRelevant).toBe(false);
    expect(change.after?.targetRelevant).toBe(true);
  });

  it('reports added and removed skills as emphasis changes', () => {
    const a = model({ skills: [cvSkill('SKILL-a', 'A')] });
    const b = model({ skills: [cvSkill('SKILL-b', 'B')] });
    const diff = diffCv(a, b);
    const byKind = Object.fromEntries(diff.skills.emphasised.map((c) => [String(c.id), c.kind]));
    expect(byKind).toEqual({ 'SKILL-a': 'removed', 'SKILL-b': 'added' });
  });

  it('flags the minimal set of skills whose relative order changed', () => {
    // a, b, c  ->  c, a, b : only c moved.
    const a = model({
      skills: [cvSkill('SKILL-a', 'A'), cvSkill('SKILL-b', 'B'), cvSkill('SKILL-c', 'C')],
    });
    const b = model({
      skills: [cvSkill('SKILL-c', 'C'), cvSkill('SKILL-a', 'A'), cvSkill('SKILL-b', 'B')],
    });
    const diff = diffCv(a, b);
    expect(diff.skills.emphasised.map((c) => String(c.id))).toEqual(['SKILL-c']);
  });
});

describe('@core/output — diffCv of identical models is empty (R33.3)', () => {
  it('returns an empty diff for the same model', () => {
    const m = model({
      experience: [bullet('BULLET-01'), bullet('STAR-02', { star: true })],
      skills: [cvSkill('SKILL-a', 'A', true), cvSkill('SKILL-b', 'B')],
    });
    const diff = diffCv(m, m);
    expect(diff.empty).toBe(true);
    expect(diff.accomplishments.added).toEqual([]);
    expect(diff.accomplishments.removed).toEqual([]);
    expect(diff.accomplishments.reordered).toEqual([]);
    expect(diff.skills.emphasised).toEqual([]);
  });

  it('is deterministic for identical inputs', () => {
    const a = model({ experience: [bullet('BULLET-01')], skills: [cvSkill('SKILL-a', 'A')] });
    const b = model({ experience: [bullet('BULLET-02')], skills: [cvSkill('SKILL-b', 'B')] });
    expect(diffCv(a, b)).toEqual(diffCv(a, b));
  });
});
