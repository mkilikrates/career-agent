import { describe, expect, it } from 'vitest';
import { asMemoryPath, asRoleSlug } from '@core/types';
import {
  CANONICAL_FILES,
  InvalidMemoryPathError,
  MemoryPathNotFoundError,
  MemoryTree,
  cvPath,
  interviewPath,
  normalizeDir,
  normalizePath,
  parseSessionLog,
  renderSessionLog,
} from './index';

describe('@core/storage — canonical path normalization (R34.1)', () => {
  it('strips an optional store-root prefix and slash style', () => {
    expect(normalizePath('career_agent/profile/skill_map.md')).toBe('profile/skill_map.md');
    expect(normalizePath('/career_agent/profile/skill_map.md')).toBe('profile/skill_map.md');
    expect(normalizePath('profile\\skill_map.md')).toBe('profile/skill_map.md');
  });

  it('rejects paths outside the canonical directories', () => {
    expect(() => normalizePath('random/x.md')).toThrow(InvalidMemoryPathError);
    expect(() => normalizePath('profile')).toThrow(InvalidMemoryPathError);
    expect(() => normalizePath('')).toThrow(InvalidMemoryPathError);
  });

  it('rejects path traversal', () => {
    expect(() => normalizePath('profile/../config/locale.md')).toThrow(InvalidMemoryPathError);
  });

  it('normalises directory references', () => {
    expect(normalizeDir('career_agent/profile')).toBe('profile');
    expect(normalizeDir('/profile/')).toBe('profile');
    expect(normalizeDir('')).toBe('');
  });

  it('builds parameterised canonical paths', () => {
    const slug = asRoleSlug('staff-sre');
    expect(interviewPath(slug)).toBe('interviews/interview_staff-sre.md');
    expect(cvPath(slug, 2, 'pdf')).toBe('outputs/cv_staff-sre_v2.pdf');
  });
});

describe('MemoryTree — read/write/list/delete (R34.1)', () => {
  it('writes then reads text content back', () => {
    const tree = new MemoryTree();
    tree.write(CANONICAL_FILES.skillMap, '# Skills');
    expect(tree.readText(CANONICAL_FILES.skillMap)).toBe('# Skills');
    expect(tree.has(CANONICAL_FILES.skillMap)).toBe(true);
  });

  it('round-trips binary content without aliasing the caller buffer', () => {
    const tree = new MemoryTree();
    const bytes = new Uint8Array([0, 1, 2, 255]);
    tree.write(cvPath(asRoleSlug('sre'), 1, 'pdf'), bytes);
    bytes[0] = 99; // mutate caller copy after write
    const stored = tree.read(cvPath(asRoleSlug('sre'), 1, 'pdf'));
    expect(stored).toEqual(new Uint8Array([0, 1, 2, 255]));
  });

  it('throws a typed error when reading a missing path', () => {
    const tree = new MemoryTree();
    expect(() => tree.read('profile/skill_map.md')).toThrow(MemoryPathNotFoundError);
  });

  it('throws when reading binary content as text', () => {
    const tree = new MemoryTree();
    tree.write('outputs/cv_x_v1.pdf', new Uint8Array([1, 2, 3]));
    expect(() => tree.readText('outputs/cv_x_v1.pdf')).toThrow(TypeError);
  });

  it('lists by directory and overall, in sorted order', () => {
    const tree = new MemoryTree();
    tree.write('profile/skill_map.md', 'a');
    tree.write('profile/accomplishments.md', 'b');
    tree.write('config/locale.md', 'c');

    expect(tree.list('profile')).toEqual([
      'profile/accomplishments.md',
      'profile/skill_map.md',
    ]);
    expect(tree.list()).toEqual([
      'config/locale.md',
      'profile/accomplishments.md',
      'profile/skill_map.md',
    ]);
    expect(tree.size).toBe(3);
  });

  it('deletes a single path', () => {
    const tree = new MemoryTree();
    tree.write('config/locale.md', 'x');
    expect(tree.delete('config/locale.md')).toBe(true);
    expect(tree.delete('config/locale.md')).toBe(false);
    expect(tree.has('config/locale.md')).toBe(false);
  });
});

