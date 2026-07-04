// React shell (@ui). This is the thin presentation boundary; all domain logic
// lives in @core and all external access goes through @adapters.
//
// Localisation wiring (R41.1, R41.2, R41.3, R41.8): on first use the shell
// detects the preferred language from the browser/OS locale and asks the user
// to CONFIRM or CHANGE it (it never silently applies — R41.2). On confirmation
// the choice is persisted to the Memory Store (`config/locale.md`) and applied
// to every string, which is read from the externalised resource files via
// i18next — there are no hardcoded user-facing strings here (R41.8).
//
// View management (R66.1, R66.7, R67.1, R69.4): the app uses state-driven view
// routing via an `AppView` discriminated union. Only one view renders at a time;
// `appView` determines which. Transitions: language → (welcome | resume) →
// settings/pipeline. The phase wizard's `goToPhase` drives `appView` transitions.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MemoryTree, CANONICAL_FILES } from '@core/storage';
import {
  applyLanguage,
  browserPreferredLocales,
  createI18n,
  detectSessionLanguage,
  loadLocaleConfig,
  saveConfirmedLocaleConfig,
  SUPPORTED_LANGUAGES,
  type I18n,
  type SessionLanguage,
} from '@core/locale';
import {
  createNetworkLabelChannel,
  grantTrainingConsent,
  loadConsentState,
  mayUseForTraining,
  revokeTrainingConsent,
  saveConsentState,
  type ConsentState,
} from '@core/privacy';
import type { NetworkOperationLabel } from '@core/egress';
import type { RedactProposal, PayloadPreview } from '@core/egress';
import { asISODate, type ExtractedItem, type RolePreference, type TalkingPoint } from '@core/types';
import { IdRegistry } from '@core/registry';
import type { Phase } from '@core/orchestrator';
import { generate, loadSkillMap, type SkillMap } from '@core/skills';
import {
  loadAssistMode,
  saveAssistMode,
  type AssistMode,
} from '@core/assist';
import { parseRawExtractions, parseRawDocuments } from '@core/ingestion';
import { parseRolePreferences } from '@core/role-matcher';
import { parseInterview, interviewFilePath } from '@core/interview';
import { listAvailableProviders, type AvailableProvider } from './provider-availability';
import { IngestScreen } from './IngestScreen';
import { SkillMapScreen } from './SkillMapScreen';
import { RoleDiscoveryScreen } from './RoleDiscoveryScreen';
import { CoachingScreen } from './CoachingScreen';
import { OutputScreen } from './OutputScreen';
import { MemoryScreen } from './MemoryScreen';
import { SourceTraceInspector } from './SourceTraceInspector';
import { WelcomePage } from './WelcomePage';
import { ResumeScreen } from './ResumeScreen';
import { createCareerAgentRuntime, type CareerAgentRuntime } from './runtime';
import { SESSION_STATE_PATH } from './phase-wizard-controller';
import { PayloadPreviewModal } from './PayloadPreviewModal';
import { SettingsPage } from './SettingsPage';
import { AppShell } from './AppShell';
import { ResponsiveContainer, Button, Select } from './design-system';

// ---------------------------------------------------------------------------
// App-level view management (R66.1, R66.7, R67.1, R69.4).
// A discriminated union drives top-level rendering: only one view at a time.
// ---------------------------------------------------------------------------
export type AppView =
  | { kind: 'language' }
  | { kind: 'welcome' }
  | { kind: 'resume' }
  | { kind: 'settings'; firstRun?: boolean }
  | { kind: 'pipeline'; phase: Phase };

