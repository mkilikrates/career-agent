// Skill-map update from interview answers (R29).
//
// When a coaching session ENDS, the Interview_Coach reconciles what the user
// revealed during coaching against their skill map (the design's
// `syncSkillMap(session): SkillDelta`). Requirement 29 is a TRUST guarantee with
// three parts:
//
//   * R29.1 — at session end, detect whether any answers reveal skills, roles,
//     or achievements NOT yet in the skill map.
//   * R29.2 — surface the newly-revealed items to the user for EXPLICIT
//     confirmation before adding anything.
//   * R29.3 — only on confirmation, update the skill map with the new evidence
//     and the corresponding accomplishment (BULLET) and STAR links.
//
// The No-Fabrication rule (Property 1) constrains detection: a newly-detected
// skill must come from the user's OWN confirmed answer content, never inferred
// from a job title. A "coaching session" is an {@link InterviewFile}; the
// session's CONFIRMED talking points carry both the user's polished (firewall-
// stripped) content and the skill ids that content evidences, so they are the
// honest, delivery-invariant source of newly-revealed skills. Retired talking
// points are not mined (R23.3).
//
// Two phases, mirroring R29.1/R29.2 vs R29.3:
//
//   1. {@link detectNewSkills} / {@link syncSkillMap} reads the session and the
//      current map and returns a {@link SkillDelta} of candidates — skills the
//      confirmed talking points reference that the map does not yet represent
//      (compared by the SAME canonical slug the skill map mints ids from, so a
//      differently-cased variant is never re-proposed). The delta is a PROPOSAL
//      only; nothing is applied (R29.1, R29.2).
//   2. {@link applySkillDelta} adds ONLY the candidates the user explicitly
//      confirmed, reusing the Skill_Mapper's {@link addUserSkill} (which honours
//      R19.2 — a user-added skill needs role/project + when) and
//      {@link linkEvidence} to wire the STAR (and any accomplishment BULLET)
//      links bi-directionally through the reference graph (R18.3, R29.3).
//      Unconfirmed candidates are never added (R29.2).
//
// Detection is pure and deterministic; applying mutates the supplied map in
// place (matching {@link addUserSkill}/{@link linkEvidence}) and returns the
// created entries. Framework-agnostic: no I/O, no providers.

import type {
  BulletId,
  SkillCandidate,
  SkillCategory,
  SkillDelta,
  SkillId,
  SkillMapEntry,
  StarId,
  TalkingPoint,
} from '@core/types';
import { asISODate, asSkillId } from '@core/types';
import { IdRegistry } from '@core/registry';
import { addUserSkill, linkEvidence, skillSlug, type SkillMap } from '@core/skills';
import type { InterviewFile } from './interview-document';

const asString = (v: unknown): string => v as unknown as string;

/**
 * A coaching session, for the purposes of R29: the per-role interview file whose
 * captured answers and confirmed talking points are mined when the session ends.
 * Aliased to {@link InterviewFile} so the design's `syncSkillMap(session)` reads
 * naturally while reusing the single persisted session shape.
 */
export type CoachingSession = InterviewFile;

/** The `SKILL-` id prefix the Skill_Mapper mints (see `skillSlug`/`generate`). */
const SKILL_ID_PREFIX = 'SKILL-';

/** The canonical slug carried by a skill id (`SKILL-<slug>` → `<slug>`). */
const slugOfSkillId = (id: SkillId): string =>
  asString(id).startsWith(SKILL_ID_PREFIX)
    ? asString(id).slice(SKILL_ID_PREFIX.length)
    : skillSlug(asString(id));

/**
 * The set of canonical slugs already represented in the map (R29.1). Both the
 * entry id's slug and the entry NAME's slug are included so a differently-cased
 * or differently-spaced phrasing of the same skill is recognised as present and
 * never re-proposed (compared via the same `skillSlug` the map mints ids with).
 */
const presentSlugs = (map: SkillMap): Set<string> => {
  const slugs = new Set<string>();
  for (const entry of map.entries) {
    slugs.add(slugOfSkillId(entry.id));
    slugs.add(skillSlug(entry.name));
  }
  return slugs;
};

/** The CONFIRMED, non-retired talking points mined for revealed skills (R23.3). */
const activeTalkingPoints = (session: CoachingSession): TalkingPoint[] =>
  (session.talkingPoints ?? []).filter((tp) => tp.retired !== true);

