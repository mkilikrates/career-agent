// Task 41.10 — Tests for role discovery enriched payload (R20.6, R47.2).
//
// Unit tests for `buildDiscoveryPayload` with ATS career context data:
// job titles included, competencies included, education included, summary
// included, private items excluded for keyed-cloud destination.
// Also tests `buildDiscoveryPrompt` output for the career-context sections.

import { describe, it, expect } from 'vitest';
import { asISODate, asSkillId, type SkillMapEntry } from '@core/types';
import { buildReferenceGraph } from '@core/registry';
import type { SkillMap } from '@core/skills';
import type { EgressDestination } from '@core/assist';
import type { CareerContext } from '@core/types';
import { buildDiscoveryPayload, buildDiscoveryPrompt } from './role-discovery-payload';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLOUD: EgressDestination = { provider: 'openai', kind: 'keyed-cloud' };
const LOCAL: EgressDestination = { provider: 'ollama', kind: 'keyless-local' };

const skill = (
  id: string,
  name: string,
  opts: Partial<SkillMapEntry> = {},
): SkillMapEntry => ({
  id: asSkillId(id),
  name,
  category: 'Technical',
  proficiencySignal: 'Evidence-based.',
  evidence: [],
  since: asISODate('2024-01-01'),
  ...opts,
});

