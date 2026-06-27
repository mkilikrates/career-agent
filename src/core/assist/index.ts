// @core/assist — the shared AI-assist Opt-In-First contract (Requirements
// 14.5/14.6, 20.4/20.5, 22.5, 28.5, 30.7, 47.7/47.8).
//
// One opt-in-first contract shared by all four AI-assistable components
// (Skill_Mapper, Role_Matcher, Interview_Coach, Output_Engine) so the behaviour
// is identical everywhere: a complete deterministic `scriptOnly` result that
// issues zero provider calls, and an `aiAssisted` path that establishes the same
// baseline then adds gate-routed, user-confirmable supplements that never replace
// the baseline. Consumers import from one path:
//
//   import { BaseAssistableOperation, scriptOnlyOutcome } from '@core/assist';

export {
  isScriptOnly,
  isAiAssisted,
  isAiOnly,
  usesProvider,
  assistSuggestion,
  scriptOnlyOutcome,
  aiAssistedOutcome,
  BaseAssistableOperation,
} from './assist';

export type {
  AssistMode,
  AssistCapability,
  AssistChoice,
  EgressDestination,
  AssistSuggestion,
  AssistOutcome,
  AssistableOperation,
} from './assist';

// Shared orchestration: the one place the orchestrator/UI branches on the user's
// AssistChoice and applies the non-blocking provider-failure fallback (25.2).
export { runAssist } from './orchestrate';
export type {
  AssistTransport,
  AssistError,
  AssistRunResult,
} from './orchestrate';

// Persisted, pipeline-wide AI-assist preference (chosen up front, saved to the
// Memory Store, applied as the default across all phases).
export {
  ASSIST_PREFERENCE_PATH,
  ASSIST_PREFERENCE_HEADING,
  DEFAULT_ASSIST_MODE,
  serializeAssistMode,
  parseAssistMode,
  saveAssistMode,
  loadAssistMode,
} from './assist-preference';
export type {
  AssistPreferenceWriter,
  AssistPreferenceReader,
} from './assist-preference';
