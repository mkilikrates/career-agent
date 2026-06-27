// The Typst-Wasm PDF renderer — the ATS-safe, accessible PDF output format
// (R32.2, R32.4, R42.4).
//
// The Output_Engine derives every CV format from a single in-memory
// {@link CvModel} so the formats can never drift (R32.5). This module is the PDF
// renderer: it turns the confirmed CV (the {@link CvModel}, or the already
// confirmed Markdown source) into an ATS-safe Typst document source and compiles
// it client-side to PDF via Typst compiled to WebAssembly (R32.2).
//
// ## External boundary (mocked in tests)
//
// Typst-Wasm is an EXTERNAL WebAssembly boundary. Per the architecture, no core
// module imports a concrete `typst.ts` client directly — that would break the
// framework-agnostic, deterministic test setup, where "external boundaries (LLM,
// STT, FS Access, Typst-Wasm) are mocked in property tests for speed and
// determinism". Instead this module defines the small {@link TypstCompiler}
// contract and the compiler is INJECTED into {@link renderPdf}. Unit tests pass a
// fake compiler; the concrete `typst.ts` adapter lives behind this contract under
// `src/adapters/` and is wired in at the app edge. The source-building functions
// ({@link buildTypstSource}, {@link markdownToTypstSource}) are pure and
// deterministic and require no Wasm at all.
//
// ## ATS-safe and accessible (R32.4, R42.4)
//
// The generated Typst document is single-column with a linear reading order
// (headings + bullet lists, emitted top-to-bottom in the model's order), a real
// selectable text layer (Typst always emits genuine glyph text, never
// rasterised), and a near-black-on-white text fill for sufficient contrast. It
// contains no layout tables, no meaning-bearing icons, and no text embedded in
// images.
//
// ## Graceful failure (R32.2)
//
// {@link renderPdf} never throws on a compile failure. It returns a discriminated
// {@link PdfResult}: `{ ok: true, bytes }` on success, or `{ ok: false, error }`
// on failure. A failed PDF therefore can never block delivery of the Markdown
// primary or the DOCX format — the caller simply omits the PDF.

import { NEEDS_METRIC_MARKER } from './cv-model';
import type { CvBullet, CvEntry, CvModel } from './cv-model';

// --- External boundary contract --------------------------------------------

/**
 * The external Typst-Wasm boundary. A compiler takes a complete Typst document
 * source and resolves with the compiled PDF bytes, or rejects if compilation
 * fails. The concrete implementation (a `typst.ts` Wasm client) lives under
 * `src/adapters/`; core code depends only on this contract, and tests inject a
 * fake. Keeping the boundary this small is what makes the renderer deterministic
 * and Wasm-free to test.
 */
export interface TypstCompiler {
  /** Compile a Typst document source to PDF bytes, rejecting on failure. */
  compile(typstSource: string): Promise<Uint8Array>;
}

/** The outcome of {@link renderPdf}: PDF bytes, or a graceful failure (R32.2). */
export type PdfResult =
  | {
      /** Compilation succeeded. */
      readonly ok: true;
      /** The compiled PDF bytes. */
      readonly bytes: Uint8Array;
      /** The exact Typst source that was compiled (deterministic, inspectable). */
      readonly typstSource: string;
    }
  | {
      /** Compilation failed; the PDF must be omitted, never block other formats. */
      readonly ok: false;
      /** A human-readable reason the compile failed. */
      readonly error: string;
      /** The Typst source that failed to compile, for diagnostics. */
      readonly typstSource: string;
    };

// --- ATS-safe template -----------------------------------------------------

/**
 * The knobs of the ATS-safe, accessible PDF template (R32.4, R42.4). Defaults
 * yield a clean single-column A4 page with near-black text on white for strong
 * contrast and a generic sans-serif stack. Templates may only restyle; the
 * structure is always single-column and linear (R32.5).
 */
export interface AtsPdfTemplate {
  /** Font family stack (generic, widely available sans-serif). */
  readonly fontFamilies: readonly string[];
  /** Body text size. */
  readonly fontSize: string;
  /** Body text fill — a high-contrast near-black for readability (R42.4). */
  readonly textColor: string;
  /** Page margin on all sides. */
  readonly pageMargin: string;
}

/** The default ATS-safe template: single-column A4, near-black on white. */
export const DEFAULT_ATS_TEMPLATE: AtsPdfTemplate = {
  // Generic, widely-bundled sans-serif families; no decorative or icon fonts.
  fontFamilies: ['Liberation Sans', 'Arial', 'DejaVu Sans', 'sans-serif'],
  fontSize: '11pt',
  // #111827 on a white page is ~16:1 contrast, comfortably above WCAG AA.
  textColor: '#111827',
  pageMargin: '2cm',
};

// --- Source building (pure, deterministic) ---------------------------------

/** Quote and escape an arbitrary string as a Typst string literal. */
const q = (text: string): string =>
  `"${text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim()}"`;

/** Strip inline Markdown emphasis/code markers, leaving literal text. */
const stripInline = (text: string): string =>
  text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The document preamble that fixes the page to a single column with a linear
 * reading order, a real selectable text layer, and high-contrast text (R32.4,
 * R42.4). `justify: false` keeps a natural left-aligned reading order; the
 * document title aids screen-reader/AT identification.
 */
