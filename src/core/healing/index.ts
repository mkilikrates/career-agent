// @core/healing — resume-time state-healing pass (R36).
//
// Verifies referential integrity of the Memory Store on resume: flags broken
// skill-evidence references and duplicate identifiers, never throwing, and
// always emits a `HealingReport` (R36.1–R36.3). A structurally clean store
// yields an ok report.
//
//   import { heal, healStore, collectDeclarations } from '@core/healing';

export {
  heal,
  healStore,
  collectDeclarations,
} from './heal';

export type {
  IdDeclaration,
  StoreFile,
  MemoryStoreSnapshot,
} from './heal';
