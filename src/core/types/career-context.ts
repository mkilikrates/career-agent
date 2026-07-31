// @core/types/career-context — unified career-context type (refactoring).
//
// Formerly duplicated as `AtsCareerData` (in role-discovery-payload.ts) and
// `AtsContext` (in coach-assist.ts), this single `CareerContext` interface holds
// employer-free career-trajectory data derived from extraction: previous job
// titles (without employer names), core competencies, education, and a
// professional summary.

/**
 * Employer-free career-trajectory context derived from extraction (R20.6, R47.2,
 * R22.6, R62.5). Contains previous job titles (without employer names), confirmed
 * core competencies, education degrees/fields, and an optional professional
 * summary so downstream prompts (role discovery, STAR question calibration) can
 * reference the candidate's career arc without ever seeing where they worked.
 */
export interface CareerContext {
  /** Previous job titles — employer names stripped (R20.6). */
  readonly jobTitles: readonly string[];
  /** Confirmed core (soft/leadership) competencies from extraction. */
  readonly competencies: readonly string[];
  /** Education degrees/fields (no institution names for keyed cloud, R47.2). */
  readonly education: readonly string[];
  /** Professional summary when available from extraction. */
  readonly professionalSummary?: string;
}
