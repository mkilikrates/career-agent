// Unit tests for the Career_Agent orchestrator (@core/orchestrator).
//
// These exercise task 17.1: the resumable six-phase statechart, the PHASE HUB
// (jump to any phase, R35.2), and the rule that ALL provider calls route
// through the Egress Gate ONLY (Requirements 6, 7). The Egress Gate is a simple
// spy — no real PII scan, provider, or network is involved.

import { describe, expect, it, vi } from 'vitest';

import {
  DefaultCareerAgent,
  NotImplementedError,
  OrchestratorMisconfiguredError,
  UnknownPhaseError,
  createCareerAgent,
} from './career-agent';
import { PHASE_SEQUENCE, type Phase } from './phases';
import type { MemoryStoreReader, ResumeStoreState } from './resume';
import type { ConfirmedEvidenceReader, KnowledgeBaseReader } from './re-entry';
import type { EgressGate } from '@core/egress';
import type { ProviderResponse } from '@adapters/provider';
import {
  asDocId,
  asISODate,
  asItemId,
  asQuestionId,
  asRoleSlug,
  asSkillId,
  type ExtractedItem,
  type SkillMapEntry,
  type StarAnswer,
  type StarFlag,
} from '@core/types';
import { buildReferenceGraph } from '@core/registry';
import { sourceLine } from '@core/provenance';
import type { ConfirmedEvidence } from '@core/output';
import type { ExtractedDoc } from '@core/ingestion';

const RESPONSE = { __brand: 'ProviderResponse' } as ProviderResponse;

/** An Egress Gate spy: records calls and returns fixed values. */
function makeEgressGate(): EgressGate & {
  request: ReturnType<typeof vi.fn>;
  transcribe: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async () => RESPONSE);
  const transcribe = vi.fn(async () => ({ text: 'hello', redactedCategories: [] }));
  return { request, transcribe } as unknown as EgressGate & {
    request: ReturnType<typeof vi.fn>;
    transcribe: ReturnType<typeof vi.fn>;
  };
}

function makeAgent() {
  const gate = makeEgressGate();
  const agent = new DefaultCareerAgent({ egressGate: gate });
  return { gate, agent };
}

describe('@core/orchestrator — construction', () => {
  it('starts a new session in the Ingest phase', () => {
    const { agent } = makeAgent();
    expect(agent.currentPhase()).toBe('ingest');
  });

  it('throws when constructed without an Egress Gate', () => {
    // @ts-expect-error — intentionally omitting the required collaborator.
    expect(() => new DefaultCareerAgent({})).toThrow(OrchestratorMisconfiguredError);
  });

  it('throws when constructed without options', () => {
    // @ts-expect-error — intentionally passing no options.
    expect(() => new DefaultCareerAgent()).toThrow(OrchestratorMisconfiguredError);
  });

  it('createCareerAgent builds a working orchestrator', () => {
    const agent = createCareerAgent({ egressGate: makeEgressGate() });
    expect(agent.currentPhase()).toBe('ingest');
  });
});

describe('@core/orchestrator — linear advance', () => {
  it('advances through every phase in order and stops at the last', async () => {
    const { agent } = makeAgent();
    for (let i = 0; i < PHASE_SEQUENCE.length - 1; i++) {
      expect(agent.currentPhase()).toBe(PHASE_SEQUENCE[i]);
      await agent.advance();
      expect(agent.currentPhase()).toBe(PHASE_SEQUENCE[i + 1]);
    }
    // On the terminal phase ADVANCE is a no-op (the hub handles other moves).
    expect(agent.currentPhase()).toBe('memory');
    await agent.advance();
    expect(agent.currentPhase()).toBe('memory');
  });
});

describe('@core/orchestrator — phase hub (R35.2: jump to any phase)', () => {
  it('jumps directly to any phase from the initial phase', async () => {
    for (const phase of PHASE_SEQUENCE) {
      const { agent } = makeAgent();
      await agent.jumpToPhase(phase);
      expect(agent.currentPhase()).toBe(phase);
    }
  });

  it('jumps to every phase from every phase (forward and backward)', async () => {
    for (const from of PHASE_SEQUENCE) {
      for (const to of PHASE_SEQUENCE) {
        const { agent } = makeAgent();
        await agent.jumpToPhase(from);
        expect(agent.currentPhase()).toBe(from);
        await agent.jumpToPhase(to);
        expect(agent.currentPhase()).toBe(to);
      }
    }
  });

  it('rejects an unknown phase value and leaves state unchanged', async () => {
    const { agent } = makeAgent();
    await expect(agent.jumpToPhase('nonsense' as Phase)).rejects.toThrow(UnknownPhaseError);
    expect(agent.currentPhase()).toBe('ingest');
  });
});

