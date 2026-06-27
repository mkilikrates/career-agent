// The No-Fabrication fixture library (R40.1, R40.3).
//
// R40.1 requires the harness to maintain a regression suite of sample profiles
// "including sparse and ambiguous cases", and R40.3 requires "adversarial cases
// that tempt inference" (the canonical example being a bare "DevOps Engineer"
// title that tempts a naive generator into inventing Docker/Kubernetes skills).
// This module builds that fixture library.
//
// Each {@link SampleProfile} bundles a {@link ProvenanceIndex} — the confirmed
// evidence backbone — together with a set of {@link GeneratedOutput}s that a
// *correct* generator would produce from that evidence. Every claim in every
// fixture output is backed by a provenance record in the profile's index, so a
// correct generator's outputs all PASS verification. The fixtures therefore
// pin the expected behaviour; the harness's job (and the unit/property tests) is
// to prove the verifier FAILS the moment an output strays from it (an unresolved
// claim or an invented, title-implied skill).
//
// Framework-agnostic: only domain types, provenance constructors, and the
// output model shapes are used — no storage, network, or React.

import {
  asBulletId,
  asDocId,
  asISODate,
  asItemId,
  asRoleSlug,
  asSkillId,
  asStarId,
  type SkillCategory,
  type SkillMapEntry,
  type TalkingPoint,
} from '@core/types';
import {
  ProvenanceIndex,
  interviewAnswer,
  sourceLine,
  userConfirmation,
} from '@core/provenance';
import type { CvModel, CvBullet, CvSkill, CvEntry, LinkedInReport } from '@core/output';
import { ADVISORY_NOTICE } from '@core/output';
import type { GeneratedOutput } from './claims';

/** The breadth a fixture exercises: a rich profile, a sparse one, or an adversarial one. */
export type ProfileKind = 'rich' | 'sparse' | 'adversarial';

/**
 * A sample profile in the regression suite (R40.1): a provenance index of
 * confirmed evidence plus the generated outputs a correct generator yields from
 * it. Every output's claims resolve in {@link index}, so all outputs pass
 * verification — the fixture pins correct No-Fabrication behaviour.
 */
export interface SampleProfile {
  /** Stable fixture id. */
  readonly id: string;
  /** Human-readable description of what this fixture exercises. */
  readonly description: string;
  /** Whether this is a rich, sparse, or adversarial profile (R40.1, R40.3). */
  readonly kind: ProfileKind;
  /** The confirmed-evidence provenance backbone every output resolves against. */
  readonly index: ProvenanceIndex;
  /** Generated outputs a correct generator produces — all should verify clean. */
  readonly outputs: readonly GeneratedOutput[];
}

/**
 * An adversarial fixture that tempts skill inference (R40.3). It carries the bare
 * job title and the skills that title would tempt a naive generator to invent,
 * so the harness can assert that none of them appear unsourced in the outputs
 * (R37.3). Its own outputs deliberately surface NO inferred skill — the correct
 * response to the temptation.
 */
export interface AdversarialCase extends SampleProfile {
  readonly kind: 'adversarial';
  /** The bare job title presented as the only strong signal (e.g. "DevOps Engineer"). */
  readonly jobTitle: string;
  /** Skills the title tempts a naive generator to infer without evidence (R37.3). */
  readonly titleImpliedSkills: readonly string[];
  /** A description of the inference trap this fixture sets. */
  readonly temptation: string;
}

// --- small builders --------------------------------------------------------

const skill = (
  id: string,
  name: string,
  category: SkillCategory = 'Technical',
  targetRelevant = false,
): CvSkill => ({ id: asSkillId(id), name, category, targetRelevant });

const accBullet = (id: string, text: string, skillIds: string[]): CvBullet => ({
  id: asBulletId(id),
  source: 'accomplishment',
  text,
  skills: skillIds.map(asSkillId),
  targetRelevant: true,
  quantified: /\d/.test(text),
  needsMetric: false,
});

const starBullet = (id: string, text: string, skillIds: string[]): CvBullet => ({
  id: asStarId(id),
  source: 'talking-point',
  text,
  skills: skillIds.map(asSkillId),
  targetRelevant: true,
  quantified: /\d/.test(text),
  needsMetric: false,
});

