// @core/no-fabrication — the No_Fabrication_Harness (R37, R40).
//
// The harness is the executable backbone of the No-Fabrication Rule (R37) and
// Correctness Property 1: it maintains a fixture library of sample profiles
// (including sparse and adversarial cases, R40.1/R40.3), extracts every factual
// claim from a generated output and resolves each against the provenance index
// (R40.2), fails any output with an unresolved claim or an invented title-implied
// skill (R37.1, R37.3, R40.2, R40.3), and versions the no-fabrication system
// prompt alongside its evaluation results so prompt changes can be regression-
// tested (R40.4). It is framework-agnostic — no storage, network, or React.
//
// Consumers import from a single stable path:
//   import { createNoFabricationHarness } from '@core/no-fabrication';

// The harness factory and its result/interface types.
export { createNoFabricationHarness } from './harness';
export type {
  NoFabricationHarness,
  HarnessEvaluation,
  EvaluatedOutput,
} from './harness';

// Claim extraction (R40.2) and the generated-output union it operates over.
export { extractClaims } from './claims';
export type {
  Claim,
  ClaimKind,
  GeneratedOutput,
  GeneratedOutputKind,
} from './claims';

// The provenance-resolving verifier (R37, R40.2, R40.3).
export { verifyOutput } from './verify';
export type { VerificationReport, VerifyOptions, ProvenanceLike } from './verify';

// The fixture library (R40.1, R40.3).
export { sampleProfiles, adversarialCases } from './fixtures';
export type { SampleProfile, AdversarialCase, ProfileKind } from './fixtures';

// The versioned no-fabrication system prompt (R40.4).
export {
  NO_FABRICATION_PROMPT_VERSION,
  NO_FABRICATION_SYSTEM_PROMPT,
  promptHash,
  currentPromptVersion,
} from './prompt-version';
export type { PromptVersionRecord } from './prompt-version';
