// Unit tests for the employer-free role-discovery AI-assist payload (task 26.1;
// R20.6, R47.2, R47.4). The property test for Property 22 is task 26.2.

import { describe, it, expect, vi } from 'vitest';
import {
  asSkillId,
  asBulletId,
  asISODate,
  type SkillMapEntry,
} from '@core/types';
import { buildReferenceGraph } from '@core/registry';
import type { SkillMap } from '@core/skills';
import type { AssistTransport, EgressDestination } from '@core/assist';
import {
  buildDiscoveryPayload,
  buildDiscoveryPrompt,
  approxDurationMonths,
} from './role-discovery-payload';
import { createRoleDiscoveryOperation } from './role-assist';

const CLOUD: EgressDestination = { provider: 'openai', kind: 'keyed-cloud' };
const LOCAL: EgressDestination = { provider: 'local', kind: 'keyless-local' };

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

describe('approxDurationMonths (R20.6, R70.7)', () => {
  const NOW = new Date('2025-01-01');

  it('computes duration as (now - since) when since is available', () => {
    const entry = skill('SKILL-a', 'JavaScript', {
      evidence: [
        { ref: asBulletId('BULLET-01'), when: asISODate('2021-01-01'), note: '' },
        { ref: asBulletId('BULLET-02'), when: asISODate('2022-01-01'), note: '' },
      ],
      since: asISODate('2023-01-01'),
    });
    // 2023-01-01 → 2025-01-01 ≈ 24 months.
    expect(approxDurationMonths(entry, NOW)).toBe(24);
  });

  it('falls back to (now - earliestEvidence) when since is absent', () => {
    const entry = skill('SKILL-a', 'JavaScript', {
      evidence: [
        { ref: asBulletId('BULLET-01'), when: asISODate('2022-01-01'), note: '' },
        { ref: asBulletId('BULLET-02'), when: asISODate('2024-01-01'), note: '' },
      ],
      since: undefined,
    });
    // earliest evidence 2022-01-01 → now 2025-01-01 ≈ 36 months.
    expect(approxDurationMonths(entry, NOW)).toBe(36);
  });

  it('returns a minimum of one month when since equals now', () => {
    const single = skill('SKILL-b', 'SQL', {
      evidence: [{ ref: asBulletId('BULLET-03'), when: asISODate('2025-01-01'), note: '' }],
      since: asISODate('2025-01-01'),
    });
    expect(approxDurationMonths(single, NOW)).toBe(1);
  });

  it('returns a minimum of one month when no dates are available', () => {
    const noDate = skill('SKILL-d', 'Rust', {
      evidence: [],
      since: undefined,
    });
    expect(approxDurationMonths(noDate, NOW)).toBe(1);
  });

  it('is never negative regardless of date ordering', () => {
    const entry = skill('SKILL-c', 'Go', {
      evidence: [{ ref: asBulletId('BULLET-04'), when: asISODate('2025-06-01'), note: '' }],
      since: asISODate('2020-01-01'),
    });
    expect(approxDurationMonths(entry, NOW)).toBeGreaterThanOrEqual(1);
  });

  it('ignores evidence dates when since is present (uses only since)', () => {
    const entry = skill('SKILL-e', 'Python', {
      evidence: [
        { ref: asBulletId('BULLET-05'), when: asISODate('2015-01-01'), note: '' },
      ],
      since: asISODate('2024-01-01'),
    });
    // since is 2024-01-01 → now 2025-01-01 ≈ 12 months (ignores earlier evidence)
    expect(approxDurationMonths(entry, NOW)).toBe(12);
  });
});

