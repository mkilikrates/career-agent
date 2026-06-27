// Per-role interview-file persistence — serialize / parse / save
// `interviews/interview_[role_slug].md` (R22.3, R34.1, R34.2).
//
// The Interview_Coach stores the generated questions (and, in later phases, the
// captured responses and confirmed talking points) in a per-role interview file
// in the Memory Store (R22.3). This module owns that persistence, mirroring the
// skill-map and role-preference documents:
//
// The Memory Store is a Markdown-as-database (R34.1): every entity is plain,
// human-readable Markdown carrying its stable identifier as an HTML anchor
// comment mirrored into the frontmatter `ids:` list (see `@core/markdown`).
// Following that pattern, each {@link Question} is rendered as one Markdown
// section under a `## Questions` heading — a decorative heading, a
// `<!-- id: Q-NN -->` anchor, and the question's fields (category, STAR framing,
// the grounded skill or gap, and the prompt) — and the `Q-*` ids are mirrored
// into the document frontmatter. The owning role's slug and title live in the
// frontmatter so the file round-trips back to a fully-formed {@link InterviewFile}.
//
// Two guarantees, mirroring the rest of the store:
//   1. Lossless round trip (R34.2): {@link parseInterview} ∘
//      {@link serializeInterview} recovers the interview file, and the
//      serialized string is a fixpoint of parse → serialize. Free-text prompts
//      are normalised to a single line on render (the line-based store's
//      contract). Section headings are derived from the question fields, so the
//      parser never depends on them and re-serialization reproduces them.
//   2. Per-role persistence (R22.3): {@link saveInterview} writes the canonical
//      `interviews/interview_[role_slug].md` path through any Storage_Adapter /
//      MemoryTree writer.
//
// The structure deliberately scopes questions under a `## Questions` heading so
// later subtasks (12.2 responses, 12.6 talking points) can append sibling
// `## Responses` / `## Talking Points` sections without disturbing this one.

import type {
  MemoryPath,
  Question,
  QuestionCategory,
  QuestionId,
  ResponseStatus,
  RoleSlug,
  StarAnswer,
  StarElement,
  StarFlag,
  TalkingPoint,
} from '@core/types';
import {
  asQuestionId,
  asRoleSlug,
  asSkillId,
  asSkillTerm,
  asStarId,
} from '@core/types';
import { anchorComment, parseMarkdown, serializeMarkdown } from '@core/markdown';
import { interviewPath } from '@core/storage';
import type { SkillMap } from '@core/skills';
import type { RolePreference } from '@core/types';
import { generateQuestions } from './questions';
import {
  STAR_ORDER,
  flagToElement,
  progress,
  recommendationFor,
} from './coach';
import type { ProgressIndicator } from './coach';

const asString = (v: unknown): string => v as unknown as string;

/** Collapse a value to a single line so it cannot corrupt the line-based document. */
const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/** Title heading written at the top of every interview document. */
export const INTERVIEW_HEADING = '# Interview';

/** Heading that scopes the generated-question sections (R22.3). */
export const QUESTIONS_HEADING = '## Questions';

/** Heading that scopes the captured/in-progress response sections (R24, R25). */
export const RESPONSES_HEADING = '## Responses';

/** Heading that scopes the confirmed talking-point sections (R28.4, R23). */
export const TALKING_POINTS_HEADING = '## Talking Points';

/** Frontmatter key carrying the owning role slug. */
const ROLE_KEY = 'role';
/** Frontmatter key carrying the owning role title. */
const TITLE_KEY = 'title';
/** Frontmatter key carrying the mid-question resume cursor (R25.4). */
const CURSOR_KEY = 'cursor';

/**
 * A per-role interview file: the role it belongs to plus the generated
 * questions. Later subtasks extend the on-disk document with responses and
 * talking points; this shape covers what task 12.1 persists.
 */
