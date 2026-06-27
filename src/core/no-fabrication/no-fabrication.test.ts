// Unit tests for the No_Fabrication_Harness (R37, R40).
//
// These cover the harness's executable guarantees with concrete examples:
//   - a clean output (every claim sourced/confirmed) PASSES (R40.2);
//   - an output with an unresolved/invented claim FAILS (R40.2);
//   - a title-implied skill is rejected, not silently accepted (R37.3, R40.3);
//   - the sparse and adversarial fixtures are present and verify clean (R40.1/3);
//   - the no-fabrication prompt is versioned with its eval results (R40.4).
// (Property 1's universally-quantified property test is the separate task 18.2.)

import { describe, expect, it } from 'vitest';
import {
  asBulletId,
  asISODate,
  asItemId,
  asSkillId,
  asStarId,
  asRoleSlug,
  asDocId,
  type SkillMapEntry,
  type TalkingPoint,
} from '@core/types';
import {
  ProvenanceIndex,
  sourceLine,
  userConfirmation,
} from '@core/provenance';
import type { CvModel } from '@core/output';
import { ADVISORY_NOTICE } from '@core/output';
import {
  createNoFabricationHarness,
  extractClaims,
  verifyOutput,
  sampleProfiles,
  adversarialCases,
  currentPromptVersion,
  promptHash,
  NO_FABRICATION_SYSTEM_PROMPT,
  NO_FABRICATION_PROMPT_VERSION,
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

/** A minimal talking-point output. */
const talkingPointOutput = (id: string, polished: string, skills: string[]): GeneratedOutput => {
  const point: TalkingPoint = {
    id: asStarId(id),
    polished,
    flags: [],
    skills: skills.map(asSkillId),
  };
  return { kind: 'talking-point', point };
};

describe('@core/no-fabrication — claim extraction (R40.2)', () => {
  it('extracts a claim per skill, bullet, education, and certification of a CV', () => {
    const model: CvModel = {
      targetRole: { slug: asRoleSlug('engineer'), title: 'Engineer' },
      header: {},
      skills: [{ id: asSkillId('SKILL-go'), name: 'Go', category: 'Technical', targetRelevant: true }],
      experience: [
        {
          id: asBulletId('BULLET-01'),
          source: 'accomplishment',
          text: 'Shipped the API',
          skills: [asSkillId('SKILL-go')],
          targetRelevant: true,
          quantified: false,
          needsMetric: false,
        },
      ],
      education: [{ id: asItemId('ITEM-edu'), title: 'BSc' }],
      certifications: [{ id: asItemId('ITEM-cert'), title: 'AWS SA' }],
    };

    const claims = extractClaims({ kind: 'cv', model });
    expect(claims.map((c) => c.kind)).toEqual([
      'skill',
      'accomplishment',
      'education',
      'certification',
    ]);
    expect(claims.map((c) => c.ref as unknown as string)).toEqual([
      'SKILL-go',
      'BULLET-01',
      'ITEM-edu',
      'ITEM-cert',
    ]);
  });

  it('classifies a LinkedIn experience bullet by its id prefix', () => {
    const output: GeneratedOutput = {
      kind: 'linkedin',
      report: {
        advisory: true,
        notice: ADVISORY_NOTICE,
        headline: '',
        about: '',
        experienceBullets: [
          { id: asBulletId('BULLET-02'), text: 'a', needsMetric: false },
          { id: asStarId('STAR-02'), text: 'b', needsMetric: false },
        ],
        positions: [],
        recommendedSkills: [],
      },
    };
    const kinds = extractClaims(output).map((c) => c.kind);
    expect(kinds).toEqual(['accomplishment', 'talking-point']);
  });
});

describe('@core/no-fabrication — verifyOutput (R37, R40.2, R40.3)', () => {
  it('passes a clean output: every claim resolves to provenance (R40.2)', () => {
    const index = new ProvenanceIndex().attach(
      asSkillId('SKILL-go'),
      sourceLine(asDocId('cv.pdf'), 3, 'Go, 4 years'),
    );
    const report = verifyOutput(skillEntryOutput('SKILL-go', 'Go'), index);

    expect(report.passed).toBe(true);
    expect(report.unresolved).toHaveLength(0);
    expect(report.resolved).toHaveLength(1);
    expect(report.inventedSkills).toHaveLength(0);
  });

  it('fails an output with an unresolved claim (R40.2)', () => {
    const emptyIndex = new ProvenanceIndex();
    const report = verifyOutput(skillEntryOutput('SKILL-rust', 'Rust'), emptyIndex);

    expect(report.passed).toBe(false);
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0]?.ref as unknown as string).toBe('SKILL-rust');
    expect(report.inventedSkills).toHaveLength(1);
  });

  it('fails when a talking point references an invented skill (R37.1)', () => {
    // The talking point itself is confirmed, but one of its skills is not.
    const index = new ProvenanceIndex()
      .attach(asStarId('STAR-05'), userConfirmation(asISODate('2024-05-01'), 'confirmed answer'))
      .attach(asSkillId('SKILL-react'), userConfirmation(asISODate('2024-05-01'), 'confirmed'));

    const report = verifyOutput(
      talkingPointOutput('STAR-05', 'Built the dashboard', ['SKILL-react', 'SKILL-graphql']),
      index,
    );

    expect(report.passed).toBe(false);
    expect(report.inventedSkills.map((c) => c.ref as unknown as string)).toEqual([
      'SKILL-graphql',
    ]);
  });

  it('rejects a skill implied solely by a job title (R37.3, R40.3)', () => {
    // A bare "DevOps Engineer" title with no Docker provenance: a generated
    // skill-map entry for Docker must be flagged as an invented, title-implied
    // skill — never silently accepted.
    const index = new ProvenanceIndex().attach(
      asItemId('ITEM-emp'),
      sourceLine(asDocId('history.txt'), 1, 'DevOps Engineer'),
    );

    const report = verifyOutput(skillEntryOutput('SKILL-docker', 'Docker'), index, {
      titleImpliedSkills: ['Docker', 'Kubernetes'],
    });

    expect(report.passed).toBe(false);
    expect(report.inventedSkills.map((c) => c.text)).toContain('Docker');
    expect(report.titleImpliedSkills.map((c) => c.text)).toEqual(['Docker']);
  });

  it('accepts ProvenanceSources directly (not just a prebuilt index)', () => {
    const report = verifyOutput(skillEntryOutput('SKILL-x', 'X'), {
      facts: [
        { ref: asSkillId('SKILL-x'), provenance: [userConfirmation(asISODate('2024-01-01'), 'ok')] },
      ],
    });
    expect(report.passed).toBe(true);
  });
});