describe('@core/orchestrator — phase-change subscription', () => {
  it('notifies subscribers on change and stops after unsubscribe', async () => {
    const { agent } = makeAgent();
    const seen: Phase[] = [];
    const unsubscribe = agent.onPhaseChange((p) => seen.push(p));

    await agent.jumpToPhase('output');
    await agent.advance(); // output -> memory
    unsubscribe();
    await agent.jumpToPhase('ingest'); // not observed

    expect(seen).toEqual(['output', 'memory']);
  });

  it('does not fire when a jump targets the current phase', async () => {
    const { agent } = makeAgent();
    const seen: Phase[] = [];
    agent.onPhaseChange((p) => seen.push(p));
    await agent.jumpToPhase('ingest'); // already in ingest
    expect(seen).toEqual([]);
  });
});

describe('@core/orchestrator — provider calls route through the Egress Gate ONLY', () => {
  it('delegates LLM requests to the Egress Gate with the exact intent', async () => {
    const { gate, agent } = makeAgent();
    const intent = { provider: 'openai', text: 'hi', operation: 'llm-chat' as const };
    const res = await agent.requestProvider(intent);
    expect(res).toBe(RESPONSE);
    expect(gate.request).toHaveBeenCalledTimes(1);
    expect(gate.request).toHaveBeenCalledWith(intent);
    expect(gate.transcribe).not.toHaveBeenCalled();
  });

  it('delegates STT transcription to the Egress Gate with the exact intent', async () => {
    const { gate, agent } = makeAgent();
    const audio = { __brand: 'AudioBlob', format: 'mp3', bytes: new Uint8Array([1]) } as const;
    const intent = { provider: 'openai', audio } as const;
    const out = await agent.transcribeAudio(intent);
    expect(out).toEqual({ text: 'hello', redactedCategories: [] });
    expect(gate.transcribe).toHaveBeenCalledTimes(1);
    expect(gate.transcribe).toHaveBeenCalledWith(intent);
    expect(gate.request).not.toHaveBeenCalled();
  });

  it('propagates Egress Gate failures (fail-closed) without swallowing them', async () => {
    const { gate, agent } = makeAgent();
    gate.request.mockRejectedValueOnce(new Error('declined'));
    await expect(
      agent.requestProvider({ provider: 'openai', text: 'x', operation: 'llm-chat' }),
    ).rejects.toThrow('declined');
  });
});

describe('@core/orchestrator — session resume (R35.1)', () => {
  const emptyState: ResumeStoreState = {
    storeFiles: [],
    skills: [],
    interviews: [],
    conflicts: [],
  };

  function makeReader(state: ResumeStoreState): MemoryStoreReader & {
    load: ReturnType<typeof vi.fn>;
  } {
    const load = vi.fn(async () => state);
    return { load } as unknown as MemoryStoreReader & { load: ReturnType<typeof vi.fn> };
  }

  it('throws when resuming without a Memory Store reader', async () => {
    const { agent } = makeAgent();
    await expect(agent.resumeSession()).rejects.toThrow(OrchestratorMisconfiguredError);
  });

  it('loads the store, returns a summary, and never touches the Egress Gate', async () => {
    const gate = makeEgressGate();
    const reader = makeReader(emptyState);
    const agent = new DefaultCareerAgent({ egressGate: gate, memoryStoreReader: reader });

    const summary = await agent.resumeSession();

    expect(reader.load).toHaveBeenCalledTimes(1);
    expect(summary.outstanding).toEqual([]);
    expect(summary.healingReport.ok).toBe(true);
    // Provider reachability is never exercised on resume.
    expect(gate.request).not.toHaveBeenCalled();
    expect(gate.transcribe).not.toHaveBeenCalled();
  });

  it('continues from the last phase the user was in (R35.1)', async () => {
    const reader = makeReader({ ...emptyState, lastPhase: 'output' });
    const agent = new DefaultCareerAgent({
      egressGate: makeEgressGate(),
      memoryStoreReader: reader,
    });

    const summary = await agent.resumeSession();

    expect(summary.resumePhase).toBe('output');
    expect(agent.currentPhase()).toBe('output');
  });

  it('a brand-new (empty) store resumes at the initial phase', async () => {
    const reader = makeReader(emptyState);
    const agent = new DefaultCareerAgent({
      egressGate: makeEgressGate(),
      memoryStoreReader: reader,
    });

    const summary = await agent.resumeSession();

    expect(summary.resumePhase).toBe('ingest');
    expect(agent.currentPhase()).toBe('ingest');
  });
});

