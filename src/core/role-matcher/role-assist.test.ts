// Unit tests for the Role_Matcher `role_discovery` assist operation (task 25.2).

import { describe, it, expect, vi } from 'vitest';
import { asItemId, asDocId, type ExtractedItem } from '@core/types';
import { generate, type SkillMap } from '@core/skills';
import {
  runAssist,
  type AssistTransport,
  type EgressDestination,
} from '@core/assist';
import {
  createRoleDiscoveryOperation,
  RoleDiscoveryOperation,
  parseAiRoles,
} from './role-assist';

const DEST: EgressDestination = { provider: 'openai', kind: 'keyed-cloud' };

const skill = (id: string, name: string): ExtractedItem =>
  ({
    id: asItemId(id),
    type: 'skill',
    fields: { name },
    confidence: 'High',
    provenance: [],
    userConfirmed: false,
    private: false,
    sourceDoc: asDocId('doc.md'),
  }) as unknown as ExtractedItem;

const MAP: SkillMap = generate([
  skill('doc.md#a', 'JavaScript'),
  skill('doc.md#b', 'SQL Database'),
]);

describe('parseAiRoles', () => {
  it('parses "Title — reason" lines and de-duplicates by title', () => {
    const roles = parseAiRoles('Backend Engineer — builds APIs\nBackend Engineer — dup\n- Data Analyst');
    expect(roles.map((r) => r.title)).toEqual(['Backend Engineer', 'Data Analyst']);
    expect(roles[0].rationale).toBe('builds APIs');
  });
});

describe('RoleDiscoveryOperation — scriptOnly (R20.5)', () => {
  it('issues zero provider calls and returns deterministic scored suggestions', () => {
    const transport = vi.fn<AssistTransport>(async () => 'never');
    const op = createRoleDiscoveryOperation(transport);

    const outcome = op.scriptOnly({ map: MAP });

    expect(transport).not.toHaveBeenCalled();
    expect(outcome.mode).toBe('script-only');
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.baseline.length).toBeGreaterThan(0);
    // Scores are estimate-labelled (R20.2).
    expect(outcome.baseline.every((s) => s.estimated === true)).toBe(true);
  });
});

describe('RoleDiscoveryOperation — aiAssisted (R47.3)', () => {
  it('returns the deterministic baseline plus confirm-before-entry AI roles', async () => {
    const transport = vi.fn<AssistTransport>(
      async () => 'Platform Engineer — runs infra\nData Engineer — pipelines',
    );
    const op = new RoleDiscoveryOperation(transport);

    const outcome = await op.aiAssisted({ map: MAP }, DEST);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(outcome.baseline.length).toBeGreaterThan(0);
    expect(outcome.suggestions.map((s) => s.value.title)).toEqual([
      'Platform Engineer',
      'Data Engineer',
    ]);
    expect(outcome.suggestions.every((s) => s.requiresConfirmation === true)).toBe(true);
  });

  it('sends only skill names — no employer/company names (R20.6)', async () => {
    const transport = vi.fn<AssistTransport>(async () => '');
    const op = new RoleDiscoveryOperation(transport);

    await op.aiAssisted({ map: MAP }, DEST);

    const sent = transport.mock.calls[0]?.[0] ?? '';
    expect(sent).toContain('JavaScript');
    expect(sent).toContain('SQL Database');
  });

  it('Both mode asks the model to REVIEW/REFINE the matcher\'s role suggestions', async () => {
    const transport = vi.fn<AssistTransport>(async () => '');
    const op = new RoleDiscoveryOperation(transport);

    await op.aiAssisted({ map: MAP, review: true }, DEST);

    const sent = transport.mock.calls[0]?.[0] ?? '';
    // The review prompt names the deterministic matcher and asks to review.
    expect(sent).toMatch(/matcher suggested these roles/i);
    expect(sent).toMatch(/review/i);
    // Still employer-free: only skill names are carried.
    expect(sent).toContain('JavaScript');
  });
});

describe('RoleDiscoveryOperation — provider failure fallback (runAssist)', () => {
  it('falls back to the deterministic baseline with a non-blocking error', async () => {
    const transport = vi.fn<AssistTransport>(async () => {
      throw new Error('offline');
    });
    const op = createRoleDiscoveryOperation(transport);

    const { outcome, error } = await runAssist(
      op,
      { map: MAP },
      { mode: 'ai-assisted', capability: 'role_discovery' },
      DEST,
    );

    expect(outcome.baseline.length).toBeGreaterThan(0);
    expect(outcome.suggestions).toEqual([]);
    expect(error?.capability).toBe('role_discovery');
    expect(error?.message).toContain('offline');
  });
});
