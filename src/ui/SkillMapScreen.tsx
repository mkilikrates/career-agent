// Skill Map screen (@ui) — Phase 2 (R14–R19), on the shared design system.
//
// Generates the evidence-backed skill map from the confirmed extractions, shows
// each skill with its category, evidence-based proficiency signal, and evidence
// trail, and persists the confirmed map to `profile/skill_map.md` (R14.4). Pure
// engine calls (`@core/skills`) — no provider is touched here; AI suggestions go
// through the Egress Gate via the injected `aiAssist`.
//
// Built from the shared component library + screen-state primitives so its
// controls inherit the design tokens, keyboard operability, focus indicator
// (R58.1, R58.4, R58.10), and its empty/loading/error states match every other
// screen (R58.6, R58.7, R58.8). No typography/colour/spacing is hardcoded.

import { useMemo, useState } from 'react';
import {
  asDocId,
  asISODate,
  asItemId,
  type ExtractedItem,
} from '@core/types';
import { trailOf, userConfirmation } from '@core/provenance';
import { MemoryTree } from '@core/storage';
import {
  generate,
  saveSkillMap,
  createSkillDiscoveryOperation,
  type SkillMap,
} from '@core/skills';
import { runAssist, type AssistMode, type EgressDestination } from '@core/assist';
import { AssistChoice } from './AssistChoice';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  LoadingIndicator,
  Stack,
  TextArea,
  tokens,
} from './design-system';

export interface SkillMapScreenProps {
  readonly extractions: ExtractedItem[];
  readonly skillMap: SkillMap | null;
  readonly onSkillMap: (map: SkillMap) => void;
  /** Append user-confirmed items (e.g. AI-suggested, user-accepted skills). */
  readonly onAddExtractions: (added: ExtractedItem[]) => void;
  readonly store: MemoryTree;
  /** Whether an AI provider key is configured (opt-in assist, R42.1). */
  readonly aiAvailable: boolean;
  /** Routes a prompt through the Egress Gate; returns the model's text. */
  readonly aiAssist: (prompt: string) => Promise<string>;
  /** The chosen chat provider id for the destination label, or null. */
  readonly chatProvider?: string | null;
  /**
   * Whether the chosen CHAT provider is a keyless local on-device provider
   * (R7.6). When true, AI skill discovery sends the FULL corpus — including
   * private items — because the call never leaves the device (R46.4 scopes the
   * private-item exclusion to third-party/cloud providers). When false (cloud),
   * private items are excluded and the Egress Gate PII-screens before sending.
   */
  readonly chatIsLocal?: boolean;
  /**
   * The raw full text of each ingested document (PDF/Markdown/plain text),
   * retained in-session from ingestion. When the chat provider is a keyless
   * local on-device provider, AI skill discovery reads this WHOLE-document text
   * — so the model finds skills the structured extractor missed — instead of
   * the parsed items (R47.1/R47.5). Never sent to a cloud provider, since raw
   * text has no per-item private flag (R46.4). Absent after a fresh resume (raw
   * text is not persisted), in which case discovery falls back to the items.
   */
  readonly rawDocs?: ReadonlyArray<{ readonly doc: string; readonly text: string }>;
  /** The pipeline-wide AI-assist mode (chosen up front, applied as default). */
  readonly assistMode: AssistMode;
  /** Change the pipeline-wide AI-assist mode (persisted by the shell). */
  readonly onAssistMode: (mode: AssistMode) => void;
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}

const AI_DOC = asDocId('ai-suggested.md');
/** Source doc for skills the user typed in by hand (always kept, any mode). */
const USER_DOC = asDocId('user-added.md');

/** Split a comma- or newline-separated list into trimmed, de-duped entries. */
const parseList = (text: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
};