describe('@core/orchestrator — methods reserved for later tasks', () => {
  it('applyUserOverride is not implemented yet (task 18)', () => {
    const { agent } = makeAgent();
    expect(() => agent.applyUserOverride('ref', 1)).toThrow(NotImplementedError);
  });
});

// --- Re-entry triggers (task 17.3, R35.3–R35.5) ----------------------------

const skillEntry = (id: string, name: string): SkillMapEntry => ({
  id: asSkillId(id),
  name,
  category: 'Technical',
  proficiencySignal: 'Evidence-based.',
  evidence: [],
  recency: asISODate('2024-01-01'),
});

const evidenceWith = (entries: SkillMapEntry[]): ConfirmedEvidence => ({
  skillMap: { entries, graph: buildReferenceGraph({ skills: entries }) },
});

function makeEvidenceReader(evidence: ConfirmedEvidence): ConfirmedEvidenceReader & {
  read: ReturnType<typeof vi.fn>;
} {
  const read = vi.fn(async () => evidence);
  return { read } as unknown as ConfirmedEvidenceReader & { read: ReturnType<typeof vi.fn> };
}

const employmentItem = (employer: string, title: string, start: string): ExtractedItem => ({
  id: asItemId(`${employer}-${start}`),
  type: 'employment',
  fields: { employer, title, start },
  confidence: 'High',
  provenance: [sourceLine(asDocId('cv.pdf'), 1, title)],
  userConfirmed: false,
  private: false,
  sourceDoc: asDocId('cv.pdf'),
});

describe('@core/orchestrator — startNewRole (R35.3: Phase 3 without re-ingest)', () => {
  it('jumps directly to role-discovery using the existing state', async () => {
    const { agent } = makeAgent();
    await agent.startNewRole();
    expect(agent.currentPhase()).toBe('role-discovery');
  });
});

describe('@core/orchestrator — ingestJobPosting (R35.3)', () => {
  it('throws without a confirmed-evidence reader', async () => {
    const { agent } = makeAgent();
    await expect(agent.ingestJobPosting('Backend Engineer\nRequired: JavaScript')).rejects.toThrow(
      OrchestratorMisconfiguredError,
    );
  });

  it('parses, scores against the existing map, identifies gaps, and proposes a CV', async () => {
    const reader = makeEvidenceReader(evidenceWith([skillEntry('SKILL-javascript', 'JavaScript')]));
    const agent = new DefaultCareerAgent({
      egressGate: makeEgressGate(),
      confirmedEvidenceReader: reader,
    });

    const match = await agent.ingestJobPosting(
      'Backend Engineer\nRequired: JavaScript, SQL Database\nPreferred: TypeScript',
    );

    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(match.slug).toBe('backend-engineer');
    // JavaScript is owned (matched); SQL Database is an unmet required gap.
    expect(match.matchedSkills).toEqual([asSkillId('SKILL-javascript')]);
    expect(match.gapSkills.map(String)).toContain('SQL Database');
    expect(match.score.estimated).toBe(true);
    // The proposed CV is tailored to the posting and surfaces the owned skill.
    expect(match.proposedCv.targetRole.slug).toBe(asRoleSlug('backend-engineer'));
    expect(match.proposedCv.skills.map((s) => s.name)).toContain('JavaScript');
    // Re-entry lands in Phase 5 (output) without re-ingesting (R35.3).
    expect(agent.currentPhase()).toBe('output');
  });

  it('routes parsing through an injected parser and never touches the Egress Gate', async () => {
    const { gate } = makeAgent();
    const reader = makeEvidenceReader(evidenceWith([skillEntry('SKILL-go', 'Go')]));
    const parser = { parse: vi.fn(() => ({
      title: 'Platform Engineer',
      description: 'Platform Engineer',
      requiredSkills: ['Go'],
      preferredSkills: [],
    })) };
    const agent = new DefaultCareerAgent({
      egressGate: gate,
      confirmedEvidenceReader: reader,
      jobPostingParser: parser,
    });

    const match = await agent.ingestJobPosting('anything');

    expect(parser.parse).toHaveBeenCalledWith('anything');
    expect(match.title).toBe('Platform Engineer');
    expect(gate.request).not.toHaveBeenCalled();
    expect(gate.transcribe).not.toHaveBeenCalled();
  });
});

