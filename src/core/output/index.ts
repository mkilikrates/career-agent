// @core/output — the Output_Engine (R30–R33, R41).
//
// Every CV format is derived from a single in-memory {@link CvModel} so the
// formats can never drift (R32.5). Task 14.1 implements that single model: the
// {@link buildCvModel} builder turns the confirmed evidence — the skill map, the
// interview-derived accomplishments / talking points, and the confirmed
// extracted items — into the role-tailored {@link CvModel} the format renderers
// (tasks 14.2–14.4) consume. Task 14.2 adds {@link renderMarkdown}, the primary
// Markdown output the other formats are derived from (R32.1). Consumers import
// from one path:
//
//   import { buildCvModel, renderMarkdown, type CvModel } from '@core/output';

export { buildCvModel, NEEDS_METRIC_MARKER, NEEDS_METRIC_NOTE } from './cv-model';
export { renderMarkdown } from './markdown-renderer';
export type {
  CvModel,
  CvHeader,
  CvSkill,
  CvBullet,
  CvBulletSource,
  CvEntry,
  ConfirmedEvidence,
} from './cv-model';

// CV tailoring wired to the shared opt-in-first AssistableOperation (25.2):
// scriptOnly = deterministic single CV model (zero provider calls);
// aiAssisted = same model + gate-routed, user-confirmable tailoring notes.
export {
  CvTailoringOperation,
  createCvTailoringOperation,
  buildCvTailoringPrompt,
  parseTailoringNotes,
} from './output-assist';
export type { CvTailoringInput, CvTailoringSuggestion } from './output-assist';

// Task 28.1 — opportunity-driven CV tailoring primitives (R30.5, R30.6, R30.8,
// R30.9, R30.10, R35.6): the in-session-only TargetOpportunity (a tailoring
// target, never a claim source), the new-CV re-entry prompt, and
// buildTailoringPayload (the gate-routed, private-excluded tailoring text).
export {
  buildTailoringPayload,
  targetOpportunity,
  cvGenerationPrompt,
} from './tailoring';
export type {
  TargetOpportunity,
  TargetOpportunityPrompt,
  CvGenerationMode,
} from './tailoring';

// Task 28.1 — the CvRequest-based generateCv flow with script-only fallback
// (R30.5–R30.10): one entry point that runs the deterministic script-only path
// or the opt-in-first AI-assisted tailoring path, always emitting the
// deterministic CV model and indicating whether script-only generation was used.
export { generateCv } from './cv-request';
export type { CvRequest, CvBundle, GenerateCvOptions } from './cv-request';

// Task 14.3 — the Typst-Wasm PDF renderer (ATS-safe, accessible). The Wasm
// compiler is an injected external boundary (mocked in tests); the source
// builders are pure and deterministic.
export {
  buildTypstSource,
  markdownToTypstSource,
  renderPdf,
  DEFAULT_ATS_TEMPLATE,
} from './pdf-renderer';
export type { TypstCompiler, PdfResult, AtsPdfTemplate } from './pdf-renderer';

// Task 14.4 — the structured DOCX renderer (ATS-portal upload format). Built
// with the pure-JS `docx` OOXML builder; derived from the same single
// {@link CvModel} for cross-format fidelity (R32.3, R32.4, R32.5).
export { buildDocxDocument, renderDocx, DOCX_EPOCH } from './docx-renderer';

// Task 14.7 — the advisory LinkedIn improvement report (R31). A pure,
// deterministic local Markdown generator built solely from confirmed evidence;
// advisory only — it never posts to, nor applies changes on, LinkedIn (R31.2).
export { buildLinkedInReport, renderLinkedInReportMarkdown, ADVISORY_NOTICE } from './linkedin-report';
export type {
  LinkedInReport,
  LinkedInPosition,
  LinkedInBullet,
  LinkedInSkillSuggestion,
} from './linkedin-report';

// Task 14.8 — CV versioning and diffing (R33). Each produced CV is stored as an
// immutable file named by role slug + version number (R33.1); editing always
// allocates a NEW version, never mutating a stored one (R33.2); and `diffCv`
// enumerates exactly the accomplishments added/removed/reordered and the skills
// whose emphasis changed between two versions (R33.3). Pure and deterministic.
export {
  VERSION_FORMATS,
  versionStem,
  versionIdToString,
  versionPath,
  versionPaths,
  storedVersions,
  nextVersionNumber,
  nextVersion,
  nextVersionFor,
  recordVersion,
  diffCv,
  CvVersionExistsError,
} from './versioning';
export type {
  VersionId,
  CvVersionContents,
  AccomplishmentId,
  AccomplishmentDiff,
  SkillEmphasis,
  SkillEmphasisKind,
  SkillEmphasisChange,
  CvDiff,
} from './versioning';

// Task 14.10 — locale-driven output formatting (R41.5, R41.6, R41.7). Resolves a
// concrete {@link OutputLocale} from a {@link LocaleConfig} (per-locale defaults
// + individually overridable conventions), formats dates / numbers / currency
// per the resolved conventions, and applies section-name conventions and
// privacy-preserving personal-data defaults to the single {@link CvModel} —
// while preserving technical terms, tool names, and proper nouns verbatim. Pure
// and deterministic.
export {
  SECTION_KEYS,
  DEFAULT_SECTION_NAMES,
  OUTPUT_LOCALE_PRESETS,
  FALLBACK_LOCALE_KEY,
  resolveOutputLocale,
  formatNumber,
  formatCurrency,
  formatDate,
  collectCvText,
  verbatimTermsPreserved,
  applyLocaleFormatting,
} from './locale-formatting';
export type {
  SectionKey,
  LocalisedSections,
  PersonalDataInclusion,
  LocalisedCvModel,
} from './locale-formatting';