export interface InterviewFile {
  /** Owning role slug — keys the canonical interview path (R22.3). */
  roleSlug: RoleSlug;
  /** Owning role title (human-readable; kept verbatim). */
  roleTitle: string;
  /** The generated, role-grounded questions (R22.1, R22.2). */
  questions: Question[];
  /**
   * Captured or in-progress answers, one per question worked on (R24, R25).
   * Omitted entirely when no question has been started, so a freshly-built
   * interview file is unchanged from the question-only shape. Persisting these
   * is what lets a session resume mid-question with flags intact (R25.2, R25.4).
   */
  responses?: StarAnswer[];
  /**
   * The 0-based index of the question the session is paused on, so the next
   * session resumes at exactly that point (R25.4). Omitted when the session has
   * not advanced past the first question.
   */
  cursor?: number;
  /**
   * Confirmed talking points with their stable `STAR-NN` ids (R28.3, R28.4).
   * Retired talking points stay in this list marked `retired: true` rather than
   * being deleted (R23.3). Omitted entirely until the first talking point is
   * confirmed, so a response-only interview file is unchanged.
   */
  talkingPoints?: TalkingPoint[];
}

// --- Serialize --------------------------------------------------------------

/** Human-readable label for a question category (decorative heading only). */
const categoryLabel = (category: QuestionCategory): string => {
  switch (category) {
    case 'behavioural':
      return 'Behavioural';
    case 'gap':
      return 'Skill gap';
    case 'motivation':
      return 'Professional motivation';
  }
};

/** Decorative section heading, derived purely from the question's fields. */
const questionHeading = (q: Question): string => {
  const label = categoryLabel(q.category);
  if (q.category === 'behavioural' && q.skill !== undefined) {
    return `### ${label} — \`${asString(q.skill)}\``;
  }
  if (q.category === 'gap' && q.gap !== undefined) {
    return `### ${label} — ${oneLine(asString(q.gap))}`;
  }
  return `### ${label}`;
};

/** Render one question as a Markdown section (R34.1). */
const renderQuestion = (q: Question): string[] => {
  const lines: string[] = [
    questionHeading(q),
    '',
    anchorComment(asString(q.id)),
    '',
    `- **Category:** ${q.category}`,
    `- **STAR-framed:** ${q.starFramed ? 'yes' : 'no'}`,
  ];
  if (q.skill !== undefined) {
    lines.push(`- **Skill:** \`${asString(q.skill)}\``);
  }
  if (q.gap !== undefined) {
    lines.push(`- **Gap:** \`${asString(q.gap)}\``);
  }
  lines.push(`- **Prompt:** ${oneLine(q.prompt)}`);
  return lines;
};

// Response rendering (R24, R25). Each answer is one Markdown section under the
// `## Responses` heading: a decorative heading, the question it answers, its
// loop status, whichever STAR elements have been captured, and any
// missing-element flags. A `Recommendation` line is emitted per flag (R25.5);
// it is derived from the flag, so the parser ignores it and re-serialization
// reproduces it — keeping the round trip lossless.

/** Human-readable label for a STAR element (decorative). */
const elementLabel: Readonly<Record<StarElement, string>> = {
  situation: 'Situation',
  task: 'Task',
  action: 'Action',
  result: 'Result',
};

/** Render one captured/in-progress answer as a Markdown section (R24, R25). */
const renderResponse = (a: StarAnswer): string[] => {
  const lines: string[] = [
    `### Response — ${asString(a.questionId)}`,
    '',
    `- **Question:** ${asString(a.questionId)}`,
    `- **Status:** ${a.status}`,
  ];
  for (const element of STAR_ORDER) {
    const value = a[element];
    if (value !== undefined && value !== '') {
      lines.push(`- **${elementLabel[element]}:** ${oneLine(value)}`);
    }
  }
  if (a.flags.length > 0) {
    lines.push(`- **Flags:** ${a.flags.join(', ')}`);
    // Later-recommendation per flag (derived from the flag; R25.5).
    for (const flag of a.flags) {
      lines.push(
        `- **Recommendation (${flag}):** ${oneLine(recommendationFor(flagToElement(flag)))}`,
      );
    }
  }
  return lines;
};

