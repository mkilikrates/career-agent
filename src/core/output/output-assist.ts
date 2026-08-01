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
import { experienceDuration } from '@core/types';
import { computeEligibility } from '@core/ingestion';
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
 * body, stripping any preamble text and code fences the model may have included.
 * Returns `undefined` when the reply is too short to constitute a meaningful draft.
 */
export function parseCvDraft(reply: string): CvDraft | undefined {
  const trimmed = reply.trim();
  if (trimmed.length < 20) return undefined;

  // Strip code fences if present: ```markdown ... ```
  let markdown = trimmed;
  const fenceMatch = markdown.match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/);
  if (fenceMatch) {
    markdown = fenceMatch[1].trim();
  } else {
    // No code fence — strip any preamble before the first Markdown heading (#).
    const headingIdx = markdown.indexOf('\n#');
    if (headingIdx > 0) {
      // There's text before the first heading — treat it as preamble.
      const before = markdown.slice(0, headingIdx).trim();
      // Only strip if the preamble looks like prose (doesn't start with # itself).
      if (!before.startsWith('#')) {
        markdown = markdown.slice(headingIdx + 1).trim();
      }
    }
  }

  if (markdown.length < 20) return undefined;

  // Derive summary from first non-empty content line (skip code fence markers).
  let summary = '';
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (line.length >= 4) {
      summary = line.length > 80 ? line.slice(0, 77) + '...' : line;
      break;
    }
  }
  if (!summary) summary = 'AI-tailored CV draft';

  return { markdown, summary };
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
  // Name and contact info (Bug fix: prevent "[Your Name]" placeholder)
  const nameStr = model.header.name ??
    (evidence?.header?.name) ?? '';
  const contactLines = model.header.contact ??
    (evidence?.header?.contact) ?? [];

  // Compute output-eligible items for fallback paths (R30.16, R71.24, R11.2–R11.4)
  const eligibleItems = evidence?.items
    ? computeEligibility({ items: evidence.items, promotedLowIds: evidence.promotedLowIds }).eligible
    : [];

  // Professional summary (R30.14) — fall back to eligible items when model field is empty
  let summaryLine = model.professionalSummary ?? model.summary ?? '';
  if (!summaryLine && eligibleItems.length > 0) {
    const summaryItems = eligibleItems.filter(
      (i) => i.type === 'professional_summary',
    );
    summaryLine = summaryItems
      .map((i) => (typeof i.fields.text === 'string' ? i.fields.text.trim() : ''))
      .filter((t) => t.length > 0)
      .join(' ');
  }
  if (!summaryLine) summaryLine = '(none)';

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

  // Core competencies (R30.14) — fall back to eligible items when model field is empty
  let competencies = model.coreCompetencies ?? [];
  if (competencies.length === 0 && eligibleItems.length > 0) {
    const competencyItems = eligibleItems.filter(
      (i) => i.type === 'core_competency',
    );
    competencies = competencyItems
      .map((i) => (typeof i.fields.name === 'string' ? i.fields.name.trim() : ''))
      .filter((n) => n.length > 0);
  }
  const competenciesLine = competencies.length > 0
    ? competencies.join(', ')
    : '(none)';

  // Education (R30.14) — fall back to eligible items when model field is empty
  const educationLines: string[] = [];
  if (model.education.length > 0) {
    for (const ed of model.education) {
      const parts = [ed.title];
      if (ed.subtitle) parts.push(`at ${ed.subtitle}`);
      if (ed.detail) parts.push(`(${ed.detail})`);
      educationLines.push(`  - ${parts.join(' ')}`);
    }
  } else if (eligibleItems.length > 0) {
    const educationItems = eligibleItems.filter(
      (i) => i.type === 'education',
    );
    for (const item of educationItems) {
      const degree = typeof item.fields.degree === 'string' ? item.fields.degree :
        typeof item.fields.title === 'string' ? item.fields.title : 'Education';
      const institution = typeof item.fields.institution === 'string' ? item.fields.institution : '';
      const start = item.fields.start ?? item.fields.startedOn;
      const end = item.fields.end ?? item.fields.finishedOn;
      const dateStr = start || end
        ? ` (${typeof start === 'string' ? start : ''}${start && end ? ' – ' : ''}${typeof end === 'string' ? end : ''})`
        : '';
      educationLines.push(`  - ${degree}${institution ? ` at ${institution}` : ''}${dateStr}`);
    }
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
        const years = experienceDuration(entry.since, entry.lastEvidence);
        if (years !== undefined && years > 0) durStr = ` (~${years} years)`;
      }
    }
    skillLines.push(`  - ${sk.name}${durStr}`);
  }

  // Build the "Confirmed career data" section, starting with name/contact
  let confirmedData = 'Confirmed career data:\n';
  if (nameStr) confirmedData += `- Name: ${nameStr}\n`;
  if (contactLines.length > 0) confirmedData += `- Contact: ${contactLines.join(', ')}\n`;
  confirmedData += `- Professional summary: ${summaryLine}\n`;
  confirmedData += '- Positions:\n';
  confirmedData += (positionLines.length > 0 ? positionLines.join('\n') : '  - (none)') + '\n';
  confirmedData += `- Core competencies: ${competenciesLine}\n`;
  confirmedData += '- Education:\n';
  confirmedData += (educationLines.length > 0 ? educationLines.join('\n') : '  - (none)') + '\n';

  // Certifications (R30.16, R71.24)
  const certLines: string[] = [];
  if (model.certifications.length > 0) {
    for (const cert of model.certifications) {
      const parts = [cert.title];
      if (cert.subtitle) parts.push(`(${cert.subtitle})`);
      certLines.push(`  - ${parts.join(' ')}`);
    }
  } else if (eligibleItems.length > 0) {
    const certItems = eligibleItems.filter(
      (i) => i.type === 'certification',
    );
    for (const item of certItems) {
      const name = typeof item.fields.name === 'string' ? item.fields.name :
        typeof item.fields.title === 'string' ? item.fields.title : 'Certification';
      const issuer = typeof item.fields.issuer === 'string' ? item.fields.issuer :
        typeof item.fields.authority === 'string' ? item.fields.authority : '';
      certLines.push(`  - ${name}${issuer ? ` (${issuer})` : ''}`);
    }
  }
  if (certLines.length > 0) {
    confirmedData += '- Certifications:\n';
    confirmedData += certLines.join('\n') + '\n';
  }

  // Awards from eligible additional_info items (R30.16, R71.24)
  if (eligibleItems.length > 0) {
    const awardItems = eligibleItems.filter(
      (i) => i.type === 'additional_info' &&
        typeof i.fields.category === 'string' &&
        /^award/i.test(i.fields.category.trim()),
    );
    if (awardItems.length > 0) {
      confirmedData += '- Awards:\n';
      for (const item of awardItems) {
        const value = typeof item.fields.value === 'string' ? item.fields.value.trim() : '';
        if (value) confirmedData += `  - ${value}\n`;
      }
    }
  }

  // Nationality from eligible additional_info items (R30.16, R71.24)
  if (eligibleItems.length > 0) {
    const nationalityItems = eligibleItems.filter(
      (i) => i.type === 'additional_info' &&
        typeof i.fields.category === 'string' &&
        /^nationalit/i.test(i.fields.category.trim()),
    );
    const nationalityValues = nationalityItems
      .map((i) => typeof i.fields.value === 'string' ? i.fields.value.trim() : '')
      .filter((v) => v.length > 0);
    if (nationalityValues.length > 0) {
      confirmedData += `- Nationality: ${nationalityValues.join(', ')}\n`;
    }
  }

  confirmedData += '- Skills:\n';
  confirmedData += (skillLines.length > 0 ? skillLines.join('\n') : '  - (none)');

  return (
    `You are producing a complete ATS-formatted CV draft in Markdown for the role of "${model.targetRole.title}". ` +
    'Use ONLY the confirmed career data below. Do NOT invent any skill, metric, date, title, or employer not present in the confirmed data.\n\n' +
    'Produce a complete CV in Markdown with the following sections:\n' +
    '1. Professional Summary (2-3 sentences targeting this role)\n' +
    '2. Experience (employment entries with adjusted bullet emphasis for the role)\n' +
    '3. Skills (ordered by relevance to this role)\n' +
    '4. Education\n' +
    '5. Certifications (if applicable)\n' +
    '6. Core Competencies (if applicable)\n' +
    '7. Awards (if applicable)\n\n' +
    'Use the provided Name and Contact info for the header — do NOT use placeholders like [Full Name] or [Email].\n\n' +
    confirmedData
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
