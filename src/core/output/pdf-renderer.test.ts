import { describe, expect, it } from 'vitest';
import {
  asBulletId,
  asDocId,
  asISODate,
  asItemId,
  asRoleSlug,
  asSkillId,
  asStarId,
  type Accomplishment,
  type ExtractedItem,
  type RolePreference,
  type SkillId,
  type SkillMapEntry,
  type TalkingPoint,
} from '@core/types';
import { sourceLine, trailOf } from '@core/provenance';
import { buildReferenceGraph } from '@core/registry';
import type { SkillMap } from '@core/skills';
import { buildCvModel } from './cv-model';
import type { CvModel } from './cv-model';
import { NEEDS_METRIC_MARKER } from './cv-model';
import { renderMarkdown } from './markdown-renderer';
import {
  buildTypstSource,
  markdownToTypstSource,
  renderPdf,
  type PdfResult,
  type TypstCompiler,
} from './pdf-renderer';

// --- Fixtures (mirroring the markdown-renderer test setup) -----------------

const doc = asDocId('cv.md');

const skill = (id: string, name: string): SkillMapEntry => ({
  id: asSkillId(id),
  name,
  category: 'Technical',
  proficiencySignal: 'Evidence-based.',
  evidence: [],
  recency: asISODate('2024-01-01'),
});

const skillMapOf = (
  entries: SkillMapEntry[],
  accomplishments: readonly Accomplishment[] = [],
  talkingPoints: readonly TalkingPoint[] = [],
): SkillMap => ({
  entries,
  graph: buildReferenceGraph({ skills: entries, accomplishments, talkingPoints }),
});

const accomplishment = (id: string, text: string, skills: SkillId[]): Accomplishment => ({
  id: asBulletId(id),
  text,
  provenance: trailOf(sourceLine(doc, 1, text)),
  skills,
});

const talkingPoint = (
  id: string,
  polished: string,
  skills: SkillId[],
  opts: { result?: string; flags?: TalkingPoint['flags'] } = {},
): TalkingPoint => ({
  id: asStarId(id),
  polished,
  skills,
  flags: opts.flags ?? [],
  ...(opts.result !== undefined ? { result: opts.result } : {}),
});

const role = (matched: SkillId[]): RolePreference => ({
  slug: asRoleSlug('staff-engineer'),
  title: 'Staff Engineer',
  description: '',
  matchScore: 0.8,
  matchedSkills: matched,
  gapSkills: [],
  rationale: '',
  rank: 1,
  tag: 'actively_applying',
});

const item = (
  id: string,
  type: ExtractedItem['type'],
  fields: Record<string, unknown>,
): ExtractedItem => ({
  id: asItemId(id),
  type,
  fields,
  confidence: 'High',
  provenance: trailOf(sourceLine(doc, 1, id)),
  userConfirmed: false,
  private: false,
  sourceDoc: doc,
});

/** A fully-populated model exercising every section. */
const fullModel = (): CvModel => {
  const react = skill('SKILL-react', 'React');
  const node = skill('SKILL-node', 'Node.js');
  const acc = accomplishment('BULLET-01', 'Led the React migration across 12 teams.', [
    react.id,
  ]);
  const tp = talkingPoint('STAR-01', 'Scaled the Node.js platform.', [node.id], {
    flags: ['needs_metric'],
  });
  const map = skillMapOf([react, node], [acc], [tp]);
  const edu = item('I-edu', 'education', {
    degree: 'BSc Computer Science',
    institution: 'MIT',
    field: 'Distributed Systems',
  });
  const cert = item('I-cert', 'certification', {
    name: 'AWS Solutions Architect',
    issuer: 'Amazon',
    date: '2023',
  });
  return buildCvModel(role([react.id]), {
    skillMap: map,
    accomplishments: [acc],
    talkingPoints: [tp],
    items: [edu, cert],
    header: { name: 'Ada Lovelace', contact: ['ada@example.com', '+1 555 0100'] },
    summary: 'Staff engineer with a focus on platform reliability.',
  });
};

// --- Fake Typst-Wasm boundary (external boundary is always mocked) ---------

/** A fake compiler that records its input and returns deterministic bytes. */
const fakeCompiler = (
  bytes: Uint8Array = new Uint8Array([0x25, 0x50, 0x44, 0x46]), // "%PDF"
): TypstCompiler & { lastSource?: string } => {
  const compiler: TypstCompiler & { lastSource?: string } = {
    async compile(typstSource: string): Promise<Uint8Array> {
      compiler.lastSource = typstSource;
      return bytes;
    },
  };
  return compiler;
};

/** A fake compiler that always fails, simulating a Typst-Wasm compile error. */
const failingCompiler = (message = 'typst: unexpected error'): TypstCompiler => ({
  async compile(): Promise<Uint8Array> {
    throw new Error(message);
  },
});

// --- Successful compile ----------------------------------------------------

describe('@core/output — renderPdf compiles via the injected Typst-Wasm boundary (R32.2)', () => {
  it('returns the PDF bytes produced by the injected compiler', async () => {
    const expected = new Uint8Array([1, 2, 3, 4, 5]);
    const compiler = fakeCompiler(expected);
    const result = await renderPdf(fullModel(), compiler);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes).toEqual(expected);
  });

  it('compiles the exact Typst source it built (no hidden transformation)', async () => {
    const compiler = fakeCompiler();
    const cv = fullModel();
    const result = await renderPdf(cv, compiler);
    expect(result.ok).toBe(true);
    expect(compiler.lastSource).toBe(buildTypstSource(cv));
    if (result.ok) expect(result.typstSource).toBe(buildTypstSource(cv));
  });

  it('accepts the confirmed Markdown source string as input', async () => {
    const compiler = fakeCompiler();
    const md = renderMarkdown(fullModel());
    const result = await renderPdf(md, compiler);
    expect(result.ok).toBe(true);
    expect(compiler.lastSource).toBe(markdownToTypstSource(md));
  });
});

