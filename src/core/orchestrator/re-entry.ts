// Re-entry triggers for the Career_Agent orchestrator (task 17.3; R35.3–R35.5).
//
// On return, a user does not always continue where they left off — they may
// arrive with something NEW. Requirement 35 names three such re-entry triggers,
// and every one reuses the EXISTING confirmed knowledge base rather than
// re-ingesting from scratch (design §Phase Pipeline: "New role"/"New job
// posting" jump directly to Phase 3 / Phase 5 using the existing skill map):
//
//   * R35.3 — a NEW JOB DESCRIPTION: parse it into required/preferred skills,
//     compare against the skill map with the Role_Matcher's ONTOLOGICAL matching
//     (reusing {@link scoreMatch} from `@core/role-matcher`, R20.3), identify the
//     gap skills, and propose a tailored CV (reusing {@link buildCvModel} from
//     `@core/output`). This module owns the pure parse → score → propose
//     pipeline; the orchestrator lands the pipeline in Phase 5 (output).
//   * R35.4 — a NEW DOCUMENT: merge it into the existing knowledge base using
//     the Requirement 9 conflict-resolution rules — reusing the Ingestion_Engine
//     {@link reconcile} rather than reimplementing the merge.
//   * R35.5 — a POST-INTERVIEW DEBRIEF: update talking points and note gaps from
//     the reported questions and answers — reusing the Interview_Coach
//     {@link refine}/{@link confirmTalkingPoint} (talking points) and
//     {@link detectNewSkills} (the skill-coverage gaps surfaced unapplied, R29).
//
// Everything here is pure and deterministic and touches NO provider: the
// default job-posting parser is a local, deterministic heuristic, so the
// Egress-Gate-only invariant from task 17.1 holds without the orchestrator
// importing a provider client. Callers that prefer LLM-assisted parsing inject
// their own {@link JobPostingParser} that routes through the Egress Gate; the
// orchestrator simply delegates to whatever parser it is given.
//
// Requirements: 35.3, 35.4, 35.5.

import type {
  QuestionId,
  RoleSlug,
  RolePreference,
  SkillId,
  SkillTerm,
  StarAnswer,
  StarFlag,
  StarId,
  TalkingPoint,
} from '@core/types';
import { asRoleSlug } from '@core/types';
import { scoreMatch, type MatchScore, type RoleSpec } from '@core/role-matcher';
import { buildCvModel, type ConfirmedEvidence, type CvModel } from '@core/output';
import { reconcile, type ExtractedDoc, type ReconcileResult } from '@core/ingestion';
import {
  confirmTalkingPoint,
  detectNewSkills,
  refine,
  type InterviewFile,
} from '@core/interview';
import type { SkillMap } from '@core/skills';
import type { SkillDelta } from '@core/types';
import { IdRegistry } from '@core/registry';

const asString = (v: unknown): string => v as unknown as string;

// --- R35.3: new job description -------------------------------------------

/**
 * A job posting parsed into the skills it expects (R35.3). `requiredSkills` are
 * the core skills the posting lists; `preferredSkills` are nice-to-haves. The
 * `title`/`description` are surfaced verbatim from the posting text.
 */
export interface ParsedJobPosting {
  /** A short title for the posting, taken verbatim from the text. */
  readonly title: string;
  /** A one-line description for the posting (the title when none is found). */
  readonly description: string;
  /** Core skills the posting requires — unmet ones become gaps (R35.3). */
  readonly requiredSkills: readonly string[];
  /** Nice-to-have skills that lift the score but never create a gap (R35.3). */
  readonly preferredSkills: readonly string[];
}

/**
 * Parses raw job-posting text into {@link ParsedJobPosting} (R35.3). Injected
 * into the orchestrator so the parsing strategy is pluggable: the default is a
 * local, deterministic heuristic (no provider), but a caller may supply an
 * LLM-assisted parser that routes through the Egress Gate. May be sync or async.
 */
export interface JobPostingParser {
  parse(text: string): ParsedJobPosting | Promise<ParsedJobPosting>;
}

/** Headers that open the REQUIRED-skills section of a posting (case-insensitive). */
const REQUIRED_HEADERS =
  /^\s*(required|requirements|must[- ]?haves?|qualifications|you (?:will )?(?:have|need)|skills?)\b/i;

/** Headers that open the PREFERRED-skills section of a posting (case-insensitive). */
const PREFERRED_HEADERS =
  /^\s*(preferred|nice[- ]?to[- ]?haves?|bonus|pluses?|a plus|desirable|good to have)\b/i;

/** Strip a leading list marker (`- `, `* `, `• `, `1. `) from a line. */
const stripBullet = (line: string): string =>
  line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();

/**
 * Split a single line into individual skill phrases. A line may hold one skill
 * or a comma/`/`/`;`-separated list; an inline `header: a, b, c` form is split
 * on the colon first so the header word is dropped. Empty fragments are removed.
 */
const skillsFromLine = (line: string): string[] => {
  const afterColon = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;
  return afterColon
    .split(/[,/;]|\band\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 60);
};

