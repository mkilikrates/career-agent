// Unit tests for post-extraction AI dedup suggestions (R15.4, Problem D).
//
// The suggestAiDedups function produces SUGGESTIONS only — it never auto-merges.
// It detects two high-confidence relationships:
//   * Parenthetical stripping: "DNS (Route 53)" + "DNS" → suggest merge.
//   * Vendor-qualified: "AWS Lambda" + "Lambda" → suggest merge.
// It must NOT produce false positives for confusable pairs like Java/JavaScript.

import { describe, it, expect } from 'vitest';
import {
  suggestAiDedups,
  stripParenthetical,
  stripVendorPrefix,
} from './ai-dedup';

describe('stripParenthetical', () => {
  it('removes trailing parenthetical content', () => {
    expect(stripParenthetical('DNS (Route 53)')).toBe('DNS');
    expect(stripParenthetical('Terraform (IaC)')).toBe('Terraform');
    expect(stripParenthetical('Node.js (LTS)')).toBe('Node.js');
  });

  it('returns unchanged when no parenthetical is present', () => {
    expect(stripParenthetical('JavaScript')).toBe('JavaScript');
    expect(stripParenthetical('AWS Lambda')).toBe('AWS Lambda');
  });

  it('only strips trailing parentheticals, not mid-string ones', () => {
    // "(foo) bar" is not a trailing parenthetical
    expect(stripParenthetical('(foo) bar')).toBe('(foo) bar');
  });
});

describe('stripVendorPrefix', () => {
  it('detects known vendor prefixes', () => {
    expect(stripVendorPrefix('AWS Lambda')).toBe('Lambda');
    expect(stripVendorPrefix('Azure DevOps')).toBe('DevOps');
    expect(stripVendorPrefix('Google Cloud Pub/Sub')).toBe('Pub/Sub');
    expect(stripVendorPrefix('HashiCorp Terraform')).toBe('Terraform');
  });

  it('returns null when no vendor prefix is present', () => {
    expect(stripVendorPrefix('Lambda')).toBeNull();
    expect(stripVendorPrefix('JavaScript')).toBeNull();
    expect(stripVendorPrefix('Terraform')).toBeNull();
  });

  it('is case-insensitive for vendor prefix matching', () => {
    expect(stripVendorPrefix('aws Lambda')).toBe('Lambda');
    expect(stripVendorPrefix('AZURE DevOps')).toBe('DevOps');
  });
});

describe('suggestAiDedups — parenthetical stripping', () => {
  it('suggests merge when parenthetical variant and standalone exist', () => {
    const suggestions = suggestAiDedups([
      { name: 'DNS (Route 53)' },
      { name: 'DNS' },
    ]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].canonical).toBe('DNS');
    expect(suggestions[0].variants).toContain('DNS (Route 53)');
    expect(suggestions[0].reason).toContain('parenthetical');
  });

  it('groups multiple parenthetical variants of the same base', () => {
    const suggestions = suggestAiDedups([
      { name: 'Terraform (IaC)' },
      { name: 'Terraform (HashiCorp)' },
      { name: 'Terraform' },
    ]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].canonical).toBe('Terraform');
    expect(suggestions[0].variants).toContain('Terraform (IaC)');
    expect(suggestions[0].variants).toContain('Terraform (HashiCorp)');
  });

  it('does NOT suggest merge when only parenthetical forms exist (no standalone base)', () => {
    const suggestions = suggestAiDedups([
      { name: 'DNS (Route 53)' },
      { name: 'DNS (CloudFlare)' },
    ]);
    // Without a standalone "DNS" there's no high-confidence canonical to pick.
    expect(suggestions).toHaveLength(0);
  });
});

describe('suggestAiDedups — vendor-qualified detection', () => {
  it('suggests merge for vendor-qualified vs standalone', () => {
    const suggestions = suggestAiDedups([
      { name: 'AWS Lambda', since: '2018' },
      { name: 'Lambda', since: '2017' },
    ]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].canonical).toBe('Lambda');
    expect(suggestions[0].variants).toContain('AWS Lambda');
    expect(suggestions[0].reason).toContain('vendor-qualified');
  });

  it('detects Azure-qualified forms', () => {
    const suggestions = suggestAiDedups([
      { name: 'Azure DevOps' },
      { name: 'DevOps' },
    ]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].canonical).toBe('DevOps');
    expect(suggestions[0].variants).toContain('Azure DevOps');
  });

  it('does NOT suggest when only vendor-qualified form exists (no standalone)', () => {
    const suggestions = suggestAiDedups([
      { name: 'AWS Lambda' },
      { name: 'EC2' },
    ]);
    expect(suggestions).toHaveLength(0);
  });
});

describe('suggestAiDedups — no false positives', () => {
  it('does NOT suggest merge for confusable pairs like Java/JavaScript', () => {
    const suggestions = suggestAiDedups([
      { name: 'Java' },
      { name: 'JavaScript' },
    ]);
    expect(suggestions).toHaveLength(0);
  });

  it('does NOT suggest merge for unrelated skills', () => {
    const suggestions = suggestAiDedups([
      { name: 'Kubernetes' },
      { name: 'Docker' },
      { name: 'Terraform' },
    ]);
    expect(suggestions).toHaveLength(0);
  });

  it('does NOT suggest merge for partial name overlaps without structural match', () => {
    const suggestions = suggestAiDedups([
      { name: 'React' },
      { name: 'React Native' },
    ]);
    // "React Native" doesn't have a vendor prefix that matches "React",
    // and "React" doesn't have parentheticals. No structural match.
    expect(suggestions).toHaveLength(0);
  });
});

describe('suggestAiDedups — multiple groups', () => {
  it('produces separate suggestions for independent groups', () => {
    const suggestions = suggestAiDedups([
      { name: 'DNS (Route 53)' },
      { name: 'DNS' },
      { name: 'AWS Lambda' },
      { name: 'Lambda' },
      { name: 'Kubernetes' },
      { name: 'Docker' },
    ]);
    expect(suggestions).toHaveLength(2);
    const canonicals = suggestions.map((s) => s.canonical).sort();
    expect(canonicals).toEqual(['DNS', 'Lambda']);
  });

  it('handles overlapping strategies without duplicating suggestions', () => {
    // "AWS Lambda" could in theory trigger both parenthetical and vendor checks.
    // Only one suggestion should appear per pair.
    const suggestions = suggestAiDedups([
      { name: 'AWS Lambda' },
      { name: 'Lambda' },
      { name: 'Lambda (Serverless)' },
    ]);
    // Should get: vendor-qualified (AWS Lambda → Lambda) and parenthetical (Lambda (Serverless) → Lambda)
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    // All suggestions should reference Lambda as canonical
    for (const s of suggestions) {
      expect(s.canonical).toBe('Lambda');
    }
  });
});

describe('suggestAiDedups — edge cases', () => {
  it('returns empty array for empty input', () => {
    expect(suggestAiDedups([])).toEqual([]);
  });

  it('returns empty array for single skill', () => {
    expect(suggestAiDedups([{ name: 'TypeScript' }])).toEqual([]);
  });

  it('is case-insensitive when matching base names', () => {
    const suggestions = suggestAiDedups([
      { name: 'dns (Route 53)' },
      { name: 'DNS' },
    ]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].canonical).toBe('DNS');
  });
});
