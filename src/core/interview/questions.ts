// Role-grounded STAR question generation (R22.1, R22.2).
//
// When the user selects a role for coaching, the Interview_Coach generates
// STAR-framework questions grounded in the skill match between the user's
// profile (the {@link SkillMap}) and the target {@link RolePreference} (R22.1).
// `generateQuestions(role, map)` produces, deterministically:
//
//   * at least one BEHAVIOURAL STAR question per CORE SKILL the role requires
//     that the user's profile already matches — these are the role's
//     `matchedSkills`, i.e. the intersection of the profile and the role, so the
//     question is grounded in a real skill match (R22.1, R22.2);
//   * exactly one GAP question targeting an identified skill gap (the role's
//     first `gapSkills` term) when a gap exists (R22.2);
//   * one professional MOTIVATION question (R22.2).
//
// The function is pure and deterministic: the same role + map always yields the
// same questions, in the same order, with the same stable per-role ids
// (`Q-01`, `Q-02`, …). Questions are OPEN — they ask the user to recount their
// own Situation/Task/Action/Result and never suggest specific facts or outcomes
// for the user to claim (the open-question discipline carried into R24.3).

import type {
  Question,
  QuestionCategory,
  RolePreference,
  SkillId,
  SkillTerm,
} from '@core/types';
import { asQuestionId } from '@core/types';
import type { SkillMap } from '@core/skills';

const asString = (v: unknown): string => v as unknown as string;

/** Zero-padded per-role question id (`Q-01`, `Q-02`, …). */
const questionId = (n: number): Question['id'] =>
  asQuestionId(`Q-${String(n).padStart(2, '0')}`);

/** Resolve a matched skill id to the user's own phrasing via the skill map. */
const skillName = (id: SkillId, map: SkillMap): string => {
  const entry = map.entries.find((e) => asString(e.id) === asString(id));
  return entry ? entry.name : asString(id);
};

/** STAR-framed behavioural prompt grounded in a matched core skill (R22.1). */
const behaviouralPrompt = (skill: string): string =>
  `Tell me about a time your ${skill} made a difference in your work. ` +
  `Walk me through the Situation you were in, the Task you were responsible for, ` +
  `the Actions you personally took, and the Result you achieved.`;

/** STAR-framed prompt targeting an identified skill gap (R22.2). */
const gapPrompt = (gap: string, roleTitle: string): string =>
  `This ${roleTitle} role values ${gap}. Describe a situation where ${gap} ` +
  `(or something close to it) came into play — the Task you faced, the Actions ` +
  `you took, and the Result — even if it is an area you are still developing.`;

/** Open professional-motivation prompt (R22.2). */
const motivationPrompt = (roleTitle: string): string =>
  `What draws you to working as a ${roleTitle}, and what keeps you motivated ` +
  `professionally? Share a specific experience: the Situation that shaped that ` +
  `motivation and the Result it led to.`;

/** Build one question, assigning the next sequential per-role id. */
const make = (
  n: number,
  category: QuestionCategory,
  starFramed: boolean,
  prompt: string,
  grounding: { skill?: SkillId; gap?: SkillTerm } = {},
): Question => ({
  id: questionId(n),
  category,
  starFramed,
  prompt,
  ...(grounding.skill !== undefined ? { skill: grounding.skill } : {}),
  ...(grounding.gap !== undefined ? { gap: grounding.gap } : {}),
});

/**
 * Generate the role-grounded STAR questions for a coaching session (R22.1,
 * R22.2). Deterministic: questions are emitted in a stable order — one
 * behavioural question per matched core skill (in the role's matched-skill
 * order), then one gap question when the role has an identified gap, then one
 * professional motivation question — and numbered `Q-01…` in that order.
 *
 * Behavioural questions are grounded in the skill match between the profile and
 * the role (the role's `matchedSkills`, resolved to the user's own phrasing via
 * the skill map). The gap question targets the first of the role's `gapSkills`.
 */
export const generateQuestions = (
  role: RolePreference,
  map: SkillMap,
): Question[] => {
  const questions: Question[] = [];
  let n = 1;

  // One behavioural STAR question per matched core skill (R22.1, R22.2).
  for (const skill of role.matchedSkills) {
    questions.push(
      make(n++, 'behavioural', true, behaviouralPrompt(skillName(skill, map)), {
        skill,
      }),
    );
  }

  // Exactly one gap question, when the role has an identified gap (R22.2).
  const gap = role.gapSkills[0];
  if (gap !== undefined) {
    questions.push(
      make(n++, 'gap', true, gapPrompt(asString(gap), role.title), { gap }),
    );
  }

  // One professional motivation question (R22.2).
  questions.push(make(n++, 'motivation', false, motivationPrompt(role.title)));

  return questions;
};
