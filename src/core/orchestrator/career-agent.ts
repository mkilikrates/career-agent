// Career_Agent orchestrator (design §Career_Agent (Orchestrator); R35.2).
//
// The orchestrator owns the XState six-phase pipeline statechart, mediates
// between the UI shell and the domain engines, and enforces a cross-cutting
// rule that is the whole point of this task: ALL provider calls route through
// the Egress Gate ONLY. No domain component — and not the orchestrator itself —
// imports a provider client directly. The orchestrator holds a single
// {@link EgressGate} reference and exposes provider access solely by delegating
// to it, so the trust-critical PII pre-screening, network labelling, payload
// minimisation, and "transmit only to the user's chosen provider" guarantees
// (Requirements 6, 7) cannot be bypassed.
//
// This file implements tasks 17.1, 17.2 and 17.3:
//   - drive the resumable six-phase statechart, and
//   - the PHASE HUB — jump to any phase (R35.2) — plus linear `advance`, and
//   - provider access routed exclusively through the Egress Gate, and
//   - session resume + the outstanding-items summary (task 17.2, R35.1):
//     `resumeSession` loads/summarises the Memory Store via the injected reader,
//     runs the state-healing pass, computes the outstanding union, and continues
//     from the user's last phase, and
//   - the re-entry triggers (task 17.3, R35.3–R35.5): `startNewRole` jumps to
//     Phase 3 without re-ingest; `ingestJobPosting` parses a posting, scores it
//     ontologically against the EXISTING skill map, and proposes a tailored CV
//     (Phase 5); `mergeNewDocument` merges a new upload via the Requirement 9
//     rules; and `recordInterviewDebrief` updates talking points and notes gaps.
//     The trigger logic lives in `re-entry.ts`; this file wires it to the
//     statechart and the injected collaborators, and keeps all provider access
//     routed through the Egress Gate.
//
// Only `applyUserOverride` remains reserved (task 18); calling it throws
// {@link NotImplementedError} so the boundary stays explicit.
//
// Requirements: 35.1, 35.2, 35.3, 35.4, 35.5.

import { createActor, type Actor } from 'xstate';
import type {
  EgressGate,
  EgressIntent,
  EgressSttIntent,
  EgressTranscript,
} from '@core/egress';
import type { ProviderResponse } from '@adapters/provider';
import type { ExtractedDoc, ReconcileResult } from '@core/ingestion';
import { cvGenerationPrompt, type TargetOpportunityPrompt } from '@core/output';
import { IdRegistry } from '@core/registry';
import { isPhase, type Phase } from './phases';
import { pipelineMachine } from './statechart';
import { summariseSession, type MemoryStoreReader, type SessionSummary } from './resume';
import {
  DEFAULT_JOB_POSTING_PARSER,
  matchJobPosting,
  mergeDocument,
  processDebrief,
  type ConfirmedEvidenceReader,
  type DebriefResult,
  type InterviewDebrief,
  type JobPostingParser,
  type KnowledgeBaseReader,
  type RoleMatch,
} from './re-entry';

export type { SessionSummary, MemoryStoreReader } from './resume';
export type {
  ResumeStoreState,
  OutstandingItem,
  OutstandingKind,
  PhaseStatus,
} from './resume';
export type { TargetOpportunityPrompt } from '@core/output';
export type {
  RoleMatch,
  ParsedJobPosting,
  JobPostingParser,
  ConfirmedEvidenceReader,
  KnowledgeBaseReader,
  InterviewDebrief,
  DebriefAnswer,
  DebriefGap,
  DebriefResult,
} from './re-entry';

/** A reference to a value the user is overriding (R39). Placeholder for task 18. */
export type Ref = string;

/**
 * The Career_Agent orchestrator contract (design §Career_Agent). Task 17.1
 * implements {@link jumpToPhase} (the phase hub) and the Egress-Gate-only
 * provider routing; the remaining methods are reserved for tasks 17.2–17.3 / 18.
 */
