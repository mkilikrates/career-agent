// Fact-fidelity tests (R37.5, R37.6, R40.2b).
//
// These cover the second verification stage: a resolved claim whose emitted text
// introduces a NEW fact token (metric, date, title, employer) absent from its
// confirmed source is a fabrication, even though its id resolves — while prose
// rephrasing that introduces no new fact is allowed. They exercise the pure
// primitives (`extractFactTokens`, `checkFidelity`, `sourceTextOf`,
// `auditDraftFidelity`), the `verifyOutput` fidelity stage (document source,
// interview-answer source via `starText`, and the user-confirmation attestation
// degrade), and the CV employment-claim coverage.

import { describe, expect, it } from 'vitest';
import {
  asBulletId,
  asDocId,
  asISODate,
  asItemId,
  asRoleSlug,
  asStarId,
  type StarId,
} from '@core/types';
import {
  ProvenanceIndex,
  interviewAnswer,
  sourceLine,
  userConfirmation,
} from '@core/provenance';
import type { CvModel } from '@core/output';
import {
  createNoFabricationHarness,
  extractFactTokens,
  checkFidelity,
  sourceTextOf,
  auditDraftFidelity,
  verifyOutput,
  type GeneratedOutput,
} from './index';

// ---------------------------------------------------------------------------
// extractFactTokens
// ---------------------------------------------------------------------------

