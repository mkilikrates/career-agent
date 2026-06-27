// Canonical Memory Store path model (R34.1).
//
// The Memory Store is organised into a fixed, human-readable directory layout
// rooted at `career_agent/` (design §Data Models):
//
//   career_agent/
//     profile/      skill_map.md, role_preferences.md, raw_extractions.md, raw_documents.md, accomplishments.md
//     interviews/   interview_[role_slug].md
//     outputs/      cv_[role_slug]_v[n].md/.pdf/.docx, linkedin_recommendations.md
//     config/       locale.md, confusables.yaml, taxonomy.yaml
//     log/          session_log.md
//
// This module is the single source of truth for that layout: it normalises raw
// path strings into a canonical, root-relative form, validates that every path
// lives under one of the canonical directories, and provides builders for the
// well-known files so callers never hand-assemble path strings.

import type { MemoryPath, RoleSlug } from '@core/types';
import { asMemoryPath } from '@core/types';

/** The folder name the canonical tree is rooted at. */
export const STORE_ROOT = 'career_agent';

/** The five canonical top-level directories (R34.1). */
export const CANONICAL_DIRS = ['profile', 'interviews', 'outputs', 'config', 'log'] as const;

/** One of the canonical top-level directories. */
export type CanonicalDir = (typeof CANONICAL_DIRS)[number];

const CANONICAL_DIR_SET: ReadonlySet<string> = new Set(CANONICAL_DIRS);

/** Thrown when a path escapes or does not belong to the canonical layout. */
export class InvalidMemoryPathError extends Error {
  constructor(path: string, reason: string) {
    super(`Invalid Memory Store path "${path}": ${reason}`);
    this.name = 'InvalidMemoryPathError';
  }
}

/** Split a raw path into clean, non-empty segments. */
const segmentsOf = (raw: string): string[] =>
  raw
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * Normalise a raw path into the canonical, root-relative spelling used as the
 * key inside the {@link MemoryTree} (e.g. `profile/skill_map.md`).
 *
 * Accepts paths with or without a leading `/career_agent/` prefix and with
 * either slash style. Rejects traversal (`.`/`..`) segments and any path whose
 * top-level directory is not one of the canonical directories (R34.1).
 */
export const normalizePath = (raw: string): MemoryPath => {
  const segments = segmentsOf(raw);
  if (segments.length === 0) {
    throw new InvalidMemoryPathError(raw, 'path is empty');
  }
  // Drop an optional leading store-root segment so callers may pass either
  // `career_agent/profile/x.md` or `profile/x.md`.
  if (segments[0] === STORE_ROOT) {
    segments.shift();
  }
  if (segments.some((s) => s === '.' || s === '..')) {
    throw new InvalidMemoryPathError(raw, 'path traversal segments are not allowed');
  }
  if (segments.length < 2) {
    throw new InvalidMemoryPathError(
      raw,
      'a file must live inside a canonical directory (e.g. "profile/skill_map.md")',
    );
  }
  const [dir] = segments;
  if (!CANONICAL_DIR_SET.has(dir)) {
    throw new InvalidMemoryPathError(
      raw,
      `top-level directory "${dir}" is not one of ${CANONICAL_DIRS.join(', ')}`,
    );
  }
  return asMemoryPath(segments.join('/'));
};

/** Normalise a directory reference to its canonical, root-relative prefix. */
export const normalizeDir = (raw: string): string => {
  const segments = segmentsOf(raw);
  if (segments[0] === STORE_ROOT) {
    segments.shift();
  }
  if (segments.some((s) => s === '.' || s === '..')) {
    throw new InvalidMemoryPathError(raw, 'path traversal segments are not allowed');
  }
  return segments.join('/');
};

/** True when `path` (already normalised) sits within the directory `dir`. */
export const isUnderDir = (path: MemoryPath, dir: string): boolean => {
  if (dir.length === 0) return true; // root → everything
  return path === dir || path.startsWith(`${dir}/`);
};

/** The full path including the store root (e.g. `career_agent/profile/x.md`). */
export const withRoot = (path: MemoryPath): MemoryPath =>
  asMemoryPath(`${STORE_ROOT}/${path}`);

// --- Well-known canonical files ------------------------------------------
// Builders for every fixed file in the layout so callers never hand-assemble
// path strings (and so a layout change is made in exactly one place).

/** Canonical paths for the fixed files in the layout. */
export const CANONICAL_FILES = {
  skillMap: asMemoryPath('profile/skill_map.md'),
  rolePreferences: asMemoryPath('profile/role_preferences.md'),
  rawExtractions: asMemoryPath('profile/raw_extractions.md'),
  rawDocuments: asMemoryPath('profile/raw_documents.md'),
  accomplishments: asMemoryPath('profile/accomplishments.md'),
  locale: asMemoryPath('config/locale.md'),
  consent: asMemoryPath('config/consent.md'),
  assistPreference: asMemoryPath('config/assist_preference.md'),
  confusables: asMemoryPath('config/confusables.yaml'),
  taxonomy: asMemoryPath('config/taxonomy.yaml'),
  sessionLog: asMemoryPath('log/session_log.md'),
  linkedinRecommendations: asMemoryPath('outputs/linkedin_recommendations.md'),
} as const;

/** Path to the per-role interview file (R22, R25, R28). */
export const interviewPath = (roleSlug: RoleSlug): MemoryPath =>
  asMemoryPath(`interviews/interview_${roleSlug}.md`);

/** A CV output format extension. */
export type CvFormat = 'md' | 'pdf' | 'docx';

/** Path to an immutable CV version output (R30, R32, R33). */
export const cvPath = (roleSlug: RoleSlug, version: number, format: CvFormat): MemoryPath =>
  asMemoryPath(`outputs/cv_${roleSlug}_v${version}.${format}`);