export default function App() {
  // The canonical Memory Store this session reads/writes (config/locale.md, …).
  const store = useMemo(() => new MemoryTree(), []);

  // The current top-level view — drives which single card/screen renders.
  const [appView, setAppView] = useState<AppView>({ kind: 'language' });

  const [i18n, setI18n] = useState<I18n | null>(null);
  const [language, setLanguage] = useState<SessionLanguage>('en');
  // Whether the Session Language has been confirmed + persisted (R41.2/R41.3).
  const [confirmed, setConfirmed] = useState(false);
  // The pending selection shown in the confirmation step before the user acts.
  const [pending, setPending] = useState<SessionLanguage>('en');

  // The single channel the UI subscribes to for third-party network-operation
  // labels (R7.3). Wire `channel.notify` into the Egress Gate's `notifyLabel`
  // so every gated call surfaces here before it runs (task 19.2 completes the
  // inspector wiring).
  const labelChannel = useMemo(() => createNetworkLabelChannel(), []);
  const [networkLabels, setNetworkLabels] = useState<readonly NetworkOperationLabel[]>([]);

  // Pending Outbound Payload Preview (R65): when the Egress Gate is about to send
  // a text payload to a third-party provider it calls `previewPayload`, which the
  // shell fulfils by opening the modal below and parking the gate's promise here
  // until the user approves (resolve the edited text) or cancels (resolve null →
  // gate fails closed, R65.4).
  const [pendingPreview, setPendingPreview] = useState<{
    readonly preview: PayloadPreview;
    readonly resolve: (value: string | null) => void;
  } | null>(null);
  // A stable prompt function so the runtime (built once) keeps a constant
  // `previewPayload` reference while always driving the latest shell state. The
  // setter is stable, so this initial closure stays valid for the session.
  const previewPromptRef = useRef<(preview: PayloadPreview) => Promise<string | null>>(
    (preview) =>
      new Promise<string | null>((resolve) => {
        setPendingPreview({ preview, resolve });
      }),
  );

  // The wired runtime: the XState orchestrator behind the single Egress Gate,
  // plus the phase-wizard controller that drives it (task 19.1). Built once for
  // this session's Memory Store and label channel. The UI reaches a provider
  // only through this orchestrator → Egress Gate path (Requirements 6, 7).
  const runtime = useMemo<CareerAgentRuntime>(
    () =>
      createCareerAgentRuntime({
        store,
        labelChannel,
        // Redact-and-proceed prompt on PII detection (R6.3). Fail-closed: an
        // unanswered/declined prompt transmits nothing.
        confirmRedactAndProceed: (proposal: RedactProposal) =>
          typeof window !== 'undefined' && typeof window.confirm === 'function'
            ? window.confirm(
                `Detected ${proposal.detectionCount} high-risk value(s) ` +
                  `(${proposal.categories.join(', ')}). Redact and proceed?`,
              )
            : false,
        // Outbound Payload Preview before a third-party send (R65). Delegates to
        // the stable ref so the runtime is built once yet always opens the modal
        // against current shell state.
        previewPayload: (preview: PayloadPreview) => previewPromptRef.current(preview),
      }),
    [store, labelChannel],
  );

  // Informed-consent decision for model training/improvement (R42.1). Defaults
  // to NOT consented; the persisted decision (if any) is loaded on mount.
  const [consent, setConsent] = useState<ConsentState>(() => loadConsentState(store));

  // The pipeline-wide AI-assist mode (script-only / ai-assisted / ai-only),
  // chosen ONCE up front (on Ingest, before saving) and persisted to the Memory
  // Store so it survives reload/resume/import and is applied as the default on
  // every phase. Changing it on any screen updates this single source of truth.
  const [assistMode, setAssistModeState] = useState<AssistMode>(() => loadAssistMode(store));
  const handleAssistMode = useCallback(
    (mode: AssistMode) => {
      setAssistModeState(mode);
      void saveAssistMode(store, mode);
    },
    [store],
  );

  // Shared session pipeline state flowing across phases: ingest → skill map →
  // role discovery → coaching → output. Kept in the shell so each phase screen
  // consumes the previous phase's confirmed output.
  const [extractions, setExtractions] = useState<ExtractedItem[]>([]);
  // Raw full text per ingested document. Persisted to the user-owned Memory
  // Store (`profile/raw_documents.md`) so whole-document local-only AI skill
  // discovery survives reload/resume/Memory import (R47.1/R47.5/R49). The
  // Memory Store never leaves the device (R7.1) and this text is only ever read
  // by the keyless local discovery path — never sent to a cloud provider.
  const [rawDocs, setRawDocs] = useState<{ doc: string; text: string }[]>([]);
  const [skillMap, setSkillMap] = useState<SkillMap | null>(null);
  const [rolePrefs, setRolePrefs] = useState<RolePreference[]>([]);
  const [talkingPoints, setTalkingPoints] = useState<TalkingPoint[]>([]);
  // Stable STAR/BULLET id allocator shared across the session (R23.1, R18.4).
  const idRegistry = useMemo(() => new IdRegistry(), []);
  // Bumped to force a re-render after an in-place Memory Store mutation (import).
  const [, forceStoreRender] = useState(0);

  // Save & Exit: export the entire Memory Store as a JSON snapshot download
  // (R68.3). Same logic as MemoryScreen's export action — triggers a browser
  // download without closing the window (browser security prevents that).
  const handleSaveExit = useCallback(() => {
    const json = JSON.stringify(store.snapshot(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'career-agent-memory-store.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [store]);

  // Per-capability provider selection (R44): the user chooses the chat/LLM
  // provider and the speech-to-text provider INDEPENDENTLY. Each capability
  // tracks the providers currently available to select (a keyed provider with a
  // stored key, or the keyless Local Provider once configured) and the user's
  // current choice. A `null` choice means no provider is available for that
  // capability yet, so that capability is simply not offered. Availability is
  // recomputed whenever a key changes or the local config is tested
  // (`keysVersion`, bumped by ProviderSetup's `onKeysChanged`).
  const [chatProviders, setChatProviders] = useState<readonly AvailableProvider[]>([]);
  const [sttProviders, setSttProviders] = useState<readonly AvailableProvider[]>([]);
  const [chatProvider, setChatProvider] = useState<string | null>(null);
  const [sttProvider, setSttProvider] = useState<string | null>(null);
  const [keysVersion, setKeysVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [chat, stt] = await Promise.all([
        listAvailableProviders(runtime.providerManager, runtime.keyVault, 'chat'),
        listAvailableProviders(runtime.providerManager, runtime.keyVault, 'stt'),
      ]);
      if (cancelled) return;
      setChatProviders(chat);
      setSttProviders(stt);
      // Keep the user's explicit choice when it is still available; otherwise
      // default to the first available provider for that capability, or null.
      setChatProvider((prev) =>
        prev && chat.some((p) => p.id === prev) ? prev : (chat[0]?.id ?? null),
      );
      setSttProvider((prev) =>
        prev && stt.some((p) => p.id === prev) ? prev : (stt[0]?.id ?? null),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [runtime, keysVersion, confirmed]);

  // Surface every third-party network label the Egress Gate emits (R7.3).
  useEffect(() => labelChannel.subscribe(() => setNetworkLabels(labelChannel.labels())), [
    labelChannel,
  ]);

  // Whether every selected capability provider is a keyless Local Provider
  // running on the user's own device (R1.5). True only when at least one
  // provider is selected AND every selected provider (the chat provider and,
  // when set, the STT provider) is flagged `keyless` in the registry. If no
  // provider is selected yet, this is false so the cloud/not-fully-offline
  // privacy statement is shown by default (R1.4). The keyless flag is read from
  // the descriptor, never a hardcoded id.
  const allLocal = useMemo(() => {
    const selected = [chatProvider, sttProvider].filter(
      (p): p is string => p !== null,
    );
    if (selected.length === 0) return false;
    let descriptors: { id: string; keyless?: boolean }[];
    try {
      descriptors = runtime.providerManager.listProviders();
    } catch {
      return false;
    }
    const keyless = new Set(descriptors.filter((d) => d.keyless).map((d) => d.id));
    return selected.every((id) => keyless.has(id));
  }, [chatProvider, sttProvider, runtime, keysVersion]);

  // Whether the chosen CHAT provider specifically is a keyless local on-device
  // provider (R7.6). Skill discovery uses this to decide whether the full
  // corpus — including private items — may be sent: yes for a local on-device
  // call (no third-party egress), no for a cloud provider (R46.4).
  const chatIsLocal = useMemo(() => {
    if (!chatProvider) return false;
    try {
      const descriptor = runtime.providerManager
        .listProviders()
        .find((d) => d.id === chatProvider);
      return descriptor?.keyless === true;
    } catch {
      return false;
    }
  }, [chatProvider, runtime, keysVersion]);

  // The skill map downstream phases (Role Discovery, Coaching, Output) operate
  // on. Prefer an explicitly generated/edited/loaded skill map; otherwise derive
  // one deterministically from the confirmed extracted items so a user who built
  // their skills via AI-only (and never clicked "Generate skill map") is not
  // blocked downstream. `null` only when there is neither a map nor any
  // extracted items yet.
  const effectiveSkillMap = useMemo<SkillMap | null>(
    () => skillMap ?? (extractions.length > 0 ? generate(extractions) : null),
    [skillMap, extractions],
  );

  // Once the Session Language is confirmed, load the resume summary and continue
  // from the user's last phase (R35.1). Dispose the controller on teardown.
  useEffect(() => {
    if (!confirmed) {
      return;
    }
    void runtime.controller.resume();
    return () => runtime.controller.dispose();
  }, [confirmed, runtime]);

  // Rehydrate the in-memory pipeline from the Memory Store (R35.1). Reads the
  // confirmed skill map, role preferences, and the machine-readable extractions
  // block so a returning session continues with its data, and a Memory import
  // restores the working pipeline. Degrades gracefully when a file is absent.
  const hydrateFromStore = useCallback(() => {
    try {
      // Reapply the persisted pipeline-wide AI-assist preference (R34.1).
      setAssistModeState(loadAssistMode(store));
      if (store.has(CANONICAL_FILES.rawExtractions)) {
        const items = parseRawExtractions(store.readText(CANONICAL_FILES.rawExtractions));
        if (items.length > 0) setExtractions(items);
      }
      // Restore the persisted raw document text so whole-document local AI skill
      // discovery works after resume AND Memory import (R47.1/R47.5/R49). It is
      // a normal Memory Store file, so it is already carried by the fallback-tier
      // zip export/import automatically — nothing extra is needed here.
      if (store.has(CANONICAL_FILES.rawDocuments)) {
        const docs = parseRawDocuments(store.readText(CANONICAL_FILES.rawDocuments));
        if (docs.length > 0) setRawDocs(docs.map((d) => ({ doc: d.doc, text: d.text })));
      }
      if (store.has(CANONICAL_FILES.skillMap)) {
        setSkillMap(loadSkillMap(store.readText(CANONICAL_FILES.skillMap)));
      }
      let prefs: RolePreference[] = [];
      if (store.has(CANONICAL_FILES.rolePreferences)) {
        prefs = parseRolePreferences(store.readText(CANONICAL_FILES.rolePreferences));
        setRolePrefs(prefs);
      }
      // Confirmed talking points live in each role's interview file (R28.4).
      const restored: TalkingPoint[] = [];
      for (const pref of prefs) {
        const path = interviewFilePath(pref.slug);
        if (!store.has(path)) continue;
        const file = parseInterview(store.readText(path));
        for (const tp of file.talkingPoints ?? []) restored.push(tp);
      }
      if (restored.length > 0) setTalkingPoints(restored);
    } catch (error) {
      console.error('Failed to rehydrate session from the Memory Store', error);
    }
  }, [store]);

  // Hydrate once when the Session Language is confirmed (a returning session).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!confirmed || hydratedRef.current) return;
    hydratedRef.current = true;
    hydrateFromStore();
  }, [confirmed, hydrateFromStore]);

  // First-use detection (R41.2): load any persisted choice, else propose the
  // detected language for the user to confirm/change. Detection never applies.
  useEffect(() => {
    let cancelled = false;
    const persisted = loadLocaleConfig(store);
    const initial = persisted?.sessionLanguage ?? detectSessionLanguage(browserPreferredLocales());

    void createI18n(initial).then((instance) => {
      if (cancelled) return;
      setI18n(instance);
      setLanguage(initial);
      setPending(initial);
      // A previously persisted profile is already confirmed; a first-use
      // profile must pass through the confirmation step (R41.2).
      const isReturning = persisted !== undefined;
      setConfirmed(isReturning);
      // Set initial view: if already confirmed (returning session), determine
      // whether we have persisted pipeline data (→ resume) or not (→ welcome).
      // If not yet confirmed, stay on the language screen.
      if (isReturning) {
        const hasSession = store.has(SESSION_STATE_PATH);
        setAppView(hasSession ? { kind: 'resume' } : { kind: 'welcome' });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [store]);

  if (!i18n) {
    return <main aria-busy="true" />;
  }

  const t = i18n.t.bind(i18n);

  // Opt-in AI assist (R42.1): route the prompt through the orchestrator → Egress
  // Gate ONLY (Requirements 6, 7), so it is PII pre-screened, labelled (local
  // on-device vs third-party), and addressed only to the user's chosen CHAT
  // provider (R44.2). The no-training preference is derived from the consent
  // state. Each caller decides its own corpus: for a CLOUD provider, callers
  // pass NON-private content only (R46.4); for a keyless LOCAL on-device
  // provider (no third-party egress, R7.6) a caller may include private content,
  // since nothing leaves the device.
  const aiAvailable = chatProvider !== null;
  const aiAssist = async (prompt: string): Promise<string> => {
    if (!chatProvider) {
      throw new Error('No AI provider is configured.');
    }
    // Apply the confirmed Session Language to every AI prompt (R41.3): the core
    // prompt builders are language-neutral, so we append a directive telling the
    // model to answer in the active language. Without this the model defaults to
    // English even when the UI is in pt-BR. Technical terms/proper nouns are
    // preserved verbatim per the directive (R41.6).
    const localizedPrompt = `${prompt}\n\n${t('assist.languageDirective')}`;
    const response = await runtime.agent.requestProvider({
      provider: chatProvider,
      text: localizedPrompt,
      operation: 'llm-chat',
      noTraining: !mayUseForTraining(consent),
    });
    return (response as { text?: string }).text ?? '';
  };

  // Render the working UI for the active pipeline phase inside the wizard.
  const renderPhase = (phase: Phase) => {
    switch (phase) {
      case 'ingest':
        return (
          <IngestScreen
            engine={runtime.ingestionEngine}
            store={store}
            locale={language}
            items={extractions}
            onItemsChange={setExtractions}
            rawDocs={rawDocs}
            onRawDocsChange={setRawDocs}
            scanner={runtime.scanner}
            destinationKind={chatIsLocal ? 'keyless-local' : 'keyed-cloud'}
            assistMode={assistMode}
            onAssistMode={handleAssistMode}
            aiAvailable={aiAvailable}
            chatProvider={chatProvider}
            chatIsLocal={chatIsLocal}
            t={t}
          />
        );
      case 'skill-map':
        return (
          <SkillMapScreen
            extractions={extractions}
            skillMap={skillMap}
            onSkillMap={setSkillMap}
            onAddExtractions={(added) => setExtractions([...extractions, ...added])}
            store={store}
            aiAvailable={aiAvailable}
            aiAssist={aiAssist}
            chatProvider={chatProvider}
            chatIsLocal={chatIsLocal}
            rawDocs={rawDocs}
            assistMode={assistMode}
            onAssistMode={handleAssistMode}
            t={t}
          />
        );
      case 'role-discovery':
        return (
          <RoleDiscoveryScreen
            skillMap={skillMap}
            extractions={extractions}
            rolePrefs={rolePrefs}
            onRolePrefs={setRolePrefs}
            store={store}
            aiAvailable={aiAvailable}
            aiAssist={aiAssist}
            chatProvider={chatProvider}
            chatIsLocal={chatIsLocal}
            assistMode={assistMode}
            onAssistMode={handleAssistMode}
            t={t}
          />
        );
      case 'interview-coaching':
        return (
          <CoachingScreen
            skillMap={effectiveSkillMap}
            onSkillMap={setSkillMap}
            rolePrefs={rolePrefs}
            talkingPoints={talkingPoints}
            onTalkingPoints={setTalkingPoints}
            idRegistry={idRegistry}
            store={store}
            egressGate={runtime.egressGate}
            sttProvider={sttProvider}
            aiAvailable={aiAvailable}
            aiAssist={aiAssist}
            chatProvider={chatProvider}
            chatIsLocal={chatIsLocal}
            assistMode={assistMode}
            onAssistMode={handleAssistMode}
            t={t}
          />
        );
      case 'output':
        return (
          <OutputScreen
            skillMap={effectiveSkillMap}
            rolePrefs={rolePrefs}
            talkingPoints={talkingPoints}
            extractions={extractions}
            store={store}
            pdfCompiler={runtime.pdfCompiler}
            aiAvailable={aiAvailable}
            aiAssist={aiAssist}
            chatProvider={chatProvider}
            chatIsLocal={chatIsLocal}
            assistMode={assistMode}
            onAssistMode={handleAssistMode}
            t={t}
          />
        );
      case 'memory':
        return (
          <MemoryScreen
            store={store}
            onChanged={() => {
              forceStoreRender((n) => n + 1);
              hydrateFromStore();
            }}
            t={t}
          />
        );
      default:
        return null;
    }
  };

  // Confirm or change the detected language (R41.2), then persist + apply.
  // After confirmation, transition the view: first-run → welcome; returning → resume.
  const handleConfirm = async (choice: SessionLanguage) => {
    await saveConfirmedLocaleConfig(store, { sessionLanguage: choice }, true);
    await applyLanguage(i18n, choice);
    setLanguage(choice);
    setConfirmed(true);
    // After language confirmation, determine next view:
    const hasSession = store.has(SESSION_STATE_PATH);
    setAppView(hasSession ? { kind: 'resume' } : { kind: 'welcome' });
  };

  // Record + persist an explicit consent decision for training/improvement use
  // (R42.1). Both branches write to the Memory Store so the choice survives a
  // reload; consent is never enabled without this explicit action.
  const handleGrantConsent = async () => {
    const next = grantTrainingConsent(asISODate(new Date().toISOString()));
    setConsent(next);
    await saveConsentState(store, next);
  };
  const handleRevokeConsent = async () => {
    const next = revokeTrainingConsent(asISODate(new Date().toISOString()));
    setConsent(next);
    await saveConsentState(store, next);
  };

  if (!confirmed || appView.kind === 'language') {
    const detectedName = t(`language.names.${pending}`);
    return (
      <ResponsiveContainer>
        <main>
          <h1>{t('language.settingsHeading')}</h1>
          <p>{t('language.detectedPrompt', { language: detectedName })}</p>
          <Select
            label={t('language.choosePrompt')}
            value={pending}
            onChange={(e) => setPending(e.target.value as SessionLanguage)}
          >
            {SUPPORTED_LANGUAGES.map((lng) => (
              <option key={lng} value={lng}>
                {t(`language.names.${lng}`)}
              </option>
            ))}
          </Select>{' '}
          <Button
            onClick={() =>
              void handleConfirm(pending).catch((error) => {
                // Surface failures instead of silently doing nothing (a swallowed
                // rejection here is what makes a broken confirm look like a no-op).
                console.error('Failed to confirm Session Language', error);
              })
            }
          >
            {t('language.confirm')}
          </Button>
        </main>
      </ResponsiveContainer>
    );
  }

  // -------------------------------------------------------------------------
  // View-driven rendering (R66.1): only one view renders at a time.
  // -------------------------------------------------------------------------

  // Helper: navigate to a pipeline phase (updates both the controller and appView).
  const goToPipelinePhase = (phase: Phase) => {
    void runtime.controller.goToPhase(phase);
    setAppView({ kind: 'pipeline', phase });
  };

  // Welcome page (first-run only, task 33.4 — R66.1–R66.8).
  if (appView.kind === 'welcome') {
    return (
      <WelcomePage t={t} onGetStarted={() => setAppView({ kind: 'settings', firstRun: true })} />
    );
  }

  // Resume screen (task 33.5; R69.1–R69.5).
  if (appView.kind === 'resume') {
    return (
      <ResumeScreen
        t={t}
        currentPhase={runtime.controller.currentPhase()}
        outstanding={runtime.controller.outstanding()}
        onContinue={() => goToPipelinePhase(runtime.controller.currentPhase())}
        onGoToSettings={() => setAppView({ kind: 'settings' })}
        onStartFresh={() => {
          store.deleteAll();
          setAppView({ kind: 'welcome' });
        }}
      />
    );
  }

  // Settings view: dedicated SettingsPage component (task 33.6, R67.4).
  if (appView.kind === 'settings') {
    const isFirstRun = appView.firstRun === true;
    return (
      <SettingsPage
        t={t}
        language={language}
        onLanguageChange={(lang) => {
          void (async () => {
            await applyLanguage(i18n, lang);
            setLanguage(lang);
            await saveConfirmedLocaleConfig(store, { sessionLanguage: lang }, true);
          })();
        }}
        providerSetupProps={{
          providerManager: runtime.providerManager,
          keyVault: runtime.keyVault,
          locale: language,
          onKeysChanged: () => setKeysVersion((v) => v + 1),
          t,
        }}
        providerSelectionProps={{
          chatProviders,
          sttProviders,
          chatProvider,
          sttProvider,
          onChatProvider: setChatProvider,
          onSttProvider: setSttProvider,
          t,
        }}
        privacyProps={{
          t,
          consent,
          onGrantConsent: () => void handleGrantConsent(),
          onRevokeConsent: () => void handleRevokeConsent(),
          networkLabels,
          allLocal,
        }}
        onBackToPipeline={() => goToPipelinePhase(isFirstRun ? 'ingest' : runtime.controller.currentPhase())}
        backLabel={isFirstRun ? t('views.settings.continueToIngest') : undefined}
        pendingPreview={
          pendingPreview ? (
            <PayloadPreviewModal
              preview={pendingPreview.preview}
              onApprove={(text) => {
                pendingPreview.resolve(text);
                setPendingPreview(null);
              }}
              onCancel={() => {
                pendingPreview.resolve(null);
                setPendingPreview(null);
              }}
              t={t}
            />
          ) : undefined
        }
      />
    );
  }

  // Pipeline view: one phase card at a time inside the AppShell (sidebar + main).
  const currentPhase = appView.kind === 'pipeline' ? appView.phase : runtime.controller.currentPhase();

  // Phase-specific "next" action label and target (R67.6).
  const phaseNextLabel: Record<string, string> = {
    ingest: t('views.pipeline.saveAndSkillMap'),
    'skill-map': t('views.pipeline.saveAndRoles'),
    'role-discovery': t('views.pipeline.saveAndCoaching'),
    'interview-coaching': t('views.pipeline.saveAndOutput'),
    output: t('views.pipeline.saveToMemory'),
  };

  const nextPhaseId = (() => {
    const seq: Phase[] = ['ingest', 'skill-map', 'role-discovery', 'interview-coaching', 'output', 'memory'];
    const idx = seq.indexOf(currentPhase);
    return idx >= 0 && idx < seq.length - 1 ? seq[idx + 1] : null;
  })();

  return (
    <AppShell
      phases={runtime.controller.phases()}
      currentPhase={currentPhase}
      onPhaseSelect={goToPipelinePhase}
      onGoToSettings={() => setAppView({ kind: 'settings' })}
      onSaveExit={handleSaveExit}
      saveStatus={t('saveStatus.saved')}
      t={t}
    >
      {renderPhase(currentPhase)}

      {/* Phase-specific "next step" action (R67.6) — shown for all phases except Memory */}
      {nextPhaseId && (
        <div style={{ marginTop: '1.5rem', paddingTop: '1rem', borderTop: '1px solid #e2e5e9' }}>
          <button
            type="button"
            onClick={() => {
              void runtime.controller.confirmStep();
              goToPipelinePhase(nextPhaseId);
            }}
            style={{
              padding: '0.75rem 1.5rem',
              fontSize: '1rem',
              fontWeight: 'bold',
              background: '#0b5cad',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              width: '100%',
            }}
          >
            {phaseNextLabel[currentPhase] ?? t('wizard.confirmAndContinue')} →
          </button>
        </div>
      )}

      {/* Source-trace inspector: only shown on Output and Memory phases where
          confirmed claims exist to inspect (R38.2). Hidden during earlier phases
          where it would confuse users. */}
      {(currentPhase === 'output' || currentPhase === 'memory') && (
        <SourceTraceInspector lookup={runtime.traceLookup} t={t} />
      )}

      {pendingPreview && (
        <PayloadPreviewModal
          preview={pendingPreview.preview}
          onApprove={(text) => {
            pendingPreview.resolve(text);
            setPendingPreview(null);
          }}
          onCancel={() => {
            pendingPreview.resolve(null);
            setPendingPreview(null);
          }}
          t={t}
        />
      )}
    </AppShell>
  );
}
