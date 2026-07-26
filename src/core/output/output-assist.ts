// Output_Engine AI-assist operation (capability `cv_tailoring`) routed through
// the shared opt-in-first contract (task 25.2; design "AI Assist Opt-In-First
// Pattern" + "Output_Engine").
//
// Adapts the Output_Engine to the shared {@link BaseAssistableOperation}:
//   - `scriptOnly` → the deterministic single {@link buildCvModel} tailored from
//     confirmed evidence (R30.1–R30.4) with ZERO provider calls (R30.7). The
//     transport is never reached, so the CV is produced entirely on-device.
//   - `aiAssisted` → the SAME deterministic CV model PLUS an AI-generated
//     advisory full ATS-formatted CV draft in Markdown (R30.9, R30.10, R30.11,
//     R30.14). The draft is presented for user review and confirmation before it
//     replaces the deterministic CV. The baseline model is always carried in full,
//     so the AI draft never auto-applies (No-Fabrication, R47.6).
//
// All provider access is via the injected gate-routed {@link AssistTransport};
// the prompt sends the full confirmed ATS career data (employment positions with
// titles/dates/achievements, core competencies, education, professional summary,
// and skills with durations — R30.14). The draft is advisory until confirmed —
// nothing the model returns is woven into the CV automatically (R30.11).

import {
  BaseAssistableOperation,
  type AssistTransport,
  type EgressDestination,
} from '@core/assist';
import type { RolePreference } from '@core/types';
import { experienceYears } from '@core/types';
import { buildCvModel, type ConfirmedEvidence, type CvModel } from './cv-model';
import { buildTailoringPayload, type TargetOpportunity } from './tailoring';

/** Input to the CV-tailoring assist operation. */
export interface CvTailoringInput {
  /** The target role the CV is tailored toward (R30.2). */
  readonly role: RolePreference;
  /** The confirmed evidence the deterministic CV model is built from (R30.1). */
  readonly evidence: ConfirmedEvidence;
  /**
   * The Target Opportunity to tailor toward, when the user supplied one (R30.6).
   * When present, the AI request carries the job-posting text as a tailoring
   * target (never a claim source, R30.9) via {@link buildTailoringPayload};
   * when absent, the model is asked to tailor toward the role alone. Either way
   * the deterministic baseline is unchanged, so no posting-only fact can leak.
   */
  readonly opportunity?: TargetOpportunity;
}

/**
 * An AI-generated full ATS-formatted CV draft in Markdown (R30.9, R30.10,
 * R30.11, R30.14). The draft is **advisory** — it is presented for user review
 * and explicit confirmation before it replaces or supplements the deterministic
 * CV, so the user retains full control over the final output.
 */
export interface CvDraft {
  /** The complete Markdown CV draft produced by the model. */
  readonly markdown: string;
  /**
   * A short description of what the AI tailored (for the confirmation UI).
   * Derived from the first non-empty line of the draft (typically the header or
   * professional summary heading).
   */
  readonly summary: string;
}

/**
 * A single AI CV-tailoring suggestion. Now wraps a {@link CvDraft} — the full
 * ATS-formatted CV draft the model produced (R30.9, R30.10). The draft is
 * advisory (R30.11) and requires user confirmation before it replaces the
 * deterministic CV.
 */
export type CvTailoringSuggestion = CvDraft;

/** Parse a model reply into distinct tailoring notes (one per non-empty line). */
export function parseTailoringNotes(reply: string): CvTailoringSuggestion[] {
  const draft = parseCvDraft(reply);
  if (draft === undefined) return [];
  return [draft];
}

/**
 * Parse a model reply into a {@link CvDraft} (R30.9, R30.10, R30.11). The model
 * is expected to return a full Markdown CV; this parser extracts the Markdown
 * body and derives a short summary from the first significant line. Returns
 * `undefined` when the reply is too short to constitute a meaningful draft.
 */
export function parseCvDraft(reply: string): CvDraft | undefined {
  const trimmed = reply.trim();
  if (trimmed.length < 20) return undefined;

  // Derive summary from first non-empty content line (skip code fence markers).
  let summary = '';
  for (const raw of trimmed.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').replace(/^\s*```\w*\s*$/, '').trim();
    if (line.length >= 4) {
      summary = line.length > 80 ? line.slice(0, 77) + '...' : line;
      break;
    }
  }
  if (!summary) summary = 'AI-tailored CV draft';

  return { markdown: trimmed, summary };
}

/**
 * Build the full ATS CV draft prompt from the deterministic CV model and its
 * confirmed evidence (R30.9, R30.14). Instructs the model to produce a complete
 * ATS-formatted CV draft in Markdown containing: a tailored professional summary,
 * an employment section with bullet emphasis adjusted for the target role, and a
 * skills section ordered by relevance. Includes explicit No-Fabrication
 * instructions (R37).
 */
