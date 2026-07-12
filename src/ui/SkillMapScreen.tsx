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

import { useState } from 'react';
import {
  asDocId,
  asISODate,
  asItemId,
  experienceYears,
  SKILL_CATEGORIES,
  type ExtractedItem,
  type RolePreference,
  type SkillCategory,
} from '@core/types';
import { trailOf, userConfirmation } from '@core/provenance';
import { MemoryTree } from '@core/storage';
import {
  generate,
  saveSkillMap,
  splitMerge,
  buildCareerExtractionPrompt,
  parseCareerExtractionWithTracking,
  mergeCareerExtractions,
  careerExtractionToItems,
  suggestAiDedups,
  buildRawDiscoveryCorpus,
  buildDiscoveryCorpus,
  type SkillMap,
  type CareerExtraction,
  type DedupSuggestion,
  type PostProcessingTransformation,
} from '@core/skills';
import { rescorePreferences, saveRolePreferences } from '@core/role-matcher';
import { type AssistMode, type EgressDestination } from '@core/assist';
import { AssistChoice } from './AssistChoice';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  LoadingIndicator,
  Select,
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
  /** Current role preferences for re-scoring when the skill map changes (R77.1). */
  readonly rolePrefs?: readonly RolePreference[];
  /** Update role preferences after re-scoring (R77.1). */
  readonly onRolePrefs?: (prefs: RolePreference[]) => void;
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
  rolePrefs,
  onRolePrefs,
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
  const [aiSuggestions, setAiSuggestions] = useState<Array<{ name: string; since?: string }>>([]);
  const [aiSelected, setAiSelected] = useState<Set<string>>(new Set());
  const [aiError, setAiError] = useState<string>('');
  // Free-text skills the user adds by hand (comma- or newline-separated). The
  // user is ultimately responsible for the list, so these are always included.
  const [manualText, setManualText] = useState<string>('');

  // Structured career extraction state (R71.6).
  const [careerExtraction, setCareerExtraction] = useState<CareerExtraction | null>(null);
  const [extractionItems, setExtractionItems] = useState<ExtractedItem[]>([]);
  const [extractionReviewed, setExtractionReviewed] = useState(false);
  const [extractionSelected, setExtractionSelected] = useState<Set<string>>(new Set());
  const [dedupSuggestions, setDedupSuggestions] = useState<DedupSuggestion[]>([]);
  const [dedupDecisions, setDedupDecisions] = useState<Map<string, 'merge' | 'keep'>>(new Map());
  // Post-processing transformation records (R75.1, R75.2, R75.6).
  const [postProcessing, setPostProcessing] = useState<PostProcessingTransformation[]>([]);

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
    // Employment-type and education-type items are factual structure — always
    // included regardless of assist mode (Problem B fix).
    const isStructural = (it: ExtractedItem): boolean =>
      it.type === 'employment' || it.type === 'education';
    const aiItems = extractions.filter(isAi);
    const scriptItems = extractions.filter((it) => !isAi(it) && !isUser(it));
    const userItems = extractions.filter(isUser);
    const structuralItems = extractions.filter((it) => isStructural(it) && !isAi(it) && !isUser(it));
    const base =
      assistMode === 'ai-only'
        ? aiItems
        : assistMode === 'script-only'
          ? scriptItems
          : aiItems.length > 0
            ? aiItems
            : scriptItems;
    // User-typed skills are always included, whatever the discovery mode — the
    // user owns the final list. Structural items (employment, education) are
    // always included as factual context (Problem B fix).
    const baseIds = new Set(base.map((it) => it.id as unknown as string));
    const structuralExtras = structuralItems.filter(
      (it) => !baseIds.has(it.id as unknown as string),
    );
    const map = generate([...base, ...userItems, ...structuralExtras]);
    onSkillMap(map);
    setStatus(t('skillMap.generated', { count: map.entries.length }));
  };

  const handleSave = async () => {
    if (!skillMap) return;
    try {
      await saveSkillMap(store, skillMap);
      store.logConfirmation(`Saved skill map (${skillMap.entries.length} skills).`);
      setStatus(t('skillMap.saved'));
      // Re-score role preferences against the updated skill map (R77.1, R77.2).
      if (rolePrefs && rolePrefs.length > 0 && onRolePrefs) {
        const rescored = rescorePreferences(rolePrefs, skillMap);
        onRolePrefs(rescored);
        await saveRolePreferences(store, rescored);
      }
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
      // --- Structured career extraction (R71.1, R71.6) ---
      // Build the corpus chunks for the extraction prompt.
      const local = dest?.kind === 'keyless-local';
      const useRaw = rawTexts.length > 0;
      const chunks = useRaw
        ? buildRawDiscoveryCorpus(rawTexts)
        : buildDiscoveryCorpus(extractions, { includePrivate: local ?? false });

      // Run the extraction prompt on each chunk and merge results.
      const chunkExtractions: CareerExtraction[] = [];
      const allTransformations: PostProcessingTransformation[] = [];
      for (const chunk of chunks) {
        const prompt = buildCareerExtractionPrompt(chunk);
        const reply = await aiAssist(prompt);
        const { extraction: chunkExtraction, transformations } = parseCareerExtractionWithTracking(reply);
        chunkExtractions.push(chunkExtraction);
        allTransformations.push(...transformations);
      }
      const merged = mergeCareerExtractions(chunkExtractions);
      const items = careerExtractionToItems(merged);

      // Run dedup suggestions on the extracted standalone skills.
      const dedups = suggestAiDedups(merged.skills);

      if (merged.positions.length === 0 && merged.education.length === 0 && merged.skills.length === 0) {
        setAiError(t('skillMap.extraction.noResults'));
      } else {
        // Present the extraction for user review (R71.6).
        setCareerExtraction(merged);
        setExtractionItems(items);
        setExtractionReviewed(false);
        // Pre-select all items for convenience.
        setExtractionSelected(new Set(items.map((it) => it.id as unknown as string)));
        setDedupSuggestions(dedups);
        setDedupDecisions(new Map());
        // Store post-processing transformations for display (R75.1, R75.2, R75.6).
        setPostProcessing(allTransformations);
        // Log each transformation to the session log (R75.6).
        for (const tx of allTransformations) {
          const label = tx.kind === 'date-normalisation'
            ? t('skillMap.extraction.postProcessing.dateLog', { original: tx.original, normalized: tx.normalized })
            : t('skillMap.extraction.postProcessing.splitLog', { original: tx.original, normalized: tx.normalized });
          store.logAction(label);
        }
      }
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setAiBusy(false);
    }
  };

  /** After user reviews and confirms the structured extraction (R71.6). */
  const handleConfirmExtraction = () => {
    // Add only selected extraction items.
    const selected = extractionItems.filter(
      (it) => extractionSelected.has(it.id as unknown as string),
    );

    // Apply dedup merge decisions: remove variants whose canonical is merged.
    const mergedVariants = new Set<string>();
    for (const dedup of dedupSuggestions) {
      const pairKey = [dedup.canonical.toLowerCase(), ...dedup.variants.map((v) => v.toLowerCase())].sort().join('|');
      if (dedupDecisions.get(pairKey) === 'merge') {
        for (const variant of dedup.variants) {
          mergedVariants.add(variant.toLowerCase());
        }
      }
    }

    // Filter out merged variants from skill items.
    const finalItems = selected.filter((it) => {
      if (it.type === 'skill') {
        const name = (it.fields as { name?: string }).name ?? '';
        return !mergedVariants.has(name.toLowerCase());
      }
      return true;
    });

    onAddExtractions(finalItems);
    setExtractionReviewed(true);
    setStatus(t('skillMap.ai.added', { count: finalItems.length }));
    // Clear extraction UI to show the flat suggestions flow if needed.
    setCareerExtraction(null);
    setExtractionItems([]);
    setDedupSuggestions([]);
    setPostProcessing([]);
  };

  const toggleSuggestion = (name: string) =>
    setAiSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const toggleExtractionItem = (id: string) =>
    setExtractionSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setDedupDecision = (key: string, decision: 'merge' | 'keep') =>
    setDedupDecisions((prev) => {
      const next = new Map(prev);
      next.set(key, decision);
      return next;
    });

  const handleAddSelected = () => {
    const at = asISODate(new Date().toISOString());
    const selectedSuggestions = aiSuggestions.filter((s) => aiSelected.has(s.name));
    const added: ExtractedItem[] = selectedSuggestions.map((s) => ({
      id: asItemId(`ai-suggested.md#skill-${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`),
      type: 'skill',
      fields: { name: s.name, ...(s.since ? { since: `${s.since}-01-01` } : {}) },
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

          {/* Structured extraction review (R71.6) — shown before flat suggestions. */}
          {careerExtraction && !extractionReviewed ? (
            <Card style={{ marginTop: tokens.spacing.sm }}>
              <h4>{t('skillMap.extraction.heading')}</h4>
              <p><small>{t('skillMap.extraction.review')}</small></p>

              {careerExtraction.positions.length > 0 ? (
                <>
                  <h5>{t('skillMap.extraction.positions')}</h5>
                  <ul>
                    {careerExtraction.positions.map((pos, i) => {
                      const itemId = extractionItems.find(
                        (it) => it.type === 'employment' && (it.fields as { title?: string }).title === pos.title && (it.fields as { employer?: string }).employer === pos.company,
                      )?.id as unknown as string | undefined;
                      return (
                        <li key={`pos-${i}`}>
                          <label>
                            {itemId ? (
                              <input
                                type="checkbox"
                                checked={extractionSelected.has(itemId)}
                                onChange={() => toggleExtractionItem(itemId)}
                              />
                            ) : null}{' '}
                            <strong>{t('skillMap.extraction.positionItem', { title: pos.title, company: pos.company })}</strong>
                            {pos.start ? (
                              <small style={{ color: tokens.colour.muted, marginLeft: tokens.spacing.xs }}>
                                {pos.end
                                  ? t('skillMap.extraction.dates', { start: pos.start, end: pos.end })
                                  : t('skillMap.extraction.datesOngoing', { start: pos.start })}
                              </small>
                            ) : null}
                            {pos.technologies.length > 0 ? (
                              <br />
                            ) : null}
                            {pos.technologies.length > 0 ? (
                              <small style={{ color: tokens.colour.muted }}>{pos.technologies.join(', ')}</small>
                            ) : null}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}

              {careerExtraction.education.length > 0 ? (
                <>
                  <h5>{t('skillMap.extraction.education')}</h5>
                  <ul>
                    {careerExtraction.education.map((edu, i) => {
                      const itemId = extractionItems.find(
                        (it) => it.type === 'education' && (it.fields as { degree?: string }).degree === edu.degree && (it.fields as { institution?: string }).institution === edu.institution,
                      )?.id as unknown as string | undefined;
                      return (
                        <li key={`edu-${i}`}>
                          <label>
                            {itemId ? (
                              <input
                                type="checkbox"
                                checked={extractionSelected.has(itemId)}
                                onChange={() => toggleExtractionItem(itemId)}
                              />
                            ) : null}{' '}
                            <strong>{edu.degree}</strong> — {edu.institution}
                            {edu.start ? (
                              <small style={{ color: tokens.colour.muted, marginLeft: tokens.spacing.xs }}>
                                {edu.end
                                  ? t('skillMap.extraction.dates', { start: edu.start, end: edu.end })
                                  : t('skillMap.extraction.datesOngoing', { start: edu.start })}
                              </small>
                            ) : null}
                            {edu.skills.length > 0 ? (
                              <br />
                            ) : null}
                            {edu.skills.length > 0 ? (
                              <small style={{ color: tokens.colour.muted }}>{edu.skills.join(', ')}</small>
                            ) : null}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}

              {careerExtraction.skills.length > 0 ? (
                <>
                  <h5>{t('skillMap.extraction.skills')}</h5>
                  <ul>
                    {careerExtraction.skills.map((skill, i) => {
                      const itemId = extractionItems.find(
                        (it) => it.type === 'skill' && (it.fields as { name?: string }).name === skill.name,
                      )?.id as unknown as string | undefined;
                      return (
                        <li key={`skill-${i}`}>
                          <label>
                            {itemId ? (
                              <input
                                type="checkbox"
                                checked={extractionSelected.has(itemId)}
                                onChange={() => toggleExtractionItem(itemId)}
                              />
                            ) : null}{' '}
                            {skill.name}
                            {skill.since ? (
                              <small style={{ color: tokens.colour.muted, marginLeft: tokens.spacing.xs }}>
                                {t('skillMap.extraction.since', { year: skill.since })}
                              </small>
                            ) : null}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}

              {careerExtraction.professionalSummary ? (
                <>
                  <h5>{t('skillMap.extraction.professionalSummarySection')}</h5>
                  <ul>
                    <li>
                      <label>
                        <input
                          type="checkbox"
                          checked={extractionSelected.has('professional-summary')}
                          onChange={() => toggleExtractionItem('professional-summary')}
                        />{' '}
                        {careerExtraction.professionalSummary}
                      </label>
                    </li>
                  </ul>
                </>
              ) : null}

              {careerExtraction.coreCompetencies.length > 0 ? (
                <>
                  <h5>{t('skillMap.extraction.coreCompetencies')}</h5>
                  <ul>
                    {careerExtraction.coreCompetencies.map((comp, i) => {
                      const compId = `core-competency-${i}`;
                      return (
                        <li key={compId}>
                          <label>
                            <input
                              type="checkbox"
                              checked={extractionSelected.has(compId)}
                              onChange={() => toggleExtractionItem(compId)}
                            />{' '}
                            {comp}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}

              {careerExtraction.languages.length > 0 ? (
                <>
                  <h5>{t('skillMap.extraction.languagesSection')}</h5>
                  <ul>
                    {careerExtraction.languages.map((lang, i) => {
                      const langId = `language-${i}`;
                      return (
                        <li key={langId}>
                          <label>
                            <input
                              type="checkbox"
                              checked={extractionSelected.has(langId)}
                              onChange={() => toggleExtractionItem(langId)}
                            />{' '}
                            {t('skillMap.extraction.languageItem', { language: lang.language, proficiency: lang.proficiency })}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}

              {careerExtraction.hobbies.length > 0 ? (
                <>
                  <h5>{t('skillMap.extraction.hobbiesSection')}</h5>
                  <ul>
                    {careerExtraction.hobbies.map((hobby, i) => {
                      const hobbyId = `hobby-${i}`;
                      return (
                        <li key={hobbyId}>
                          <label>
                            <input
                              type="checkbox"
                              checked={extractionSelected.has(hobbyId)}
                              onChange={() => toggleExtractionItem(hobbyId)}
                            />{' '}
                            {hobby}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}

              {careerExtraction.causes.length > 0 ? (
                <>
                  <h5>{t('skillMap.extraction.causesSection')}</h5>
                  <ul>
                    {careerExtraction.causes.map((cause, i) => {
                      const causeId = `cause-${i}`;
                      return (
                        <li key={causeId}>
                          <label>
                            <input
                              type="checkbox"
                              checked={extractionSelected.has(causeId)}
                              onChange={() => toggleExtractionItem(causeId)}
                            />{' '}
                            {cause}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}

              {careerExtraction.additionalInfo.length > 0 ? (
                <>
                  <h5>{t('skillMap.extraction.additionalInfoSection')}</h5>
                  <ul>
                    {careerExtraction.additionalInfo.map((info, i) => {
                      const infoId = `additional-info-${i}`;
                      return (
                        <li key={infoId}>
                          <label>
                            <input
                              type="checkbox"
                              checked={extractionSelected.has(infoId)}
                              onChange={() => toggleExtractionItem(infoId)}
                            />{' '}
                            {t('skillMap.extraction.additionalInfoItem', { category: info.category, value: info.value })}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}

              {dedupSuggestions.length > 0 ? (
                <>
                  <h5>{t('skillMap.extraction.dedup.heading')}</h5>
                  <ul>
                    {dedupSuggestions.map((dedup) => {
                      const pairKey = [dedup.canonical.toLowerCase(), ...dedup.variants.map((v) => v.toLowerCase())].sort().join('|');
                      const decision = dedupDecisions.get(pairKey);
                      return (
                        <li key={pairKey}>
                          <small>{dedup.reason}</small>
                          <br />
                          <Button
                            variant={decision === 'merge' ? 'primary' : 'secondary'}
                            onClick={() => setDedupDecision(pairKey, 'merge')}
                          >
                            {t('skillMap.extraction.dedup.merge')}
                          </Button>{' '}
                          <Button
                            variant={decision === 'keep' ? 'primary' : 'secondary'}
                            onClick={() => setDedupDecision(pairKey, 'keep')}
                          >
                            {t('skillMap.extraction.dedup.keep')}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}

              {postProcessing.length > 0 ? (
                <>
                  <h5>{t('skillMap.extraction.postProcessing.heading')}</h5>
                  <p><small>{t('skillMap.extraction.postProcessing.intro')}</small></p>
                  <ul>
                    {postProcessing.map((tx, i) => (
                      <li key={`pp-${i}`}>
                        <Badge>{tx.kind === 'date-normalisation'
                          ? t('skillMap.extraction.postProcessing.dateLabel')
                          : t('skillMap.extraction.postProcessing.splitLabel')}</Badge>{' '}
                        <small>
                          {tx.original} → {tx.normalized}
                        </small>
                        {tx.context ? (
                          <small style={{ color: tokens.colour.muted, marginLeft: tokens.spacing.xs }}>
                            ({tx.context})
                          </small>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              <Button onClick={handleConfirmExtraction}>
                {t('skillMap.extraction.confirm')}
              </Button>
            </Card>
          ) : null}

          {aiSuggestions.length > 0 ? (
            <Card style={{ marginTop: tokens.spacing.sm }}>
              <h4>{t('skillMap.ai.suggestionsHeading')}</h4>
              <ul>
                {aiSuggestions.map((s) => (
                  <li key={s.name}>
                    <label>
                      <input
                        type="checkbox"
                        checked={aiSelected.has(s.name)}
                        onChange={() => toggleSuggestion(s.name)}
                      />{' '}
                      {s.name}
                      {s.since && (
                        <small style={{ color: tokens.colour.muted, marginLeft: tokens.spacing.xs }}>
                          (since ~{s.since})
                        </small>
                      )}
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
          {assistMode === 'ai-only' ? (
            <Banner role="status" data-ai-only-label>
              <small>{t('skillMap.aiOnlyLabel')}</small>
            </Banner>
          ) : null}
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
            {skillMap.entries.map((entry) => {
              const years = experienceYears(entry.since);
              const yearsLabel =
                years === undefined
                  ? ''
                  : years === 0
                    ? '< 1 year'
                    : t('skillMap.experienceYears', { years });
              return (
                <li key={entry.id as unknown as string}>
                  <strong>{entry.name}</strong>{' '}
                  <Select
                    label={t('skillMap.category.label')}
                    hideLabel
                    value={entry.category}
                    onChange={(e) => {
                      const updated = skillMap.entries.map((sk) =>
                        sk.id === entry.id
                          ? { ...sk, category: e.target.value as SkillCategory }
                          : sk,
                      );
                      onSkillMap({ ...skillMap, entries: updated });
                    }}
                    fieldStyle={{ display: 'inline-block', verticalAlign: 'middle' }}
                    style={{ fontSize: tokens.typography.scale.sm, padding: '2px 4px' }}
                  >
                    {SKILL_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {t(`skillMap.category.${cat}`)}
                      </option>
                    ))}
                  </Select>
                  <br />
                  <small>{entry.proficiencySignal}</small>
                  <br />
                  <small>{t('skillMap.evidenceCount', { count: entry.evidence.length })}</small>
                  {entry.mergeRecord ? (
                    <div style={{ marginTop: tokens.spacing.xs, padding: tokens.spacing.xs, background: tokens.colour.surface, borderRadius: '4px' }}>
                      <small><strong>{t('skillMap.merge.heading')}</strong></small>
                      <br />
                      <small>{entry.mergeRecord.rationale}</small>
                      <br />
                      <Button
                        variant="secondary"
                        onClick={() => {
                          splitMerge(skillMap, entry.id);
                          onSkillMap({ ...skillMap, entries: [...skillMap.entries] });
                        }}
                        style={{ fontSize: tokens.typography.scale.sm, padding: '2px 6px', marginTop: tokens.spacing.xs }}
                      >
                        {t('skillMap.merge.revert')}
                      </Button>
                    </div>
                  ) : null}
                  <br />
                  <label style={{ fontSize: tokens.typography.scale.sm, display: 'flex', alignItems: 'center', gap: tokens.spacing.xs, marginTop: tokens.spacing.xs }}>
                    {t('skillMap.since')}{' '}
                    <input
                      type="month"
                      value={entry.since ? (entry.since as unknown as string).slice(0, 7) : ''}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const updated = skillMap.entries.map((sk) =>
                          sk.id === entry.id
                            ? { ...sk, since: raw ? asISODate(`${raw}-01`) : undefined }
                            : sk,
                        );
                        onSkillMap({ ...skillMap, entries: updated });
                      }}
                      style={{ marginLeft: tokens.spacing.xs }}
                    />
                    {yearsLabel ? <strong style={{ marginLeft: tokens.spacing.xs }}>{yearsLabel}</strong> : null}
                  </label>
                  {!entry.since && (
                    <small style={{ color: tokens.colour.muted, display: 'block', marginTop: '2px' }}>
                      {t('skillMap.sinceHint')}
                    </small>
                  )}
                </li>
              );
            })}
          </ul>
          <Button onClick={() => void handleSave()}>{t('skillMap.save')}</Button>
        </>
      ) : null}
    </section>
  );
}