// Talking-point rendering (R28.3, R28.4, R23). Each confirmed talking point is
// one Markdown section under the `## Talking Points` heading: a decorative
// heading, its stable `STAR-NN` id as an anchor comment, its status
// (active/retired, R23.3), whichever STAR elements it carries, any flags, the
// linked skills, and the polished first-person past-tense text (R28.3). All
// fields are emitted on a single line so the round trip stays lossless.

/** Render one confirmed talking point as a Markdown section (R28.4, R23). */
const renderTalkingPoint = (tp: TalkingPoint): string[] => {
  const lines: string[] = [
    `### Talking Point — ${asString(tp.id)}`,
    '',
    anchorComment(asString(tp.id)),
    '',
    `- **Status:** ${tp.retired === true ? 'retired' : 'active'}`,
  ];
  for (const element of STAR_ORDER) {
    const value = tp[element];
    if (value !== undefined && value !== '') {
      lines.push(`- **${elementLabel[element]}:** ${oneLine(value)}`);
    }
  }
  if (tp.flags.length > 0) {
    lines.push(`- **Flags:** ${tp.flags.join(', ')}`);
  }
  if (tp.skills.length > 0) {
    lines.push(`- **Skills:** ${tp.skills.map(asString).join(', ')}`);
  }
  lines.push(`- **Polished:** ${oneLine(tp.polished)}`);
  return lines;
};

/**
 * Serialize an interview file to the canonical `interview_[role_slug].md`
 * Markdown (R22.3, R34.1). Each question becomes a human-readable section
 * carrying its stable `Q-*` id as an anchor comment; the ids are mirrored into
 * the document frontmatter alongside the owning role slug and title (R34.2).
 * Questions are emitted in their given order. Deterministic: the output depends
 * only on the interview file.
 */
export const serializeInterview = (file: InterviewFile): string => {
  const body: string[] = [INTERVIEW_HEADING, '', QUESTIONS_HEADING, ''];
  for (const q of file.questions) {
    body.push(...renderQuestion(q), '');
  }
  // Sibling `## Responses` section, only when answers exist (R24, R25).
  const responses = file.responses ?? [];
  if (responses.length > 0) {
    body.push(RESPONSES_HEADING, '');
    for (const a of responses) {
      body.push(...renderResponse(a), '');
    }
  }
  // Sibling `## Talking Points` section, only when confirmed points exist (R28.4).
  const talkingPoints = file.talkingPoints ?? [];
  if (talkingPoints.length > 0) {
    body.push(TALKING_POINTS_HEADING, '');
    for (const tp of talkingPoints) {
      body.push(...renderTalkingPoint(tp), '');
    }
  }
  const ids = [
    ...file.questions.map((q) => asString(q.id)),
    ...talkingPoints.map((tp) => asString(tp.id)),
  ];
  const frontmatter: Record<string, unknown> = {
    [ROLE_KEY]: asString(file.roleSlug),
    [TITLE_KEY]: oneLine(file.roleTitle),
  };
  // Persist the mid-question resume cursor when set (R25.4).
  if (file.cursor !== undefined) {
    frontmatter[CURSOR_KEY] = file.cursor;
  }
  return serializeMarkdown({
    frontmatter,
    ids,
    body: `${body.join('\n')}\n`,
  });
};

// --- Parse ------------------------------------------------------------------

