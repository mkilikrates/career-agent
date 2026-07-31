// Opportunity-driven CV tailoring primitives (task 28.1; design "Output_Engine"
// — Opportunity-driven tailoring flow; Requirements 30.5, 30.6, 30.8, 30.9,
// 30.10, 35.6).
//
// When the user requests a CV, the Output_Engine FIRST asks whether the user has
// a Target Opportunity to tailor toward (R30.5; the same prompt is reachable
// from the new-CV re-entry point, R35.6). This module owns the trust-critical
// pieces of that ask and the AI-assist request it produces:
//
//   * {@link TargetOpportunity} — a branded, in-session-only job-posting text the
//     user uploaded or pasted (R30.6). It is a TAILORING TARGET ONLY and NEVER a
//     claim source (R30.9): nothing in it is ever admitted as a fact.
//   * {@link cvGenerationPrompt} — the pure model the UI surfaces for the R30.5 /
//     R35.6 ask ("do you have a Target Opportunity?"), reachable from the new-CV
//     re-entry point.
//   * {@link buildTailoringPayload} — builds the text routed THROUGH the Egress
//     Gate for AI-assisted tailoring. It carries the CONFIRMED EVIDENCE (the only
//     source of claims, R30.1/R30.8) plus the Target Opportunity text as a
//     clearly-labelled tailoring target, instructs the model to tailor emphasis
//     and ordering using only that confirmed evidence, and — for a keyed cloud
//     (third-party) destination — EXCLUDES every item marked private (R30.10,
//     R46.4). The Egress Gate performs the PII pre-screening on this text before
//     anything leaves the device (R30.9, R6) and produces the minimised Redacted
//     Payload; this module never constructs a payload that bypasses the gate.
//
// Everything here is pure and deterministic and imports NO provider client: the
// only path to a provider is the gate-routed transport the assist operation is
// constructed with (see `output-assist.ts`).

import { isThirdPartyDestination as isThirdParty, type EgressDestination } from '@core/assist';
import { experienceYears } from '@core/types';
import type { ConfirmedEvidence } from './cv-model';

const asString = (v: unknown): string => v as unknown as string;

/** Which generation path produced a CV, surfaced to the user (R30.7). */
export type CvGenerationMode = 'ai-tailored' | 'script-only';

/**
 * A job posting the user supplied to tailor a CV toward (R30.6). It is branded
 * so it can never be confused with confirmed evidence, and it is a TAILORING
 * TARGET ONLY — never a claim source (R30.9): no skill, metric, date, title, or
 * employer that appears only here is ever admitted into a CV. Held in-session
 * only; never persisted as a claim source in the Memory Store.
 */
export interface TargetOpportunity {
  readonly __brand: 'TargetOpportunity';
  /** Whether the user uploaded a file or pasted the posting text (R30.6). */
  readonly source: 'uploaded' | 'pasted';
  /** The raw job-posting details — a tailoring target only (R30.9). */
  readonly text: string;
}

/**
 * Construct a {@link TargetOpportunity} from user-supplied job-posting text
 * (R30.6). The text is trimmed but otherwise preserved verbatim; it is treated
 * strictly as a tailoring target (R30.9).
 */
export const targetOpportunity = (
  source: TargetOpportunity['source'],
  text: string,
): TargetOpportunity => ({
  __brand: 'TargetOpportunity',
  source,
  text: text.trim(),
});

/**
 * The pre-operation ask the Output_Engine surfaces when the user begins CV
 * generation (R30.5; reachable from the new-CV re-entry point, R35.6): does the
 * user have a Target Opportunity to tailor toward? It is a pure model the UI /
 * orchestrator renders; the user's reply (none / paste / upload) drives the
 * branch in {@link generateCv}.
 */
export interface TargetOpportunityPrompt {
  /** Discriminates this prompt for the UI. */
  readonly kind: 'target-opportunity';
  /** The question to put to the user (R30.5). */
  readonly question: string;
  /** The ways the user may supply a posting, or decline (R30.6). */
  readonly options: readonly ['none', 'paste', 'upload'];
}

/**
 * Build the {@link TargetOpportunityPrompt} the new-CV re-entry point surfaces
 * (R30.5, R35.6). Pure and deterministic; carries no user data.
 */
export const cvGenerationPrompt = (): TargetOpportunityPrompt => ({
  kind: 'target-opportunity',
  question:
    'Do you have a Target Opportunity (a specific job posting) to tailor this CV ' +
    'toward? You can paste or upload the posting, or generate a CV without one.',
  options: ['none', 'paste', 'upload'],
});

/**
 * Build the full confirmed ATS career data lines for the full-draft prompt
 * (R30.14). Includes employment positions with titles/dates/achievements,
 * core competencies, education, professional summary, and skills with durations.
 * For a keyed cloud (third-party) destination, items marked private are excluded
 * (R30.13, R46.4).
 */