const entry = (id: string, title: string, subtitle?: string): CvEntry => {
  const e: CvEntry = { id: asItemId(id), title };
  if (subtitle !== undefined) (e as { subtitle?: string }).subtitle = subtitle;
  return e;
};

const skillMapEntry = (id: string, name: string): SkillMapEntry => ({
  id: asSkillId(id),
  name,
  category: 'Technical',
  proficiencySignal: 'Demonstrated across confirmed evidence',
  evidence: [],
  recency: asISODate('2024-05-01'),
});

const talkingPoint = (id: string, polished: string, skillIds: string[]): TalkingPoint => ({
  id: asStarId(id),
  polished,
  flags: [],
  skills: skillIds.map(asSkillId),
});

// --- Fixture 1: rich profile ----------------------------------------------
// A fully-populated profile: every skill, bullet, education, certification, and
// position resolves to source provenance or a confirmed interview answer.

const buildRichProfile = (): SampleProfile => {
  const cv = asDocId('cv.pdf');
  const index = new ProvenanceIndex();
  index
    .attach(asSkillId('SKILL-typescript'), sourceLine(cv, 4, 'TypeScript, 6 years'))
    .attach(asSkillId('SKILL-react'), interviewAnswer(asStarId('STAR-01')))
    .attach(asBulletId('BULLET-01'), sourceLine(cv, 9, 'Migrated the billing platform'))
    .attach(asStarId('STAR-01'), interviewAnswer(asStarId('STAR-01')))
    .attach(asItemId('ITEM-edu-01'), sourceLine(cv, 20, 'BSc Computer Science, 2016'))
    .attach(asItemId('ITEM-cert-01'), sourceLine(cv, 24, 'AWS Solutions Architect, 2022'))
    .attach(asItemId('ITEM-emp-01'), sourceLine(cv, 7, 'Senior Engineer, Acme, 2019–2024'));

  const skills = [
    skill('SKILL-typescript', 'TypeScript', 'Technical', true),
    skill('SKILL-react', 'React', 'Technical', true),
  ];
  const experience = [
    accBullet('BULLET-01', 'Migrated the billing platform, cutting latency 40%', [
      'SKILL-typescript',
    ]),
    starBullet('STAR-01', 'Led a 4-engineer team to ship the React design system', [
      'SKILL-react',
    ]),
  ];
  const education = [entry('ITEM-edu-01', 'BSc Computer Science', 'State University')];
  const certifications = [entry('ITEM-cert-01', 'AWS Solutions Architect', 'Amazon')];

  const cvModel: CvModel = {
    targetRole: { slug: asRoleSlug('senior-frontend-engineer'), title: 'Senior Frontend Engineer' },
    header: { name: 'Jordan Rivera', contact: ['jordan@example.com'] },
    skills,
    experience,
    education,
    certifications,
  };

  const linkedIn: LinkedInReport = {
    advisory: true,
    notice: ADVISORY_NOTICE,
    headline: 'TypeScript · React',
    about: 'Senior frontend engineer with a record of platform migrations.',
    experienceBullets: [
      { id: asBulletId('BULLET-01'), text: 'Migrated the billing platform, cutting latency 40%', needsMetric: false },
      { id: asStarId('STAR-01'), text: 'Led a 4-engineer team to ship the React design system', needsMetric: false },
    ],
    positions: [
      { id: asItemId('ITEM-emp-01'), title: 'Senior Engineer', employer: 'Acme', dates: '2019 – 2024' },
    ],
    recommendedSkills: [
      { id: asSkillId('SKILL-typescript'), name: 'TypeScript', category: 'Technical' },
      { id: asSkillId('SKILL-react'), name: 'React', category: 'Technical' },
    ],
  };

  return {
    id: 'rich-frontend-engineer',
    description: 'Fully-populated profile; every claim is sourced or confirmed.',
    kind: 'rich',
    index,
    outputs: [
      { kind: 'cv', model: cvModel },
      { kind: 'linkedin', report: linkedIn },
      { kind: 'talking-point', point: talkingPoint('STAR-01', 'Led a 4-engineer team to ship the React design system', ['SKILL-react']) },
      { kind: 'skill-map-entry', entry: skillMapEntry('SKILL-typescript', 'TypeScript') },
    ],
  };
};

