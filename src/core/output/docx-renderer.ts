// The structured DOCX renderer — the ATS-portal upload format (R32.3, R32.4).
//
// The Output_Engine derives every CV format from a single in-memory
// {@link CvModel} so the formats can never drift (R32.5). This module is the
// DOCX renderer: it turns the confirmed CV (the {@link CvModel}) into a
// simplified, structured rich-text Word document optimised for upload into ATS
// portals (R32.3), built with the pure-JS `docx` OOXML builder.
//
// ## Structured rich text, not layout (R32.3, R32.4)
//
// The document is deliberately "simplified": a single linear column of
// paragraphs, headings, and bullet lists — the same structure as the Markdown
// primary and the Typst-Wasm PDF, emitted top-to-bottom in the model's order. It
// carries a real text layer (Word stores genuine runs, never rasterised glyphs)
// and contains no layout tables, no meaning-bearing icons, and no text embedded
// in images. ATS parsers read it as plain, ordered text.
//
// ## A pure-JS boundary (no external mock needed)
//
// Unlike the Typst-Wasm PDF boundary, `docx` is a pure-JavaScript OOXML builder
// with no WebAssembly and no environment dependency, so core code can depend on
// it directly (it runs identically in Node and the browser, exactly like the
// JSZip dependency already used by the adapters). {@link buildDocxDocument} is a
// pure, deterministic builder of the document tree; {@link renderDocx} packs that
// tree to OOXML `.docx` bytes.
//
// ## Determinism (R32.5, R33)
//
// `docx` stamps a wall-clock created / modified date into the document's core
// properties, and the underlying ZIP records a wall-clock date on every entry —
// both of which would otherwise make the rendered bytes vary run-to-run. To keep
// the output a pure function of the model (so the same model always yields the
// same bytes, supporting immutable CV versions, R33), {@link renderDocx} repacks
// the document with both core-property timestamps and every ZIP entry date
// pinned to a fixed epoch ({@link DOCX_EPOCH}). The renderer only restyles the
// model; it never adds, drops, or alters its content (R32.5), and it surfaces
// the {@link NEEDS_METRIC_MARKER} on every metric-needing bullet (R30.4).

import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import JSZip from 'jszip';
import { NEEDS_METRIC_MARKER } from './cv-model';
import type { CvBullet, CvEntry, CvModel } from './cv-model';

/**
 * The fixed timestamp pinned into the document's core properties and every ZIP
 * entry so the rendered bytes are a deterministic function of the model (R32.5,
 * R33). The value itself is never surfaced to the user; it only neutralises the
 * wall-clock dates `docx` and the ZIP container would otherwise embed.
 */
export const DOCX_EPOCH = new Date(0);

/** A heading outline level accepted by `docx` (`Heading1`…`Heading6`). */
type HeadingLevelValue = (typeof HeadingLevel)[keyof typeof HeadingLevel];

// --- Paragraph builders (pure, deterministic) ------------------------------

/** A single heading paragraph at the given outline level with literal text. */
const heading = (level: HeadingLevelValue, text: string): Paragraph =>
  new Paragraph({ heading: level, children: [new TextRun(text)] });

/** A plain body paragraph with literal text, in natural top-to-bottom order. */
const body = (text: string): Paragraph =>
  new Paragraph({ children: [new TextRun(text)] });

/** A single bullet-list item (linear list, never a layout table) with text. */
const bullet = (text: string): Paragraph =>
  new Paragraph({ bullet: { level: 0 }, children: [new TextRun(text)] });

/** The bullet text, surfacing the needs-metric marker when flagged (R30.4). */
const bulletText = (b: CvBullet): string =>
  b.needsMetric ? `${b.text} ${NEEDS_METRIC_MARKER}` : b.text;

/** Flatten an education / certification entry to one linear line. */
const entryLine = (entry: CvEntry): string =>
  [entry.title, entry.subtitle, entry.detail]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(' — ');

/**
 * Build the ordered paragraph stream for a {@link CvModel} (R32.3, R32.4). Pure
 * and deterministic. Sections appear in a fixed, linear reading order (header,
 * summary, experience, skills, education, certifications); any empty section is
 * omitted so a sparse model still renders cleanly. Only headings, paragraphs,
 * and bullet items are emitted — never tables, icons, or images.
 */
