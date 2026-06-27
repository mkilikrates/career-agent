// @core/interview — the Interview_Coach (R22–R29).
//
// Task 12.1 implements the front of the Interview_Coach: role-grounded STAR
// question generation and the per-role interview file (R22). When the user
// selects a role for coaching, the coach generates STAR-framework questions
// grounded in the skill match between the user's profile and the target role —
// at least one behavioural question per matched core skill, one question on an
// identified skill gap, and one professional motivation question (R22.1, R22.2)
// — and stores them in the canonical `interviews/interview_[role_slug].md`
// (R22.3). Consumers import from one path:
//
//   import { generateQuestions, buildInterview, saveInterview } from '@core/interview';

// Role-grounded STAR question generation (R22.1, R22.2).
export { generateQuestions } from './questions';

// AI STAR question generation + educational summary wired to the shared
// opt-in-first AssistableOperation (25.2, 27.1, 27.4): scriptOnly = deterministic
// questions / teaching summary (zero provider calls); aiAssisted = same baseline
// + gate-routed, user-confirmable AI supplements that never replace the script
// set. The question prompt frames the model as a recruiter for the SPECIFIC
// target position and excludes private skills for a keyed cloud destination
// (R22.6, R22.7); AI questions are practice prompts, never gated by the
// No-Fabrication harness (R22.9). The educational summary is a teaching artefact
// ({@link StarTeachingSummary}) bound strictly to the user's own answer content
// and DISTINCT from the polished talking point (R28.5–R28.8).
export {
  StarQuestionsOperation,
  createStarQuestionsOperation,
  buildStarQuestionsPrompt,
  starQuestionSkillNames,
  parseQuestionPrompts,
  StarSummaryOperation,
  createStarSummaryOperation,
  buildStarSummaryPrompt,
  buildTeachingSummary,
  educationalSummary,
  educationalSummaryScriptOnly,
  STAR_GUIDANCE,
  buildAdequacyPrompt,
  parseAdequacyReply,
  assessAdequacy,
  buildPerQuestionSummaryPrompt,
  parsePerQuestionSummaryReply,
  perQuestionSummary,
} from './coach-assist';
export type {
  StarQuestionsInput,
  StarQuestionSuggestion,
  StarSummaryInput,
  StarSummarySuggestion,
  StarTeachingSummary,
  StarCoverage,
  AdequacyInput,
  AdequacyAssessment,
  PerQuestionSummary,
  PerQuestionSummaryInput,
} from './coach-assist';

// The adaptive STAR coaching loop controller (R63.1, R63.3–R63.5). A
// deterministic state machine that drives question → answer (typed or a
// confirmed audio transcript from the EXISTING gated Whisper/STT path) →
// adequacy assessment (via the stateless gate-routed {@link assessAdequacy}) →
// follow-up. It owns the accumulated answers, the AI follow-up count, and the
// termination decision (the chat model is stateless), caps AI follow-ups at
// three, offers a "dig deeper" opt-in past the cap only when the model still has
// a follow-up (R63.4), and lets the user stop at any round (R63.5). Imports no
// provider client and never transcribes audio itself.
export {
  MAX_AI_FOLLOW_UPS,
  CoachingLoopStateError,
  StarCoachingLoop,
  createStarCoachingLoop,
} from './coaching-loop';
export type {
  CoachingLoopReason,
  CoachingLoopAction,
  CoachingAwaitAnswer,
  CoachingAwaitDigDeeper,
  CoachingFinished,
  CoachingLoopInit,
  CoachingLoopOptions,
  CoachingLoopSnapshot,
} from './coaching-loop';

// The guided STAR text loop, Soft-Close, and progress (R24, R25).
export {
  STAR_ORDER,
  MIN_ELEMENT_WORDS,
  OPEN_FOLLOW_UPS,
  LATER_RECOMMENDATIONS,
  elementToFlag,
  flagToElement,
  isElementPresent,
  outstandingElements,
  openFollowUp,
  recommendationFor,
  newAnswer,
  collectText,
  softClose,
  pass,
  progress,
} from './coach';
export type { CoachTurn, FlaggedPoint, ProgressIndicator } from './coach';

// Per-role interview-file persistence: build / serialize / parse / save the
// canonical `interviews/interview_[role_slug].md` (R22.3, R34.1, R34.2), plus
// mid-question state persistence and resume reconstruction (R24, R25).
export {
  buildInterview,
  serializeInterview,
  parseInterview,
  saveInterview,
  interviewFilePath,
  withResponse,
  withTalkingPoint,
  flaggedResponses,
  resumeState,
  INTERVIEW_HEADING,
  QUESTIONS_HEADING,
  RESPONSES_HEADING,
  TALKING_POINTS_HEADING,
} from './interview-document';
export type {
  InterviewFile,
  InterviewWriter,
  OutstandingItem,
  OutstandingReason,
  ResumeState,
} from './interview-document';