export interface CareerAgent {
  /** Current pipeline phase (the active statechart state). */
  currentPhase(): Phase;
  /** Phase hub: jump directly to any phase (R35.2). */
  jumpToPhase(phase: Phase): Promise<void>;
  /** Step forward to the next phase in canonical order (no-op on the last). */
  advance(): Promise<void>;
  /** Subscribe to phase changes; returns an unsubscribe function. */
  onPhaseChange(listener: (phase: Phase) => void): () => void;
  /** Route an LLM request through the Egress Gate ONLY (Requirements 6, 7). */
  requestProvider(intent: EgressIntent): Promise<ProviderResponse>;
  /** Route an STT transcription through the Egress Gate ONLY (R26.2, R6, R7). */
  transcribeAudio(intent: EgressSttIntent): Promise<EgressTranscript>;

  // --- Reserved for later tasks (declared for design fidelity) ---
  /** Session resume + outstanding-items summary (R35.1) — task 17.2. */
  resumeSession(): Promise<SessionSummary>;
  /** New target role without re-ingest (R35.3) — jumps to Phase 3 (role-discovery). */
  startNewRole(): Promise<void>;
  /** Parse a job posting and match against the skill map (R35.3); lands in Phase 5. */
  ingestJobPosting(text: string): Promise<RoleMatch>;
  /**
   * Begin CV generation (R35.6): jump to the output phase and surface the
   * Target Opportunity prompt (R30.5) so the user can indicate whether a Target
   * Opportunity applies before tailoring. The user's reply (paste/upload a
   * posting, or decline) routes into the Output_Engine's `generateCv` flow (R30).
   */
  beginCvGeneration(): Promise<TargetOpportunityPrompt>;
  /** Merge a newly-uploaded document via the Requirement 9 rules (R35.4). */
  mergeNewDocument(incoming: ExtractedDoc): Promise<ReconcileResult>;
  /** Post-interview debrief: update talking points and note gaps (R35.5). */
  recordInterviewDebrief(debrief: InterviewDebrief): Promise<DebriefResult>;
  /** User Override Supremacy (R39) — task 18. */
  applyUserOverride<T>(target: Ref, value: T): Promise<void>;
}

/** Collaborators injected into the orchestrator. */
export interface CareerAgentOptions {
  /**
   * The single Egress Gate chokepoint. Every provider call the orchestrator
   * makes is delegated here; the orchestrator never imports a provider client
   * directly (Requirements 6, 7).
   */
  readonly egressGate: EgressGate;
  /**
   * Reads and hydrates the Memory Store for session resume (R35.1). Required
   * for {@link CareerAgent.resumeSession}; the orchestrator never parses the
   * store itself. Touches no provider, so the Egress-Gate-only invariant holds.
   */
  readonly memoryStoreReader?: MemoryStoreReader;
  /**
   * Reads the user's confirmed evidence (skill map + proofs) for the re-entry
   * triggers (R35.3, R35.5). Required for {@link CareerAgent.ingestJobPosting}
   * and {@link CareerAgent.recordInterviewDebrief}; the new job posting / debrief
   * is matched against the EXISTING skill map without re-ingesting. Touches no
   * provider.
   */
  readonly confirmedEvidenceReader?: ConfirmedEvidenceReader;
  /**
   * Reads the existing knowledge base for the new-document merge (R35.4).
   * Required for {@link CareerAgent.mergeNewDocument}; a new upload is merged
   * against the already-ingested documents via the Requirement 9 rules.
   */
  readonly knowledgeBaseReader?: KnowledgeBaseReader;
  /**
   * Parses raw job-posting text into required/preferred skills (R35.3). Defaults
   * to a local, provider-free heuristic parser. Inject an LLM-assisted parser
   * (which MUST route through the Egress Gate) to override; the orchestrator
   * only ever delegates to it, never importing a provider client itself.
   */
  readonly jobPostingParser?: JobPostingParser;
  /**
   * The stable-id registry used to mint `STAR-NN` ids for talking points
   * confirmed during a post-interview debrief (R35.5, R23.1). Inject the
   * session's registry (seeded from the store) so ids are never reused; a fresh
   * registry is created when omitted.
   */
  readonly idRegistry?: IdRegistry;
}

/** Raised when a required collaborator is missing at construction. */
export class OrchestratorMisconfiguredError extends Error {
  constructor(public readonly missing: string) {
    super(`Career_Agent orchestrator is misconfigured: missing "${missing}".`);
    this.name = 'OrchestratorMisconfiguredError';
  }
}