const HEADING = /^### /;
const H2 = /^## (.+)$/;
const ANCHOR = /^<!--\s*id:\s*(\S+)\s*-->$/;
const CATEGORY = /^- \*\*Category:\*\* (.*)$/;
const STAR_FRAMED = /^- \*\*STAR-framed:\*\* (.*)$/;
const SKILL = /^- \*\*Skill:\*\* `([^`]*)`$/;
const GAP = /^- \*\*Gap:\*\* `([^`]*)`$/;
const PROMPT = /^- \*\*Prompt:\*\* (.*)$/;

// Response field lines (R24, R25). Recommendation lines are intentionally not
// matched: they are derived from the flags on re-serialize (R25.5).
const RESP_QUESTION = /^- \*\*Question:\*\* (.*)$/;
const RESP_STATUS = /^- \*\*Status:\*\* (.*)$/;
const RESP_SITUATION = /^- \*\*Situation:\*\* (.*)$/;
const RESP_TASK = /^- \*\*Task:\*\* (.*)$/;
const RESP_ACTION = /^- \*\*Action:\*\* (.*)$/;
const RESP_RESULT = /^- \*\*Result:\*\* (.*)$/;
const RESP_FLAGS = /^- \*\*Flags:\*\* (.*)$/;

// Talking-point field lines (R28.4, R23). The polished text and skills mirror
// the response shape; `Status` carries the retired marker (R23.3).
const TP_STATUS = /^- \*\*Status:\*\* (.*)$/;
const TP_SITUATION = /^- \*\*Situation:\*\* (.*)$/;
const TP_TASK = /^- \*\*Task:\*\* (.*)$/;
const TP_ACTION = /^- \*\*Action:\*\* (.*)$/;
const TP_RESULT = /^- \*\*Result:\*\* (.*)$/;
const TP_FLAGS = /^- \*\*Flags:\*\* (.*)$/;
const TP_SKILLS = /^- \*\*Skills:\*\* (.*)$/;
const TP_POLISHED = /^- \*\*Polished:\*\* (.*)$/;

/** A category is one of the closed set; default defensively to behavioural. */
const isCategory = (v: string): v is QuestionCategory =>
  v === 'behavioural' || v === 'gap' || v === 'motivation';

/** Mutable accumulator for a question being parsed. */
interface PartialQuestion {
  id?: string;
  category: QuestionCategory;
  starFramed: boolean;
  prompt: string;
  skill?: string;
  gap?: string;
}

const newPartial = (): PartialQuestion => ({
  category: 'behavioural',
  starFramed: false,
  prompt: '',
});

/** Finalise a partial into a {@link Question} (ids/grounding defaulted defensively). */
const finalise = (p: PartialQuestion, fallbackIndex: number): Question => {
  const q: Question = {
    id: asQuestionId(p.id ?? `Q-${String(fallbackIndex + 1).padStart(2, '0')}`),
    category: p.category,
    starFramed: p.starFramed,
    prompt: p.prompt,
  };
  if (p.skill !== undefined) q.skill = asSkillId(p.skill);
  if (p.gap !== undefined) q.gap = asSkillTerm(p.gap);
  return q;
};

/** A status is one of the closed set; default defensively to in_progress. */
const isStatus = (v: string): v is ResponseStatus =>
  v === 'in_progress' ||
  v === 'complete' ||
  v === 'soft_closed' ||
  v === 'passed';

/** A flag is one of the closed set. */
const isFlag = (v: string): v is StarFlag =>
  v === 'needs_metric' ||
  v === 'needs_action' ||
  v === 'needs_situation' ||
  v === 'needs_task';

/** Mutable accumulator for a response being parsed. */
interface PartialResponse {
  questionId?: string;
  status: ResponseStatus;
  situation?: string;
  task?: string;
  action?: string;
  result?: string;
  flags: StarFlag[];
}

const newPartialResponse = (): PartialResponse => ({
  status: 'in_progress',
  flags: [],
});

/** Finalise a partial response into a {@link StarAnswer}. */
const finaliseResponse = (p: PartialResponse): StarAnswer => {
  const a: StarAnswer = {
    questionId: asQuestionId(p.questionId ?? ''),
    flags: p.flags,
    status: p.status,
  };
  if (p.situation !== undefined) a.situation = p.situation;
  if (p.task !== undefined) a.task = p.task;
  if (p.action !== undefined) a.action = p.action;
  if (p.result !== undefined) a.result = p.result;
  return a;
};

/** Mutable accumulator for a talking point being parsed. */
interface PartialTalkingPoint {
  id?: string;
  retired: boolean;
  situation?: string;
  task?: string;
  action?: string;
  result?: string;
  flags: StarFlag[];
  skills: string[];
  polished: string;
}

const newPartialTalkingPoint = (): PartialTalkingPoint => ({
  retired: false,
  flags: [],
  skills: [],
  polished: '',
});

/** Finalise a partial talking point into a {@link TalkingPoint} (R28.4, R23). */
const finaliseTalkingPoint = (p: PartialTalkingPoint): TalkingPoint => {
  const tp: TalkingPoint = {
    id: asStarId(p.id ?? ''),
    flags: p.flags,
    polished: p.polished,
    skills: p.skills.map(asSkillId),
  };
  if (p.situation !== undefined) tp.situation = p.situation;
  if (p.task !== undefined) tp.task = p.task;
  if (p.action !== undefined) tp.action = p.action;
  if (p.result !== undefined) tp.result = p.result;
  if (p.retired) tp.retired = true;
  return tp;
};

/**
 * Parse an `interview_[role_slug].md` document back into its {@link InterviewFile}
 * (R34.2). The exact inverse of {@link serializeInterview} for the
 * single-line-field contract the store carries: the owning role slug/title (and
 * the resume cursor, R25.4) are read from frontmatter, each `### ` section under
 * `## Questions` rebuilds a question, and each under `## Responses` rebuilds a
 * captured answer with its flags (R24, R25). Decorative headings, derived
 * recommendation lines, and lines that match no rule are ignored, so heading
 * text and section spacing never confuse the parse. Questions and responses are
 * returned in document order.
 */
export const parseInterview = (markdown: string): InterviewFile => {
  const { body, frontmatter } = parseMarkdown(markdown);
  const questions: Question[] = [];
  const responses: StarAnswer[] = [];
  const talkingPoints: TalkingPoint[] = [];
  let section: 'questions' | 'responses' | 'talkingPoints' = 'questions';
  let currentQ: PartialQuestion | undefined;
  let currentR: PartialResponse | undefined;
  let currentT: PartialTalkingPoint | undefined;

  const flushQ = (): void => {
    if (currentQ) questions.push(finalise(currentQ, questions.length));
    currentQ = undefined;
  };
  const flushR = (): void => {
    if (currentR) responses.push(finaliseResponse(currentR));
    currentR = undefined;
  };
  const flushT = (): void => {
    if (currentT) talkingPoints.push(finaliseTalkingPoint(currentT));
    currentT = undefined;
  };

  for (const raw of body.split('\n')) {
    const line = raw.trim();

    // A `## ` heading switches the active section (and never an `### ` heading).
    const h2 = H2.exec(line);
    if (h2) {
      flushQ();
      flushR();
      flushT();
      const title = h2[1].trim();
      if (title === 'Responses') section = 'responses';
      else if (title === 'Talking Points') section = 'talkingPoints';
      else section = 'questions';
      continue;
    }

    if (HEADING.test(line)) {
      if (section === 'responses') {
        flushR();
        currentR = newPartialResponse();
      } else if (section === 'talkingPoints') {
        flushT();
        currentT = newPartialTalkingPoint();
      } else {
        flushQ();
        currentQ = newPartial();
      }
      continue;
    }

    if (section === 'talkingPoints') {
      if (!currentT) continue;
      const anchor = ANCHOR.exec(line);
      if (anchor) {
        currentT.id = anchor[1];
        continue;
      }
      const status = TP_STATUS.exec(line);
      if (status) {
        currentT.retired = status[1].trim() === 'retired';
        continue;
      }
      const situation = TP_SITUATION.exec(line);
      if (situation) {
        currentT.situation = situation[1];
        continue;
      }
      const task = TP_TASK.exec(line);
      if (task) {
        currentT.task = task[1];
        continue;
      }
      const action = TP_ACTION.exec(line);
      if (action) {
        currentT.action = action[1];
        continue;
      }
      const result = TP_RESULT.exec(line);
      if (result) {
        currentT.result = result[1];
        continue;
      }
      const flags = TP_FLAGS.exec(line);
      if (flags) {
        currentT.flags = flags[1]
          .split(',')
          .map((f) => f.trim())
          .filter(isFlag);
        continue;
      }
      const skills = TP_SKILLS.exec(line);
      if (skills) {
        currentT.skills = skills[1]
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        continue;
      }
      const polished = TP_POLISHED.exec(line);
      if (polished) {
        currentT.polished = polished[1];
        continue;
      }
      continue;
    }

    if (section === 'responses') {
      if (!currentR) continue;
      const qid = RESP_QUESTION.exec(line);
      if (qid) {
        currentR.questionId = qid[1].trim();
        continue;
      }
      const status = RESP_STATUS.exec(line);
      if (status) {
        const value = status[1].trim();
        if (isStatus(value)) currentR.status = value;
        continue;
      }
      const situation = RESP_SITUATION.exec(line);
      if (situation) {
        currentR.situation = situation[1];
        continue;
      }
      const task = RESP_TASK.exec(line);
      if (task) {
        currentR.task = task[1];
        continue;
      }
      const action = RESP_ACTION.exec(line);
      if (action) {
        currentR.action = action[1];
        continue;
      }
      const result = RESP_RESULT.exec(line);
      if (result) {
        currentR.result = result[1];
        continue;
      }
      const flags = RESP_FLAGS.exec(line);
      if (flags) {
        currentR.flags = flags[1]
          .split(',')
          .map((f) => f.trim())
          .filter(isFlag);
        continue;
      }
      // Recommendation and other decorative lines are ignored (derived, R25.5).
      continue;
    }

    if (!currentQ) continue;

    const anchor = ANCHOR.exec(line);
    if (anchor) {
      currentQ.id = anchor[1];
      continue;
    }
    const category = CATEGORY.exec(line);
    if (category) {
      const value = category[1].trim();
      if (isCategory(value)) currentQ.category = value;
      continue;
    }
    const starFramed = STAR_FRAMED.exec(line);
    if (starFramed) {
      currentQ.starFramed = starFramed[1].trim() === 'yes';
      continue;
    }
    const skill = SKILL.exec(line);
    if (skill) {
      currentQ.skill = skill[1];
      continue;
    }
    const gap = GAP.exec(line);
    if (gap) {
      currentQ.gap = gap[1];
      continue;
    }
    const prompt = PROMPT.exec(line);
    if (prompt) {
      currentQ.prompt = prompt[1];
      continue;
    }
  }
  flushQ();
  flushR();
  flushT();

  const roleSlug = asRoleSlug(
    typeof frontmatter[ROLE_KEY] === 'string' ? (frontmatter[ROLE_KEY] as string) : '',
  );
  const roleTitle =
    typeof frontmatter[TITLE_KEY] === 'string' ? (frontmatter[TITLE_KEY] as string) : '';

  const file: InterviewFile = { roleSlug, roleTitle, questions };
  if (responses.length > 0) file.responses = responses;
  if (typeof frontmatter[CURSOR_KEY] === 'number') {
    file.cursor = frontmatter[CURSOR_KEY] as number;
  }
  if (talkingPoints.length > 0) file.talkingPoints = talkingPoints;
  return file;
};

// --- Build (R22.1, R22.2) ---------------------------------------------------

/**
 * Build a per-role {@link InterviewFile} for a coaching session: generate the
 * role-grounded questions for `role` against `map` (R22.1, R22.2) and bind them
 * to the owning role. Deterministic — the same role + map always yields the same
 * file. Ready to hand to {@link saveInterview} (R22.3).
 */
export const buildInterview = (
  role: RolePreference,
  map: SkillMap,
): InterviewFile => ({
  roleSlug: role.slug,
  roleTitle: role.title,
  questions: generateQuestions(role, map),
});

// --- Persist (R22.3) --------------------------------------------------------

/** Minimal writer satisfied by both the Storage_Adapter and the MemoryTree. */
export interface InterviewWriter {
  write(path: MemoryPath, data: string): unknown;
}

/** The canonical Memory Store location for a role's interview file (R22.3). */
export const interviewFilePath = (roleSlug: RoleSlug): MemoryPath =>
  interviewPath(roleSlug);

/**
 * Persist an interview file to `interviews/interview_[role_slug].md` via the
 * supplied writer (Storage_Adapter or MemoryTree). Serialization is shared with
 * {@link serializeInterview}, so the written file round-trips losslessly
 * (R34.2). Awaits the write so a Promise-returning adapter completes before the
 * caller advances. Returns the written path.
 */
export const saveInterview = async (
  writer: InterviewWriter,
  file: InterviewFile,
): Promise<MemoryPath> => {
  const path = interviewFilePath(file.roleSlug);
  await writer.write(path, serializeInterview(file));
  return path;
};

// --- Mid-question state & resume (R25.2, R25.3, R25.4) ----------------------

/**
 * Upsert a response into an interview file and record the resume cursor (R25.4).
 * Replaces the existing answer for `answer.questionId` (or appends it), and
 * sets `cursor` to the question the session is paused on so the next session
 * resumes at exactly this point. Pure — returns a new file, never mutates the
 * input. Persist the result with {@link saveInterview} to make the mid-question
 * state and any flags durable across sessions (R25.2).
 */
export const withResponse = (
  file: InterviewFile,
  answer: StarAnswer,
  cursor?: number,
): InterviewFile => {
  const existing = file.responses ?? [];
  const qid = asString(answer.questionId);
  const replaced = existing.some((a) => asString(a.questionId) === qid);
  const responses = replaced
    ? existing.map((a) => (asString(a.questionId) === qid ? answer : a))
    : [...existing, answer];

  const next: InterviewFile = {
    roleSlug: file.roleSlug,
    roleTitle: file.roleTitle,
    questions: file.questions,
    responses,
  };
  const resolvedCursor = cursor ?? file.cursor;
  if (resolvedCursor !== undefined) next.cursor = resolvedCursor;
  if (file.talkingPoints !== undefined) next.talkingPoints = file.talkingPoints;
  return next;
};

/**
 * Upsert a confirmed talking point into an interview file (R28.4). Replaces the
 * existing talking point with the same `STAR-NN` id (so retiring a point swaps
 * in its `retired: true` version, R23.3) or appends it when new. The stable id
 * is never reused or renumbered (R23.2 — enforced by the registry). Pure —
 * returns a new file, never mutates the input. Persist the result with
 * {@link saveInterview} to make confirmed talking points durable (R28.4).
 */
export const withTalkingPoint = (
  file: InterviewFile,
  talkingPoint: TalkingPoint,
): InterviewFile => {
  const existing = file.talkingPoints ?? [];
  const id = asString(talkingPoint.id);
  const replaced = existing.some((tp) => asString(tp.id) === id);
  const talkingPoints = replaced
    ? existing.map((tp) => (asString(tp.id) === id ? talkingPoint : tp))
    : [...existing, talkingPoint];

  const next: InterviewFile = {
    roleSlug: file.roleSlug,
    roleTitle: file.roleTitle,
    questions: file.questions,
    talkingPoints,
  };
  if (file.responses !== undefined) next.responses = file.responses;
  if (file.cursor !== undefined) next.cursor = file.cursor;
  return next;
};

/**
 * Why a question is still outstanding on resume (R25.2). Mirrors the union the
 * session summary reports (design Property 16): a question with no answer is
 * `unanswered`, a still-collecting answer is `in_progress`, and a Soft-Closed
 * answer is `flagged` so its flags resurface.
 */
export type OutstandingReason = 'unanswered' | 'in_progress' | 'flagged';

/** One outstanding question carried into the resume summary (R25.2). */
export interface OutstandingItem {
  /** The question still needing the user's attention. */
  questionId: QuestionId;
  /** Why it is outstanding. */
  reason: OutstandingReason;
  /** Any missing-element flags raised on it (empty unless `flagged`/in-progress). */
  flags: StarFlag[];
}

/**
 * The reconstructed state for resuming a coaching session from a loaded
 * interview file (R25.2, R25.3, R25.4). `cursor` is the persisted mid-question
 * resume point (falling back to the first outstanding question, then the end);
 * `currentQuestion`/`currentAnswer` are what sits there; `progress` is the
 * "Q n of N" indicator (R25.3); and `outstanding` is the ordered union of
 * unanswered, in-progress, and flagged questions whose flags resurface (R25.2).
 */
export interface ResumeState {
  /** 0-based index of the question to resume on (R25.4). */
  cursor: number;
  /** The question at the cursor, if any. */
  currentQuestion?: Question;
  /** The in-progress answer at the cursor, if one was started (R25.4). */
  currentAnswer?: StarAnswer;
  /** Session progress indicator, e.g. "Q 3 of 8" (R25.3). */
  progress: ProgressIndicator;
  /** Ordered union of questions still needing attention (R25.2). */
  outstanding: OutstandingItem[];
}

/** The Soft-Closed (flagged) answers in a file, in document order (R25.2). */
export const flaggedResponses = (file: InterviewFile): StarAnswer[] =>
  (file.responses ?? []).filter((a) => a.flags.length > 0);

/**
 * Compute the resume point and the outstanding/flagged set from a loaded
 * interview file (R25.2, R25.3, R25.4). The outstanding list is built in
 * question order: a question with no response is `unanswered`; a response left
 * `in_progress` is carried forward; a `soft_closed` response is `flagged` so its
 * flags resurface; `complete` and `passed` responses are done. The resume cursor
 * is the persisted one, else the first outstanding question, else the end.
 */
export const resumeState = (file: InterviewFile): ResumeState => {
  const byQuestion = new Map<string, StarAnswer>();
  for (const a of file.responses ?? []) {
    byQuestion.set(asString(a.questionId), a);
  }

  const outstanding: OutstandingItem[] = [];
  let firstOutstandingIndex = -1;

  file.questions.forEach((q, index) => {
    const answer = byQuestion.get(asString(q.id));
    let item: OutstandingItem | undefined;
    if (answer === undefined) {
      item = { questionId: q.id, reason: 'unanswered', flags: [] };
    } else if (answer.status === 'in_progress') {
      item = { questionId: q.id, reason: 'in_progress', flags: answer.flags };
    } else if (answer.status === 'soft_closed') {
      item = { questionId: q.id, reason: 'flagged', flags: answer.flags };
    }
    if (item) {
      outstanding.push(item);
      if (firstOutstandingIndex === -1) firstOutstandingIndex = index;
    }
  });

  const fallback =
    firstOutstandingIndex === -1 ? file.questions.length : firstOutstandingIndex;
  const cursor = file.cursor ?? fallback;

  const currentQuestion = file.questions[cursor];
  const currentAnswer =
    currentQuestion !== undefined
      ? byQuestion.get(asString(currentQuestion.id))
      : undefined;

  const state: ResumeState = {
    cursor,
    progress: progress(file.questions, cursor),
    outstanding,
  };
  if (currentQuestion !== undefined) state.currentQuestion = currentQuestion;
  if (currentAnswer !== undefined) state.currentAnswer = currentAnswer;
  return state;
};