// --- ATS-safe / accessible source (R32.4, R42.4) ---------------------------

describe('@core/output — buildTypstSource produces ATS-safe, accessible source (R32.4, R42.4)', () => {
  it('is single-column and linear: no layout tables, columns, or images', () => {
    const src = buildTypstSource(fullModel());
    expect(src).not.toMatch(/#?table\s*\(/); // no layout tables
    expect(src).not.toMatch(/#?image\s*\(/); // no text embedded in images
    expect(src).not.toMatch(/columns\s*\(/); // no multi-column layout
    expect(src).not.toMatch(/#?grid\s*\(/); // no grid layout
  });

  it('emits sections in a fixed, linear reading order', () => {
    const src = buildTypstSource(fullModel());
    const order = ['Summary', 'Experience', 'Skills', 'Education', 'Certifications'];
    const positions = order.map((h) => src.indexOf(`#heading(level: 2, "${h}")`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('sets a high-contrast text fill and a real (selectable) text layer', () => {
    const src = buildTypstSource(fullModel());
    expect(src).toContain('#set text(');
    expect(src).toContain('fill: rgb("#111827")'); // near-black on white, AA contrast
    // Selectable text: content flows through #heading/#par/#list text, never images.
    expect(src).toContain('#heading(level: 1, "Ada Lovelace")');
    expect(src).toContain('#par(');
    expect(src).toContain('#list(');
  });

  it('sets a document title for assistive-technology identification', () => {
    const src = buildTypstSource(fullModel());
    expect(src).toContain('#set document(title: "Ada Lovelace")');
  });

  it('preserves every model bullet, skill and entry verbatim (R32.5)', () => {
    const cv = fullModel();
    const src = buildTypstSource(cv);
    for (const b of cv.experience) expect(src).toContain(b.text);
    for (const s of cv.skills) expect(src).toContain(s.name);
    for (const e of cv.education) expect(src).toContain(e.title);
    for (const c of cv.certifications) expect(src).toContain(c.title);
  });

  it('surfaces the needs-metric marker on a metric-needing bullet (R30.4)', () => {
    const cv = fullModel();
    const needsMetric = cv.experience.find((b) => b.needsMetric);
    expect(needsMetric).toBeDefined();
    const src = buildTypstSource(cv);
    expect(src).toContain(`${needsMetric!.text} ${NEEDS_METRIC_MARKER}`);
  });

  it('omits empty sections for a sparse model', () => {
    const src = buildTypstSource(buildCvModel(role([]), { skillMap: skillMapOf([]) }));
    expect(src).not.toContain('#heading(level: 2, "Summary")');
    expect(src).not.toContain('#heading(level: 2, "Experience")');
    expect(src).not.toContain('#heading(level: 2, "Skills")');
  });
});

// --- Markdown → Typst mapping is also ATS-safe -----------------------------

describe('@core/output — markdownToTypstSource maps Markdown to ATS-safe Typst', () => {
  it('maps headings and bullets without introducing tables or images', () => {
    const src = markdownToTypstSource(renderMarkdown(fullModel()));
    expect(src).toContain('#heading(level: 1, "Ada Lovelace")');
    expect(src).toContain('#heading(level: 2, "Skills")');
    expect(src).toContain('#list(');
    expect(src).not.toMatch(/#?table\s*\(/);
    expect(src).not.toMatch(/#?image\s*\(/);
  });
});

// --- Graceful failure (R32.2) ----------------------------------------------

describe('@core/output — renderPdf fails gracefully without blocking other formats (R32.2)', () => {
  it('returns a failure result instead of throwing when compilation fails', async () => {
    const cv = fullModel();
    let result!: PdfResult;
    await expect(
      (async () => {
        result = await renderPdf(cv, failingCompiler('boom'));
      })(),
    ).resolves.toBeUndefined(); // never throws
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('boom');
      expect(result.typstSource).toBe(buildTypstSource(cv));
    }
  });

  it('still lets the Markdown primary deliver when the PDF fails', async () => {
    const cv = fullModel();
    const md = renderMarkdown(cv); // primary format, independent of PDF
    const pdf = await renderPdf(cv, failingCompiler());
    expect(pdf.ok).toBe(false);
    // The Markdown primary is unaffected and still complete.
    expect(md).toContain('# Ada Lovelace');
    expect(md).toContain('## Experience');
  });

  it('normalises non-Error throwables into a string error', async () => {
    const compiler: TypstCompiler = {
      async compile(): Promise<Uint8Array> {
        throw 'string failure';
      },
    };
    const result = await renderPdf(fullModel(), compiler);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('string failure');
  });
});

// --- Determinism -----------------------------------------------------------

describe('@core/output — Typst source generation is deterministic', () => {
  it('produces an identical source for an identical model', () => {
    expect(buildTypstSource(fullModel())).toBe(buildTypstSource(fullModel()));
  });

  it('produces an identical source for an identical Markdown string', () => {
    const md = renderMarkdown(fullModel());
    expect(markdownToTypstSource(md)).toBe(markdownToTypstSource(md));
  });
});

// --- Escaping --------------------------------------------------------------

describe('@core/output — Typst source escapes literal text safely', () => {
  it('escapes quotes and backslashes so arbitrary text never breaks the source', () => {
    const react = skill('SKILL-x', 'C# "Sharp" \\ stack');
    const cv = buildCvModel(role([]), { skillMap: skillMapOf([react]) });
    const src = buildTypstSource(cv);
    expect(src).toContain('C# \\"Sharp\\" \\\\ stack');
  });
});
