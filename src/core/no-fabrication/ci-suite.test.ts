// Dedicated No-Fabrication CI gate (task 18.3, R40.2/R40.3/R40.4).
//
// This suite is the build-failing gate the maintainer story (R40) asks for: it
// runs the No_Fabrication_Harness over the WHOLE fixture library and fails the
// build if any generated output contains an unresolved claim or an invented /
// title-implied skill, and it asserts that the eval results are recorded
// together with the prompt version that produced them. It is deliberately kept
// in its own file with its own npm entry point (`npm run test:no-fabrication`,
// which runs `vitest run src/core/no-fabrication`) so it can be invoked as a
// standalone CI gate independently of the broader unit/property suites.
//
// To guarantee the gate is not vacuously green (a build that passes because it
// asserts nothing meaningful), the last test feeds a deliberately-invented claim
// through the very same verifier the gate relies on and proves the gate logic
// rejects it. If that guard ever stops failing, the gate itself is broken.

import { describe, expect, it } from 'vitest';
import {
  asISODate,
  asSkillId,
  type SkillMapEntry,
} from '@core/types';
import { ProvenanceIndex } from '@core/provenance';
import {
  createNoFabricationHarness,
  verifyOutput,
  adversarialCases,
  NO_FABRICATION_PROMPT_VERSION,
  promptHash,
  NO_FABRICATION_SYSTEM_PROMPT,
  type GeneratedOutput,
} from './index';

const harness = createNoFabricationHarness();

/** A minimal skill-map-entry output for the given skill id/name. */
const skillEntryOutput = (id: string, name: string): GeneratedOutput => {
  const entry: SkillMapEntry = {
    id: asSkillId(id),
    name,
    category: 'Technical',
    proficiencySignal: 'demonstrated',
    evidence: [],
    recency: asISODate('2024-05-01'),
  };
  return { kind: 'skill-map-entry', entry };
};

describe('@core/no-fabrication — CI gate: fixture library is fabrication-free (R40.2, R40.3)', () => {
  const evaluation = harness.evaluate();

  it('runs over a non-empty fixture library so the gate is not vacuous (R40.1)', () => {
    // A gate that evaluated zero outputs would pass trivially; require coverage.
    expect(evaluation.outputs.length).toBeGreaterThan(0);
    expect(harness.fixtures().length).toBeGreaterThan(0);
  });

  it('FAILS THE BUILD on any unresolved claim or invented skill (R40.2, R40.3)', () => {
    // The single load-bearing assertion of the CI gate: the whole library passes.
    expect(evaluation.passed).toBe(true);
  });

  it('every fixture output has zero unresolved claims (R40.2)', () => {
    for (const output of evaluation.outputs) {
      const where = `${output.profileId} / ${output.outputKind} #${output.outputIndex}`;
      expect(output.report.unresolved, `unresolved in ${where}`).toHaveLength(0);
    }
  });

  it('every fixture output invents zero skills and zero title-implied skills (R40.3)', () => {
    for (const output of evaluation.outputs) {
      const where = `${output.profileId} / ${output.outputKind} #${output.outputIndex}`;
      expect(output.report.inventedSkills, `invented skills in ${where}`).toHaveLength(0);
      expect(
        output.report.titleImpliedSkills,
        `title-implied skills in ${where}`,
      ).toHaveLength(0);
    }
  });
});

describe('@core/no-fabrication — CI gate: eval results recorded with prompt version (R40.4)', () => {
  const evaluation = harness.evaluate();

  it('binds the eval results to the current, hashed prompt version (R40.4)', () => {
    expect(evaluation.promptVersion.version).toBe(NO_FABRICATION_PROMPT_VERSION);
    expect(evaluation.promptVersion.prompt).toBe(NO_FABRICATION_SYSTEM_PROMPT);
    // The recorded hash matches the live prompt: a stale binding would diverge.
    expect(evaluation.promptVersion.hash).toBe(promptHash(NO_FABRICATION_SYSTEM_PROMPT));
  });

  it('records one result per evaluated output, all passing (R40.4)', () => {
    const results = evaluation.promptVersion.results;
    expect(results).toBeDefined();
    expect(results).toHaveLength(evaluation.outputs.length);
    expect(results?.every((r) => r.passed)).toBe(true);
  });
});

describe('@core/no-fabrication — CI gate: guard against a vacuously-green gate', () => {
  it('the gate logic FAILS a deliberately-invented claim (negative control, R40.2)', () => {
    // Feed an unsourced skill through the exact verifier the gate relies on.
    // If this passed, the gate could be green while fabrications slip through.
    const emptyIndex = new ProvenanceIndex();
    const report = verifyOutput(skillEntryOutput('SKILL-fabricated', 'Telepathy'), emptyIndex);

    expect(report.passed).toBe(false);
    expect(report.unresolved.length).toBeGreaterThan(0);
    expect(report.inventedSkills.length).toBeGreaterThan(0);
  });

  it('the gate logic catches a title-implied skill the adversarial case tempts (R40.3)', () => {
    // A naive generator inferring Kubernetes from a "DevOps Engineer" title must
    // be rejected by the same verifier the gate uses — proving the gate's
    // adversarial coverage is real, not asserted.
    const devops = adversarialCases()[0]!;
    const report = verifyOutput(
      skillEntryOutput('SKILL-kubernetes', 'Kubernetes'),
      devops.index,
      { titleImpliedSkills: devops.titleImpliedSkills },
    );

    expect(report.passed).toBe(false);
    expect(report.titleImpliedSkills.map((c) => c.text)).toContain('Kubernetes');
  });
});