describe('buildDiscoveryPayload (R20.6, R47.2)', () => {
  it('carries only name, approxDurationMonths and category per skill', () => {
    const map = mapOf([skill('SKILL-a', 'JavaScript')]);
    const payload = buildDiscoveryPayload(map, CLOUD);
    expect(payload.skills).toHaveLength(1);
    expect(Object.keys(payload.skills[0]).sort()).toEqual([
      'approxDurationMonths',
      'category',
      'name',
    ]);
    expect(payload.skills[0].name).toBe('JavaScript');
    expect(payload.skills[0].category).toBe('Technical');
    expect(payload.skills[0].approxDurationMonths).toBeGreaterThanOrEqual(1);
  });

  it('includes an approximate duration for EVERY carried skill (R20.6)', () => {
    const map = mapOf([skill('SKILL-a', 'JavaScript'), skill('SKILL-b', 'SQL')]);
    const payload = buildDiscoveryPayload(map, CLOUD);
    expect(payload.skills).toHaveLength(2);
    expect(
      payload.skills.every(
        (s) => typeof s.approxDurationMonths === 'number' && s.approxDurationMonths >= 1,
      ),
    ).toBe(true);
  });

  it('EXCLUDES private skills for a keyed cloud destination (R47.4, R46.4)', () => {
    const map = mapOf([
      skill('SKILL-a', 'JavaScript'),
      skill('SKILL-b', 'Secret Skill', { private: true }),
    ]);
    const payload = buildDiscoveryPayload(map, CLOUD);
    const names = payload.skills.map((s) => s.name);
    expect(names).toContain('JavaScript');
    expect(names).not.toContain('Secret Skill');
  });

  it('INCLUDES private skills for a keyless local destination (R46.5)', () => {
    const map = mapOf([
      skill('SKILL-a', 'JavaScript'),
      skill('SKILL-b', 'Secret Skill', { private: true }),
    ]);
    const payload = buildDiscoveryPayload(map, LOCAL);
    const names = payload.skills.map((s) => s.name);
    expect(names).toContain('JavaScript');
    expect(names).toContain('Secret Skill');
  });

  it('treats an absent destination kind as third-party (excludes private)', () => {
    const map = mapOf([skill('SKILL-b', 'Secret Skill', { private: true })]);
    const payload = buildDiscoveryPayload(map, { provider: 'openai' });
    expect(payload.skills).toHaveLength(0);
  });
});

describe('buildDiscoveryPrompt (R20.6)', () => {
  it('renders skill name, category and a duration hint; no employer label', () => {
    const map = mapOf([skill('SKILL-a', 'JavaScript')]);
    const prompt = buildDiscoveryPrompt(buildDiscoveryPayload(map, CLOUD));
    expect(prompt).toContain('JavaScript');
    expect(prompt).toContain('Technical');
    expect(prompt).toMatch(/~\d/); // duration hint present
  });
});

describe('recommendRolesAi (R47.2, R47.3)', () => {
  it('routes the employer-free payload through the transport and returns suggestions', async () => {
    const transport = vi.fn<AssistTransport>(
      async () => 'Platform Engineer — runs infra\nData Engineer — pipelines',
    );
    const op = createRoleDiscoveryOperation(transport);
    const map = mapOf([skill('SKILL-a', 'JavaScript'), skill('SKILL-b', 'SQL')]);

    const roles = await op.recommendRolesAi(map, CLOUD);

    expect(transport).toHaveBeenCalledTimes(1);
    const sent = transport.mock.calls[0]?.[0] ?? '';
    expect(sent).toContain('JavaScript');
    expect(sent).toContain('SQL');
    expect(roles.map((r) => r.title)).toEqual(['Platform Engineer', 'Data Engineer']);
    // Suggestions are not fabricated fits: zero score, estimate-labelled (R47.3).
    expect(roles.every((r) => r.matchScore === 0 && r.estimated === true)).toBe(true);
  });

  it('excludes private skills from the AI request for a keyed cloud destination', async () => {
    const transport = vi.fn<AssistTransport>(async () => '');
    const op = createRoleDiscoveryOperation(transport);
    const map = mapOf([
      skill('SKILL-a', 'JavaScript'),
      skill('SKILL-b', 'Secret Skill', { private: true }),
    ]);

    await op.recommendRolesAi(map, CLOUD);

    const sent = transport.mock.calls[0]?.[0] ?? '';
    expect(sent).toContain('JavaScript');
    expect(sent).not.toContain('Secret Skill');
  });
});
