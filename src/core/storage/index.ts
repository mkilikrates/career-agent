// @core/storage — the canonical in-memory Memory Store model and its shared
// serialization (R34.1, R34.3, R34.4).
//
// `MemoryTree` is the single in-memory projection of the canonical Markdown
// directory layout that BOTH storage tiers build on (tasks 4.2 and 4.3), so the
// two tiers round-trip through one identical structure. Consumers import from
// this single stable path:
//
//   import { MemoryTree, CANONICAL_FILES } from '@core/storage';

export {
  MemoryTree,
  MemoryPathNotFoundError,
} from './memory-tree';
export type {
  FileContent,
  FileEncoding,
  MemoryFileSnapshot,
  MemoryTreeSnapshot,
  MemoryTreeOptions,
} from './memory-tree';

export {
  STORE_ROOT,
  CANONICAL_DIRS,
  CANONICAL_FILES,
  InvalidMemoryPathError,
  normalizePath,
  normalizeDir,
  isUnderDir,
  withRoot,
  interviewPath,
  cvPath,
} from './paths';
export type { CanonicalDir, CvFormat } from './paths';

export {
  SESSION_LOG_HEADING,
  renderEntry,
  renderSessionLog,
  parseSessionLog,
} from './session-log';
export type { SessionLogEntry, SessionLogEventType } from './session-log';