describe('@core/orchestrator — mergeNewDocument (R35.4: Requirement 9 merge)', () => {
  function makeKbReader(docs: ExtractedDoc[]): KnowledgeBaseReader & {
    read: ReturnType<typeof vi.fn>;
  } {
    const read = vi.fn(async () => docs);
    return { read } as unknown as KnowledgeBaseReader & { read: ReturnType<typeof vi.fn> };
  }

  it('throws without a knowledge-base reader', async () => {
    const { agent } = makeAgent();
    await expect(
      agent.mergeNewDocument({ docId: asDocId('new.pdf'), items: [] }),
    ).rejects.toThrow(OrchestratorMisconfiguredError);
  });

  it('merges the new document against the existing base and records conflicts (R9.2)', async () => {
    const existing: ExtractedDoc = {
      docId: asDocId('old.pdf'),
      date: asISODate('2023-01-01'),
      items: [employmentItem('Acme', 'Engineer', '2020-01')],
    };
    const incoming: ExtractedDoc = {
      docId: asDocId('new.pdf'),
      date: asISODate('2024-01-01'),
      items: [employmentItem('Acme', 'Senior Engineer', '2020-01')],
    };
    const reader = makeKbReader([existing]);
    const agent = new DefaultCareerAgent({
      egressGate: makeEgressGate(),
      knowledgeBaseReader: reader,
    });

    const result = await agent.mergeNewDocument(incoming);

    expect(reader.read).toHaveBeenCalledTimes(1);
    // Same role (employer + start) merged into one item, the title differs → a conflict.
    expect(result.merged).toHaveLength(1);
    expect(result.conflicts.some((c) => c.field.endsWith('::title'))).toBe(true);
    expect(agent.currentPhase()).toBe('ingest');
  });
});

describe('@core/orchestrator — recordInterviewDebrief (R35.5)', () => {
  const answer = (questionId: string, result: string, flags: StarFlag[] = []): StarAnswer => ({
    questionId: asQuestionId(questionId),
    situation: 'we had an outage',
    task: 'I had to restore service',
    action: 'I rolled back the deploy',
    result,
    flags,
    status: flags.length > 0 ? 'soft_closed' : 'complete',
  });

  it('throws without a confirmed-evidence reader', async () => {
    const { agent } = makeAgent();
    await expect(
      agent.recordInterviewDebrief({ roleSlug: asRoleSlug('be'), answers: [] }),
    ).rejects.toThrow(OrchestratorMisconfiguredError);
  });

  it('confirms talking points, notes flagged gaps, and surfaces revealed skills', async () => {
    const reader = makeEvidenceReader(evidenceWith([skillEntry('SKILL-javascript', 'JavaScript')]));
    const agent = new DefaultCareerAgent({
      egressGate: makeEgressGate(),
      confirmedEvidenceReader: reader,
    });

    const result = await agent.recordInterviewDebrief({
      roleSlug: asRoleSlug('backend-engineer'),
      roleTitle: 'Backend Engineer',
      answers: [
        { answer: answer('Q-01', 'cut latency 40%'), skills: [asSkillId('SKILL-javascript')] },
        // A flagged (Soft-Closed, no result) answer reveals a skill not yet in the map.
        { answer: answer('Q-02', '', ['needs_metric']), skills: [asSkillId('SKILL-kubernetes')] },
      ],
    });

    // Two answers → two confirmed talking points with minted STAR ids (R28).
    expect(result.talkingPoints).toHaveLength(2);
    expect(result.talkingPoints.every((tp) => String(tp.id).startsWith('STAR-'))).toBe(true);
    // The flagged answer is noted as a gap (R25.1, R35.5).
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].questionId).toBe(asQuestionId('Q-02'));
    expect(result.gaps[0].flags).toContain('needs_metric');
    // The revealed skill not in the map surfaces unapplied (R29).
    expect(result.skillDelta.candidates.map((c) => String(c.skill))).toContain('SKILL-kubernetes');
    expect(agent.currentPhase()).toBe('interview-coaching');
  });
});
