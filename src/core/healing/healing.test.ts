import { describe, expect, it } from 'vitest';
import {
  asBulletId,
  asDocId,
  asISODate,
  asMemoryPath,
  asSkillId,
  asStarId,
  type SkillMapEntry,
} from '@core/types';
import { anchorComment } from '@core/markdown';
import { collectDeclarations, heal, healStore, type StoreFile } from './index';

const skillWith = (refs: string[]): SkillMapEntry => ({
  id: asSkillId('SKILL-1'),
  name: 'CI/CD',
  category: 'Technical',
  proficiencySignal: 'evidenced',
  evidence: refs.map((ref) => ({
    ref: ref.startsWith('STAR')
      ? asStarId(ref)
      : ref.startsWith('BULLET')
        ? asBulletId(ref)
        : asDocId(ref),
    when: asISODate('2024-01-01'),
    note: 'note',
  })),
  recency: asISODate('2024-01-01'),
});

describe('@core/healing — clean store (R36.1)', () => {
  it('yields an ok, empty report when every reference resolves and no duplicates exist', () => {
    const report = healStore({
      declarations: [
        { id: 'STAR-01', location: asMemoryPath('interviews/i.md') },
        { id: 'BULLET-01', location: asMemoryPath('profile/accomplishments.md') },
      ],
      skills: [skillWith(['STAR-01', 'BULLET-01'])],
    });

    expect(report.ok).toBe(true);
    expect(report.brokenReferences).toEqual([]);
    expect(report.duplicateIds).toEqual([]);
  });

  it('returns an ok report for a completely empty store', () => {
    const report = healStore({ declarations: [], skills: [] });
    expect(report).toEqual({ brokenReferences: [], duplicateIds: [], ok: true });
  });

  it('treats doc-backed evidence refs as out of scope (not broken references)', () => {
    const report = healStore({
      declarations: [{ id: 'STAR-01', location: asMemoryPath('interviews/i.md') }],
      skills: [skillWith(['STAR-01', 'cv.pdf'])],
    });
    expect(report.ok).toBe(true);
    expect(report.brokenReferences).toEqual([]);
  });
});

describe('@core/healing — broken references (R36.2)', () => {
  it('flags exactly the skill evidence refs that are not declared anywhere', () => {
    const report = healStore({
      declarations: [{ id: 'STAR-01', location: asMemoryPath('interviews/i.md') }],
      skills: [skillWith(['STAR-01', 'BULLET-99'])], // BULLET-99 missing
    });

    expect(report.ok).toBe(false);
    expect(report.brokenReferences).toEqual([
      { entry: asSkillId('SKILL-1'), missing: asBulletId('BULLET-99') },
    ]);
  });

  it('does not throw on a broken store and still returns a report', () => {
    expect(() =>
      healStore({
        declarations: [],
        skills: [skillWith(['STAR-77'])],
      }),
    ).not.toThrow();

    const report = healStore({ declarations: [], skills: [skillWith(['STAR-77'])] });
    expect(report.ok).toBe(false);
    expect(report.brokenReferences).toEqual([
      { entry: asSkillId('SKILL-1'), missing: asStarId('STAR-77') },
    ]);
  });

  it('reports a missing ref once even when referenced multiple times', () => {
    const report = healStore({
      declarations: [],
      skills: [skillWith(['BULLET-50', 'BULLET-50'])],
    });
    expect(report.brokenReferences).toHaveLength(1);
  });
});

describe('@core/healing — duplicate identifiers (R36.3)', () => {
  it('detects ids declared more than once and lists every location', () => {
    const report = healStore({
      declarations: [
        { id: 'STAR-01', location: asMemoryPath('interviews/a.md') },
        { id: 'STAR-01', location: asMemoryPath('interviews/b.md') },
        { id: 'BULLET-01', location: asMemoryPath('profile/acc.md') },
      ],
      skills: [],
    });

    expect(report.ok).toBe(false);
    expect(report.duplicateIds).toEqual([
      {
        id: asStarId('STAR-01'),
        locations: [asMemoryPath('interviews/a.md'), asMemoryPath('interviews/b.md')],
      },
    ]);
  });

  it('detects both broken references and duplicates together', () => {
    const report = healStore({
      declarations: [
        { id: 'STAR-01', location: asMemoryPath('a.md') },
        { id: 'STAR-01', location: asMemoryPath('b.md') },
      ],
      skills: [skillWith(['BULLET-42'])],
    });
    expect(report.ok).toBe(false);
    expect(report.duplicateIds).toHaveLength(1);
    expect(report.brokenReferences).toHaveLength(1);
  });
});

describe('@core/healing — collectDeclarations + heal over raw Markdown files', () => {
  const fileA: StoreFile = {
    path: asMemoryPath('interviews/interview_x.md'),
    markdown: `---\nids:\n  - STAR-01\n---\n## Q\n${anchorComment('STAR-01')}\nanswer\n`,
  };
  const fileB: StoreFile = {
    path: asMemoryPath('profile/accomplishments.md'),
    markdown: `## Bullet\n${anchorComment('BULLET-01')}\ntext\n`,
  };

  it('collects anchor declarations (not frontmatter mirrors) with their file path', () => {
    const decls = collectDeclarations([fileA, fileB]);
    expect(decls).toEqual([
      { id: 'STAR-01', location: asMemoryPath('interviews/interview_x.md') },
      { id: 'BULLET-01', location: asMemoryPath('profile/accomplishments.md') },
    ]);
  });

  it('heals a real file set, resolving present refs', () => {
    const report = heal([fileA, fileB], [skillWith(['STAR-01', 'BULLET-01'])]);
    expect(report.ok).toBe(true);
  });

  it('detects a duplicate anchor across two files', () => {
    const dupFile: StoreFile = {
      path: asMemoryPath('interviews/dup.md'),
      markdown: `## Q\n${anchorComment('STAR-01')}\n`,
    };
    const report = heal([fileA, dupFile], []);
    expect(report.duplicateIds).toHaveLength(1);
    expect(report.duplicateIds[0].id).toBe(asStarId('STAR-01'));
  });
});
