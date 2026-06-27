// @core/orchestrator — the Career_Agent orchestrator (design §Career_Agent; R35.2).
//
// Owns the resumable six-phase pipeline statechart (Ingest → Skill Map → Role
// Discovery → Interview Coaching → Output → Memory) and the PHASE HUB that lets
// the user jump directly to any phase (R35.2). Crucially, it routes EVERY
// provider call through the single Egress Gate and never imports a provider
// client directly (Requirements 6, 7). Consumers import from one path:
//
//   import { createCareerAgent } from '@core/orchestrator';

// Phase vocabulary and ordering (XState-independent).
export {
  PHASE_SEQUENCE,
  PHASE_LABELS,
  INITIAL_PHASE,
  isPhase,
  phaseIndex,
  nextPhase,
  previousPhase,
} from './phases';
export type { Phase } from './phases';

// The six-phase statechart (resumable pipeline + phase hub, R35.2).
export { pipelineMachine, PIPELINE_STATE_VALUES } from './statechart';
export type {
  PipelineEvent,
  AdvanceEvent,
  JumpToPhaseEvent,
} from './statechart';

// The orchestrator: phase hub + Egress-Gate-only provider routing.
export {
  DefaultCareerAgent,
  createCareerAgent,
  OrchestratorMisconfiguredError,
  NotImplementedError,
  UnknownPhaseError,
} from './career-agent';
export type {
  CareerAgent,
  CareerAgentOptions,
  Ref,
  SessionSummary,
  RoleMatch,
  TargetOpportunityPrompt,
} from './career-agent';

// Re-entry triggers (task 17.3, R35.3–R35.5): job-posting parsing/matching,
// new-document merge, and post-interview debrief — each reusing the existing
// confirmed knowledge base (no re-ingestion) and touching no provider.
export {
  parseJobPosting,
  DEFAULT_JOB_POSTING_PARSER,
  matchJobPosting,
  mergeDocument,
  processDebrief,
} from './re-entry';
export type {
  ParsedJobPosting,
  JobPostingParser,
  ConfirmedEvidenceReader,
  KnowledgeBaseReader,
  InterviewDebrief,
  DebriefAnswer,
  DebriefGap,
  DebriefResult,
} from './re-entry';

// Session resume + outstanding-items summary (task 17.2, R35.1).
export {
  computeOutstanding,
  summariseSession,
  resumePhaseOf,
} from './resume';
export type {
  MemoryStoreReader,
  ResumeStoreState,
  OutstandingItem,
  OutstandingKind,
  PhaseStatus,
} from './resume';
