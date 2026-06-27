// The No_Fabrication_Harness (R37, R40).
//
// This module assembles the pieces — the fixture library (`fixtures.ts`), the
// claim extractor (`claims.ts`), the provenance-resolving verifier (`verify.ts`),
// and the versioned system prompt (`prompt-version.ts`) — into the single
// {@link NoFabricationHarness} the design specifies:
//
//   interface NoFabricationHarness {
//     fixtures(): SampleProfile[];                 // R40.1 sparse + adversarial
//     verifyOutput(output, store/index): VerificationReport; // R40.2
//     adversarialCases(): AdversarialCase[];       // R40.3
//     promptVersion(): PromptVersionRecord;        // R40.4
//   }
//
// It is the executable backbone of Correctness Property 1 and the dedicated CI
// suite (task 18.3): {@link NoFabricationHarness.evaluate} runs the verifier over
// every output of every fixture, fails if any output contains an unresolved
// claim or an invented title-implied skill, and binds the results to the current
// prompt version so prompt changes can be regression-tested (R40.4).
//
// Framework-agnostic throughout: no storage, network, or React.

import { verifyOutput, type ProvenanceLike, type VerificationReport, type VerifyOptions } from './verify';
import type { GeneratedOutput } from './claims';
import {
  adversarialCases as buildAdversarialCases,
  sampleProfiles,
  type AdversarialCase,
  type SampleProfile,
} from './fixtures';
import { currentPromptVersion, type PromptVersionRecord } from './prompt-version';

/** A fixture output paired with the report the harness produced for it. */
export interface EvaluatedOutput {
  /** The fixture the output belongs to. */
  readonly profileId: string;
  /** Index of the output within the profile's `outputs` list. */
  readonly outputIndex: number;
  /** The kind of generated output that was verified. */
  readonly outputKind: GeneratedOutput['kind'];
  /** The verification report (R40.2). */
  readonly report: VerificationReport;
}

/** The outcome of running the whole fixture library (task 18.3 / CI). */
export interface HarnessEvaluation {
  /** True when every fixture output passed (no unresolved/invented claims). */
  readonly passed: boolean;
  /** Per-output verification reports. */
  readonly outputs: readonly EvaluatedOutput[];
  /** The prompt version these results are bound to (R40.4). */
  readonly promptVersion: PromptVersionRecord;
}

/**
 * The No_Fabrication_Harness (design §No_Fabrication_Harness). Maintains the
 * fixture library (R40.1), verifies any generated output against a provenance
 * index (R40.2), exposes the adversarial inference-tempting cases (R40.3), and
 * versions the no-fabrication system prompt alongside its evaluation results
 * (R40.4).
 */
export interface NoFabricationHarness {
  /** The full fixture library, including sparse and adversarial cases (R40.1). */
  fixtures(): SampleProfile[];
  /**
   * Verify a generated output against a provenance index/sources, failing any
   * unresolved claim or invented (title-implied) skill (R40.2, R40.3).
   */
  verifyOutput(
    output: GeneratedOutput,
    source: ProvenanceLike,
    options?: VerifyOptions,
  ): VerificationReport;
  /** The adversarial cases that tempt skill inference (R40.3). */
  adversarialCases(): AdversarialCase[];
  /** The current no-fabrication prompt version record (R40.4). */
  promptVersion(): PromptVersionRecord;
  /**
   * Run the verifier over the whole fixture library (R40.2, R40.3) and bind the
   * results to the current prompt version (R40.4). This is the executable
   * backbone of Property 1 and the dedicated CI suite (task 18.3).
   */
  evaluate(): HarnessEvaluation;
}

/**
 * Create a {@link NoFabricationHarness}. Pure construction — the harness holds no
 * mutable state; each call rebuilds the fixtures so callers cannot accidentally
 * share/mutate provenance indices between runs.
 */
export const createNoFabricationHarness = (): NoFabricationHarness => {
  const harness: NoFabricationHarness = {
    fixtures: () => sampleProfiles(),
    adversarialCases: () => buildAdversarialCases(),
    verifyOutput: (output, source, options) => verifyOutput(output, source, options),
    promptVersion: () => currentPromptVersion(),
    evaluate: () => {
      const profiles = sampleProfiles();
      const outputs: EvaluatedOutput[] = [];

      for (const profile of profiles) {
        // Adversarial profiles also assert no title-implied skill is invented (R37.3).
        const options: VerifyOptions =
          profile.kind === 'adversarial'
            ? { titleImpliedSkills: (profile as AdversarialCase).titleImpliedSkills }
            : {};

        profile.outputs.forEach((output, outputIndex) => {
          outputs.push({
            profileId: profile.id,
            outputIndex,
            outputKind: output.kind,
            report: verifyOutput(output, profile.index, options),
          });
        });
      }

      const reports = outputs.map((o) => o.report);
      return {
        passed: reports.every((r) => r.passed),
        outputs,
        // R40.4 — bind the eval results to the prompt version that produced them.
        promptVersion: currentPromptVersion(reports),
      };
    },
  };

  return harness;
};