const mapOf = (entries: SkillMapEntry[]): SkillMap => ({
  entries,
  graph: buildReferenceGraph({ skills: entries }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildDiscoveryPayload with ATS career context (R20.6, R47.2)', () => {
  const atsData: CareerContext = {
    jobTitles: ['Senior Platform Engineer', 'SRE Lead'],
    competencies: ['Leadership', 'Stakeholder Management', 'Innovation'],
    education: ['MSc Computer Science, Imperial College London'],
    professionalSummary: 'Seasoned platform engineer with 15 years of experience.',
  };

  it('includes job titles in the payload when provided', () => {
    const map = mapOf([skill('SKILL-k8s', 'Kubernetes')]);
    const payload = buildDiscoveryPayload(map, CLOUD, atsData);
    expect(payload.jobTitles).toEqual(['Senior Platform Engineer', 'SRE Lead']);
  });

  it('includes competencies in the payload when provided', () => {
    const map = mapOf([skill('SKILL-k8s', 'Kubernetes')]);
    const payload = buildDiscoveryPayload(map, CLOUD, atsData);
    expect(payload.competencies).toEqual(['Leadership', 'Stakeholder Management', 'Innovation']);
  });

  it('includes education summaries in the payload when provided', () => {
    const map = mapOf([skill('SKILL-k8s', 'Kubernetes')]);
    const payload = buildDiscoveryPayload(map, CLOUD, atsData);
    expect(payload.educationSummaries).toEqual(['MSc Computer Science, Imperial College London']);
  });

  it('includes professional summary in the payload when provided', () => {
    const map = mapOf([skill('SKILL-k8s', 'Kubernetes')]);
    const payload = buildDiscoveryPayload(map, CLOUD, atsData);
    expect(payload.professionalSummary).toBe('Seasoned platform engineer with 15 years of experience.');
  });

  it('omits career context fields when ATS data is not provided', () => {
    const map = mapOf([skill('SKILL-k8s', 'Kubernetes')]);
    const payload = buildDiscoveryPayload(map, CLOUD);
    expect(payload.jobTitles).toBeUndefined();
    expect(payload.competencies).toBeUndefined();
    expect(payload.educationSummaries).toBeUndefined();
    expect(payload.professionalSummary).toBeUndefined();
  });

  it('omits career context fields when ATS data has empty arrays', () => {
    const map = mapOf([skill('SKILL-k8s', 'Kubernetes')]);
    const emptyAts: CareerContext = {
      jobTitles: [],
      competencies: [],
      education: [],
      professionalSummary: '',
    };
    const payload = buildDiscoveryPayload(map, CLOUD, emptyAts);
    expect(payload.jobTitles).toBeUndefined();
    expect(payload.competencies).toBeUndefined();
    expect(payload.educationSummaries).toBeUndefined();
    expect(payload.professionalSummary).toBeUndefined();
  });

  it('still excludes private skills for keyed-cloud even with ATS data', () => {
    const map = mapOf([
      skill('SKILL-k8s', 'Kubernetes'),
      skill('SKILL-secret', 'Secret Skill', { private: true }),
    ]);
    const payload = buildDiscoveryPayload(map, CLOUD, atsData);
    const names = payload.skills.map((s) => s.name);
    expect(names).toContain('Kubernetes');
    expect(names).not.toContain('Secret Skill');
    // But the ATS data is still present
    expect(payload.jobTitles).toHaveLength(2);
  });

  it('retains private skills for keyless-local destination with ATS data', () => {
    const map = mapOf([
      skill('SKILL-k8s', 'Kubernetes'),
      skill('SKILL-secret', 'Secret Skill', { private: true }),
    ]);
    const payload = buildDiscoveryPayload(map, LOCAL, atsData);
    expect(payload.skills).toHaveLength(2);
    expect(payload.jobTitles).toEqual(atsData.jobTitles);
  });
});

describe('buildDiscoveryPrompt with career context sections (R20.6)', () => {
  const atsData: CareerContext = {
    jobTitles: ['Senior Platform Engineer', 'SRE Lead'],
    competencies: ['Leadership', 'Stakeholder Management'],
    education: ['MSc Computer Science'],
    professionalSummary: 'Experienced platform engineer.',
  };

  it('contains "Previous roles:" section when job titles are provided', () => {
    const map = mapOf([skill('SKILL-k8s', 'Kubernetes')]);
    const prompt = buildDiscoveryPrompt(buildDiscoveryPayload(map, CLOUD, atsData));
    expect(prompt).toContain('Previous roles:');
    expect(prompt).toContain('Senior Platform Engineer');
    expect(prompt).toContain('SRE Lead');
  });

  it('contains "Core competencies:" section when competencies are provided', () => {
    const map = mapOf([skill('SKILL-k8s', 'Kubernetes')]);
    const prompt = buildDiscoveryPrompt(buildDiscoveryPayload(map, CLOUD, atsData));
    expect(prompt).toContain('Core competencies:');
    expect(prompt).toContain('Leadership');
    expect(prompt).toContain('Stakeholder Management');
  });

  it('contains "Education:" section when education is provided', () => {
    const map = mapOf([skill('SKILL-k8s', 'Kubernetes')]);
    const prompt = buildDiscoveryPrompt(buildDiscoveryPayload(map, CLOUD, atsData));
    expect(prompt).toContain('Education:');
    expect(prompt).toContain('MSc Computer Science');
  });

  it('contains "Summary:" section when professional summary is provided', () => {
    const map = mapOf([skill('SKILL-k8s', 'Kubernetes')]);
    const prompt = buildDiscoveryPrompt(buildDiscoveryPayload(map, CLOUD, atsData));
    expect(prompt).toContain('Summary:');
    expect(prompt).toContain('Experienced platform engineer.');
  });

  it('omits career context sections when no ATS data is provided', () => {
    const map = mapOf([skill('SKILL-k8s', 'Kubernetes')]);
    const prompt = buildDiscoveryPrompt(buildDiscoveryPayload(map, CLOUD));
    expect(prompt).not.toContain('Previous roles:');
    expect(prompt).not.toContain('Core competencies:');
    expect(prompt).not.toContain('Education:');
    expect(prompt).not.toContain('Summary:');
  });

  it('still contains skill names and duration hints alongside career context', () => {
    const map = mapOf([skill('SKILL-k8s', 'Kubernetes'), skill('SKILL-tf', 'Terraform')]);
    const prompt = buildDiscoveryPrompt(buildDiscoveryPayload(map, CLOUD, atsData));
    expect(prompt).toContain('Kubernetes');
    expect(prompt).toContain('Terraform');
    expect(prompt).toMatch(/~\d/); // duration hint present
  });
});
