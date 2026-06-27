// Factual-claim extraction from a generated output (R40.2, Property 1).
//
// The No_Fabrication_Harness verifies that *every factual claim* in a generated
// output resolves to a provenance record (R40.2). Before it can resolve claims
// it must first enumerate them, and that is this module's single job: given any
// supported generated output — a CV (`CvModel`), an advisory LinkedIn report
// (`LinkedInReport`), a confirmed talking point (`TalkingPoint`), or a skill-map
// entry (`SkillMapEntry`) — produce the flat list of {@link Claim}s it asserts.
//
// Every claim is keyed by the stable domain identifier the rest of the pipeline
// already attaches provenance to (the bi-directional skill ↔ proof graph and the
// provenance index, R18.3 / R38.1). Concretely:
//
//   * a surfaced skill          → its `SkillId`        (kind `skill`);
//   * an experience bullet       → its `BulletId`/`StarId` (kind `accomplishment`
//                                  or `talking-point`, matching its source);
//   * an education / cert entry  → its `ItemId`         (kind `education` /
//                                  `certification`);
//   * a position rewrite         → its `ItemId`         (kind `employment`).
//
// Because each claim carries the exact `ClaimRef` the provenance index keys on,
// the verifier (see `verify.ts`) can resolve every claim with a single index
// lookup — no string matching, no fuzzy inference. This module is framework-
// agnostic: it imports only domain types and the output model shapes, never
// storage, the network, or React.

import type { SkillMapEntry, TalkingPoint } from '@core/types';
import type { ClaimRef } from '@core/provenance';
import type { CvModel, LinkedInReport } from '@core/output';

/** Which supported output a claim was extracted from. */
export type GeneratedOutputKind =
  | 'cv'
  | 'linkedin'
  | 'talking-point'
  | 'skill-map-entry';

/**
 * The category of a factual claim. These mirror the No-Fabrication Rule's
 * enumerated claim types (R37.1 skills, R37.2 metric/date/title/employer) at the
 * granularity the pipeline tracks provenance: a skill, an experience proof
 * (accomplishment or talking point), or a sourced extracted item (education,
 * certification, employment).
 */
export type ClaimKind =
  | 'skill'
  | 'accomplishment'
  | 'talking-point'
  | 'education'
  | 'certification'
  | 'employment';

/**
 * One factual claim asserted by a generated output (R40.2). It pairs the stable
 * identifier the claim is built from ({@link ref}) — the key the provenance
 * index resolves against — with enough description for a {@link VerificationReport}
 * to explain a failure to a human.
 */
export interface Claim {
  /** The stable id the claim is built from; the provenance-index lookup key. */
  readonly ref: ClaimRef;
  /** The category of the claim (R37.1, R37.2). */
  readonly kind: ClaimKind;
  /** The human-readable text the output surfaced for this claim. */
  readonly text: string;
  /** Which output (and section) the claim came from, for diagnostics. */
  readonly origin: GeneratedOutputKind;
}

/**
 * A generated output the harness can verify. The four members are exactly the
 * outputs Property 1 enumerates: a CV, a LinkedIn report, a talking point, and a
 * skill-map entry.
 */
export type GeneratedOutput =
  | { readonly kind: 'cv'; readonly model: CvModel }
  | { readonly kind: 'linkedin'; readonly report: LinkedInReport }
  | { readonly kind: 'talking-point'; readonly point: TalkingPoint }
  | { readonly kind: 'skill-map-entry'; readonly entry: SkillMapEntry };

const asString = (v: unknown): string => v as unknown as string;

/**
 * Classify an experience proof id by its stable prefix: `STAR-NN` talking points
 * vs `BULLET-NN` accomplishments (R18.4, R23.2). A LinkedIn bullet carries only
 * the id, so this recovers the claim kind from it.
 */
const proofKind = (id: ClaimRef): 'accomplishment' | 'talking-point' =>
  asString(id).toUpperCase().startsWith('STAR') ? 'talking-point' : 'accomplishment';

/** Extract every factual claim asserted by a CV model (R30, R40.2). */
const cvClaims = (model: CvModel): Claim[] => {
  const claims: Claim[] = [];

  for (const skill of model.skills) {
    claims.push({ ref: skill.id, kind: 'skill', text: skill.name, origin: 'cv' });
  }
  for (const bullet of model.experience) {
    claims.push({
      ref: bullet.id,
      kind: bullet.source === 'talking-point' ? 'talking-point' : 'accomplishment',
      text: bullet.text,
      origin: 'cv',
    });
  }
  for (const entry of model.education) {
    claims.push({ ref: entry.id, kind: 'education', text: entry.title, origin: 'cv' });
  }
  for (const entry of model.certifications) {
    claims.push({
      ref: entry.id,
      kind: 'certification',
      text: entry.title,
      origin: 'cv',
    });
  }

  return claims;
};

/** Extract every factual claim asserted by an advisory LinkedIn report (R31). */
const linkedInClaims = (report: LinkedInReport): Claim[] => {
  const claims: Claim[] = [];

  for (const skill of report.recommendedSkills) {
    claims.push({ ref: skill.id, kind: 'skill', text: skill.name, origin: 'linkedin' });
  }
  for (const bullet of report.experienceBullets) {
    claims.push({
      ref: bullet.id,
      kind: proofKind(bullet.id),
      text: bullet.text,
      origin: 'linkedin',
    });
  }
  for (const position of report.positions) {
    const label = position.employer
      ? `${position.title} — ${position.employer}`
      : position.title;
    claims.push({ ref: position.id, kind: 'employment', text: label, origin: 'linkedin' });
  }

  return claims;
};

/** Extract the claims asserted by a confirmed talking point (the proof + its skills). */
const talkingPointClaims = (point: TalkingPoint): Claim[] => {
  const claims: Claim[] = [
    { ref: point.id, kind: 'talking-point', text: point.polished, origin: 'talking-point' },
  ];
  for (const skill of point.skills) {
    claims.push({
      ref: skill,
      kind: 'skill',
      text: asString(skill),
      origin: 'talking-point',
    });
  }
  return claims;
};

/** Extract the single claim asserted by a skill-map entry. */
const skillMapEntryClaims = (entry: SkillMapEntry): Claim[] => [
  { ref: entry.id, kind: 'skill', text: entry.name, origin: 'skill-map-entry' },
];

/**
 * Extract every factual claim from any supported generated output (R40.2). Pure
 * and deterministic: the same output always yields the same claims in the same
 * order. The result feeds the verifier, which resolves each {@link Claim.ref}
 * against the provenance index.
 */
export const extractClaims = (output: GeneratedOutput): Claim[] => {
  switch (output.kind) {
    case 'cv':
      return cvClaims(output.model);
    case 'linkedin':
      return linkedInClaims(output.report);
    case 'talking-point':
      return talkingPointClaims(output.point);
    case 'skill-map-entry':
      return skillMapEntryClaims(output.entry);
  }
};
