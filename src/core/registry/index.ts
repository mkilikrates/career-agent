// @core/registry — stable-ID assignment and the bi-directional reference graph.
//
// Owns the two trust-critical invariants behind every accomplishment/talking
// point identifier (R18, R23): ids are unique, monotonic, and never reused or
// renumbered; retirement marks rather than deletes. Also builds the bi-directional
// skill ↔ accomplishment graph (R18.3) used by the skill map and output engine.
//
//   import { IdRegistry, buildReferenceGraph } from '@core/registry';

export {
  IdRegistry,
  parseId,
  kindOf,
  formatId,
} from './id-registry';
export type { IdKind } from './id-registry';

export {
  ReferenceGraph,
  buildReferenceGraph,
} from './reference-graph';
export type { ProofRef, ReferenceGraphInput } from './reference-graph';
