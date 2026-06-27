// Unit tests for the AI skill-discovery helpers (R42.1, R47).
//
// These cover the trust-relevant behaviours the UI relies on:
//   * private items are included ONLY when includePrivate is set (the local
//     on-device case, R7.6) and excluded otherwise (cloud, R46.4);
//   * the full corpus is chunked, never truncated;
//   * model replies parse into clean, de-duplicated candidate names.

import { describe, it, expect } from 'vitest';

import {
  buildDiscoveryCorpus,
  buildRawDiscoveryCorpus,
  buildDiscoveryPrompt,
  parseDiscoveredSkills,
  itemToLine,
  DISCOVERY_PROMPT_INSTRUCTION,
} from './skill-discovery';
import { asItemId, asDocId, type ExtractedItem } from '@core/types';

const item = (
  id: string,
  type: ExtractedItem['type'],
  fields: Record<string, unknown>,
  options: { private?: boolean } = {},
): ExtractedItem =>
  ({
    id: asItemId(`${id}`),
    type,
    fields,
    confidence: 'High',
    provenance: [],
    userConfirmed: false,
    private: options.private ?? false,
    sourceDoc: asDocId('doc.md'),
  }) as unknown as ExtractedItem;

describe('itemToLine', () => {
  it('flattens type + non-empty fields, comma-joining arrays', () => {
    const line = itemToLine(
      item('a', 'employment', {
        title: 'SRE',
        employer: 'Acme',
        technologies: ['Kubernetes', 'Go'],
        blank: '',
      }),
    );
    expect(line).toBe('employment; title: SRE; employer: Acme; technologies: Kubernetes, Go');
  });
});

describe('buildDiscoveryCorpus — privacy boundary (R46.4 / R7.6)', () => {
  const items = [
    item('a', 'skill', { name: 'Public Skill' }),
    item('b', 'skill', { name: 'Secret Skill' }, { private: true }),
  ];

  it('EXCLUDES private items for a cloud provider (includePrivate=false)', () => {
    const chunks = buildDiscoveryCorpus(items, { includePrivate: false });
    const text = chunks.join('\n');
    expect(text).toContain('Public Skill');
    expect(text).not.toContain('Secret Skill');
  });

  it('INCLUDES private items for a local on-device provider (includePrivate=true)', () => {
    const chunks = buildDiscoveryCorpus(items, { includePrivate: true });
    const text = chunks.join('\n');
    expect(text).toContain('Public Skill');
    expect(text).toContain('Secret Skill');
  });
});

describe('buildDiscoveryCorpus — chunking (no truncation)', () => {
  it('packs everything into chunks no larger than the budget, dropping nothing', () => {
    // 40 items (~45 chars each ≈ 1800 chars) against the minimum 500-char budget
    // forces several chunks.
    const items = Array.from({ length: 40 }, (_, i) =>
      item(`s${i}`, 'skill', { name: `Skill Number ${i} With Some Padding Text` }),
    );
    const budget = 500;
    const chunks = buildDiscoveryCorpus(items, { includePrivate: false, maxCharsPerChunk: budget });

    expect(chunks.length).toBeGreaterThan(1);
    // Every original skill survives somewhere across the chunks.
    const all = chunks.join('\n');
    for (let i = 0; i < 40; i++) expect(all).toContain(`Skill Number ${i} `);
    // No chunk exceeds the budget.
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(budget);
  });

  it('keeps an oversized single line as its own chunk rather than dropping it', () => {
    const huge = 'x'.repeat(2000);
    const chunks = buildDiscoveryCorpus([item('h', 'skill', { name: huge })], {
      includePrivate: false,
      maxCharsPerChunk: 500,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain(huge);
  });

  it('returns no chunks when there is nothing to send', () => {
    expect(buildDiscoveryCorpus([], { includePrivate: true })).toEqual([]);
  });
});

describe('buildRawDiscoveryCorpus — whole-document corpus (local-only)', () => {
  it('chunks raw document text by lines, separating multiple documents, dropping nothing', () => {
    const docA = 'Headline: Cloud Engineer\nLed migration to Kubernetes and Terraform.';
    const docB = 'Built CI/CD with GitLab and ran observability on Grafana.';
    const chunks = buildRawDiscoveryCorpus([docA, '', docB], { maxCharsPerChunk: 500 });
    const all = chunks.join('\n');
    expect(all).toContain('Cloud Engineer');
    expect(all).toContain('Kubernetes and Terraform');
    expect(all).toContain('GitLab');
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
  });

  it('returns no chunks when there is no raw text', () => {
    expect(buildRawDiscoveryCorpus([], {})).toEqual([]);
    expect(buildRawDiscoveryCorpus(['', '   '])).toEqual([]);
  });

  it('splits a long raw document across multiple chunks', () => {
    const longDoc = Array.from({ length: 40 }, (_, i) => `Line ${i} describing work with tools`).join('\n');
    const chunks = buildRawDiscoveryCorpus([longDoc], { maxCharsPerChunk: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < 40; i++) expect(chunks.join('\n')).toContain(`Line ${i} `);
  });
});

describe('buildDiscoveryPrompt', () => {
  it('prepends the discovery instruction to the corpus chunk', () => {
    const prompt = buildDiscoveryPrompt('employment; title: SRE');
    expect(prompt.startsWith(DISCOVERY_PROMPT_INSTRUCTION)).toBe(true);
    expect(prompt).toContain('CAREER EVIDENCE:');
    expect(prompt).toContain('employment; title: SRE');
  });
});

describe('parseDiscoveredSkills', () => {
  it('splits on commas/newlines/semicolons/bullets and trims markers', () => {
    const reply = '- Kubernetes\n* Go;  Terraform, Incident Response.';
    expect(parseDiscoveredSkills(reply, new Set())).toEqual([
      'Kubernetes',
      'Go',
      'Terraform',
      'Incident Response',
    ]);
  });

  it('drops empties and over-long (>60 char) fragments that look like prose', () => {
    const prose = 'a'.repeat(61);
    const out = parseDiscoveredSkills(`Kubernetes, ${prose}, ,Go`, new Set());
    expect(out).toEqual(['Kubernetes', 'Go']);
  });

  it('de-dupes case-insensitively against the existing set and within the reply', () => {
    const existing = new Set(['kubernetes']);
    const out = parseDiscoveredSkills('Kubernetes, Go, go, GO', existing);
    expect(out).toEqual(['Go']);
  });
});