export function SkillMapScreen({
  extractions,
  skillMap,
  onSkillMap,
  onAddExtractions,
  store,
  aiAvailable,
  aiAssist,
  chatProvider = null,
  chatIsLocal = false,
  rawDocs = [],
  assistMode,
  onAssistMode,
  t,
}: SkillMapScreenProps) {
  const [status, setStatus] = useState<string>('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([]);
  const [aiSelected, setAiSelected] = useState<Set<string>>(new Set());
  const [aiError, setAiError] = useState<string>('');
  // Free-text skills the user adds by hand (comma- or newline-separated). The
  // user is ultimately responsible for the list, so these are always included.
  const [manualText, setManualText] = useState<string>('');

  // The skill-discovery operation, bound to a gate-routed transport: every
  // prompt goes through the Egress Gate via `aiAssist` (PII screening, labelling,
  // chosen-provider-only). scriptOnly never reaches it (zero provider calls).
  const operation = useMemo(
    () => createSkillDiscoveryOperation((prompt) => aiAssist(prompt)),
    [aiAssist],
  );

  const handleGenerate = () => {
    // The reviewed list that feeds the map depends on the discovery mode:
    //   - script-only → only deterministically-extracted (non-AI) items;
    //   - ai-only     → only the AI-discovered, user-confirmed skills (purely
    //                   what the AI returned);
    //   - both        → the AI-reviewed/refined skills (which the model derived
    //                   from the parser's detections); falls back to the script
    //                   items if the AI review has not been run/accepted yet.
    // AI-discovered items are tagged with the AI source doc, so the split is a
    // simple, deterministic filter (no core change).
    const isAi = (it: ExtractedItem): boolean =>
      (it.sourceDoc as unknown as string) === (AI_DOC as unknown as string);
    const isUser = (it: ExtractedItem): boolean =>
      (it.sourceDoc as unknown as string) === (USER_DOC as unknown as string);
    const aiItems = extractions.filter(isAi);
    const scriptItems = extractions.filter((it) => !isAi(it) && !isUser(it));
    const userItems = extractions.filter(isUser);
    const base =
      assistMode === 'ai-only'
        ? aiItems
        : assistMode === 'script-only'
          ? scriptItems
          : aiItems.length > 0
            ? aiItems
            : scriptItems;
    // User-typed skills are always included, whatever the discovery mode — the
    // user owns the final list.
    const map = generate([...base, ...userItems]);
    onSkillMap(map);
    setStatus(t('skillMap.generated', { count: map.entries.length }));
  };

  const handleSave = async () => {
    if (!skillMap) return;
    try {
      await saveSkillMap(store, skillMap);
      store.logConfirmation(`Saved skill map (${skillMap.entries.length} skills).`);
      setStatus(t('skillMap.saved'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const handleAiSuggest = async () => {
    setAiBusy(true);
    setAiError('');
    setAiSuggestions([]);
    // The destination scopes private-item handling: a keyless local on-device
    // provider may read whole documents (nothing leaves the device, R47.1); a
    // cloud provider gets structured non-private items only (R46.4).
    const dest: EgressDestination | null = chatProvider
      ? { provider: chatProvider, kind: chatIsLocal ? 'keyless-local' : 'keyed-cloud' }
      : null;
    const rawTexts = rawDocs.map((d) => d.text).filter((tx) => tx.trim().length > 0);
    try {
      // runAssist branches on the mode: script-only never constructs an Egress
      // request; ai-assisted computes the baseline then routes supplements
      // through the gate, falling back to the baseline on provider failure.
      const { outcome, error } = await runAssist(
        operation,
        { extractions, existingMap: skillMap, rawTexts, review: assistMode === 'ai-assisted' },
        { mode: assistMode, capability: 'skill_discovery' },
        dest ?? undefined,
      );
      const found = outcome.suggestions.map((s) => s.value);
      setAiSuggestions(found);
      // Pre-select every returned candidate: in "AI only" the model is the sole
      // discoverer and in "Both" it has already reviewed/refined the parser's
      // list, so the returned set is the curated candidate list to keep.
      setAiSelected(new Set(found));
      if (error) {
        setAiError(t('assist.fallback', { reason: error.message }));
      } else if (found.length === 0) {
        setAiError(t('skillMap.ai.none'));
      }
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setAiBusy(false);
    }
  };

  const toggleSuggestion = (name: string) =>
    setAiSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const handleAddSelected = () => {
    const at = asISODate(new Date().toISOString());
    const added: ExtractedItem[] = [...aiSelected].map((name) => ({
      id: asItemId(`ai-suggested.md#skill-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`),
      type: 'skill',
      fields: { name },
      confidence: 'High',
      // User explicitly confirms each AI suggestion → user-confirmation
      // provenance, never a fabricated source (No-Fabrication / R12.4, R38.1).
      provenance: trailOf(userConfirmation(at, 'User confirmed an AI-suggested skill.')),
      userConfirmed: true,
      private: false,
      sourceDoc: AI_DOC,
    }));
    onAddExtractions(added);
    setStatus(t('skillMap.ai.added', { count: added.length }));
    setAiSuggestions([]);
    setAiSelected(new Set());
  };

  const handleAddManual = () => {
    const names = parseList(manualText);
    if (names.length === 0) return;
    const at = asISODate(new Date().toISOString());
    const added: ExtractedItem[] = names.map((name) => ({
      id: asItemId(`user-added.md#skill-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`),
      type: 'skill',
      fields: { name },
      confidence: 'High',
      // The user typed these in, so they carry user-confirmation provenance and
      // are always kept regardless of the discovery mode.
      provenance: trailOf(userConfirmation(at, 'User added a skill manually.')),
      userConfirmed: true,
      private: false,
      sourceDoc: USER_DOC,
    }));
    onAddExtractions(added);
    setStatus(t('skillMap.manual.added', { count: added.length }));
    setManualText('');
  };

  return (
    <section aria-label={t('skillMap.heading')} data-skill-map-screen>
      <h3>{t('skillMap.heading')}</h3>
      <p>{t('skillMap.intro')}</p>

      {/* Empty state names the next action: ingest documents first (R58.6). */}
      {extractions.length === 0 ? (
        <EmptyState message={t('skillMap.needExtractions')} />
      ) : (
        <>
          {/* Step 1 — DISCOVER. Choose how skills are found (script / AI / both)
              and run AI discovery, BEFORE finalising. The AI-discovered skills
              are reviewed and selected here. */}
          <Stack gap="sm" style={{ marginTop: tokens.spacing.sm, marginBottom: tokens.spacing.sm }}>
            <AssistChoice
              mode={assistMode}
              onMode={onAssistMode}
              aiAvailable={aiAvailable}
              provider={chatProvider}
              destinationKind={chatIsLocal ? 'keyless-local' : 'keyed-cloud'}
              t={t}
            />
            {aiAvailable && assistMode !== 'script-only' ? (
              <div>
                <Button onClick={() => void handleAiSuggest()} disabled={aiBusy}>
                  {aiBusy ? t('skillMap.ai.working') : t('skillMap.ai.suggest')}
                </Button>
              </div>
            ) : null}
          </Stack>

          {/* Loading indicator shown within 1s of the AI call starting (R58.7). */}
          {aiBusy ? <LoadingIndicator message={t('skillMap.ai.working')} /> : null}

          {aiError ? (
            <Banner role="status">
              <small>{aiError}</small>
            </Banner>
          ) : null}

          {aiSuggestions.length > 0 ? (
            <Card style={{ marginTop: tokens.spacing.sm }}>
              <h4>{t('skillMap.ai.suggestionsHeading')}</h4>
              <ul>
                {aiSuggestions.map((name) => (
                  <li key={name}>
                    <label>
                      <input
                        type="checkbox"
                        checked={aiSelected.has(name)}
                        onChange={() => toggleSuggestion(name)}
                      />{' '}
                      {name}
                    </label>
                  </li>
                ))}
              </ul>
              <Button onClick={handleAddSelected} disabled={aiSelected.size === 0}>
                {t('skillMap.ai.add')}
              </Button>
            </Card>
          ) : null}

          {/* Add-your-own: the user owns the final list, so they can type any
              skills (comma- or newline-separated) to include before finalising. */}
          <div style={{ marginTop: tokens.spacing.sm }}>
            <TextArea
              label={t('skillMap.manual.label')}
              value={manualText}
              rows={3}
              placeholder={t('skillMap.manual.placeholder')}
              onChange={(e) => setManualText(e.target.value)}
            />
            <Button
              variant="secondary"
              onClick={handleAddManual}
              disabled={manualText.trim().length === 0}
            >
              {t('skillMap.manual.add')}
            </Button>
          </div>

          {/* Step 2 — FINALISE. Build the reviewed list into the skill map used
              by the next stages. Placed AFTER discovery so the user finalises
              once the candidate list is reviewed. */}
          <p style={{ marginTop: tokens.spacing.md }}>
            <Button onClick={handleGenerate}>{t('skillMap.generate')}</Button>
          </p>
        </>
      )}

      {status ? (
        <Banner role="status">
          <small>{status}</small>
        </Banner>
      ) : null}

      {skillMap && skillMap.entries.length > 0 ? (
        <>
          <ul>
            {skillMap.entries.map((entry) => (
              <li key={entry.id as unknown as string}>
                <strong>{entry.name}</strong> <Badge>{entry.category}</Badge>
                <br />
                <small>{entry.proficiencySignal}</small>
                <br />
                <small>{t('skillMap.evidenceCount', { count: entry.evidence.length })}</small>
              </li>
            ))}
          </ul>
          <Button onClick={() => void handleSave()}>{t('skillMap.save')}</Button>
        </>
      ) : null}
    </section>
  );
}