describe('MemoryTree — session log (R34.3)', () => {
  const fixedClock = () => {
    let tick = 0;
    return () => `2024-05-01T00:00:0${tick++}.000Z`;
  };

  it('records actions, confirmations, and conflict resolutions in session_log.md', () => {
    const tree = new MemoryTree({ now: fixedClock() });
    tree.logAction('Extracted 3 items from cv.pdf');
    tree.logConfirmation('User confirmed the skill map');
    tree.logConflictResolution('Kept newer end date for Acme role');

    const entries = tree.sessionLog();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.type)).toEqual([
      'action',
      'confirmation',
      'conflict-resolution',
    ]);
    expect(entries[0].message).toBe('Extracted 3 items from cv.pdf');

    // Stored as human-readable Markdown at the canonical log path.
    const raw = tree.readText(CANONICAL_FILES.sessionLog);
    expect(raw.startsWith('# Session Log')).toBe(true);
    expect(raw).toContain('**conflict-resolution**: Kept newer end date for Acme role');
  });

  it('collapses multi-line messages to keep the line-based log intact', () => {
    const tree = new MemoryTree({ now: fixedClock() });
    tree.logAction('line one\nline two');
    expect(tree.sessionLog()[0].message).toBe('line one line two');
  });

  it('round-trips the session log through render/parse', () => {
    const tree = new MemoryTree({ now: fixedClock() });
    tree.logAction('a').logConfirmation('b');
    const entries = tree.sessionLog();
    expect(parseSessionLog(renderSessionLog(entries))).toEqual(entries);
  });

  it('returns an empty log when none has been written', () => {
    expect(new MemoryTree().sessionLog()).toEqual([]);
  });
});

describe('MemoryTree — snapshot serialization and deleteAll (R34.4)', () => {
  it('round-trips a mixed text/binary store through a snapshot', () => {
    const tree = new MemoryTree({ now: () => '2024-05-01T00:00:00.000Z' });
    tree.write('profile/skill_map.md', '# Skills\n');
    tree.write('outputs/cv_sre_v1.pdf', new Uint8Array([10, 20, 30, 200]));
    tree.logAction('did a thing');

    const rebuilt = MemoryTree.fromSnapshot(tree.snapshot());

    expect(rebuilt.paths()).toEqual(tree.paths());
    expect(rebuilt.readText('profile/skill_map.md')).toBe('# Skills\n');
    expect(rebuilt.read('outputs/cv_sre_v1.pdf')).toEqual(new Uint8Array([10, 20, 30, 200]));
    expect(rebuilt.sessionLog()).toEqual(tree.sessionLog());
  });

  it('snapshot tags encodings correctly', () => {
    const tree = new MemoryTree();
    tree.write('profile/skill_map.md', 'text');
    tree.write('outputs/cv_x_v1.pdf', new Uint8Array([1]));
    const snap = tree.snapshot();
    expect(snap.root).toBe('career_agent');
    const byPath = Object.fromEntries(snap.files.map((f) => [f.path, f.encoding]));
    expect(byPath['profile/skill_map.md']).toBe('utf-8');
    expect(byPath['outputs/cv_x_v1.pdf']).toBe('base64');
  });

  it('loadSnapshot replaces existing contents', () => {
    const tree = new MemoryTree();
    tree.write('config/locale.md', 'old');
    tree.loadSnapshot({
      root: 'career_agent',
      files: [{ path: asMemoryPath('profile/skill_map.md'), encoding: 'utf-8', content: 'new' }],
    });
    expect(tree.has('config/locale.md')).toBe(false);
    expect(tree.readText('profile/skill_map.md')).toBe('new');
  });

  it('deleteAll empties the entire store', () => {
    const tree = new MemoryTree();
    tree.write('profile/skill_map.md', 'x');
    tree.logAction('y');
    expect(tree.size).toBeGreaterThan(0);
    tree.deleteAll();
    expect(tree.size).toBe(0);
    expect(tree.paths()).toEqual([]);
    expect(tree.sessionLog()).toEqual([]);
  });
});
