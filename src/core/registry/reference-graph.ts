// Bi-directional skill ↔ accomplishment reference graph (R18.2, R18.3).
//
// Each skill must resolve to the accomplishments / talking points that prove it,
// and each accomplishment / talking point must resolve to the skills it
// evidences (R18.3). The graph below stores a single symmetric relation between
// a `SkillId` and a *proof* id (`BULLET-NN` or `STAR-NN`), so the forward and
// reverse lookups are consistent by construction — there is no way to record
// one direction without the other.
//
// The graph is built from the same data that lives in the Markdown store: a
// skill entry's evidence trail (skill → proof) and an accomplishment / talking
// point's `skills` list (proof → skill). Evidence refs that point at a source
// document rather than a STAR/BULLET id are ignored here (they belong to the
// provenance index, not the proof graph).

import type {
  Accomplishment,
  BulletId,
  SkillId,
  SkillMapEntry,
  StarId,
  TalkingPoint,
} from '@core/types';
import { asBulletId, asSkillId, asStarId } from '@core/types';
import { kindOf } from './id-registry';

/** A proof reference: an accomplishment (`BULLET-NN`) or talking point (`STAR-NN`). */
export type ProofRef = BulletId | StarId;

/** Records to build the graph from (any subset). */
export interface ReferenceGraphInput {
  skills?: readonly SkillMapEntry[];
  accomplishments?: readonly Accomplishment[];
  talkingPoints?: readonly TalkingPoint[];
}

const asString = (v: unknown): string => v as unknown as string;

/**
 * Symmetric, bi-directional index between skills and the proofs that evidence
 * them (R18.3). Forward (`proofsFor`) and reverse (`skillsFor`) lookups always
 * agree because each link is stored in both directions.
 */
export class ReferenceGraph {
  private readonly skillToProofs = new Map<string, Set<string>>();
  private readonly proofToSkills = new Map<string, Set<string>>();

  /** Record a skill ↔ proof link in both directions (R18.3). */
  addLink(skill: SkillId, proof: ProofRef): this {
    const s = asString(skill);
    const p = asString(proof);
    if (kindOf(p) === undefined) return this; // only STAR/BULLET proofs participate

    (this.skillToProofs.get(s) ?? this.skillToProofs.set(s, new Set()).get(s)!).add(p);
    (this.proofToSkills.get(p) ?? this.proofToSkills.set(p, new Set()).get(p)!).add(s);
    return this;
  }

  /** All proof ids (STAR + BULLET) evidencing a skill, sorted. */
  proofsFor(skill: SkillId): ProofRef[] {
    return [...(this.skillToProofs.get(asString(skill)) ?? [])]
      .sort()
      .map((p) => (kindOf(p) === 'STAR' ? asStarId(p) : asBulletId(p)));
  }

  /** The accomplishments (`BULLET-NN`) that prove a skill (R18.3), sorted. */
  accomplishmentsFor(skill: SkillId): BulletId[] {
    return [...(this.skillToProofs.get(asString(skill)) ?? [])]
      .filter((p) => kindOf(p) === 'BULLET')
      .sort()
      .map(asBulletId);
  }

  /** The talking points (`STAR-NN`) that prove a skill (R18.3), sorted. */
  talkingPointsFor(skill: SkillId): StarId[] {
    return [...(this.skillToProofs.get(asString(skill)) ?? [])]
      .filter((p) => kindOf(p) === 'STAR')
      .sort()
      .map(asStarId);
  }

  /** The skills a proof evidences (R18.3), sorted. */
  skillsFor(proof: ProofRef): SkillId[] {
    return [...(this.proofToSkills.get(asString(proof)) ?? [])].sort().map(asSkillId);
  }

  /** Whether a specific skill ↔ proof link exists. */
  hasLink(skill: SkillId, proof: ProofRef): boolean {
    return this.skillToProofs.get(asString(skill))?.has(asString(proof)) === true;
  }

  /** Every link as a `[skill, proof]` pair, sorted for determinism. */
  links(): [SkillId, ProofRef][] {
    const out: [SkillId, ProofRef][] = [];
    for (const [s, proofs] of this.skillToProofs) {
      for (const p of proofs) {
        out.push([asSkillId(s), kindOf(p) === 'STAR' ? asStarId(p) : asBulletId(p)]);
      }
    }
    return out.sort((a, b) =>
      asString(a[0]) === asString(b[0])
        ? asString(a[1]).localeCompare(asString(b[1]))
        : asString(a[0]).localeCompare(asString(b[0])),
    );
  }

  /** Number of distinct skills with at least one proof. */
  get skillCount(): number {
    return this.skillToProofs.size;
  }

  /** Number of distinct proofs with at least one skill. */
  get proofCount(): number {
    return this.proofToSkills.size;
  }
}

/**
 * Build the bi-directional skill ↔ accomplishment graph from the records that
 * live in the Memory Store (R18.2, R18.3). Links are drawn from:
 *   - each skill entry's STAR/BULLET evidence refs (skill → proof),
 *   - each accomplishment's `skills` list (BULLET → skill),
 *   - each talking point's `skills` list (STAR → skill).
 */
export const buildReferenceGraph = (input: ReferenceGraphInput = {}): ReferenceGraph => {
  const graph = new ReferenceGraph();

  for (const skill of input.skills ?? []) {
    for (const evidence of skill.evidence) {
      const ref = asString(evidence.ref);
      const kind = kindOf(ref);
      if (kind === 'STAR') graph.addLink(skill.id, asStarId(ref));
      else if (kind === 'BULLET') graph.addLink(skill.id, asBulletId(ref));
    }
  }

  for (const acc of input.accomplishments ?? []) {
    for (const skillId of acc.skills) {
      graph.addLink(skillId, acc.id);
    }
  }

  for (const tp of input.talkingPoints ?? []) {
    for (const skillId of tp.skills) {
      graph.addLink(skillId, tp.id);
    }
  }

  return graph;
};
