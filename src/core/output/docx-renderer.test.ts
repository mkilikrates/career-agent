import JSZip from 'jszip';
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
import { buildDocxDocument, renderDocx } from './docx-renderer';

// --- Fixtures (mirroring the markdown/pdf-renderer test setup) -------------

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

/** Read `word/document.xml` (the body text) out of a packed `.docx` byte array. */
const documentXml = async (bytes: Uint8Array): Promise<string> => {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file('word/document.xml');
  expect(entry).not.toBeNull();
  return entry!.async('string');
};

// --- Valid OOXML bytes -----------------------------------------------------

describe('@core/output — renderDocx produces a valid structured DOCX (R32.3)', () => {
  it('produces non-empty bytes that are a valid OOXML (ZIP) package', async () => {
    const bytes = await renderDocx(fullModel());
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    // ZIP local-file-header magic "PK\x03\x04" — every OOXML .docx is a ZIP.
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('packs the expected OOXML parts (a real Word document body)', async () => {
    const bytes = await renderDocx(fullModel());
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file('word/document.xml')).not.toBeNull();
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
  });
});

// --- Content fidelity: nothing added, dropped, or altered (R32.5) ----------

describe('@core/output — DOCX preserves all CvModel content (R32.5)', () => {
  it('contains every bullet, skill, and entry from the model', async () => {
    const cv = fullModel();
    const xml = await documentXml(await renderDocx(cv));
    for (const b of cv.experience) expect(xml).toContain(b.text);
    for (const s of cv.skills) expect(xml).toContain(s.name);
    for (const e of cv.education) expect(xml).toContain(e.title);
    for (const c of cv.certifications) expect(xml).toContain(c.title);
  });

  it('contains the header name, contact, and summary verbatim', async () => {
    const cv = fullModel();
    const xml = await documentXml(await renderDocx(cv));
    expect(xml).toContain('Ada Lovelace');
    expect(xml).toContain('ada@example.com');
    expect(xml).toContain('+1 555 0100');
    expect(xml).toContain(cv.summary!);
  });

  it('carries the same textual bullets as the Markdown primary (cross-format fidelity)', async () => {
    const cv = fullModel();
    const xml = await documentXml(await renderDocx(cv));
    // Every experience bullet the Markdown primary renders is present in the DOCX.
    const md = renderMarkdown(cv);
    for (const b of cv.experience) {
      expect(md).toContain(b.text);
      expect(xml).toContain(b.text);
    }
  });
});

// --- ATS-safe structure: single-column, no tables/images (R32.4) -----------

describe('@core/output — DOCX is ATS-safe: single-column, no tables or images (R32.4)', () => {
  it('contains no layout tables', async () => {
    const xml = await documentXml(await renderDocx(fullModel()));
    expect(xml).not.toMatch(/<w:tbl[ >]/); // no table element
  });

  it('contains no embedded images or drawings (no text-in-images)', async () => {
    const xml = await documentXml(await renderDocx(fullModel()));
    expect(xml).not.toContain('<w:drawing');
    expect(xml).not.toContain('<w:pict');
  });

  it('declares no multi-column section layout (single column)', async () => {
    const xml = await documentXml(await renderDocx(fullModel()));
    // A single-column section never emits a <w:cols> with num > 1.
    expect(xml).not.toMatch(/w:num="[2-9]/);
  });

  it('emits headings in a fixed, linear reading order', async () => {
    const xml = await documentXml(await renderDocx(fullModel()));
    const order = ['Summary', 'Experience', 'Skills', 'Education', 'Certifications'];
    const positions = order.map((h) => xml.indexOf(h));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

// --- needs_metric annotation (R30.4) ---------------------------------------

describe('@core/output — DOCX surfaces the needs-metric annotation (R30.4)', () => {
  it('appends the needs-metric marker to a metric-needing bullet', async () => {
    const cv = fullModel();
    const needsMetric = cv.experience.find((b) => b.needsMetric);
    expect(needsMetric).toBeDefined();
    const xml = await documentXml(await renderDocx(cv));
    expect(xml).toContain(NEEDS_METRIC_MARKER);
    // The marker sits with its bullet's text, not free-floating.
    expect(xml).toContain(needsMetric!.text);
  });

  it('does not add the marker to a bullet that is not flagged', async () => {
    const react = skill('SKILL-react', 'React');
    const acc = accomplishment('BULLET-01', 'Shipped the new checkout flow.', [react.id]);
    const cv = buildCvModel(role([react.id]), {
      skillMap: skillMapOf([react], [acc]),
      accomplishments: [acc],
    });
    const xml = await documentXml(await renderDocx(cv));
    expect(xml).toContain('Shipped the new checkout flow.');
    expect(xml).not.toContain(NEEDS_METRIC_MARKER);
  });
});

// --- Determinism (R32.5) ---------------------------------------------------

describe('@core/output — DOCX rendering is deterministic', () => {
  it('produces identical document content for an identical model', async () => {
    const a = await documentXml(await renderDocx(fullModel()));
    const b = await documentXml(await renderDocx(fullModel()));
    expect(a).toBe(b);
  });

  it('produces byte-identical output for an identical model (pinned timestamps)', async () => {
    const a = await renderDocx(fullModel());
    const b = await renderDocx(fullModel());
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

// --- Sparse model ----------------------------------------------------------

describe('@core/output — DOCX renders a sparse model cleanly', () => {
  it('omits empty sections and still produces a valid document', async () => {
    const cv = buildCvModel(role([]), { skillMap: skillMapOf([]) });
    const document = buildDocxDocument(cv);
    expect(document).toBeInstanceOf(Object);
    const xml = await documentXml(await renderDocx(cv));
    expect(xml).not.toContain('Summary');
    expect(xml).not.toContain('Experience');
    expect(xml).not.toContain('Skills');
  });
});
