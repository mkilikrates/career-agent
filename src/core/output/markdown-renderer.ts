// The Markdown renderer — the primary CV output format (R32.1).
//
// The Output_Engine always generates Markdown as the primary output (R32.1),
// and derives every other format (Typst-Wasm PDF in task 14.3, structured DOCX
// in task 14.4) from the same single {@link CvModel} so the formats can never
// drift (R32.5). This module is that primary renderer: a pure, deterministic
// function from a {@link CvModel} to an ATS-safe, human-readable Markdown
// string.
//
// "ATS-safe" here follows the spirit of R32.4: a single-column, linear
// reading order built from headings and bullet lists only — no layout tables,
// no meaningful icons, no images, and nothing but selectable text. The renderer
// only restyles the model; it never adds, drops, or alters its content (R32.5).
// In particular, every metric-needing bullet carries the {@link
// NEEDS_METRIC_MARKER} annotation so the user can see where a quantified metric
// would strengthen the point (R30.4).

import { NEEDS_METRIC_MARKER } from './cv-model';
import type { CvBullet, CvEmploymentEntry, CvEntry, CvModel } from './cv-model';

/** Render the contact header (name + verbatim contact lines), when present. */
const renderHeader = (cv: CvModel): string | undefined => {
  const lines: string[] = [];
  const name = cv.header.name?.trim();
  if (name) lines.push(`# ${name}`);

  const contact = (cv.header.contact ?? [])
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (contact.length > 0) lines.push(contact.join(' · '));

  return lines.length > 0 ? lines.join('\n\n') : undefined;
};

/** Render the optional professional summary, supplied verbatim. */
const renderSummary = (cv: CvModel): string | undefined => {
  // Prefer the structured professionalSummary from confirmed extraction (R73.5),
  // falling back to the generic summary field.
  const summary = (cv.professionalSummary ?? cv.summary ?? '').trim();
  if (!summary) return undefined;
  return `## Summary\n\n${summary}`;
};

/** Render core competencies as a single line (R73.5). */
const renderCoreCompetencies = (cv: CvModel): string | undefined => {
  const competencies = cv.coreCompetencies;
  if (!competencies || competencies.length === 0) return undefined;
  return `## Core Competencies\n\n${competencies.join(' · ')}`;
};

/** Render one experience bullet, surfacing the needs-metric marker (R30.4). */
const renderBullet = (bullet: CvBullet): string => {
  const text = bullet.needsMetric ? `${bullet.text} ${NEEDS_METRIC_MARKER}` : bullet.text;
  return `- ${text}`;
};

/** Render a single employment entry as a subsection with its bullets (R71.7). */
const renderEmploymentEntry = (entry: CvEmploymentEntry): string => {
  const heading = entry.company
    ? `### ${entry.title} — ${entry.company}${entry.dateRange ? ` (${entry.dateRange})` : ''}`
    : `### ${entry.title}${entry.dateRange ? ` (${entry.dateRange})` : ''}`;

  const lines: string[] = [heading];

  // Show technologies if present
  if (entry.technologies.length > 0) {
    lines.push(`\n*${entry.technologies.join(', ')}*`);
  }

  // Show achievements from extraction (R73.5)
  for (const achievement of entry.achievements) {
    lines.push(`- ${achievement}`);
  }

  // Show matched talking point / accomplishment bullets
  for (const bullet of entry.bullets) {
    lines.push(renderBullet(bullet));
  }

  return lines.join('\n');
};

/**
 * Render the experience section. Prefers the structured employment entries
 * (R71.7) when available; otherwise falls back to the flat bullet list.
 */
const renderExperience = (cv: CvModel): string | undefined => {
  // Prefer structured employment entries with grouped bullets (R71.7)
  if (cv.employmentEntries && cv.employmentEntries.length > 0) {
    const entries = cv.employmentEntries.map(renderEmploymentEntry).join('\n\n');
    return `## Experience\n\n${entries}`;
  }
  // Fallback: flat bullets if no employment structure is available
  if (cv.experience.length === 0) return undefined;
  return `## Experience\n\n${cv.experience.map(renderBullet).join('\n')}`;
};

/** Render the skills section as a linear bullet list, model order preserved. */
const renderSkills = (cv: CvModel): string | undefined => {
  if (cv.skills.length === 0) return undefined;
  return `## Skills\n\n${cv.skills.map((s) => `- ${s.name}`).join('\n')}`;
};

/** Render a single education / certification entry on one linear line. */
const renderEntry = (entry: CvEntry): string => {
  const parts = [`**${entry.title}**`];
  if (entry.subtitle) parts.push(entry.subtitle);
  if (entry.detail) parts.push(entry.detail);
  return `- ${parts.join(' — ')}`;
};

/** Render the education section, when any entries are present. */
const renderEducation = (cv: CvModel): string | undefined => {
  if (cv.education.length === 0) return undefined;
  return `## Education\n\n${cv.education.map(renderEntry).join('\n')}`;
};

/** Render the certifications section, when any entries are present. */
const renderCertifications = (cv: CvModel): string | undefined => {
  if (cv.certifications.length === 0) return undefined;
  return `## Certifications\n\n${cv.certifications.map(renderEntry).join('\n')}`;
};

/** Render languages with proficiency levels (R73.5). */
const renderLanguages = (cv: CvModel): string | undefined => {
  const langs = cv.languages;
  if (!langs || langs.length === 0) return undefined;
  return `## Languages\n\n${langs.map((l) => `- ${l.language} (${l.proficiency})`).join('\n')}`;
};

/** Render hobbies, causes, and interests (R73.5). */
const renderHobbiesAndCauses = (cv: CvModel): string | undefined => {
  const items = cv.hobbiesAndCauses;
  if (!items || items.length === 0) return undefined;
  return `## Interests & Community\n\n${items.join(' · ')}`;
};

/**
 * Render a {@link CvModel} to ATS-safe, human-readable Markdown — the primary
 * CV output format (R32.1). Pure and deterministic: the same model always
 * yields the same string. Sections appear in a fixed, linear reading order
 * (header, summary, core competencies, experience, skills, education,
 * certifications, languages, interests); any section with no content is omitted
 * entirely so an empty or partial model still renders cleanly. Every
 * metric-needing bullet carries the {@link NEEDS_METRIC_MARKER} annotation
 * (R30.4). The renderer only restyles the model — it never adds, drops, or
 * alters its content (R32.5).
 */
export const renderMarkdown = (cv: CvModel): string => {
  const sections = [
    renderHeader(cv),
    renderSummary(cv),
    renderCoreCompetencies(cv),
    renderExperience(cv),
    renderSkills(cv),
    renderEducation(cv),
    renderCertifications(cv),
    renderLanguages(cv),
    renderHobbiesAndCauses(cv),
  ].filter((section): section is string => section !== undefined);

  return `${sections.join('\n\n')}\n`;
};
