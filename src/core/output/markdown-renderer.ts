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
import type { CvBullet, CvEntry, CvModel } from './cv-model';

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
  const summary = cv.summary?.trim();
  if (!summary) return undefined;
  return `## Summary\n\n${summary}`;
};

/** Render one experience bullet, surfacing the needs-metric marker (R30.4). */
const renderBullet = (bullet: CvBullet): string => {
  const text = bullet.needsMetric ? `${bullet.text} ${NEEDS_METRIC_MARKER}` : bullet.text;
  return `- ${text}`;
};

/** Render the experience section, prioritised order preserved (R30.2). */
const renderExperience = (cv: CvModel): string | undefined => {
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

/**
 * Render a {@link CvModel} to ATS-safe, human-readable Markdown — the primary
 * CV output format (R32.1). Pure and deterministic: the same model always
 * yields the same string. Sections appear in a fixed, linear reading order
 * (header, summary, experience, skills, education, certifications); any section
 * with no content is omitted entirely so an empty or partial model still
 * renders cleanly. Every metric-needing bullet carries the {@link
 * NEEDS_METRIC_MARKER} annotation (R30.4). The renderer only restyles the
 * model — it never adds, drops, or alters its content (R32.5).
 */
export const renderMarkdown = (cv: CvModel): string => {
  const sections = [
    renderHeader(cv),
    renderSummary(cv),
    renderExperience(cv),
    renderSkills(cv),
    renderEducation(cv),
    renderCertifications(cv),
  ].filter((section): section is string => section !== undefined);

  return `${sections.join('\n\n')}\n`;
};
