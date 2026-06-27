// @core/provenance — Provenance / Citation Service (R38).
//
// Two responsibilities, mirroring the design's "Provenance / Citation Service":
//   1. Attach a provenance record (source line, user confirmation, or interview
//      answer) to every fact at creation time (R38.1) — see provenance-record.
//   2. Build a provenance index that resolves any claim ref to its source trace
//      and expose a trace lookup for the UI inspector (R38.1, R38.2) — see
//      provenance-index.
//
// Consumers import from a single stable path:
//   import { ProvenanceIndex, sourceLine } from '@core/provenance';

export {
  sourceLine,
  userConfirmation,
  interviewAnswer,
  trailOf,
  isProvenanceTrail,
} from './provenance-record';

export {
  ProvenanceIndex,
  buildProvenanceIndex,
} from './provenance-index';

export type {
  ClaimRef,
  SourceTrace,
  ProvenanceFact,
  ProvenanceSources,
} from './provenance-index';
