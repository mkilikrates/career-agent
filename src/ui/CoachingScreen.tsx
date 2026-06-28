// Interview Coaching screen (@ui) — Phase 4, full guided loop (R22–R29).
//
// Generates role-grounded STAR questions (R22), then walks the user through each
// question one STAR element at a time with OPEN follow-ups (R24), supports
// Soft-Close and Pass (R25), shows progress (R25.3), and persists mid-question
// state after every turn so a paused session resumes exactly where it left off
// (R25.4). Audio answers are uploaded and transcribed through the single Egress
// Gate, then confirmed/corrected before use (R26). Confirmed answers are refined
// into polished first-person talking points with stable STAR ids (R28) and
// persisted per role. At session end, skills the answers revealed that are not
// yet in the map are surfaced for explicit confirmation and added (R29).
//
// No provider is reached except via the Egress Gate (audio STT); all other
// coaching logic is local and provider-free (Requirements 6, 7).

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Question,
  RolePreference,
  SkillCandidate,
  SkillDelta,
  SkillId,
  StarAnswer,
  StarElement,
  TalkingPoint,
} from '@core/types';
import { asQuestionId, asSkillId } from '@core/types';
import type { IdRegistry } from '@core/registry';
import type { EgressGate } from '@core/egress';
import { MemoryTree } from '@core/storage';
import { skillSlug, saveSkillMap, type SkillMap } from '@core/skills';
import {
  runAssist,
  type AssistMode,
  type AssistTransport,
  type EgressDestination,
} from '@core/assist';
import { AssistChoice } from './AssistChoice';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  LoadingIndicator,
  Row,
  Select,
  TextArea,
  TextField,
  tokens,
} from './design-system';
import {
  buildInterview,
  parseInterview,
  saveInterview,
  interviewFilePath,
  withResponse,
  withTalkingPoint,
  resumeState,
  newAnswer,
  collectText,
  softClose,
  pass,
  outstandingElements,
  openFollowUp,
  progress,
  refine,
  confirmTalkingPoint,
  uploadAudio,
  confirmTranscript,
  collectFromTranscript,
  detectNewSkills,
  detectSessionSkills,
  applySkillDelta,
  createStarQuestionsOperation,
  createStarCoachingLoop,
  perQuestionSummary,
  MAX_AI_FOLLOW_UPS,
  type InterviewFile,
  type TalkingPointDraft,
  type Transcript,
  type StarQuestionSuggestion,
  type StarCoachingLoop,
  type CoachingLoopAction,
  type PerQuestionSummary,
  type ConfirmedTranscript,
} from '@core/interview';
import { RecordAnswer } from './RecordAnswer';
import {
  createBrowserAudioRecorderPort,
  isBrowserAudioRecordingSupported,
  type BrowserAudioRecorderPort,
} from './audio-recorder-port';

export interface CoachingScreenProps {
  readonly skillMap: SkillMap | null;
  readonly onSkillMap: (map: SkillMap) => void;
  readonly rolePrefs: RolePreference[];
  readonly talkingPoints: TalkingPoint[];
  readonly onTalkingPoints: (next: TalkingPoint[]) => void;
  readonly idRegistry: IdRegistry;
  readonly store: MemoryTree;
  /** Egress Gate for audio STT (R26.2); the only path to a provider here. */
  readonly egressGate: EgressGate;
  /** The provider id to use for STT, or null when no key is configured. */
  readonly sttProvider: string | null;
  /**
   * Factory for the browser MediaRecorder audio port (R26.4). Injected for
   * testability; defaults to the real `navigator.mediaDevices`/`MediaRecorder`
   * implementation in the shell. @core never imports this DOM seam.
   */
  readonly createAudioRecorder?: () => BrowserAudioRecorderPort;
  /**
   * Whether in-browser audio recording is available in this environment (R26.12).
   * The record-audio answer mode is offered only when this is true; type and
   * upload are always offered. Defaults to a runtime feature-detect.
   */
  readonly audioRecordingSupported?: boolean;
  /** Whether an AI provider key is configured (opt-in assist, R42.1). */
  readonly aiAvailable?: boolean;
  /** Routes a prompt through the Egress Gate; returns the model's text. */
  readonly aiAssist?: (prompt: string) => Promise<string>;
  /** The chosen chat provider id for the destination label, or null. */
  readonly chatProvider?: string | null;
  /** Whether the chosen chat provider is a keyless local on-device provider. */
  readonly chatIsLocal?: boolean;
  /** The pipeline-wide AI-assist mode (chosen up front, applied as default). */
  readonly assistMode: AssistMode;
  /** Change the pipeline-wide AI-assist mode (persisted by the shell). */
  readonly onAssistMode: (mode: AssistMode) => void;
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}

const STAR: readonly StarElement[] = ['situation', 'task', 'action', 'result'];

/** De-slugify a `SKILL-foo-bar` id into a human-editable default name. */
const nameFromSkillId = (id: SkillId): string =>
  (id as unknown as string)
    .replace(/^SKILL-/, '')
    .replace(/-/g, ' ')
    .trim();