const preamble = (template: AtsPdfTemplate, title?: string): string => {
  const fonts = `(${template.fontFamilies.map(q).join(', ')})`;
  const lines = [
    title ? `#set document(title: ${q(title)})` : undefined,
    `#set page(paper: "a4", margin: ${template.pageMargin})`,
    `#set text(font: ${fonts}, size: ${template.fontSize}, fill: rgb(${q(template.textColor)}))`,
    `#set par(justify: false, leading: 0.65em)`,
    `#show heading: set block(spacing: 0.9em)`,
  ].filter((l): l is string => l !== undefined);
  return lines.join('\n');
};

/** Emit a Typst heading of the given level with literal text. */
const heading = (level: number, text: string): string =>
  `#heading(level: ${level}, ${q(text)})`;

/** Emit a single Typst paragraph with literal text. */
const paragraph = (text: string): string => `#par(${q(text)})`;

/** Emit a Typst bullet list (linear, no tables) from literal item strings. */
const bulletList = (items: readonly string[]): string =>
  `#list(${items.map(q).join(', ')})`;

/** The bullet text, surfacing the needs-metric marker when flagged (R30.4). */
const bulletText = (bullet: CvBullet): string =>
  bullet.needsMetric ? `${bullet.text} ${NEEDS_METRIC_MARKER}` : bullet.text;

/** Flatten an education / certification entry to one linear line. */
const entryLine = (entry: CvEntry): string =>
  [entry.title, entry.subtitle, entry.detail]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(' — ');

/**
 * Build the ATS-safe Typst document source from a {@link CvModel} (R32.4,
 * R42.4). Pure and deterministic: the same model + template always yields the
 * same source. Sections appear in a fixed, linear reading order (header,
 * summary, experience, skills, education, certifications); empty sections are
 * omitted so a sparse model still renders cleanly. The renderer only restyles —
 * it never adds, drops, or alters model content (R32.5).
 */
export const buildTypstSource = (
  cv: CvModel,
  template: AtsPdfTemplate = DEFAULT_ATS_TEMPLATE,
): string => {
  const title = cv.header.name?.trim() || `CV — ${cv.targetRole.title}`;
  const blocks: string[] = [preamble(template, title)];

  const name = cv.header.name?.trim();
  if (name) blocks.push(heading(1, name));

  const contact = (cv.header.contact ?? [])
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (contact.length > 0) blocks.push(paragraph(contact.join(' · ')));

  const summary = cv.summary?.trim();
  if (summary) {
    blocks.push(heading(2, 'Summary'));
    blocks.push(paragraph(summary));
  }

  if (cv.experience.length > 0) {
    blocks.push(heading(2, 'Experience'));
    blocks.push(bulletList(cv.experience.map(bulletText)));
  }

  if (cv.skills.length > 0) {
    blocks.push(heading(2, 'Skills'));
    blocks.push(bulletList(cv.skills.map((s) => s.name)));
  }

  if (cv.education.length > 0) {
    blocks.push(heading(2, 'Education'));
    blocks.push(bulletList(cv.education.map(entryLine)));
  }

  if (cv.certifications.length > 0) {
    blocks.push(heading(2, 'Certifications'));
    blocks.push(bulletList(cv.certifications.map(entryLine)));
  }

  return `${blocks.join('\n\n')}\n`;
};

/**
 * Build the ATS-safe Typst document source from an already-confirmed Markdown
 * source string (R32.2). A deliberately small, deterministic line mapper:
 * ATX headings become Typst headings, `-`/`*`/`+` bullets become a single Typst
 * list, blank lines break paragraphs, and everything else is a paragraph. Inline
 * emphasis/code markers are flattened to literal text. The result is the same
 * single-column, linear, table-free, selectable-text document as the model path.
 */
export const markdownToTypstSource = (
  markdown: string,
  template: AtsPdfTemplate = DEFAULT_ATS_TEMPLATE,
): string => {
  const blocks: string[] = [preamble(template)];
  let listBuffer: string[] = [];

  const flushList = (): void => {
    if (listBuffer.length > 0) {
      blocks.push(bulletList(listBuffer));
      listBuffer = [];
    }
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') {
      flushList();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      blocks.push(heading(h[1].length, stripInline(h[2])));
      continue;
    }
    const b = /^[-*+]\s+(.*)$/.exec(line);
    if (b) {
      listBuffer.push(stripInline(b[1]));
      continue;
    }
    flushList();
    blocks.push(paragraph(stripInline(line)));
  }
  flushList();

  return `${blocks.join('\n\n')}\n`;
};

// --- Render (compiles via the injected boundary) ---------------------------

/**
 * Render an ATS-safe, accessible PDF from the confirmed CV (R32.2, R32.4,
 * R42.4) by compiling its Typst source through the injected {@link
 * TypstCompiler}. Accepts either the single {@link CvModel} (preferred — keeps
 * cross-format fidelity, R32.5) or the already-confirmed Markdown source string.
 *
 * Never throws on a compile failure: it resolves with a graceful
 * {@link PdfResult} (`ok: false`) so a failed PDF can never block delivery of the
 * Markdown primary or the DOCX format (R32.2).
 */
export const renderPdf = async (
  input: CvModel | string,
  compiler: TypstCompiler,
  template: AtsPdfTemplate = DEFAULT_ATS_TEMPLATE,
): Promise<PdfResult> => {
  const typstSource =
    typeof input === 'string'
      ? markdownToTypstSource(input, template)
      : buildTypstSource(input, template);

  try {
    const bytes = await compiler.compile(typstSource);
    return { ok: true, bytes, typstSource };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error, typstSource };
  }
};