// Audio answer upload and transcription via the Egress Gate (R26). Upload-only
// (no live capture, R26.4): MP3/WAV are accepted, transcription is routed
// through the Egress Gate with PII pre-screening (R26.2), and the transcript is
// surfaced UNCONFIRMED for confirmation/correction before any further
// processing (R26.3).
export {
  ACCEPTED_AUDIO_FORMATS,
  UnsupportedAudioFormatError,
  detectAudioFormat,
  isSupportedAudio,
  uploadAudio,
  confirmTranscript,
  collectFromTranscript,
} from './audio';
export type {
  AudioUpload,
  Transcript,
  ConfirmedTranscript,
  UploadAudioOptions,
} from './audio';

// In-browser audio recording (no video) + recording transcription (R26.4,
// R26.6–R26.11). `createRecordingController` wraps an injected
// {@link AudioRecorderPort} (the only DOM seam) to expose start / stop /
// re-record / discard with microphone-permission acquisition (R26.4), the ≤600 s
// duration and ≤25 MB size guards (R26.9 parity), and a permission-denied
// fallback naming the upload and text-answer paths (R26.10).
// `transcribeRecording` routes a take through the Egress Gate with PII
// pre-screening (R26.6), surfacing the transcript UNCONFIRMED (R26.7);
// `collectAndSendTranscript` feeds a confirmed transcript into the coaching loop
// and sends it to the chosen chat provider via the gate (R26.8). When no STT
// provider is configured, transcription fails with the audio PRESERVED (R26.11).
export {
  MAX_RECORDING_SECONDS,
  MAX_RECORDING_BYTES,
  ACCEPTED_RECORDING_FORMATS,
  RECORDING_FALLBACK_PATHS,
  MicrophonePermissionDeniedError,
  RecordingRejectedError,
  RecordingStateError,
  SttProviderNotConfiguredError,
  createRecordingController,
  transcribeRecording,
  collectAndSendTranscript,
} from './recording';
export type {
  RecordingFormat,
  MicPermissionState,
  RecordingFallbackPath,
  RawTake,
  AudioRecorderPort,
  RecordedAudio,
  RecordingRejectionReason,
  RecordingController,
  TranscribeRecordingOptions,
  SubmitTranscriptOptions,
  SubmitTranscriptResult,
} from './recording';

// The content/delivery firewall (R27). A hard structural boundary: `analyse`
// operates only on an answer's CONTENT — delivery (fillers, hesitations,
// accent, dialect, non-standard phrasing, transcription artefacts) is stripped/
// neutralised via the extensible delivery lexicon and never scored — and only
// the delivery-invariant `contentContribution` flows into the skill map and CV
// path (R27.1, R27.2).
export {
  DEFAULT_DELIVERY_LEXICON,
  contentTokens,
  normaliseContent,
  analyse,
  contentContribution,
} from './firewall';
export type { DeliveryLexicon } from './firewall';

// Answer refinement, talking points, and retirement (R23.1, R23.3, R28).
// `refine` produces a structured STAR summary with flags (R28.1), coaching
// suggestions rather than blockers (R28.2), and a polished first-person
// past-tense talking point built only from the answer's content (R28.3);
// `confirmTalkingPoint` mints a stable STAR-NN id via the IdRegistry on
// confirmation (R28.3, R23.1); `retire` marks a talking point retired rather
// than deleting it (R23.3). Confirmed talking points are persisted into the
// interview file's `## Talking Points` section (R28.4).
export { refine, confirmTalkingPoint, retire } from './refine';
export type {
  TalkingPointDraft,
  StarSummaryElement,
  CoachingSuggestion,
  RefineOptions,
} from './refine';

// Skill-map update from interview answers (R29). At session end,
// `detectNewSkills`/`syncSkillMap` mines the session's CONFIRMED talking points
// (delivery-invariant content) for skills not yet in the map and returns a
// `SkillDelta` of candidates surfaced UNAPPLIED for explicit confirmation
// (R29.1, R29.2); `applySkillDelta` adds ONLY the user-confirmed candidates,
// reusing `@core/skills` (`addUserSkill` for R19.2, `linkEvidence` for the
// bi-directional STAR/BULLET links, R29.3) — unconfirmed candidates are never
// added (R29.2). No skill is ever inferred from a job title (No-Fabrication).
// `detectSessionSkills` is the AI adaptive-loop counterpart (R63.8): it unions
// the per-answer skills across the session's per-question summaries (31.4),
// excludes any already in the map (by canonical slug), and returns the same
// `SkillDelta` surfaced UNAPPLIED for the SAME `applySkillDelta` confirm-before-
// add flow — adding only user-confirmed candidates (R29.2, R29.3).
export {
  detectNewSkills,
  syncSkillMap,
  detectSessionSkills,
  applySkillDelta,
} from './skill-sync';
export type {
  CoachingSession,
  DetectedSkillSource,
  SkillConfirmation,
  ApplySkillDeltaOptions,
} from './skill-sync';