export function CoachingScreen({
  skillMap,
  onSkillMap,
  rolePrefs,
  talkingPoints,
  onTalkingPoints,
  idRegistry,
  store,
  egressGate,
  sttProvider,
  createAudioRecorder = createBrowserAudioRecorderPort,
  audioRecordingSupported = isBrowserAudioRecordingSupported(),
  aiAvailable = false,
  aiAssist,
  chatProvider = null,
  chatIsLocal = false,
  assistMode,
  onAssistMode,
  t,
}: CoachingScreenProps) {
  const [roleSlug, setRoleSlug] = useState<string>(
    rolePrefs[0] ? (rolePrefs[0].slug as unknown as string) : '',
  );
  const [file, setFile] = useState<InterviewFile | null>(null);
  const [cursor, setCursor] = useState(0);
  const [answer, setAnswer] = useState<StarAnswer | null>(null);
  const [elementText, setElementText] = useState('');
  const [draft, setDraft] = useState<TalkingPointDraft | null>(null);
  const [extraSkills, setExtraSkills] = useState('');
  const [status, setStatus] = useState('');

  // Opt-in-first AI practice questions (R22.4): the pipeline-wide choice surfaced
  // by <AssistChoice>, plus AI-suggested practice questions that SUPPLEMENT (never
  // replace) the deterministic script questions (R22.6).
  const [aiBusy, setAiBusy] = useState(false);
  // AI-suggested practice questions carry the competency they probe (R62.3);
  // the question is shown to the user while the competency is retained for the
  // adaptive coaching loop and the per-question summary (R63.2, R63.6).
  const [aiQuestions, setAiQuestions] = useState<StarQuestionSuggestion[]>([]);
  const [aiError, setAiError] = useState<string>('');
  const questionsOperation = useMemo(
    () =>
      createStarQuestionsOperation(
        (prompt) => (aiAssist ? aiAssist(prompt) : Promise.resolve('')),
        t('coaching.ai.genericCompetency'),
      ),
    [aiAssist, t],
  );

  // Audio (R26).
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [transcriptEdit, setTranscriptEdit] = useState('');
  const [audioBusy, setAudioBusy] = useState(false);
  const [translateToEnglish, setTranslateToEnglish] = useState(false);
  // The selectable answer-input mode for the guided script loop (R26.12): always
  // type/upload, plus record when the microphone is available.
  const [answerMode, setAnswerMode] = useState<'text' | 'upload' | 'record'>('text');
  // The same selectable choice for the AI adaptive loop answer (R26.12).
  const [loopAnswerMode, setLoopAnswerMode] = useState<'text' | 'upload' | 'record'>('text');

  // Skill sync (R29).
  const [delta, setDelta] = useState<SkillDelta | null>(null);
  const [confirmInputs, setConfirmInputs] = useState<
    Record<string, { selected: boolean; name: string; roleOrProject: string; when: string }>
  >({});

  // --- AI adaptive STAR coaching loop (R63) --------------------------------
  // The deterministic loop controller for the currently-practised AI question
  // lives in a ref (it is a stateful class the chat model cannot hold); the UI
  // mirrors its next action in `loopAction` and re-renders on every transition.
  const loopRef = useRef<StarCoachingLoop | null>(null);
  // The selected AI question being practised (competency RETAINED, R63.2), or
  // null when no AI loop is active (script-only path is unaffected).
  const [loopQuestion, setLoopQuestion] = useState<StarQuestionSuggestion | null>(null);
  const [loopAction, setLoopAction] = useState<CoachingLoopAction | null>(null);
  const [loopAnswers, setLoopAnswers] = useState<readonly string[]>([]);
  const [loopAnswerText, setLoopAnswerText] = useState('');
  const [loopBusy, setLoopBusy] = useState(false);
  const [loopError, setLoopError] = useState('');
  // Audio answer for the AI loop (reuses the existing gated Whisper path, R63.1).
  const [loopTranscript, setLoopTranscript] = useState<Transcript | null>(null);
  const [loopTranscriptEdit, setLoopTranscriptEdit] = useState('');
  // The per-question summary rendered when the loop ends (R63.6), the draft
  // talking point built from the user's words, and the extra-skills field.
  const [summary, setSummary] = useState<PerQuestionSummary | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [loopDraft, setLoopDraft] = useState<TalkingPointDraft | null>(null);
  const [loopExtraSkills, setLoopExtraSkills] = useState('');
  // Every per-question summary produced this session, unioned at session end to
  // surface detected skills not yet in the map (R63.8).
  const [sessionSummaries, setSessionSummaries] = useState<readonly PerQuestionSummary[]>([]);

  const role = rolePrefs.find((r) => (r.slug as unknown as string) === roleSlug);

  // The gate-routed transport + destination the AI adaptive loop (R63) and its
  // per-question summary use. `aiAssist` already routes through the orchestrator
  // → single Egress Gate (PII pre-screen, network label, chosen-provider-only),
  // so we adapt it to the {@link AssistTransport} shape the core loop expects
  // (the `dest` is supplied by the caller and carried for labelling). This keeps
  // @core provider-agnostic and preserves the Egress-Gate-only boundary.
  const aiTransport = useMemo<AssistTransport>(
    () => (prompt) => (aiAssist ? aiAssist(prompt) : Promise.reject(new Error('No AI provider is configured.'))),
    [aiAssist],
  );
  const aiDest = useMemo<EgressDestination | null>(
    () => (chatProvider ? { provider: chatProvider, kind: chatIsLocal ? 'keyless-local' : 'keyed-cloud' } : null),
    [chatProvider, chatIsLocal],
  );

  // Load (or build) the role's interview file and resume to its cursor (R25.4).
  useEffect(() => {
    if (!role || !skillMap) {
      setFile(null);
      return;
    }
    const path = interviewFilePath(role.slug);
    const loaded = store.has(path)
      ? parseInterview(store.readText(path))
      : buildInterview(role, skillMap);
    const rs = resumeState(loaded);
    setFile(loaded);
    setCursor(rs.cursor);
    setAnswer(
      rs.currentAnswer ??
        (loaded.questions[rs.cursor] ? newAnswer(loaded.questions[rs.cursor].id) : null),
    );
    setDraft(null);
    setElementText('');
    setTranscript(null);
    setAnswerMode('text');
    setLoopAnswerMode('text');
    // Reset any active AI coaching loop when the role changes (R63).
    loopRef.current = null;
    setLoopQuestion(null);
    setLoopAction(null);
    setLoopAnswers([]);
    setLoopAnswerText('');
    setLoopError('');
    setLoopTranscript(null);
    setSummary(null);
    setLoopDraft(null);
    setLoopExtraSkills('');
    setSessionSummaries([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleSlug, skillMap]);

  const question: Question | undefined = file?.questions[cursor];
  const outstanding = answer ? outstandingElements(answer) : STAR;
  const currentElement = outstanding[0];
  const complete = answer != null && outstanding.length === 0;
  const prog = file ? progress(file.questions, cursor) : null;

  const persist = (next: InterviewFile) => {
    setFile(next);
    void saveInterview(store, next).catch((e) => console.error('persist interview failed', e));
  };

  const goToQuestion = (index: number) => {
    if (!file) return;
    const q = file.questions[index];
    setCursor(index);
    setAnswer(q ? newAnswer(q.id) : null);
    setDraft(null);
    setElementText('');
    setTranscript(null);
    setAnswerMode('text');
    if (!q) setStatus(t('coaching.sessionDone'));
  };

  const recordTurn = (next: StarAnswer) => {
    if (!file) return;
    setAnswer(next);
    persist(withResponse(file, next, cursor));
    if (outstandingElements(next).length === 0 && question) {
      setDraft(refine(next, { skills: question.skill ? [question.skill] : [] }));
    }
  };

  const handleSubmitElement = () => {
    if (!answer || !currentElement || elementText.trim().length === 0) return;
    recordTurn(collectText(answer, elementText, currentElement).answer);
    setElementText('');
  };

  const handleSoftClose = () => {
    if (!answer || !currentElement || !file || !question) return;
    const flagged = softClose(answer, currentElement);
    setAnswer(flagged.answer);
    persist(withResponse(file, flagged.answer, cursor));
    setDraft(refine(flagged.answer, { skills: question.skill ? [question.skill] : [] }));
  };

  const handlePass = () => {
    if (!answer || !file) return;
    persist(withResponse(file, pass(answer), cursor));
    goToQuestion(cursor + 1);
  };

  const handleConfirm = () => {
    if (!draft || !file) return;
    const extraIds: SkillId[] = extraSkills
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((name) => asSkillId(`SKILL-${skillSlug(name)}`));
    const tp = confirmTalkingPoint(
      { ...draft, skills: [...draft.skills, ...extraIds] },
      idRegistry,
    );
    onTalkingPoints([...talkingPoints, tp]);
    persist(withTalkingPoint(file, tp));
    store.logConfirmation(`Confirmed talking point ${tp.id as unknown as string}.`);
    setStatus(t('coaching.confirmed', { id: tp.id as unknown as string }));
    setExtraSkills('');
    goToQuestion(cursor + 1);
  };

  // --- Audio (R26) ---------------------------------------------------------

  const handleAudio = async (audioFile: File | undefined) => {
    if (!audioFile) return;
    if (!sttProvider) {
      setStatus(t('coaching.audio.noProvider'));
      return;
    }
    setAudioBusy(true);
    setStatus(t('coaching.audio.transcribing'));
    try {
      const tr = await uploadAudio(
        {
          name: audioFile.name,
          mimeType: audioFile.type,
          bytes: async () => new Uint8Array(await audioFile.arrayBuffer()),
        },
        { gate: egressGate, provider: sttProvider, translateToEnglish },
      );
      setTranscript(tr);
      setTranscriptEdit(tr.text);
      setStatus('');
    } catch (error) {
      setStatus(t('coaching.audio.failed', { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setAudioBusy(false);
    }
  };

  const handleUseTranscript = () => {
    if (!transcript || !answer || !currentElement) return;
    const confirmed = confirmTranscript(
      transcript,
      transcriptEdit !== transcript.text ? transcriptEdit : undefined,
    );
    recordTurn(collectFromTranscript(answer, confirmed, currentElement).answer);
    setTranscript(null);
  };

  // A recorded answer converges with the typed/uploaded paths (R26.8): the
  // confirmed transcript feeds the guided STAR loop exactly like an upload.
  const handleRecordedConfirmed = (confirmed: ConfirmedTranscript) => {
    if (!answer || !currentElement) return;
    recordTurn(collectFromTranscript(answer, confirmed, currentElement).answer);
    setAnswerMode('text');
  };

  // --- End-of-session skill sync (R29) -------------------------------------

  const handleDetectNewSkills = () => {
    if (!file || !skillMap) return;
    // R29 path: skills the confirmed talking points reveal (with STAR evidence).
    const fromTalkingPoints = detectNewSkills(file, skillMap);
    // R63.8 path: skills unioned across this session's AI per-question summaries
    // (plain names, no STAR id) that are not already in the map.
    const fromSession: SkillDelta =
      sessionSummaries.length > 0
        ? detectSessionSkills(sessionSummaries, skillMap)
        : { candidates: [] };
    // Union by skill id, preferring the candidate that carries STAR evidence so
    // the confirm-before-add flow can still wire the proof links (R29.3).
    const merged = new Map<string, SkillCandidate>();
    for (const c of [...fromTalkingPoints.candidates, ...fromSession.candidates]) {
      const key = c.skill as unknown as string;
      const existing = merged.get(key);
      if (!existing || (existing.evidence.length === 0 && c.evidence.length > 0)) {
        merged.set(key, c);
      }
    }
    const candidates = [...merged.values()].sort((a, b) =>
      a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
    );
    const d: SkillDelta = { candidates };
    setDelta(d);
    setConfirmInputs(
      Object.fromEntries(
        d.candidates.map((c) => [
          c.skill as unknown as string,
          { selected: false, name: nameFromSkillId(c.skill), roleOrProject: '', when: '' },
        ]),
      ),
    );
    setStatus(d.candidates.length === 0 ? t('coaching.sync.none') : '');
  };

  const handleApplySync = () => {
    if (!delta || !skillMap) return;
    const confirmations = delta.candidates
      .map((c) => ({ c, input: confirmInputs[c.skill as unknown as string] }))
      .filter(({ input }) => input?.selected)
      .map(({ c, input }) => ({
        skill: c.skill,
        name: input.name.trim(),
        roleOrProject: input.roleOrProject.trim(),
        when: input.when.trim(),
      }));
    try {
      const added = applySkillDelta(skillMap, delta, confirmations, { registry: idRegistry });
      onSkillMap({ entries: [...skillMap.entries], graph: skillMap.graph });
      void saveSkillMap(store, skillMap);
      setStatus(t('coaching.sync.added', { count: added.length }));
      setDelta(null);
    } catch (error) {
      // addUserSkill throws when role/project + when are missing (R19.2).
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const updateConfirm = (key: string, patch: Partial<{ selected: boolean; name: string; roleOrProject: string; when: string }>) =>
    setConfirmInputs((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const handleAiQuestions = async () => {
    if (!role || !skillMap || !aiAssist) return;
    setAiBusy(true);
    setAiError('');
    const dest: EgressDestination | null = chatProvider
      ? { provider: chatProvider, kind: chatIsLocal ? 'keyless-local' : 'keyed-cloud' }
      : null;
    try {
      // script-only never reaches a provider; ai-assisted returns the full
      // deterministic question set as baseline PLUS confirmable AI practice
      // questions, falling back to the baseline on provider failure.
      const { outcome, error } = await runAssist(
        questionsOperation,
        { role, map: skillMap },
        { mode: assistMode, capability: 'star_questions' },
        dest ?? undefined,
      );
      setAiQuestions(outcome.suggestions.map((s) => s.value));
      if (error) setAiError(t('assist.fallback', { reason: error.message }));
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setAiBusy(false);
    }
  };

  // --- AI adaptive STAR coaching loop (R63) --------------------------------

  /**
   * Build the polished talking-point draft from the AI loop's accumulated answer
   * via the EXISTING refine path (R28.3): the user's own words become a
   * first-person past-tense talking point, with the skills the per-question
   * summary evidenced pre-linked. Reuses {@link collectText}/{@link refine} so
   * AI-mode talking points persist through the same path as the script loop.
   */
  const buildLoopDraft = (fullAnswer: string, skills: readonly string[]) => {
    const questionId = file?.questions[cursor]?.id ?? asQuestionId('AI-PRACTICE');
    // The AI loop collects a free-form answer rather than per-element text, so
    // the user's own words are carried as the answer content (No-Fabrication).
    const built = collectText(newAnswer(questionId), fullAnswer, 'situation').answer;
    const skillIds: SkillId[] = skills.map((name) => asSkillId(`SKILL-${skillSlug(name)}`));
    setLoopDraft(refine(built, { skills: skillIds }));
  };

  // When the loop ends, fetch the per-question summary (R63.6) and prepare the
  // talking-point draft. A provider failure here is NON-BLOCKING: the loop result
  // and coaching state are preserved and the user can still confirm a point.
  const finishLoop = async (loop: StarCoachingLoop) => {
    if (!aiDest) return;
    const snap = loop.state;
    const fullAnswer = snap.answersSoFar.join('\n\n');
    if (fullAnswer.trim().length > 0) buildLoopDraft(fullAnswer, []);
    setSummaryBusy(true);
    try {
      const s = await perQuestionSummary(
        {
          role: snap.role,
          competency: snap.competency,
          question: snap.question,
          fullAnswer,
        },
        aiDest,
        aiTransport,
      );
      setSummary(s);
      setSessionSummaries((prev) => [...prev, s]);
      // Pre-link the skills the answer evidenced onto the draft (R63.6).
      if (fullAnswer.trim().length > 0) buildLoopDraft(fullAnswer, s.skills);
    } catch (error) {
      // Non-blocking (R63 fallback parity): the loop finished and the draft is
      // already available; surface the failure without losing coaching state.
      setLoopError(t('coaching.loop.summaryFailed', { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setSummaryBusy(false);
    }
  };

  /** Begin the adaptive loop for a selected AI question (competency retained, R63.1). */
  const handleStartLoop = (q: StarQuestionSuggestion) => {
    if (!role || !aiDest) return;
    const loop = createStarCoachingLoop(
      { role, competency: q.competency, question: q.question },
      aiDest,
      aiTransport,
    );
    loopRef.current = loop;
    setLoopQuestion(q);
    setLoopAction(loop.action);
    setLoopAnswers([]);
    setLoopAnswerText('');
    setLoopError('');
    setLoopTranscript(null);
    setSummary(null);
    setLoopDraft(null);
    setLoopExtraSkills('');
    setLoopAnswerMode('text');
  };

  /**
   * Submit the user's typed answer (or a confirmed audio transcript) for the
   * current loop round and run ONE gate-routed adequacy assessment (R63.2). The
   * answer is committed only after a successful assessment, so a provider failure
   * is non-blocking: coaching state is preserved and the typed answer is kept so
   * the user can retry (R63 failure parity).
   */
  const submitLoopAnswer = async (text: string) => {
    const loop = loopRef.current;
    if (!loop || text.trim().length === 0 || loopBusy) return;
    setLoopBusy(true);
    setLoopError('');
    try {
      const action = await loop.submitAnswer(text);
      setLoopAnswers(loop.state.answersSoFar);
      setLoopAction(action);
      setLoopAnswerText('');
      setLoopTranscript(null);
      if (action.kind === 'finished') await finishLoop(loop);
    } catch (error) {
      setLoopError(t('coaching.loop.failed', { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setLoopBusy(false);
    }
  };

  /** Opt into digging deeper past the three-follow-up cap (R63.4). */
  const handleDigDeeper = () => {
    const loop = loopRef.current;
    if (!loop) return;
    setLoopAction(loop.digDeeper());
  };

  /** Decline to dig deeper at the cap, ending the loop with `cap-reached` (R63.4). */
  const handleDeclineDigDeeper = () => {
    const loop = loopRef.current;
    if (!loop) return;
    const action = loop.declineDigDeeper();
    setLoopAction(action);
    if (action.kind === 'finished') void finishLoop(loop);
  };

  /** Stop the loop for this question at any round (R63.5). */
  const handleStopLoop = () => {
    const loop = loopRef.current;
    if (!loop) return;
    const action = loop.stop();
    setLoopAction(action);
    if (action.kind === 'finished') void finishLoop(loop);
  };

  /** Leave the AI coaching loop and return to the question list / script loop. */
  const handleExitLoop = () => {
    loopRef.current = null;
    setLoopQuestion(null);
    setLoopAction(null);
    setLoopAnswers([]);
    setLoopAnswerText('');
    setLoopError('');
    setLoopTranscript(null);
    setSummary(null);
    setLoopDraft(null);
    setLoopExtraSkills('');
    setLoopAnswerMode('text');
  };

  /** Transcribe an audio answer for the AI loop via the existing gated path (R63.1). */
  const handleLoopAudio = async (audioFile: File | undefined) => {
    if (!audioFile) return;
    if (!sttProvider) {
      setLoopError(t('coaching.audio.noProvider'));
      return;
    }
    setAudioBusy(true);
    try {
      const tr = await uploadAudio(
        {
          name: audioFile.name,
          mimeType: audioFile.type,
          bytes: async () => new Uint8Array(await audioFile.arrayBuffer()),
        },
        { gate: egressGate, provider: sttProvider, translateToEnglish },
      );
      setLoopTranscript(tr);
      setLoopTranscriptEdit(tr.text);
    } catch (error) {
      setLoopError(t('coaching.audio.failed', { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setAudioBusy(false);
    }
  };

  /** Confirm the transcript and submit it as the current loop answer (R63.1). */
  const handleUseLoopTranscript = () => {
    if (!loopTranscript) return;
    const confirmed = confirmTranscript(
      loopTranscript,
      loopTranscriptEdit !== loopTranscript.text ? loopTranscriptEdit : undefined,
    );
    void submitLoopAnswer(confirmed.text);
  };

  // A recorded answer for the AI loop converges with the typed/uploaded paths:
  // the confirmed transcript is submitted exactly like an upload (R26.8, R63.1).
  const handleLoopRecordedConfirmed = (confirmed: ConfirmedTranscript) => {
    void submitLoopAnswer(confirmed.text);
    setLoopAnswerMode('text');
  };

  /**
   * Confirm the AI-mode talking point through the EXISTING persistence path:
   * refine → confirmTalkingPoint → withTalkingPoint → saveInterview (R28.3, R28.4).
   */
  const handleConfirmLoopPoint = () => {
    if (!loopDraft || !file) return;
    const extraIds: SkillId[] = loopExtraSkills
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((name) => asSkillId(`SKILL-${skillSlug(name)}`));
    const tp = confirmTalkingPoint(
      { ...loopDraft, skills: [...loopDraft.skills, ...extraIds] },
      idRegistry,
    );
    onTalkingPoints([...talkingPoints, tp]);
    persist(withTalkingPoint(file, tp));
    store.logConfirmation(`Confirmed talking point ${tp.id as unknown as string} (AI coaching).`);
    setStatus(t('coaching.confirmed', { id: tp.id as unknown as string }));
    setLoopDraft(null);
    setLoopExtraSkills('');
  };

  const sessionTalkingPoints = useMemo(
    () => (file?.talkingPoints ?? []),
    [file],
  );

  if (rolePrefs.length === 0 || !skillMap) {
    return (
      <section aria-label={t('coaching.heading')} data-coaching-screen>
        <h3>{t('coaching.heading')}</h3>
        <EmptyState message={t('coaching.needRoles')} />
      </section>
    );
  }

  return (
    <section aria-label={t('coaching.heading')} data-coaching-screen>
      <h3>{t('coaching.heading')}</h3>
      <p>{t('coaching.intro')}</p>

      <Row>
        <Select
          label={t('coaching.roleLabel')}
          value={roleSlug}
          onChange={(e) => setRoleSlug(e.target.value)}
        >
          {rolePrefs.map((r) => (
            <option key={r.slug as unknown as string} value={r.slug as unknown as string}>
              {r.title}
            </option>
          ))}
        </Select>
        {prog ? <small>{prog.label}</small> : null}
      </Row>

      {/* Opt-in-first AI practice questions (R22.4): pre-operation choice + the
          destination network/privacy label, surfaced before the operation. AI
          questions supplement (never replace) the script questions (R22.6). */}
      <div style={{ margin: `${tokens.spacing.sm} 0` }}>
        <AssistChoice
          mode={assistMode}
          onMode={onAssistMode}
          aiAvailable={aiAvailable}
          provider={chatProvider}
          destinationKind={chatIsLocal ? 'keyless-local' : 'keyed-cloud'}
          t={t}
        />
        {aiAvailable && assistMode !== 'script-only' ? (
          <div data-star-explainer>
            <h4>{t('coaching.ai.explainerHeading')}</h4>
            <p>
              <small>{t('coaching.ai.explainer')}</small>
            </p>
            <p>
              <Button onClick={() => void handleAiQuestions()} disabled={aiBusy || !role}>
                {aiBusy ? t('coaching.ai.working') : t('coaching.ai.suggest')}
              </Button>
            </p>
          </div>
        ) : null}
        {aiBusy ? <LoadingIndicator message={t('coaching.ai.working')} /> : null}
        {aiError ? (
          <Banner role="status">
            <small>{aiError}</small>
          </Banner>
        ) : null}
        {aiQuestions.length > 0 && !loopQuestion ? (
          <div data-ai-practice-questions>
            {/* Heading on its own row, the practise control for each question on
                its own row beneath the question text (R63.9 — tidy layout). The
                competency is HIDDEN: only the question text is shown, while the
                competency stays in state for the loop and summary (R62.3, R63.2). */}
            <h4>{t('coaching.ai.heading')}</h4>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {aiQuestions.map((q) => (
                <li key={q.question} style={{ marginBottom: tokens.spacing.sm }}>
                  <p style={{ margin: 0 }}>
                    <small>{q.question}</small>
                  </p>
                  <p style={{ margin: `${tokens.spacing.xs} 0 0` }}>
                    <Button
                      variant="secondary"
                      onClick={() => handleStartLoop(q)}
                      disabled={!aiDest || !role}
                    >
                      {t('coaching.ai.practise')}
                    </Button>
                  </p>
                </li>
              ))}
            </ul>
            <p>
              <small>{t('coaching.ai.advisory')}</small>
            </p>
          </div>
        ) : null}

        {/* The AI adaptive STAR coaching loop for the selected question (R63). */}
        {loopQuestion ? (
          <Card data-ai-coaching-loop aria-label={t('coaching.loop.heading')} style={{ marginTop: tokens.spacing.sm }}>
            <h4>{t('coaching.loop.heading')}</h4>
            <blockquote>
              <small>{loopQuestion.question}</small>
            </blockquote>

            {/* Answers given so far in this loop (the user's own words). */}
            {loopAnswers.length > 0 ? (
              <ol>
                {loopAnswers.map((a, i) => (
                  <li key={i}>
                    <small>{a}</small>
                  </li>
                ))}
              </ol>
            ) : null}

            {loopBusy || summaryBusy ? (
              <LoadingIndicator message={t('coaching.loop.working')} />
            ) : null}

            {loopError ? (
              <Banner role="status">
                <small>{loopError}</small>
              </Banner>
            ) : null}

            {loopAction && loopAction.kind === 'await-answer' ? (
              <div>
                {loopAction.followUp ? (
                  <p>
                    <strong>{t('coaching.loop.followUp')}</strong> —{' '}
                    <small>{loopAction.followUp}</small>
                  </p>
                ) : (
                  <p>
                    <small>{t('coaching.loop.firstAnswer')}</small>
                  </p>
                )}
                <p>
                  <small>
                    {t('coaching.loop.progress', {
                      count: loopAction.followUpCount,
                      max: MAX_AI_FOLLOW_UPS,
                    })}
                  </small>
                </p>

                {/* Answer-input mode choice for the AI loop (R26.12). */}
                <Select
                  label={t('coaching.answerMode.label')}
                  value={loopAnswerMode}
                  disabled={loopBusy}
                  onChange={(e) => setLoopAnswerMode(e.target.value as 'text' | 'upload' | 'record')}
                >
                  <option value="text">{t('coaching.answerMode.text')}</option>
                  <option value="upload">{t('coaching.answerMode.upload')}</option>
                  {audioRecordingSupported ? (
                    <option value="record">{t('coaching.answerMode.record')}</option>
                  ) : null}
                </Select>

                {loopAnswerMode === 'text' ? (
                  <>
                    <TextArea
                      label={t('coaching.loop.answerLabel')}
                      hideLabel
                      rows={4}
                      value={loopAnswerText}
                      disabled={loopBusy}
                      onChange={(e) => setLoopAnswerText(e.target.value)}
                    />
                    <Button
                      onClick={() => void submitLoopAnswer(loopAnswerText)}
                      disabled={loopBusy || loopAnswerText.trim().length === 0}
                    >
                      {t('coaching.loop.submit')}
                    </Button>
                  </>
                ) : null}

                {/* Upload an audio answer for the loop (reuses the gated path, R63.1). */}
                {loopAnswerMode === 'upload' ? (
                  sttProvider ? (
                    <div>
                      <input
                        type="file"
                        aria-label={t('coaching.audio.heading')}
                        accept=".mp3,.wav,audio/mpeg,audio/wav"
                        disabled={audioBusy || loopBusy}
                        onChange={(e) => {
                          void handleLoopAudio(e.target.files?.[0]);
                          e.target.value = '';
                        }}
                      />
                      <label style={{ display: 'block', marginTop: tokens.spacing.sm }}>
                        <input
                          type="checkbox"
                          checked={translateToEnglish}
                          disabled={audioBusy || loopBusy}
                          onChange={(e) => setTranslateToEnglish(e.target.checked)}
                        />{' '}
                        <small>{t('coaching.audio.translate')}</small>
                      </label>
                      {audioBusy ? <LoadingIndicator message={t('coaching.audio.transcribing')} /> : null}
                      {loopTranscript ? (
                        <div>
                          <p>
                            <small>{t('coaching.audio.confirm')}</small>
                          </p>
                          <TextArea
                            label={t('coaching.audio.confirm')}
                            hideLabel
                            rows={3}
                            value={loopTranscriptEdit}
                            onChange={(e) => setLoopTranscriptEdit(e.target.value)}
                          />
                          <Button onClick={handleUseLoopTranscript} disabled={loopBusy}>
                            {t('coaching.audio.use')}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <EmptyState message={t('coaching.audio.noProvider')} />
                  )
                ) : null}

                {/* Record an answer in the browser for the loop (R26.4-26.8, R63.1). */}
                {loopAnswerMode === 'record' && audioRecordingSupported ? (
                  <>
                    <label style={{ display: 'block', marginBottom: tokens.spacing.sm }}>
                      <input
                        type="checkbox"
                        checked={translateToEnglish}
                        disabled={loopBusy}
                        onChange={(e) => setTranslateToEnglish(e.target.checked)}
                      />{' '}
                      <small>{t('coaching.audio.translate')}</small>
                    </label>
                    <RecordAnswer
                      createRecorder={createAudioRecorder}
                      egressGate={egressGate}
                      sttProvider={sttProvider}
                      translateToEnglish={translateToEnglish}
                      onConfirmed={handleLoopRecordedConfirmed}
                      onUnavailable={() => {
                        setLoopAnswerMode('upload');
                        setLoopError(t('coaching.audio.record.fallback'));
                      }}
                      disabled={loopBusy}
                      t={t}
                    />
                  </>
                ) : null}

                {/* Stop the loop remains available in every answer mode (R63.5). */}
                <Row>
                  <Button variant="secondary" onClick={handleStopLoop} disabled={loopBusy}>
                    {t('coaching.loop.stop')}
                  </Button>
                </Row>
              </div>
            ) : null}

            {/* Cap reached and the model still has a follow-up: dig-deeper opt-in (R63.4). */}
            {loopAction && loopAction.kind === 'await-dig-deeper' ? (
              <div data-dig-deeper>
                <p>
                  <small>{t('coaching.loop.capReached', { max: MAX_AI_FOLLOW_UPS })}</small>
                </p>
                <p>
                  <strong>{t('coaching.loop.followUp')}</strong> —{' '}
                  <small>{loopAction.followUp}</small>
                </p>
                <Row>
                  <Button onClick={handleDigDeeper}>{t('coaching.loop.digDeeper')}</Button>
                  <Button variant="secondary" onClick={handleDeclineDigDeeper}>
                    {t('coaching.loop.stop')}
                  </Button>
                </Row>
              </div>
            ) : null}

            {/* The per-question summary, rendered when the loop ends (R63.6). */}
            {loopAction && loopAction.kind === 'finished' ? (
              <div data-loop-summary>
                <p>
                  <small>{t(`coaching.loop.reason.${loopAction.reason}`)}</small>
                </p>
                {summary ? (
                  <Card aria-label={t('coaching.loop.summaryHeading')}>
                    <h5>{t('coaching.loop.summaryHeading')}</h5>
                    <p>
                      <strong>{t('coaching.loop.competency')}:</strong> {loopQuestion.competency}
                    </p>
                    <p>
                      <strong>{t('coaching.loop.summaryLabel')}:</strong> {summary.summary || t('coaching.noContent')}
                    </p>
                    <p>
                      <strong>{t('coaching.loop.starLabel')}:</strong> {summary.star || '—'}
                    </p>
                    {summary.skills.length > 0 ? (
                      <p>
                        <strong>{t('coaching.loop.skillsLabel')}:</strong> {summary.skills.join(', ')}
                      </p>
                    ) : null}
                    {summary.tips.length > 0 ? (
                      <>
                        <p>
                          <strong>{t('coaching.loop.tipsLabel')}:</strong>
                        </p>
                        <ul>
                          {summary.tips.map((tip) => (
                            <li key={tip}>
                              <small>{tip}</small>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </Card>
                ) : null}

                {/* Confirm the talking point through the existing persistence path. */}
                {loopDraft ? (
                  <Card aria-label={t('coaching.draftHeading')} style={{ marginTop: tokens.spacing.sm }}>
                    <h5>{t('coaching.draftHeading')}</h5>
                    <p>
                      <strong>{t('coaching.polished')}:</strong> {loopDraft.polished || t('coaching.noContent')}
                    </p>
                    <TextField
                      label={t('coaching.extraSkills')}
                      type="text"
                      value={loopExtraSkills}
                      onChange={(e) => setLoopExtraSkills(e.target.value)}
                      placeholder="e.g. Incident Response, Mentoring"
                    />
                    <p>
                      <Button onClick={handleConfirmLoopPoint} disabled={loopDraft.polished.length === 0}>
                        {t('coaching.confirm')}
                      </Button>
                    </p>
                  </Card>
                ) : null}

                <p>
                  <Button variant="secondary" onClick={handleExitLoop}>
                    {t('coaching.loop.done')}
                  </Button>
                </p>
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>

      {question && !loopQuestion ? (
        <section aria-label={question.id as unknown as string}>
          <blockquote>
            <small>{question.prompt}</small>
          </blockquote>

          {/* STAR element capture progress. */}
          <p>
            {STAR.map((el) => (
              <span key={el} style={{ marginRight: tokens.spacing.md }}>
                {answer && answer[el] ? '✓' : '○'} {t(`coaching.star.${el}`)}
              </span>
            ))}
          </p>

          {!complete && currentElement ? (
            <div>
              <p>
                <strong>{t(`coaching.star.${currentElement}`)}</strong> —{' '}
                <small>{openFollowUp(currentElement)}</small>
              </p>

              {/* Answer-input mode choice (R26.12): always type/upload, plus
                  record when the microphone is available. */}
              <Select
                label={t('coaching.answerMode.label')}
                value={answerMode}
                onChange={(e) => setAnswerMode(e.target.value as 'text' | 'upload' | 'record')}
              >
                <option value="text">{t('coaching.answerMode.text')}</option>
                <option value="upload">{t('coaching.answerMode.upload')}</option>
                {audioRecordingSupported ? (
                  <option value="record">{t('coaching.answerMode.record')}</option>
                ) : null}
              </Select>

              {answerMode === 'text' ? (
                <>
                  <TextArea
                    label={t(`coaching.star.${currentElement}`)}
                    hideLabel
                    rows={3}
                    value={elementText}
                    onChange={(e) => setElementText(e.target.value)}
                  />
                  <Button onClick={handleSubmitElement} disabled={elementText.trim().length === 0}>
                    {t('coaching.submit')}
                  </Button>
                </>
              ) : null}

              {/* Upload an MP3/WAV answer, transcribe via the Egress Gate (R26.1-26.3). */}
              {answerMode === 'upload' ? (
                sttProvider ? (
                  <div>
                    <input
                      type="file"
                      aria-label={t('coaching.audio.heading')}
                      accept=".mp3,.wav,audio/mpeg,audio/wav"
                      disabled={audioBusy}
                      onChange={(e) => {
                        void handleAudio(e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                    <label style={{ display: 'block', marginTop: tokens.spacing.sm }}>
                      <input
                        type="checkbox"
                        checked={translateToEnglish}
                        disabled={audioBusy}
                        onChange={(e) => setTranslateToEnglish(e.target.checked)}
                      />{' '}
                      <small>{t('coaching.audio.translate')}</small>
                    </label>
                    {audioBusy ? <LoadingIndicator message={t('coaching.audio.transcribing')} /> : null}
                    {transcript ? (
                      <div>
                        <p>
                          <small>{t('coaching.audio.confirm')}</small>
                        </p>
                        <TextArea
                          label={t('coaching.audio.confirm')}
                          hideLabel
                          rows={3}
                          value={transcriptEdit}
                          onChange={(e) => setTranscriptEdit(e.target.value)}
                        />
                        <Button onClick={handleUseTranscript}>{t('coaching.audio.use')}</Button>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <EmptyState message={t('coaching.audio.noProvider')} />
                )
              ) : null}

              {/* Record an answer in the browser (R26.4, R26.6-26.8); on mic
                  denial fall back to the upload path (R26.10). */}
              {answerMode === 'record' && audioRecordingSupported ? (
                <>
                  <label style={{ display: 'block', marginBottom: tokens.spacing.sm }}>
                    <input
                      type="checkbox"
                      checked={translateToEnglish}
                      onChange={(e) => setTranslateToEnglish(e.target.checked)}
                    />{' '}
                    <small>{t('coaching.audio.translate')}</small>
                  </label>
                  <RecordAnswer
                    createRecorder={createAudioRecorder}
                    egressGate={egressGate}
                    sttProvider={sttProvider}
                    translateToEnglish={translateToEnglish}
                    onConfirmed={handleRecordedConfirmed}
                    onUnavailable={() => {
                      setAnswerMode('upload');
                      setStatus(t('coaching.audio.record.fallback'));
                    }}
                    t={t}
                  />
                </>
              ) : null}

              {/* Soft-Close and Pass remain available in every answer mode. */}
              <Row>
                <Button variant="secondary" onClick={handleSoftClose}>
                  {t('coaching.softClose')}
                </Button>
                <Button variant="secondary" onClick={handlePass}>
                  {t('coaching.pass')}
                </Button>
              </Row>
            </div>
          ) : (
            <p>
              <small>{t('coaching.answerComplete')}</small>
            </p>
          )}
        </section>
      ) : loopQuestion ? null : (
        <p>
          <small>{t('coaching.sessionDone')}</small>
        </p>
      )}

      {/* Refine + confirm a talking point (R28). */}
      {draft ? (
        <Card aria-label={t('coaching.draftHeading')} style={{ marginTop: tokens.spacing.sm }}>
          <h4>{t('coaching.draftHeading')}</h4>
          <p>
            <strong>{t('coaching.polished')}:</strong> {draft.polished || t('coaching.noContent')}
          </p>
          {draft.suggestions.length > 0 ? (
            <ul>
              {draft.suggestions.map((s) => (
                <li key={s.flag}>
                  <small>{s.suggestion}</small>
                </li>
              ))}
            </ul>
          ) : null}
          <TextField
            label={t('coaching.extraSkills')}
            type="text"
            value={extraSkills}
            onChange={(e) => setExtraSkills(e.target.value)}
            placeholder="e.g. Incident Response, Mentoring"
          />
          <p>
            <Button onClick={handleConfirm} disabled={draft.polished.length === 0}>
              {t('coaching.confirm')}
            </Button>
          </p>
        </Card>
      ) : null}

      {status ? (
        <Banner role="status">
          <small>{status}</small>
        </Banner>
      ) : null}

      {/* Confirmed talking points for this role. */}
      {sessionTalkingPoints.length > 0 ? (
        <section aria-label={t('coaching.confirmedHeading')}>
          <h4>{t('coaching.confirmedHeading')}</h4>
          <ul>
            {sessionTalkingPoints.map((tp) => (
              <li key={tp.id as unknown as string}>
                <small>
                  <strong>{tp.id as unknown as string}</strong>: {tp.polished}
                </small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* End-of-session skill sync (R29). */}
      <section aria-label={t('coaching.sync.heading')}>
        <h4>{t('coaching.sync.heading')}</h4>
        <Button onClick={handleDetectNewSkills}>{t('coaching.sync.detect')}</Button>
        {delta && delta.candidates.length > 0 ? (
          <div>
            <p>
              <small>{t('coaching.sync.intro')}</small>
            </p>
            <ul>
              {delta.candidates.map((c) => {
                const key = c.skill as unknown as string;
                const input = confirmInputs[key];
                if (!input) return null;
                return (
                  <li key={key} style={{ marginBottom: tokens.spacing.sm }}>
                    <label>
                      <input
                        type="checkbox"
                        checked={input.selected}
                        onChange={(e) => updateConfirm(key, { selected: e.target.checked })}
                      />{' '}
                      <TextField
                        label={t('coaching.sync.skillNameLabel')}
                        hideLabel
                        type="text"
                        value={input.name}
                        onChange={(e) => updateConfirm(key, { name: e.target.value })}
                      />
                    </label>{' '}
                    <TextField
                      label={t('coaching.sync.roleOrProject')}
                      hideLabel
                      type="text"
                      placeholder={t('coaching.sync.roleOrProject')}
                      value={input.roleOrProject}
                      onChange={(e) => updateConfirm(key, { roleOrProject: e.target.value })}
                    />{' '}
                    <TextField
                      label={t('coaching.sync.when')}
                      hideLabel
                      type="text"
                      placeholder={t('coaching.sync.when')}
                      value={input.when}
                      onChange={(e) => updateConfirm(key, { when: e.target.value })}
                    />
                  </li>
                );
              })}
            </ul>
            <Button onClick={handleApplySync}>{t('coaching.sync.apply')}</Button>
          </div>
        ) : null}
      </section>
    </section>
  );
}