describe('extractFactTokens (R37.5)', () => {
  it('extracts metric, date, and entity tokens', () => {
    // "Acme" is mid-sentence (not the leading word) so it counts as an entity;
    // the leading verb "Led" is sentence-initial and correctly ignored.
    const tokens = extractFactTokens('Led the team at Acme to cut latency 40% in 2021');
    const byKind = (k: string) => tokens.filter((t) => t.kind === k).map((t) => t.norm);
    expect(byKind('metric')).toContain('40%');
    expect(byKind('date')).toContain('2021');
    expect(byKind('entity')).toContain('acme');
  });

  it('ignores ordinary prose words (no false fact tokens)', () => {
    // Lower-case prose carries no capitalised entity, number, or date.
    const tokens = extractFactTokens('led the team to deliver the project on time');
    expect(tokens).toHaveLength(0);
  });

  it('ignores a sentence-initial capitalised verb (not a proper noun)', () => {
    // "Reduced" leads the sentence; it is grammatical capitalisation, not a fact.
    expect(extractFactTokens('Reduced the backlog significantly')).toHaveLength(0);
  });

  it('is deterministic and deduplicated', () => {
    const a = extractFactTokens('Worked at Acme Acme scoring 40% 40%');
    const b = extractFactTokens('Worked at Acme Acme scoring 40% 40%');
    expect(a).toEqual(b);
    expect(a.filter((t) => t.norm === 'acme')).toHaveLength(1);
    expect(a.filter((t) => t.norm === '40%')).toHaveLength(1);
  });

  it('returns nothing for empty text', () => {
    expect(extractFactTokens('')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkFidelity
// ---------------------------------------------------------------------------

describe('checkFidelity (R37.5)', () => {
  it('passes when the emitted text introduces no new fact token', () => {
    const result = checkFidelity(
      'Cut latency 40% at Acme',
      'Reduced latency by 40% while working at Acme Corp',
    );
    expect(result.faithful).toBe(true);
    expect(result.unfaithfulTokens).toHaveLength(0);
  });

  it('allows pure rephrasing (same facts, different prose)', () => {
    const source = 'Migrated the billing platform, cutting latency 40%';
    const rephrased = 'Reduced billing-platform latency by 40% through a migration';
    expect(checkFidelity(rephrased, source).faithful).toBe(true);
  });

  it('fails when a metric is inflated', () => {
    const result = checkFidelity(
      'Cut latency 90%',
      'Reduced latency by 40%',
    );
    expect(result.faithful).toBe(false);
    expect(result.unfaithfulTokens.map((t) => t.norm)).toContain('90%');
  });

  it('fails when a new employer is invented', () => {
    const result = checkFidelity(
      'Senior Engineer at Globex',
      'Senior Engineer at Acme',
    );
    expect(result.faithful).toBe(false);
    expect(result.unfaithfulTokens.map((t) => t.norm)).toContain('globex');
  });

  it('fails when a date is shifted', () => {
    const result = checkFidelity('Graduated in 2019', 'Graduated in 2016');
    expect(result.faithful).toBe(false);
    expect(result.unfaithfulTokens.map((t) => t.norm)).toContain('2019');
  });
});

// ---------------------------------------------------------------------------
// sourceTextOf
// ---------------------------------------------------------------------------

describe('sourceTextOf (R37.5, R40.2b)', () => {
  const doc = asDocId('cv.pdf');

  it('reads the verbatim quote from a source_line record', () => {
    expect(sourceTextOf([sourceLine(doc, 3, 'TypeScript, 6 years')])).toBe(
      'TypeScript, 6 years',
    );
  });

  it('resolves an interview_answer via the supplied starText map (option b)', () => {
    const star = asStarId('STAR-01');
    const starText: ReadonlyMap<StarId, string> = new Map([
      [star, 'Led a 4-engineer team at Acme'],
    ]);
    expect(sourceTextOf([interviewAnswer(star)], starText)).toBe(
      'Led a 4-engineer team at Acme',
    );
  });

  it('returns undefined for an interview_answer with no starText (degrade)', () => {
    expect(sourceTextOf([interviewAnswer(asStarId('STAR-01'))])).toBeUndefined();
  });

  it('treats a user_confirmation as an attestation, not source text (degrade)', () => {
    expect(
      sourceTextOf([userConfirmation(asISODate('2024-05-01'), 'confirmed in review')]),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// verifyOutput — fidelity stage
// ---------------------------------------------------------------------------

const roleCv = (
  overrides: Partial<CvModel> & Pick<CvModel, 'skills' | 'experience' | 'education' | 'certifications'>,
): CvModel => ({
  targetRole: { slug: asRoleSlug('senior-engineer'), title: 'Senior Engineer' },
  header: { name: 'Jordan Rivera' },
  ...overrides,
});

describe('verifyOutput — fact fidelity (R37.5, R40.2)', () => {
  const doc = asDocId('cv.pdf');

  it('fails a resolved bullet whose metric is not in its source quote', () => {
    const index = new ProvenanceIndex().attach(
      asBulletId('BULLET-01'),
      sourceLine(doc, 9, 'Migrated the billing platform'),
    );
    const model = roleCv({
      skills: [],
      experience: [
        {
          id: asBulletId('BULLET-01'),
          source: 'accomplishment',
          text: 'Migrated the billing platform, cutting latency 40%',
          skills: [],
          targetRelevant: true,
          quantified: true,
          needsMetric: false,
        },
      ],
      education: [],
      certifications: [],
    });

    const report = verifyOutput({ kind: 'cv', model }, index);
    expect(report.passed).toBe(false);
    expect(report.unresolved).toHaveLength(0); // id resolves...
    expect(report.unfaithful).toHaveLength(1); // ...but the fact is new.
    expect(report.unfaithful[0]!.newFacts.map((t) => t.norm)).toContain('40%');
  });

  it('passes a resolved bullet that rephrases its source without new facts', () => {
    const index = new ProvenanceIndex().attach(
      asBulletId('BULLET-01'),
      sourceLine(doc, 9, 'Migrated the billing platform, cutting latency 40%'),
    );
    const model = roleCv({
      skills: [],
      experience: [
        {
          id: asBulletId('BULLET-01'),
          source: 'accomplishment',
          text: 'Reduced latency 40% by migrating the billing platform',
          skills: [],
          targetRelevant: true,
          quantified: true,
          needsMetric: false,
        },
      ],
      education: [],
      certifications: [],
    });

    const report = verifyOutput({ kind: 'cv', model }, index);
    expect(report.passed).toBe(true);
    expect(report.unfaithful).toHaveLength(0);
  });

  it('verifies an interview-answer-backed bullet against the supplied starText (option b)', () => {
    const star = asStarId('STAR-01');
    const index = new ProvenanceIndex().attach(star, interviewAnswer(star));
    const starText = new Map<StarId, string>([
      [star, 'Led a 4-engineer team to ship the React design system'],
    ]);
    const faithful = roleCv({
      skills: [],
      experience: [
        {
          id: star,
          source: 'talking-point',
          text: 'Shipped the React design system leading a 4-engineer team',
          skills: [],
          targetRelevant: true,
          quantified: false,
          needsMetric: false,
        },
      ],
      education: [],
      certifications: [],
    });
    expect(verifyOutput({ kind: 'cv', model: faithful }, index, { starText }).passed).toBe(true);

    const inflated = roleCv({
      ...faithful,
      experience: [
        { ...faithful.experience[0]!, text: 'Led a 12-engineer team on the React design system' },
      ],
    });
    const report = verifyOutput({ kind: 'cv', model: inflated }, index, { starText });
    expect(report.passed).toBe(false);
    expect(report.unfaithful[0]!.newFacts.map((t) => t.norm)).toContain('12');
  });

  it('degrades to resolution-only for a user-confirmed claim (user is judge, R39)', () => {
    // A user_confirmation attests the user approved the item; its text is never
    // compared, so even a bullet full of fact tokens passes fidelity.
    const index = new ProvenanceIndex().attach(
      asBulletId('BULLET-10'),
      userConfirmation(asISODate('2024-05-01'), 'confirmed in review'),
    );
    const model = roleCv({
      skills: [],
      experience: [
        {
          id: asBulletId('BULLET-10'),
          source: 'accomplishment',
          text: 'Grew revenue 300% at Globex across 2019 and 2020',
          skills: [],
          targetRelevant: true,
          quantified: true,
          needsMetric: false,
        },
      ],
      education: [],
      certifications: [],
    });
    const report = verifyOutput({ kind: 'cv', model }, index);
    expect(report.passed).toBe(true);
    expect(report.unfaithful).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CV employment-claim coverage (R37.2, R40.2)
// ---------------------------------------------------------------------------

describe('verifyOutput — CV employment claims (R37.2)', () => {
  const doc = asDocId('cv.pdf');

  it('fails a CV employment entry whose employer is not in its source', () => {
    const index = new ProvenanceIndex().attach(
      asItemId('ITEM-emp-01'),
      sourceLine(doc, 7, 'Senior Engineer, Acme, 2019–2024'),
    );
    const model = roleCv({
      skills: [],
      experience: [],
      education: [],
      certifications: [],
      employmentEntries: [
        {
          sourceId: asItemId('ITEM-emp-01'),
          title: 'Senior Engineer',
          company: 'Globex', // fabricated employer
          technologies: [],
          achievements: [],
          bullets: [],
        },
      ],
    });
    const report = verifyOutput({ kind: 'cv', model }, index);
    const employment = report.claims.filter((c) => c.kind === 'employment');
    expect(employment).toHaveLength(1);
    expect(report.passed).toBe(false);
    expect(report.unfaithful[0]!.newFacts.map((t) => t.norm)).toContain('globex');
  });

  it('passes a CV employment entry whose title + employer are in its source', () => {
    const index = new ProvenanceIndex().attach(
      asItemId('ITEM-emp-01'),
      sourceLine(doc, 7, 'Senior Engineer, Acme, 2019–2024'),
    );
    const model = roleCv({
      skills: [],
      experience: [],
      education: [],
      certifications: [],
      employmentEntries: [
        {
          sourceId: asItemId('ITEM-emp-01'),
          title: 'Senior Engineer',
          company: 'Acme',
          technologies: [],
          achievements: [],
          bullets: [],
        },
      ],
    });
    expect(verifyOutput({ kind: 'cv', model }, index).passed).toBe(true);
  });

  it('skips the synthetic "General" bucket (no sourceId, no employer claim)', () => {
    const index = new ProvenanceIndex();
    const model = roleCv({
      skills: [],
      experience: [],
      education: [],
      certifications: [],
      employmentEntries: [
        {
          title: 'General',
          company: '',
          technologies: [],
          achievements: [],
          bullets: [],
        },
      ],
    });
    const output: GeneratedOutput = { kind: 'cv', model };
    expect(verifyOutput(output, index).claims.filter((c) => c.kind === 'employment')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// auditDraftFidelity (live-app advisory, R37.6)
// ---------------------------------------------------------------------------

describe('auditDraftFidelity (R37.6)', () => {
  it('flags a new fact the AI draft adds over the confirmed baseline', () => {
    const baseline = '# CV\n\n- Senior Engineer at Acme\n- Cut latency 40%';
    const draft = '# CV\n\n- Senior Engineer at Acme\n- Cut latency 90% and saved $2M';
    const result = auditDraftFidelity(draft, baseline);
    expect(result.faithful).toBe(false);
    const norms = result.unfaithfulTokens.map((t) => t.norm);
    expect(norms).toContain('90%');
    expect(norms.some((n) => n.includes('2m') || n.includes('$2'))).toBe(true);
  });

  it('passes a draft that only rephrases the baseline', () => {
    const baseline = '# CV\n\n- Migrated the billing platform, cutting latency 40%';
    const draft = '# CV\n\n- Reduced latency 40% via a billing-platform migration';
    expect(auditDraftFidelity(draft, baseline).faithful).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Harness-level fidelity gate (R40.5): the CI harness hard-fails a fidelity-
// adversarial output (retained id + inflated metric / invented employer) and
// passes a rephrase-only output.
// ---------------------------------------------------------------------------

describe('No_Fabrication_Harness — fidelity gate (R40.5)', () => {
  const harness = createNoFabricationHarness();
  const doc = asDocId('cv.pdf');

  const employmentModel = (title: string, company: string): CvModel =>
    roleCv({
      skills: [],
      experience: [],
      education: [],
      certifications: [],
      employmentEntries: [
        { sourceId: asItemId('ITEM-emp-01'), title, company, technologies: [], achievements: [], bullets: [] },
      ],
    });

  const empIndex = () =>
    new ProvenanceIndex().attach(
      asItemId('ITEM-emp-01'),
      sourceLine(doc, 7, 'Senior Engineer, Acme, 2019–2024'),
    );

  it('hard-fails a retained-id output with an invented employer', () => {
    const report = harness.verifyOutput(
      { kind: 'cv', model: employmentModel('Senior Engineer', 'Globex') },
      empIndex(),
    );
    expect(report.passed).toBe(false);
    expect(report.unfaithful).toHaveLength(1);
  });

  it('passes the same output when the employer matches the source', () => {
    const report = harness.verifyOutput(
      { kind: 'cv', model: employmentModel('Senior Engineer', 'Acme') },
      empIndex(),
    );
    expect(report.passed).toBe(true);
  });
});