/** Raised for orchestrator methods reserved for a later task. */
export class NotImplementedError extends Error {
  constructor(method: string, task: string) {
    super(`Career_Agent.${method}() is not implemented yet (reserved for task ${task}).`);
    this.name = 'NotImplementedError';
  }
}

/** Raised when a jump targets a value that is not one of the six phases. */
export class UnknownPhaseError extends Error {
  constructor(public readonly value: unknown) {
    super(`"${String(value)}" is not a valid pipeline phase.`);
    this.name = 'UnknownPhaseError';
  }
}

/**
 * Default {@link CareerAgent}. Owns the pipeline statechart actor and the
 * injected Egress Gate. Holds NO provider client, NO key vault, and NO Storage
 * access — provider reachability exists only by delegating to the Egress Gate.
 */
export class DefaultCareerAgent implements CareerAgent {
  private readonly egressGate: EgressGate;
  private readonly memoryStoreReader?: MemoryStoreReader;
  private readonly confirmedEvidenceReader?: ConfirmedEvidenceReader;
  private readonly knowledgeBaseReader?: KnowledgeBaseReader;
  private readonly jobPostingParser: JobPostingParser;
  private readonly idRegistry: IdRegistry;
  private readonly actor: Actor<typeof pipelineMachine>;

  constructor(options: CareerAgentOptions) {
    if (!options || typeof options !== 'object') {
      throw new OrchestratorMisconfiguredError('options');
    }
    if (!options.egressGate) {
      throw new OrchestratorMisconfiguredError('egressGate');
    }
    this.egressGate = options.egressGate;
    this.memoryStoreReader = options.memoryStoreReader;
    this.confirmedEvidenceReader = options.confirmedEvidenceReader;
    this.knowledgeBaseReader = options.knowledgeBaseReader;
    this.jobPostingParser = options.jobPostingParser ?? DEFAULT_JOB_POSTING_PARSER;
    this.idRegistry = options.idRegistry ?? new IdRegistry();
    this.actor = createActor(pipelineMachine);
    this.actor.start();
  }

  currentPhase(): Phase {
    // The active phase IS the machine's state value (one of the six slugs).
    return this.actor.getSnapshot().value as Phase;
  }

  async jumpToPhase(phase: Phase): Promise<void> {
    // The phase hub (R35.2): jump directly to ANY phase from any phase.
    if (!isPhase(phase)) {
      throw new UnknownPhaseError(phase);
    }
    this.actor.send({ type: 'JUMP_TO_PHASE', phase });
  }

  async advance(): Promise<void> {
    this.actor.send({ type: 'ADVANCE' });
  }

  onPhaseChange(listener: (phase: Phase) => void): () => void {
    let last = this.currentPhase();
    const sub = this.actor.subscribe((snapshot) => {
      const current = snapshot.value as Phase;
      if (current !== last) {
        last = current;
        listener(current);
      }
    });
    return () => sub.unsubscribe();
  }

  async requestProvider(intent: EgressIntent): Promise<ProviderResponse> {
    // Provider reachability is ONLY via the Egress Gate (Requirements 6, 7).
    return this.egressGate.request(intent);
  }

  async transcribeAudio(intent: EgressSttIntent): Promise<EgressTranscript> {
    // STT reachability is ONLY via the Egress Gate (R26.2 → Requirements 6, 7).
    return this.egressGate.transcribe(intent);
  }

  /** Stop the underlying statechart actor (e.g. on teardown). */
  stop(): void {
    this.actor.stop();
  }

  // --- Reserved for later tasks ---