// --- Fixture 2: sparse profile --------------------------------------------
// A minimal profile (R40.1 "sparse"): a single user-confirmed skill and the one
// accomplishment that evidences it. No education, certifications, or positions.

const buildSparseProfile = (): SampleProfile => {
  const index = new ProvenanceIndex();
  index
    .attach(asSkillId('SKILL-sql'), userConfirmation(asISODate('2024-05-01'), 'confirmed SQL in review'))
    .attach(asBulletId('BULLET-10'), userConfirmation(asISODate('2024-05-01'), 'confirmed in review'));

  const cvModel: CvModel = {
    targetRole: { slug: asRoleSlug('data-analyst'), title: 'Data Analyst' },
    header: { name: 'Sam Okafor' },
    skills: [skill('SKILL-sql', 'SQL', 'Technical', true)],
    experience: [accBullet('BULLET-10', 'Built the weekly revenue report in SQL', ['SKILL-sql'])],
    education: [],
    certifications: [],
  };

  return {
    id: 'sparse-data-analyst',
    description: 'Sparse profile: one confirmed skill and its single accomplishment.',
    kind: 'sparse',
    index,
    outputs: [
      { kind: 'cv', model: cvModel },
      { kind: 'skill-map-entry', entry: skillMapEntry('SKILL-sql', 'SQL') },
    ],
  };
};

// --- Fixture 3: adversarial profile ---------------------------------------
// The canonical inference trap (R40.3): a bare "DevOps Engineer" title and
// NOTHING else. The provenance index holds only the employment title item — no
// skills. A correct generator surfaces the sourced title and invents no skills;
// these fixture outputs do exactly that, so they verify clean while exposing the
// temptation for the harness to assert against.

const buildAdversarialDevOps = (): AdversarialCase => {
  const jd = asDocId('job-history.txt');
  const index = new ProvenanceIndex();
  // Only the bare title is sourced. No Docker/Kubernetes/Terraform provenance.
  index.attach(asItemId('ITEM-emp-devops'), sourceLine(jd, 1, 'DevOps Engineer, Globex, 2021–2023'));

  const cvModel: CvModel = {
    targetRole: { slug: asRoleSlug('devops-engineer'), title: 'DevOps Engineer' },
    header: { name: 'Riley Chen' },
    // Correct behaviour: NO inferred skills, because none are sourced (R37.3).
    skills: [],
    experience: [],
    education: [],
    certifications: [],
  };

  const linkedIn: LinkedInReport = {
    advisory: true,
    notice: ADVISORY_NOTICE,
    // Headline falls back to the sourced title, not invented skills.
    headline: 'DevOps Engineer',
    about: '',
    experienceBullets: [],
    positions: [
      { id: asItemId('ITEM-emp-devops'), title: 'DevOps Engineer', employer: 'Globex', dates: '2021 – 2023' },
    ],
    recommendedSkills: [],
  };

  return {
    id: 'adversarial-bare-devops-title',
    description: 'Bare "DevOps Engineer" title that tempts inferring Docker/Kubernetes.',
    kind: 'adversarial',
    jobTitle: 'DevOps Engineer',
    titleImpliedSkills: ['Docker', 'Kubernetes', 'Terraform', 'CI/CD', 'AWS'],
    temptation:
      'The title alone would tempt a naive generator to list Docker, Kubernetes, ' +
      'Terraform, CI/CD, and AWS — none of which appear in any source.',
    index,
    outputs: [
      { kind: 'cv', model: cvModel },
      { kind: 'linkedin', report: linkedIn },
    ],
  };
};

/** The full fixture library (R40.1), rich + sparse + adversarial. */
export const sampleProfiles = (): SampleProfile[] => [
  buildRichProfile(),
  buildSparseProfile(),
  buildAdversarialDevOps(),
];

/** Just the adversarial inference-tempting cases (R40.3). */
export const adversarialCases = (): AdversarialCase[] => [buildAdversarialDevOps()];