describe('@core/no-fabrication — fixture library (R40.1, R40.3)', () => {
  it('includes a sparse and an adversarial fixture (R40.1)', () => {
    const kinds = sampleProfiles().map((p) => p.kind);
    expect(kinds).toContain('sparse');
    expect(kinds).toContain('adversarial');
  });

  it('every fixture output verifies clean (correct generation is fabrication-free)', () => {
    for (const profile of sampleProfiles()) {
      for (const output of profile.outputs) {
        const report = verifyOutput(output, profile.index);
        expect(report.passed, `${profile.id} / ${output.kind}`).toBe(true);
      }
    }
  });

  it('the sparse fixture surfaces only its single confirmed skill', () => {
    const sparse = sampleProfiles().find((p) => p.kind === 'sparse');
    expect(sparse).toBeDefined();
    const cv = sparse?.outputs.find((o) => o.kind === 'cv');
    expect(cv?.kind).toBe('cv');
    if (cv?.kind === 'cv') {
      expect(cv.model.skills).toHaveLength(1);
      expect(cv.model.education).toHaveLength(0);
    }
  });

  it('the adversarial fixture lists its title-implied skills and invents none (R40.3)', () => {
    const cases = adversarialCases();
    expect(cases).toHaveLength(1);
    const devops = cases[0];
    expect(devops?.titleImpliedSkills).toContain('Docker');
    expect(devops?.titleImpliedSkills).toContain('Kubernetes');

    // The fixture's own outputs verify clean and surface no title-implied skill.
    for (const output of devops?.outputs ?? []) {
      const report = verifyOutput(output, devops!.index, {
        titleImpliedSkills: devops!.titleImpliedSkills,
      });
      expect(report.passed).toBe(true);
      expect(report.titleImpliedSkills).toHaveLength(0);
    }
  });

  it('a generator that falls for the adversarial temptation is caught', () => {
    const devops = adversarialCases()[0]!;
    // Simulate a naive generator inventing a Kubernetes skill from the title.
    const report = verifyOutput(skillEntryOutput('SKILL-kubernetes', 'Kubernetes'), devops.index, {
      titleImpliedSkills: devops.titleImpliedSkills,
    });
    expect(report.passed).toBe(false);
    expect(report.titleImpliedSkills.map((c) => c.text)).toEqual(['Kubernetes']);
  });
});

describe('@core/no-fabrication — prompt versioning (R40.4)', () => {
  it('exposes a versioned, hashed system prompt', () => {
    const record = currentPromptVersion();
    expect(record.version).toBe(NO_FABRICATION_PROMPT_VERSION);
    expect(record.prompt).toBe(NO_FABRICATION_SYSTEM_PROMPT);
    expect(record.hash).toBe(promptHash(NO_FABRICATION_SYSTEM_PROMPT));
    expect(record.results).toBeUndefined();
  });

  it('hash changes when the prompt text changes (regression detector)', () => {
    expect(promptHash('a')).not.toBe(promptHash('b'));
    expect(promptHash(NO_FABRICATION_SYSTEM_PROMPT)).toBe(
      promptHash(NO_FABRICATION_SYSTEM_PROMPT),
    );
  });

  it('evaluate() binds the eval results to the prompt version (R40.4)', () => {
    const evaluation = harness.evaluate();
    expect(evaluation.passed).toBe(true);
    expect(evaluation.outputs.length).toBeGreaterThan(0);
    expect(evaluation.promptVersion.version).toBe(NO_FABRICATION_PROMPT_VERSION);
    expect(evaluation.promptVersion.results).toBeDefined();
    expect(evaluation.promptVersion.results).toHaveLength(evaluation.outputs.length);
    expect(evaluation.outputs.every((o) => o.report.passed)).toBe(true);
  });
});