/**
 * The default local job-posting parser (R35.3). Deterministic and provider-free:
 * the first non-empty line is the title, and each subsequent line is bucketed
 * into required/preferred skills by the most recent `Required:`/`Preferred:`
 * style header it follows (defaulting to required). Inline `header: a, b` lists
 * and bulleted lists are both handled. Nothing is fabricated — only phrases the
 * posting actually contains are returned.
 */
export const parseJobPosting = (text: string): ParsedJobPosting => {
  const lines = text.split(/\r?\n/);
  const required: string[] = [];
  const preferred: string[] = [];
  let title = '';
  let bucket: 'required' | 'preferred' = 'required';

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (title === '') {
      title = stripBullet(line);
      continue;
    }
    if (PREFERRED_HEADERS.test(line)) {
      bucket = 'preferred';
      // An inline `Preferred: a, b` header still carries skills on the same line.
      if (line.includes(':')) preferred.push(...skillsFromLine(line));
      continue;
    }
    if (REQUIRED_HEADERS.test(line)) {
      bucket = 'required';
      if (line.includes(':')) required.push(...skillsFromLine(line));
      continue;
    }
    const skills = skillsFromLine(stripBullet(line));
    (bucket === 'preferred' ? preferred : required).push(...skills);
  }

  const dedupe = (xs: string[]): string[] => [...new Set(xs)];
  return {
    title: title || 'Target Role',
    description: title || 'Target Role',
    requiredSkills: dedupe(required),
    preferredSkills: dedupe(preferred),
  };
};

/** The provider-free default parser used when none is injected (R35.3). */
export const DEFAULT_JOB_POSTING_PARSER: JobPostingParser = {
  parse: parseJobPosting,
};

/**
 * The result of matching a parsed job posting against the existing skill map
 * (R35.3). It carries the estimate-labelled skill-match score (never a
 * guarantee, R20.2), the user's own skills that satisfied a requirement, the
 * gap skills to develop, and the tailored CV proposed from confirmed evidence.
 */
export interface RoleMatch {
  /** Deterministic, URL-safe slug derived from the posting title. */
  readonly slug: string;
  /** The posting title parsed from the text. */
  readonly title: string;
  /** Estimate-labelled skill-match score against the skill map (R20.2, R35.3). */
  readonly score: MatchScore;
  /** The user's own skills that satisfied a required/preferred skill (R35.3). */
  readonly matchedSkills: readonly SkillId[];
  /** Required skills no owned skill satisfied — the gaps to develop (R35.3). */
  readonly gapSkills: readonly SkillTerm[];
  /** The tailored CV proposed from confirmed evidence for this posting (R35.3). */
  readonly proposedCv: CvModel;
}

/** Deterministic, URL-safe slug from a posting title (mirrors the role-matcher). */
const slugify = (title: string): string => {
  const base = title
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/#/g, 'sharp')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.length > 0 ? base : 'role';
};

/**
 * Match a parsed job posting against the existing confirmed evidence and propose
 * a tailored CV (R35.3). Reuses the Role_Matcher's ontological {@link scoreMatch}
 * (R20.3) to compute matched-vs-gap skills against the skill map, promotes the
 * posting to a {@link RolePreference} carrying that estimate, and reuses
 * {@link buildCvModel} to derive the role-tailored CV from the SAME confirmed
 * evidence (R30). Pure and deterministic; no re-ingestion, no provider.
 */
export const matchJobPosting = (
  posting: ParsedJobPosting,
  evidence: ConfirmedEvidence,
): RoleMatch => {
  const spec: RoleSpec = {
    title: posting.title,
    description: posting.description,
    roleType: 'employed', // a job posting is an employed position (R20.1)
    requiredSkills: posting.requiredSkills,
    preferredSkills: posting.preferredSkills,
  };
  const score = scoreMatch(spec, evidence.skillMap);
  const slug = slugify(posting.title);

  // Promote the scored posting to a RolePreference so the CV builder can
  // prioritise content toward it (R30.2). The rank/tag are defaults — this is a
  // proposal for a freshly-supplied posting, not a user-ranked preference.
  const role: RolePreference = {
    slug: asRoleSlug(slug),
    title: posting.title,
    description: posting.description,
    matchScore: score.score,
    matchedSkills: score.matchedSkills,
    gapSkills: score.gapSkills,
    rationale: score.rationale,
    rank: 1,
    tag: 'actively_applying',
  };

  const proposedCv = buildCvModel(role, evidence);

  return {
    slug,
    title: posting.title,
    score,
    matchedSkills: score.matchedSkills,
    gapSkills: score.gapSkills,
    proposedCv,
  };
};

// --- R35.4: new document ---------------------------------------------------

/**
 * Merge a newly-uploaded document into the existing knowledge base using the
 * Requirement 9 conflict-resolution rules (R35.4). Reuses the Ingestion_Engine
 * {@link reconcile} over the existing documents plus the new one, so the richest
 * description is merged (R9.1), every differing field is recorded as a conflict
 * with all candidate values (R9.2), and the default recommendation follows the
 * recency/detail rule (R9.3). Pure; the orchestrator persists the result.
 */