/**
 * Detect the skills a coaching session revealed that are NOT yet in the skill
 * map (R29.1). Mines the session's CONFIRMED talking points only — each one
 * carries the user's polished, firewall-stripped (delivery-invariant) content
 * and the skill ids that content evidences — so a candidate always derives from
 * the user's own answer, never from a job title (No-Fabrication, Property 1).
 * A referenced skill is a candidate when its canonical slug is absent from the
 * map; candidates are grouped by slug and carry every talking point (STAR id +
 * content) they surfaced in, so a later confirmation can wire the proof links
 * (R29.3). The returned {@link SkillDelta} is a PROPOSAL only — nothing is
 * applied here (R29.2). Pure; never mutates the session or the map.
 */
export const detectNewSkills = (
  session: CoachingSession,
  map: SkillMap,
): SkillDelta => {
  const present = presentSlugs(map);
  // Group candidates by canonical slug so two talking points naming the same
  // new skill collapse into one candidate carrying both pieces of evidence.
  const bySlug = new Map<string, SkillCandidate>();

  for (const tp of activeTalkingPoints(session)) {
    for (const skill of tp.skills) {
      const slug = slugOfSkillId(skill);
      if (slug.length === 0 || present.has(slug)) continue; // already represented

      const existing = bySlug.get(slug);
      const evidence = { talkingPoint: tp.id, content: tp.polished };
      if (existing) {
        existing.evidence.push(evidence);
      } else {
        bySlug.set(slug, { skill, slug, evidence: [evidence] });
      }
    }
  }

  // Deterministic ordering by slug for a stable, reviewable proposal set.
  const candidates = [...bySlug.values()].sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
  );
  return { candidates };
};

/**
 * Reconcile a coaching session against the skill map (R29) — the design's
 * `syncSkillMap(session)`. Identical to {@link detectNewSkills}: it surfaces the
 * newly-revealed candidates UNAPPLIED for explicit user confirmation (R29.1,
 * R29.2). Apply the confirmed subset with {@link applySkillDelta}.
 */
export const syncSkillMap = detectNewSkills;

/**
 * A per-answer detected-skill source mined at the end of an AI coaching session
 * (R63.8): a single per-question summary (the 31.4 {@link PerQuestionSummary})
 * whose `skills` were drawn ONLY from the candidate's own words (R63.6, R63.7).
 * Typed structurally — only the per-answer `skills` matter — so this never
 * couples to the full summary shape; a {@link PerQuestionSummary} satisfies it.
 */
export interface DetectedSkillSource {
  /** Skills the answer evidenced, derived only from the user's words (R63.6, R63.7). */
  readonly skills: readonly string[];
}

/**
 * Detect the skills an AI coaching SESSION revealed that are NOT yet in the
 * skill map (R63.8), unioned across every per-question summary's per-answer
 * `skills` (R63.6). Unlike {@link detectNewSkills} — which mines the session's
 * CONFIRMED talking points (`SkillId` references with STAR evidence) — this
 * mines the adaptive loop's per-question summaries, whose skills are plain names
 * drawn ONLY from the candidate's own words (R63.7, No-Fabrication) and never
 * from a job title.
 *
 * The union is de-duplicated by the SAME canonical slug the skill map mints ids
 * from ({@link skillSlug}), so differently-cased or differently-spaced phrasings
 * of one skill collapse to a single candidate, and any name whose slug is
 * already represented in the map is EXCLUDED (matching {@link detectNewSkills}'s
 * dedupe/normalisation convention via {@link presentSlugs}). Each candidate is
 * minted with the deterministic `SKILL-<slug>` id and carries NO talking-point
 * evidence — a per-question summary is a display artefact with no STAR id, so
 * the polished talking points are confirmed and linked SEPARATELY through the
 * existing refine → `confirmTalkingPoint` path.
 *
 * The returned {@link SkillDelta} is a PROPOSAL only (R63.8, R29.2): it is
 * surfaced UNAPPLIED for explicit user confirmation, and the user-confirmed
 * subset is added with {@link applySkillDelta} — the SAME confirm-before-add
 * flow as {@link detectNewSkills} — which adds only confirmed candidates
 * (R29.3). Pure and deterministic (candidates sorted by slug); never mutates the
 * map.
 */
