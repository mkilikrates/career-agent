// Unit tests for the Skill_Mapper `skill_discovery` assist operation (task 25.2).

import { describe, it, expect, vi } from 'vitest';
import { asItemId, asDocId, type ExtractedItem } from '@core/types';
import {
  runAssist,
  type AssistTransport,
  type EgressDestination,
} from '@core/assist';
import { createSkillDiscoveryOperation, SkillDiscoveryOperation } from './skill-assist';

const CLOUD: EgressDestination = { provider: 'openai', kind: 'keyed-cloud' };
const LOCAL: EgressDestination = { provider: 'local', kind: 'keyless-local' };

const item = (
  id: string,
  fields: Record<string, unknown>,
  options: { private?: boolean } = {},
): ExtractedItem =>
  ({
    id: asItemId(id),
    type: 'skill',
    fields,
    confidence: 'High',
    provenance: [],
    userConfirmed: false,
    private: options.private ?? false,
    sourceDoc: asDocId('doc.md'),
  }) as unknown as ExtractedItem;

const EXTRACTIONS = [
  item('doc.md#a', { name: 'TypeScript' }),
  item('doc.md#b', { name: 'Secret Skill' }, { private: true }),
];

describe('SkillDiscoveryOperation — scriptOnly (R14.6, R47.8)', () => {
  it('issues zero provider calls and returns the deterministic evidence-only map', () => {
    const transport = vi.fn<AssistTransport>(async () => 'never');
    const op = createSkillDiscoveryOperation(transport);

    const outcome = op.scriptOnly({ extractions: EXTRACTIONS });

    expect(transport).not.toHaveBeenCalled();
    expect(outcome.mode).toBe('script-only');
    expect(outcome.suggestions).toEqual([]);
    // The deterministic map contains the (verified) extracted skills.
    expect(outcome.baseline.entries.map((e) => e.name)).toContain('TypeScript');
  });
});

describe('SkillDiscoveryOperation — aiAssisted (R22.6, R47.3)', () => {
  it('returns the deterministic baseline plus confirm-before-entry suggestions', async () => {
    const transport = vi.fn<AssistTransport>(async () => 'Kubernetes, Leadership');
    const op = new SkillDiscoveryOperation(transport);

    const outcome = await op.aiAssisted({ extractions: EXTRACTIONS }, CLOUD);

    expect(outcome.mode).toBe('ai-assisted');
    expect(outcome.baseline.entries.map((e) => e.name)).toContain('TypeScript');
    expect(outcome.suggestions.map((s) => s.value)).toEqual(['Kubernetes', 'Leadership']);
    expect(outcome.suggestions.every((s) => s.requiresConfirmation === true)).toBe(true);
  });

  it('excludes private items for a keyed cloud destination (R46.4)', async () => {
    const transport = vi.fn<AssistTransport>(async () => '');
    const op = new SkillDiscoveryOperation(transport);

    await op.aiAssisted({ extractions: EXTRACTIONS }, CLOUD);

    const sent = transport.mock.calls[0]?.[0] ?? '';
    expect(sent).toContain('TypeScript');
    expect(sent).not.toContain('Secret Skill');
  });

  it('includes private items for a keyless local destination (R7.6)', async () => {
    const transport = vi.fn<AssistTransport>(async () => '');
    const op = new SkillDiscoveryOperation(transport);

    await op.aiAssisted({ extractions: EXTRACTIONS }, LOCAL);

    const sent = transport.mock.calls[0]?.[0] ?? '';
    expect(sent).toContain('TypeScript');
    expect(sent).toContain('Secret Skill');
  });

  it('AI-only discovery returns the model\'s full list (no baseline dedup)', async () => {
    // Under the AI-only model the map is built purely from what the AI returns,
    // so a skill that coincides with a script-detected one is NOT dropped.
    const transport = vi.fn<AssistTransport>(async () => 'TypeScript, GraphQL');
    const op = new SkillDiscoveryOperation(transport);

    const outcome = await op.aiAssisted({ extractions: EXTRACTIONS }, CLOUD);

    expect(outcome.suggestions.map((s) => s.value)).toEqual(['TypeScript', 'GraphQL']);
  });

  it('Both mode asks the model to REVIEW/REFINE the parser\'s detected skills', async () => {
    const transport = vi.fn<AssistTransport>(async () => 'TypeScript, GraphQL');
    const op = new SkillDiscoveryOperation(transport);

    await op.aiAssisted({ extractions: EXTRACTIONS, review: true }, CLOUD);

    const sent = transport.mock.calls[0]?.[0] ?? '';
    // The prompt carries the parser's detection and asks to review/refine it.
    expect(sent).toMatch(/review/i);
    expect(sent).toContain('SKILLS DETECTED BY THE PARSER');
    expect(sent).toContain('TypeScript');
  });

  it('sends the full decoded document text for a CLOUD destination when available', async () => {
    // The chat LLM reads decoded text (it cannot parse PDF/DOCX binary), so the
    // AI corpus is the full decoded document text for BOTH local and cloud; the
    // Egress Gate redacts PII from it before a cloud call leaves the device.
    const transport = vi.fn<AssistTransport>(async () => '');
    const op = new SkillDiscoveryOperation(transport);

    await op.aiAssisted(
      { extractions: EXTRACTIONS, rawTexts: ['I built billing systems with Kafka.'] },
      CLOUD,
    );

    const sent = transport.mock.calls[0]?.[0] ?? '';
    expect(sent).toContain('I built billing systems with Kafka.');
  });
});

describe('SkillDiscoveryOperation — provider failure fallback (runAssist)', () => {
  it('falls back to the deterministic baseline with a non-blocking error', async () => {
    const transport = vi.fn<AssistTransport>(async () => {
      throw new Error('boom');
    });
    const op = createSkillDiscoveryOperation(transport);

    const { outcome, error } = await runAssist(
      op,
      { extractions: EXTRACTIONS },
      { mode: 'ai-assisted', capability: 'skill_discovery' },
      CLOUD,
    );

    expect(outcome.baseline.entries.map((e) => e.name)).toContain('TypeScript');
    expect(outcome.suggestions).toEqual([]);
    expect(error?.message).toContain('boom');
  });
});