export const mergeDocument = (
  existing: readonly ExtractedDoc[],
  incoming: ExtractedDoc,
): ReconcileResult => reconcile([...existing, incoming]);

// --- R35.5: post-interview debrief -----------------------------------------

/** One reported question/answer from a post-interview debrief (R35.5). */
export interface DebriefAnswer {
  /** The STAR answer the user reports having given. */
  readonly answer: StarAnswer;
  /** Skills the answer evidences, linked onto the confirmed talking point (R29.3). */
  readonly skills?: readonly SkillId[];
}

/** A post-interview debrief: the role plus the reported questions/answers (R35.5). */
export interface InterviewDebrief {
  /** The role the interview was for. */
  readonly roleSlug: RoleSlug;
  /** The role title (human-readable; defaults to the slug). */
  readonly roleTitle?: string;
  /** The reported questions/answers from the interview. */
  readonly answers: readonly DebriefAnswer[];
  /**
   * An existing interview file to update; its questions/talking points are
   * carried forward so gap detection sees the full session. A fresh, empty file
   * is assumed when omitted.
   */
  readonly interview?: InterviewFile;
}

/** A STAR-element gap noted from a reported answer (R35.5). */
export interface DebriefGap {
  /** The confirmed talking point carrying the gap. */
  readonly talkingPoint: StarId;
  /** The question the gap belongs to. */
  readonly questionId: QuestionId;
  /** The missing-element flags raised on the answer (R25.1). */
  readonly flags: readonly StarFlag[];
}

/** The outcome of a post-interview debrief (R35.5). */
export interface DebriefResult {
  /** The updated/confirmed talking points from the reported answers (R28, R35.5). */
  readonly talkingPoints: readonly TalkingPoint[];
  /** The STAR-element gaps noted from the reported answers (R25.1, R35.5). */
  readonly gaps: readonly DebriefGap[];
  /**
   * Skills the reported answers revealed that are NOT yet in the skill map,
   * surfaced UNAPPLIED for explicit confirmation (R29.1, R29.2, R35.5).
   */
  readonly skillDelta: SkillDelta;
}

/**
 * Process a post-interview debrief (R35.5): for each reported answer, refine it
 * into a talking point and confirm it (minting a stable `STAR-NN` id via the
 * registry, reusing {@link refine}/{@link confirmTalkingPoint}), note any
 * missing-STAR-element gaps the answer still carries (R25.1), and detect the
 * skills the answers revealed that the map does not yet represent — surfaced
 * UNAPPLIED for confirmation via {@link detectNewSkills} (R29). The talking
 * points are the "updated talking points" and the flags + skill delta are the
 * "noted gaps" R35.5 calls for. Pure aside from the id mint delegated to the
 * registry; never mutates its inputs.
 */
export const processDebrief = (
  debrief: InterviewDebrief,
  skillMap: SkillMap,
  registry: IdRegistry,
): DebriefResult => {
  const talkingPoints: TalkingPoint[] = [];
  const gaps: DebriefGap[] = [];

  for (const { answer, skills } of debrief.answers) {
    const draft = refine(answer, { skills: skills ? [...skills] : [] });
    const talkingPoint = confirmTalkingPoint(draft, registry);
    talkingPoints.push(talkingPoint);
    if (talkingPoint.flags.length > 0) {
      gaps.push({
        talkingPoint: talkingPoint.id,
        questionId: answer.questionId,
        flags: [...talkingPoint.flags],
      });
    }
  }

  // Assemble the updated session (carrying any prior questions/talking points)
  // so skill-coverage gap detection sees everything the interview surfaced.
  const session: InterviewFile = {
    roleSlug: debrief.roleSlug,
    roleTitle: debrief.roleTitle ?? asString(debrief.roleSlug),
    questions: debrief.interview?.questions ?? [],
    talkingPoints: [...(debrief.interview?.talkingPoints ?? []), ...talkingPoints],
  };

  const skillDelta = detectNewSkills(session, skillMap);
  return { talkingPoints, gaps, skillDelta };
};

// --- Collaborators (DI) ----------------------------------------------------

/**
 * Reads the user's confirmed evidence for re-entry matching (R35.3, R35.5).
 * Injected into the orchestrator so it never re-ingests on re-entry — the new
 * job description / debrief is scored against the EXISTING skill map and built
 * into a CV from the EXISTING proofs. Touches no provider, so the Egress-Gate-
 * only invariant holds. `read` may be sync or async.
 */
export interface ConfirmedEvidenceReader {
  read(): ConfirmedEvidence | Promise<ConfirmedEvidence>;
}

/**
 * Reads the existing knowledge base (the already-ingested documents) for the
 * new-document merge (R35.4). Injected so the orchestrator merges a new upload
 * against what is already confirmed rather than re-ingesting. `read` may be sync
 * or async.
 */
export interface KnowledgeBaseReader {
  read(): readonly ExtractedDoc[] | Promise<readonly ExtractedDoc[]>;
}