export const detectSessionSkills = (
  summaries: readonly DetectedSkillSource[],
  map: SkillMap,
): SkillDelta => {
  const present = presentSlugs(map);
  // Group by canonical slug so two answers naming the same new skill (in any
  // casing/spacing) collapse into one candidate, and in-map skills are excluded.
  const bySlug = new Map<string, SkillCandidate>();

  for (const summary of summaries) {
    for (const name of summary.skills) {
      const slug = skillSlug(name);
      if (slug.length === 0 || present.has(slug) || bySlug.has(slug)) continue;
      bySlug.set(slug, {
        skill: asSkillId(`${SKILL_ID_PREFIX}${slug}`),
        slug,
        evidence: [],
      });
    }
  }

  // Deterministic ordering by slug for a stable, reviewable proposal set.
  const candidates = [...bySlug.values()].sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
  );
  return { candidates };
};

/**
 * A user's explicit confirmation that a detected candidate is a real skill to
 * add (R29.2, R29.3). It carries the user's own phrasing and the role/project +
 * approximate time the Skill_Mapper requires for any hand-added skill (R19.2),
 * plus any accomplishment (`BULLET-NN`) ids to link alongside the talking-point
 * (`STAR-NN`) evidence the candidate already carries (R29.3).
 */
export interface SkillConfirmation {
  /** The candidate skill being confirmed — must match a {@link SkillDelta} candidate. */
  readonly skill: SkillId;
  /** The user's own phrasing for the skill (R17.3, R19.2). */
  readonly name: string;
  /** The role or project the skill was used in (R19.2, required). */
  readonly roleOrProject: string;
  /** The approximate time the skill was used (R19.2, required). */
  readonly when: string;
  /** Optional explicit category; inferred from the name when omitted (R14.1). */
  readonly category?: SkillCategory;
  /** Optional accomplishment (`BULLET-NN`) ids to link as evidence too (R29.3). */
  readonly accomplishments?: readonly BulletId[];
}

/** Options for {@link applySkillDelta}. */
export interface ApplySkillDeltaOptions {
  /**
   * The stable-id registry (R18, R23). When supplied, every STAR/BULLET id being
   * linked is recorded as allocated so the proof ids stay reserved and are never
   * reissued or renumbered (R18.4, R23.2).
   */
  readonly registry?: IdRegistry;
}

/**
 * Apply ONLY the user-confirmed candidates from a {@link SkillDelta} to the map
 * (R29.2, R29.3). For each confirmation that matches a detected candidate, adds
 * the new skill via {@link addUserSkill} — which enforces R19.2 (role/project +
 * approximate time required, else it throws `MissingSkillContextError`) and
 * records a user-confirmation provenance — then wires the candidate's talking
 * point (`STAR-NN`) evidence and any confirmed accomplishment (`BULLET-NN`)
 * evidence bi-directionally through {@link linkEvidence} (R29.3, R18.3). A
 * confirmation whose skill is NOT in the delta is ignored, so unconfirmed
 * candidates are never added (R29.2). Mutates the map in place and returns the
 * entries created, in input order.
 */
export const applySkillDelta = (
  map: SkillMap,
  delta: SkillDelta,
  confirmations: readonly SkillConfirmation[],
  options: ApplySkillDeltaOptions = {},
): SkillMapEntry[] => {
  const candidateBySkill = new Map(
    delta.candidates.map((c) => [asString(c.skill), c]),
  );

  const applied: SkillMapEntry[] = [];
  for (const confirmation of confirmations) {
    const candidate = candidateBySkill.get(asString(confirmation.skill));
    if (candidate === undefined) continue; // only confirmed delta candidates (R29.2)

    // R19.2 (role/project + when) is enforced inside addUserSkill, which also
    // records the user-confirmation provenance for the new evidence (R29.3).
    const entry = addUserSkill(map, {
      name: confirmation.name,
      roleOrProject: confirmation.roleOrProject,
      when: confirmation.when,
      category: confirmation.category,
    });

    // The corresponding STAR (and any BULLET) proof links (R29.3, R18.3).
    const starRefs: StarId[] = candidate.evidence.map((e) => e.talkingPoint);
    const bulletRefs: readonly BulletId[] = confirmation.accomplishments ?? [];
    const refs = [...starRefs, ...bulletRefs];

    // Keep the proof ids allocated in the registry so they are never reissued.
    if (options.registry) {
      for (const ref of refs) options.registry.seed([asString(ref)]);
    }

    linkEvidence(
      map,
      entry.id,
      refs,
      asISODate(confirmation.when),
      `Revealed during interview coaching — used in ${confirmation.roleOrProject.trim()}.`,
    );

    applied.push(entry);
  }
  return applied;
};