  /**
   * Session resume + outstanding-items summary (R35.1). Loads and summarises
   * the Memory Store via the injected {@link MemoryStoreReader}, runs the
   * resume-time state-healing pass (R36), computes the outstanding union
   * (unanswered questions, flagged talking points, unreviewed skill entries,
   * unresolved conflicts; design Property 16), and jumps the pipeline to the
   * continue-from-last phase (R35.1, R35.2) before returning the summary. No
   * provider is touched — the Egress-Gate-only invariant from task 17.1 holds.
   */
  async resumeSession(): Promise<SessionSummary> {
    if (!this.memoryStoreReader) {
      throw new OrchestratorMisconfiguredError('memoryStoreReader');
    }
    const state = await this.memoryStoreReader.load();
    const summary = summariseSession(state);
    // Continue from where the user left off (R35.1); the hub can still move
    // anywhere afterwards (R35.2).
    this.actor.send({ type: 'JUMP_TO_PHASE', phase: summary.resumePhase });
    return summary;
  }

  startNewRole(): Promise<void> {
    // New target role WITHOUT re-ingest (R35.3): jump straight to Phase 3
    // (role discovery) using the existing skill map. The phase hub can still
    // move anywhere afterwards (R35.2).
    return this.jumpToPhase('role-discovery');
  }

  async ingestJobPosting(text: string): Promise<RoleMatch> {
    // New job description (R35.3): parse → match against the EXISTING skill map
    // (ontological scoring) → identify gaps → propose a tailored CV, then land
    // the pipeline in Phase 5 (output). No re-ingestion. Parsing routes through
    // the injected parser only (the default is local/provider-free), so the
    // Egress-Gate-only invariant from task 17.1 is preserved.
    if (!this.confirmedEvidenceReader) {
      throw new OrchestratorMisconfiguredError('confirmedEvidenceReader');
    }
    const posting = await this.jobPostingParser.parse(text);
    const evidence = await this.confirmedEvidenceReader.read();
    const match = matchJobPosting(posting, evidence);
    this.actor.send({ type: 'JUMP_TO_PHASE', phase: 'output' });
    return match;
  }

  async beginCvGeneration(): Promise<TargetOpportunityPrompt> {
    // Begin CV generation (R35.6): land in Phase 5 (output) and surface the
    // Target Opportunity prompt (R30.5) — the same ask reachable from the new-CV
    // re-entry point. The user's reply drives the `generateCv` branch (R30): a
    // supplied posting becomes a TargetOpportunity tailoring target (R30.9),
    // while declining runs the script-only path (R30.7). No provider is touched
    // here, so the Egress-Gate-only invariant from task 17.1 holds.
    this.actor.send({ type: 'JUMP_TO_PHASE', phase: 'output' });
    return cvGenerationPrompt();
  }

  async mergeNewDocument(incoming: ExtractedDoc): Promise<ReconcileResult> {
    // New document (R35.4): merge into the existing knowledge base using the
    // Requirement 9 conflict-resolution rules (reusing the Ingestion_Engine's
    // reconcile). Lands in Phase 1 (ingest) where conflicts are reviewed.
    if (!this.knowledgeBaseReader) {
      throw new OrchestratorMisconfiguredError('knowledgeBaseReader');
    }
    const existing = await this.knowledgeBaseReader.read();
    const result = mergeDocument(existing, incoming);
    this.actor.send({ type: 'JUMP_TO_PHASE', phase: 'ingest' });
    return result;
  }

  async recordInterviewDebrief(debrief: InterviewDebrief): Promise<DebriefResult> {
    // Post-interview debrief (R35.5): refine the reported answers into confirmed
    // talking points (updating talking points), note the missing-STAR-element
    // gaps, and detect newly-revealed skills against the EXISTING map (surfaced
    // unapplied, R29). Reuses the Interview_Coach; lands in Phase 4 (interview
    // coaching) where talking points are managed.
    if (!this.confirmedEvidenceReader) {
      throw new OrchestratorMisconfiguredError('confirmedEvidenceReader');
    }
    const evidence = await this.confirmedEvidenceReader.read();
    const result = processDebrief(debrief, evidence.skillMap, this.idRegistry);
    this.actor.send({ type: 'JUMP_TO_PHASE', phase: 'interview-coaching' });
    return result;
  }

  applyUserOverride<T>(_target: Ref, _value: T): Promise<void> {
    throw new NotImplementedError('applyUserOverride', '18');
  }
}

/** Convenience factory mirroring the adapters'/egress DI-friendly `create*` style. */
export function createCareerAgent(options: CareerAgentOptions): DefaultCareerAgent {
  return new DefaultCareerAgent(options);
}