export function buildCvTailoringPrompt(model: CvModel, evidence?: ConfirmedEvidence): string {
  // Professional summary (R30.14)
  const summaryLine = model.professionalSummary ?? model.summary ?? '(none)';

  // Employment positions with titles, dates, technologies, achievements (R30.14)
  const positionLines: string[] = [];
  for (const emp of model.employmentEntries ?? []) {
    const dateStr = emp.dateRange ? ` (${emp.dateRange})` : '';
    const techStr = emp.technologies.length > 0
      ? `; technologies: ${emp.technologies.join(', ')}`
      : '';
    const achStr = emp.achievements.length > 0
      ? `; achievements: ${emp.achievements.join('; ')}`
      : '';
    positionLines.push(`  - ${emp.title} at ${emp.company}${dateStr}${techStr}${achStr}`);
  }
  // Fallback: if no employment entries, use flat experience bullets
  if (positionLines.length === 0) {
    for (const b of model.experience) {
      positionLines.push(`  - ${b.text}`);
    }
  }

  // Core competencies (R30.14)
  const competencies = model.coreCompetencies ?? [];
  const competenciesLine = competencies.length > 0
    ? competencies.join(', ')
    : '(none)';

  // Education (R30.14)
  const educationLines: string[] = [];
  for (const ed of model.education) {
    const parts = [ed.title];
    if (ed.subtitle) parts.push(`at ${ed.subtitle}`);
    if (ed.detail) parts.push(`(${ed.detail})`);
    educationLines.push(`  - ${parts.join(' ')}`);
  }

  // Skills with durations (R30.14) — look up `since` from evidence skill map
  const skillLines: string[] = [];
  for (const sk of model.skills) {
    let durStr = '';
    if (evidence) {
      const entry = evidence.skillMap.entries.find(
        (e) => String(e.id) === String(sk.id),
      );
      if (entry?.since) {
        const years = experienceYears(entry.since);
        if (years !== undefined && years > 0) durStr = ` (~${years} years)`;
      }
    }
    skillLines.push(`  - ${sk.name}${durStr}`);
  }

  return (
    `You are producing a complete ATS-formatted CV draft in Markdown for the role of "${model.targetRole.title}". ` +
    'Use ONLY the confirmed career data below. Do NOT invent any skill, metric, date, title, or employer not present in the confirmed data.\n\n' +
    'Produce a complete CV in Markdown with the following sections:\n' +
    '1. Professional Summary (2-3 sentences targeting this role)\n' +
    '2. Experience (employment entries with adjusted bullet emphasis for the role)\n' +
    '3. Skills (ordered by relevance to this role)\n' +
    '4. Education\n' +
    '5. Core Competencies (if applicable)\n\n' +
    'Confirmed career data:\n' +
    `- Professional summary: ${summaryLine}\n` +
    '- Positions:\n' +
    (positionLines.length > 0 ? positionLines.join('\n') : '  - (none)') + '\n' +
    `- Core competencies: ${competenciesLine}\n` +
    '- Education:\n' +
    (educationLines.length > 0 ? educationLines.join('\n') : '  - (none)') + '\n' +
    '- Skills:\n' +
    (skillLines.length > 0 ? skillLines.join('\n') : '  - (none)')
  );
}

/**
 * The Output_Engine's `cv_tailoring` operation. `scriptOnly` is the
 * deterministic single CV model; `aiAssisted` produces a full ATS-formatted CV
 * draft in Markdown (R30.9, R30.10) presented for user review and confirmation
 * (R30.11) alongside the deterministic baseline (R22.6, R47.3).
 */
export class CvTailoringOperation extends BaseAssistableOperation<
  CvTailoringInput,
  CvModel,
  CvTailoringSuggestion
> {
  constructor(private readonly transport: AssistTransport) {
    super();
  }

  /** Deterministic single CV model from confirmed evidence (R30). Zero calls. */
  protected computeBaseline(input: CvTailoringInput): CvModel {
    return buildCvModel(input.role, input.evidence);
  }

  /** Ask the model for a full ATS-formatted CV draft (R30.9, R30.10, R30.14). */
  protected async fetchSuggestions(
    input: CvTailoringInput,
    dest: EgressDestination,
    baseline: CvModel,
  ): Promise<readonly CvTailoringSuggestion[]> {
    // With a Target Opportunity, the request carries the job-posting text as a
    // tailoring target (never a claim source, R30.9), routed through the gate
    // by the transport; without one, tailor toward the role alone (R30.2).
    // Either way the deterministic baseline is unchanged, so no posting-only
    // fact can enter the CV (R30.8, No-Fabrication R37).
    const prompt = input.opportunity
      ? buildTailoringPayload(input.evidence, input.opportunity, dest)
      : buildCvTailoringPrompt(baseline, input.evidence);
    const reply = await this.transport(prompt, dest);
    return parseTailoringNotes(reply);
  }
}

/** Construct a {@link CvTailoringOperation} bound to a gate-routed transport. */
export function createCvTailoringOperation(
  transport: AssistTransport,
): CvTailoringOperation {
  return new CvTailoringOperation(transport);
}