const buildParagraphs = (cv: CvModel): Paragraph[] => {
  const paragraphs: Paragraph[] = [];

  const name = cv.header.name?.trim();
  if (name) paragraphs.push(heading(HeadingLevel.HEADING_1, name));

  const contact = (cv.header.contact ?? [])
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (contact.length > 0) paragraphs.push(body(contact.join(' · ')));

  const summary = cv.summary?.trim();
  if (summary) {
    paragraphs.push(heading(HeadingLevel.HEADING_2, 'Summary'));
    paragraphs.push(body(summary));
  }

  if (cv.experience.length > 0) {
    paragraphs.push(heading(HeadingLevel.HEADING_2, 'Experience'));
    for (const b of cv.experience) paragraphs.push(bullet(bulletText(b)));
  }

  if (cv.skills.length > 0) {
    paragraphs.push(heading(HeadingLevel.HEADING_2, 'Skills'));
    for (const s of cv.skills) paragraphs.push(bullet(s.name));
  }

  if (cv.education.length > 0) {
    paragraphs.push(heading(HeadingLevel.HEADING_2, 'Education'));
    for (const e of cv.education) paragraphs.push(bullet(entryLine(e)));
  }

  if (cv.certifications.length > 0) {
    paragraphs.push(heading(HeadingLevel.HEADING_2, 'Certifications'));
    for (const c of cv.certifications) paragraphs.push(bullet(entryLine(c)));
  }

  return paragraphs;
};

/**
 * Build the structured DOCX {@link Document} from a {@link CvModel} (R32.3,
 * R32.4). Pure and deterministic: the same model always yields the same document
 * tree. The single default section keeps the document single-column with a
 * linear reading order; its content is headings, paragraphs, and bullet lists
 * only — no layout tables, icons, or images.
 */
export const buildDocxDocument = (cv: CvModel): Document => {
  const title = cv.header.name?.trim() || `CV — ${cv.targetRole.title}`;
  return new Document({
    creator: 'Career Agent',
    title,
    sections: [{ children: buildParagraphs(cv) }],
  });
};

/**
 * Repack a `docx`-produced OOXML buffer into deterministic bytes (R32.5, R33):
 * the core-property created / modified timestamps and every ZIP entry date are
 * pinned to {@link DOCX_EPOCH}, neutralising the wall-clock dates that would
 * otherwise vary run-to-run. Content is untouched.
 */
const pinTimestamps = async (packed: Uint8Array): Promise<Uint8Array> => {
  const fixed = DOCX_EPOCH.toISOString();
  const zip = await JSZip.loadAsync(packed);

  const coreEntry = zip.file('docProps/core.xml');
  if (coreEntry) {
    const core = (await coreEntry.async('string'))
      .replace(/(<dcterms:created[^>]*>)[^<]*(<\/dcterms:created>)/, `$1${fixed}$2`)
      .replace(/(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)/, `$1${fixed}$2`);
    zip.file('docProps/core.xml', core);
  }

  for (const entry of Object.values(zip.files)) {
    if (!entry.dir) entry.date = DOCX_EPOCH;
  }

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
};

/**
 * Render a structured rich-text `.docx` from the confirmed CV (R32.3, R32.4) by
 * packing the {@link buildDocxDocument} tree to OOXML bytes. Derived entirely
 * from the single {@link CvModel} for cross-format fidelity (R32.5): the document
 * is single-column with a linear reading order, a real selectable text layer,
 * and no layout tables, meaning-bearing icons, or text embedded in images, and
 * it surfaces the {@link NEEDS_METRIC_MARKER} on every metric-needing bullet
 * (R30.4). Deterministic — wall-clock timestamps are pinned (see {@link
 * DOCX_EPOCH}) so the same model always yields the same bytes (R33).
 */
export const renderDocx = async (cv: CvModel): Promise<Uint8Array> => {
  const packed = await Packer.toBuffer(buildDocxDocument(cv));
  return pinTimestamps(new Uint8Array(packed));
};
