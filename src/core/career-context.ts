// @core/career-context — unified derivation of career context from extracted
// items (refactoring; R20.6, R22.6, R47.2, R62.5).
//
// Previously duplicated as `deriveAtsCareerData` (RoleDiscoveryScreen) and
// `deriveAtsContext` (CoachingScreen), this module provides a single
// `deriveCareerContext` function that derives employer-free career-trajectory
// context from extracted items. It is framework-agnostic @core domain logic.

import type { ExtractedItem, CareerContext } from '@core/types';

/**
 * Derive employer-free career context from confirmed extracted items (R20.6,
 * R22.6, R47.2, R62.5). Returns undefined when there is nothing useful to
 * include, so the downstream prompt stays minimal.
 *
 * Includes all extracted items for career-context derivation — not just
 * user-confirmed ones. The userConfirmed flag gates what appears in CV outputs
 * (No-Fabrication boundary), but the career context sent to downstream prompts
 * (role discovery, STAR questions) should reflect the full extraction so the
 * model understands the candidate's trajectory. Items marked private are still
 * excluded for third-party (keyed cloud) destinations (R46.4).
 *
 * @param items — the extracted items from ingestion.
 * @param thirdParty — whether the destination is a keyed cloud provider.
 */
export function deriveCareerContext(
  items: ReadonlyArray<ExtractedItem>,
  thirdParty: boolean,
): CareerContext | undefined {
  const eligible = items.filter(
    (i) => !(thirdParty && i.private),
  );

  const jobTitles: string[] = [];
  const competencies: string[] = [];
  const education: string[] = [];
  let professionalSummary: string | undefined;

  for (const item of eligible) {
    switch (item.type) {
      case 'employment': {
        const title =
          typeof item.fields.title === 'string' ? item.fields.title.trim() : '';
        if (title.length > 0 && !jobTitles.includes(title)) {
          jobTitles.push(title);
        }
        break;
      }
      case 'core_competency': {
        const name =
          typeof item.fields.name === 'string' ? item.fields.name.trim() : '';
        if (name.length > 0 && !competencies.includes(name)) {
          competencies.push(name);
        }
        break;
      }
      case 'education': {
        const entry =
          typeof item.fields.entry === 'string' ? item.fields.entry.trim() : '';
        const degree =
          typeof item.fields.degree === 'string' ? item.fields.degree.trim() : '';
        const field =
          typeof item.fields.field === 'string' ? item.fields.field.trim() : '';
        // Strip markdown formatting that may leak from AI extraction (e.g. **bold**).
        const raw = entry || [degree, field].filter(Boolean).join(' in ') || '';
        const summary = raw.replace(/\*+/g, '').replace(/--/g, '').trim();
        // Deduplicate case-insensitively to avoid "MSc Leadership" + "MSc leadership".
        if (summary.length > 0 && !education.some(e => e.toLowerCase() === summary.toLowerCase())) {
          education.push(summary);
        }
        break;
      }
      case 'professional_summary': {
        const text =
          typeof item.fields.text === 'string' ? item.fields.text.trim() : '';
        // Strip a leading "Summary:" prefix if the AI included it in the text.
        const cleaned = text.replace(/^summary:\s*/i, '').trim();
        if (cleaned.length > 0 && !professionalSummary) {
          professionalSummary = cleaned;
        }
        break;
      }
    }
  }

  // Return undefined when there is nothing to include.
  if (
    jobTitles.length === 0 &&
    competencies.length === 0 &&
    education.length === 0 &&
    !professionalSummary
  ) {
    return undefined;
  }

  return { jobTitles, competencies, education, professionalSummary };
}

/**
 * Convert a {@link CareerContext} to the legacy {@link AtsContext} shape used by
 * the STAR question operations (coach-assist). This is a pure field-name mapping
 * kept for backward compatibility during the migration.
 */
export function toAtsContext(ctx: CareerContext | undefined): {
  previousTitles?: readonly string[];
  coreCompetencies?: readonly string[];
  educationDegrees?: readonly string[];
  professionalSummary?: string;
} | undefined {
  if (!ctx) return undefined;
  return {
    previousTitles: ctx.jobTitles.length > 0 ? ctx.jobTitles : undefined,
    coreCompetencies: ctx.competencies.length > 0 ? ctx.competencies : undefined,
    educationDegrees: ctx.education.length > 0 ? ctx.education : undefined,
    professionalSummary: ctx.professionalSummary,
  };
}
