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

import type { EgressDestination } from '@core/assist';
import type { ConfirmedEvidence } from './cv-model';

const asString = (v: unknown): string => v as unknown as string;

/** Collapse whitespace so a single evidence/opportunity line never breaks. */
const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ').trim();

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
 * Whether a destination is a keyed cloud (third-party) provider. A keyless Local
 * Provider runs on the user's own device with no third-party egress, so private
 * items may be included (R46.5). Any other destination — including one whose
 * `kind` is absent — is treated as third-party, the SAFE default: over-excluding
 * a private item is harmless, whereas the reverse would leak it (R30.10, R46.4).
 */
const isThirdParty = (dest: EgressDestination): boolean =>
  dest.kind !== 'keyless-local';

/**
 * The confirmed-evidence lines the tailoring request carries — the ONLY source
 * of facts the model may use (R30.1, R30.8). Skills are projected to phrasing +
 * category; experience bullets to their text. For a keyed cloud (third-party)
 * `dest`, every skill marked private is excluded (R30.10, R46.4).
 */
const confirmedEvidenceLines = (
  src: ConfirmedEvidence,
  thirdParty: boolean,
): { readonly skills: readonly string[]; readonly experience: readonly string[] } => {
  const skills = src.skillMap.entries
    .filter((entry) => !(thirdParty && entry.private === true))
    .map((entry) => `${entry.name} (${entry.category})`);

  const experience: string[] = [];
  for (const acc of src.accomplishments ?? []) {
    if (acc.retired) continue;
    experience.push(oneLine(acc.text));
  }
  for (const tp of src.talkingPoints ?? []) {
    if (tp.retired) continue;
    experience.push(oneLine(tp.polished));
  }

  return { skills, experience };
};

/**
 * Build the AI-assist tailoring text routed THROUGH the Egress Gate (R30.6,
 * R30.8, R30.9, R30.10). The returned text is the plaintext the gate
 * PII-pre-screens (R30.9, R6) before transmitting the minimised Redacted Payload
 * to the user's chosen provider — this module never constructs a payload that
 * bypasses the gate.
 *
 * The text instructs the model to tailor EMPHASIS and ORDERING using ONLY the
 * confirmed evidence (R30.6), and presents the {@link TargetOpportunity} as a
 * clearly-labelled TAILORING TARGET that is NEVER a claim source (R30.9): any
 * skill, metric, date, title, or employer that appears only in the posting (and
 * not in confirmed evidence) must be excluded (R30.8, No-Fabrication R37). For a
 * keyed cloud (third-party) `dest`, every item marked private is excluded from
 * the confirmed evidence it carries (R30.10, R46.4).
 *
 * Pure and deterministic; preserves the skill map's entry order.
 */
export const buildTailoringPayload = (
  src: ConfirmedEvidence,
  opp: TargetOpportunity,
  dest: EgressDestination,
): string => {
  const thirdParty = isThirdParty(dest);
  const { skills, experience } = confirmedEvidenceLines(src, thirdParty);

  const skillLines = skills.length > 0 ? skills.map((s) => `- ${s}`).join('\n') : '- (none)';
  const experienceLines =
    experience.length > 0 ? experience.map((b) => `- ${b}`).join('\n') : '- (none)';

  return (
    'You are helping tailor a CV to a Target Opportunity. The Target Opportunity ' +
    'is a TAILORING TARGET ONLY — it is NEVER a source of facts. Use ONLY the ' +
    'confirmed evidence below as the source of skills, metrics, dates, job titles, ' +
    'and employers. Do NOT add, infer, or import any skill, metric, date, title, ' +
    'or employer that appears only in the Target Opportunity and not in the ' +
    'confirmed evidence. Suggest up to 5 short, advisory edits — emphasis, ' +
    'ordering, and phrasing only — to better target this opportunity using that ' +
    'confirmed evidence. Return one suggestion per line, no preamble.\n\n' +
    'Confirmed skills:\n' +
    skillLines +
    '\n\nConfirmed experience:\n' +
    experienceLines +
    '\n\nTarget Opportunity (tailoring target only — NOT a source of facts):\n' +
    asString(opp.text)
  );
};