const confirmedAtsCareerData = (
  src: ConfirmedEvidence,
  thirdParty: boolean,
): string => {
  const lines: string[] = [];

  // Professional summary (R30.14)
  const summaryItems = (src.items ?? []).filter(
    (i) => i.type === 'professional_summary' && i.userConfirmed && !i.private,
  );
  const summaryText = summaryItems
    .map((i) => (typeof i.fields.text === 'string' ? i.fields.text.trim() : ''))
    .filter((t) => t.length > 0)
    .join(' ');
  lines.push(`- Professional summary: ${summaryText || src.summary || '(none)'}`);

  // Employment positions with titles, dates, achievements (R30.14)
  const employmentItems = (src.items ?? []).filter(
    (i) => i.type === 'employment' && i.userConfirmed && !i.private,
  );
  lines.push('- Positions:');
  if (employmentItems.length > 0) {
    for (const item of employmentItems) {
      const title = typeof item.fields.title === 'string' ? item.fields.title : 'Position';
      const company = typeof item.fields.employer === 'string' ? item.fields.employer : '';
      const start = item.fields.start ?? item.fields.startedOn ?? item.fields.from;
      const end = item.fields.end ?? item.fields.finishedOn ?? item.fields.to;
      const dateStr = start || end
        ? ` (${typeof start === 'string' ? start : ''}${start && end ? ' – ' : ''}${typeof end === 'string' ? end : ''})`
        : '';
      const techs = Array.isArray(item.fields.technologies)
        ? item.fields.technologies.filter((t): t is string => typeof t === 'string')
        : [];
      const techStr = techs.length > 0 ? `; technologies: ${techs.join(', ')}` : '';
      const achievements = Array.isArray(item.fields.achievements)
        ? item.fields.achievements.filter((a): a is string => typeof a === 'string')
        : [];
      const achStr = achievements.length > 0 ? `; achievements: ${achievements.join('; ')}` : '';
      lines.push(`  - ${title} at ${company}${dateStr}${techStr}${achStr}`);
    }
  } else {
    lines.push('  - (none)');
  }

  // Core competencies (R30.14)
  const competencyItems = (src.items ?? []).filter(
    (i) => i.type === 'core_competency' && i.userConfirmed && !i.private,
  );
  const competencies = competencyItems
    .map((i) => (typeof i.fields.name === 'string' ? i.fields.name.trim() : ''))
    .filter((n) => n.length > 0);
  lines.push(`- Core competencies: ${competencies.length > 0 ? competencies.join(', ') : '(none)'}`);

  // Education (R30.14)
  const educationItems = (src.items ?? []).filter(
    (i) => i.type === 'education' && i.userConfirmed && !i.private,
  );
  lines.push('- Education:');
  if (educationItems.length > 0) {
    for (const item of educationItems) {
      const degree = typeof item.fields.degree === 'string' ? item.fields.degree :
        typeof item.fields.title === 'string' ? item.fields.title : 'Education';
      const institution = typeof item.fields.institution === 'string' ? item.fields.institution : '';
      const start = item.fields.start ?? item.fields.startedOn;
      const end = item.fields.end ?? item.fields.finishedOn;
      const dateStr = start || end
        ? ` (${typeof start === 'string' ? start : ''}${start && end ? ' – ' : ''}${typeof end === 'string' ? end : ''})`
        : '';
      lines.push(`  - ${degree}${institution ? ` at ${institution}` : ''}${dateStr}`);
    }
  } else {
    lines.push('  - (none)');
  }

  // Skills with durations (R30.14)
  lines.push('- Skills:');
  const filteredEntries = src.skillMap.entries
    .filter((entry) => !(thirdParty && entry.private === true));
  if (filteredEntries.length > 0) {
    for (const entry of filteredEntries) {
      const years = experienceYears(entry.since);
      const durStr = years !== undefined && years > 0 ? ` (~${years} years)` : '';
      lines.push(`  - ${entry.name}${durStr}`);
    }
  } else {
    lines.push('  - (none)');
  }

  return lines.join('\n');
};

/**
 * Build the AI-assist tailoring text routed THROUGH the Egress Gate (R30.6,
 * R30.8, R30.9, R30.10, R30.14). The returned text is the plaintext the gate
 * PII-pre-screens (R30.9, R6) before transmitting the minimised Redacted Payload
 * to the user's chosen provider — this module never constructs a payload that
 * bypasses the gate.
 *
 * The text instructs the model to produce a **complete ATS-formatted CV draft in
 * Markdown** (R30.10) using ONLY the confirmed evidence (R30.6), and presents
 * the {@link TargetOpportunity} as a clearly-labelled TAILORING TARGET that is
 * NEVER a claim source (R30.9): any skill, metric, date, title, or employer
 * that appears only in the posting (and not in confirmed evidence) must be
 * excluded (R30.8, No-Fabrication R37). For a keyed cloud (third-party) `dest`,
 * every item marked private is excluded from the confirmed evidence it carries
 * (R30.13, R46.4).
 *
 * Pure and deterministic; preserves the skill map's entry order.
 */
export const buildTailoringPayload = (
  src: ConfirmedEvidence,
  opp: TargetOpportunity,
  dest: EgressDestination,
): string => {
  const thirdParty = isThirdParty(dest);
  const careerData = confirmedAtsCareerData(src, thirdParty);

  return (
    'You are producing a complete ATS-formatted CV draft in Markdown, tailored to a Target Opportunity. ' +
    'The Target Opportunity is a TAILORING TARGET ONLY — it is NEVER a source of facts. ' +
    'Use ONLY the confirmed evidence below. Do NOT invent any skill, metric, date, title, or employer not present in the confirmed data.\n\n' +
    'Produce a complete CV in Markdown with the following sections:\n' +
    '1. Professional Summary (2-3 sentences targeting this opportunity)\n' +
    '2. Experience (employment entries with adjusted bullet emphasis for the opportunity)\n' +
    '3. Skills (ordered by relevance to this opportunity)\n' +
    '4. Education\n' +
    '5. Core Competencies (if applicable)\n\n' +
    'Adapt emphasis and phrasing toward the Target Opportunity\'s language and priorities, ' +
    'but EXCLUDE any skill, metric, date, title, or employer appearing only in the Target Opportunity and not in confirmed evidence.\n\n' +
    'Confirmed career data:\n' +
    careerData +
    '\n\nTarget Opportunity (tailoring target only — NOT a source of facts):\n' +
    asString(opp.text)
  );
};
