// Role Discovery screen (@ui) — Phase 3 (R20, R21).
//
// Suggests employed / freelance / portfolio roles scored (estimate) against the
// confirmed skill map with matched-vs-gap skills and a rationale (R20), lets the
// user accept and tag roles, captures ranked preferences (R21), and persists
// them to `profile/role_preferences.md`. Pure engine calls — no provider.

import { useMemo, useState } from 'react';
import type { ExtractedItem, RolePreference, RoleTag } from '@core/types';
import { MemoryTree } from '@core/storage';
import { generate, type SkillMap } from '@core/skills';
import {
  suggestRoles,
  capturePreferences,
  saveRolePreferences,
  createRoleDiscoveryOperation,
  ROLE_TAGS,
  type RoleSuggestion,
  type RolePreferenceInput,
  type AiRoleRecommendation,
} from '@core/role-matcher';
import { runAssist, type AssistMode, type EgressDestination } from '@core/assist';
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

export interface RoleDiscoveryScreenProps {
  readonly skillMap: SkillMap | null;
  /**
   * Confirmed extracted items from ingestion. When no skill map has been
   * explicitly generated/saved yet, Role Discovery derives a working skill map
   * from these deterministically (the same `generate()` the Skill Map screen
   * uses) so the discovery options appear based on available input — matching
   * the Skill Map screen's behaviour. An explicitly generated/loaded `skillMap`
   * always takes precedence.
   */
  readonly extractions: ExtractedItem[];
  readonly rolePrefs: RolePreference[];
  readonly onRolePrefs: (prefs: RolePreference[]) => void;
  readonly store: MemoryTree;
  /** Whether an AI provider key is configured (opt-in assist, R42.1). */
  readonly aiAvailable: boolean;
  /** Routes a prompt through the Egress Gate; returns the model's text. */
  readonly aiAssist: (prompt: string) => Promise<string>;
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

interface Selection {
  readonly accepted: boolean;
  readonly tag: RoleTag;
}

export function RoleDiscoveryScreen({
  skillMap,
  extractions,
  rolePrefs,
  onRolePrefs,
  store,
  aiAvailable,
  aiAssist,
  chatProvider = null,
  chatIsLocal = false,
  assistMode,
  onAssistMode,
  t,
}: RoleDiscoveryScreenProps) {
  const [suggestions, setSuggestions] = useState<RoleSuggestion[]>([]);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [status, setStatus] = useState<string>('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiRoles, setAiRoles] = useState<AiRoleRecommendation[]>([]);
  const [aiError, setAiError] = useState<string>('');
  // Free-text roles the user adds by hand (comma- or newline-separated).
  const [manualText, setManualText] = useState<string>('');

  // The skill map Role Discovery operates on. Prefer an explicitly generated /
  // loaded skill map; otherwise derive one deterministically from the confirmed
  // extractions so the discovery options appear as soon as there is input to
  // work from (mirroring the Skill Map screen). `null` only when there is
  // neither a map nor any extracted items yet.
  const effectiveMap = useMemo<SkillMap | null>(
    () => skillMap ?? (extractions.length > 0 ? generate(extractions) : null),
    [skillMap, extractions],
  );

  // The role-discovery operation, bound to a gate-routed transport. scriptOnly
  // never reaches the transport (zero provider calls); ai-assisted routes the
  // skill-name-only recommendation prompt through the gate.
  const operation = useMemo(
    () => createRoleDiscoveryOperation((prompt) => aiAssist(prompt)),
    [aiAssist],
  );

  const handleSuggest = () => {
    if (!effectiveMap) return;
    const result = suggestRoles(effectiveMap);
    setSuggestions(result);
    setSelections(
      Object.fromEntries(
        result.map((r) => [r.slug as unknown as string, { accepted: false, tag: 'exploring' as RoleTag }]),
      ),
    );
    setStatus(t('roles.suggested', { count: result.length }));
  };

  const update = (slug: string, patch: Partial<Selection>) =>
    setSelections((prev) => ({ ...prev, [slug]: { ...prev[slug], ...patch } }));

  const acceptedCount = useMemo(
    () => Object.values(selections).filter((s) => s.accepted).length,
    [selections],
  );

  const handleConfirm = async () => {
    const inputs: RolePreferenceInput[] = suggestions
      .filter((s) => selections[s.slug as unknown as string]?.accepted)
      .map((s, index) => ({
        slug: s.slug as unknown as string,
        accepted: true,
        rank: index + 1,
        tag: selections[s.slug as unknown as string]?.tag,
      }));
    const prefs = capturePreferences(suggestions, inputs, effectiveMap ? { map: effectiveMap } : {});
    onRolePrefs(prefs);
    try {
      await saveRolePreferences(store, prefs);
      store.logConfirmation(`Saved ${prefs.length} role preference(s).`);
      setStatus(t('roles.saved', { count: prefs.length }));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const handleAiRecommend = async () => {
    if (!effectiveMap) return;
    setAiBusy(true);
    setAiError('');
    setAiRoles([]);
    const dest: EgressDestination | null = chatProvider
      ? { provider: chatProvider, kind: chatIsLocal ? 'keyless-local' : 'keyed-cloud' }
      : null;
    try {
      // runAssist branches on the mode: script-only never constructs an Egress
      // request; ai-assisted computes the deterministic suggestions first then
      // adds gate-routed AI roles, falling back to the baseline on failure.
      const { outcome, error } = await runAssist(
        operation,
        { map: effectiveMap, review: assistMode === 'ai-assisted' },
        { mode: assistMode, capability: 'role_discovery' },
        dest ?? undefined,
      );
      const roles = outcome.suggestions.map((s) => s.value);
      setAiRoles(roles);
      if (error) {
        setAiError(t('assist.fallback', { reason: error.message }));
      } else if (roles.length === 0) {
        setAiError(t('roles.ai.none'));
      }
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setAiBusy(false);
    }
  };

  const handleAddAiRole = async (role: AiRoleRecommendation) => {
    // Add an AI-recommended role as a user-added preference (R21.1). Scored
    // honestly against the skill map when possible; nothing is fabricated.
    const captured = capturePreferences(
      [],
      [{ added: { title: role.title, description: role.rationale }, tag: 'exploring' }],
      effectiveMap ? { map: effectiveMap } : {},
    );
    const candidate = captured[0];
    if (!candidate) return;
    const slug = candidate.slug as unknown as string;
    if (rolePrefs.some((r) => (r.slug as unknown as string) === slug)) {
      setStatus(t('roles.ai.duplicate', { title: role.title }));
      return;
    }
    const next = [...rolePrefs, { ...candidate, rank: rolePrefs.length + 1 }];
    onRolePrefs(next);
    try {
      await saveRolePreferences(store, next);
      setStatus(t('roles.ai.added', { title: role.title }));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const handleAddManualRoles = async () => {
    const titles = parseList(manualText);
    if (titles.length === 0) return;
    // The user owns the final list: each typed title becomes a user-added role
    // preference, deduped by slug against what is already captured.
    let next = [...rolePrefs];
    let addedCount = 0;
    for (const title of titles) {
      const captured = capturePreferences(
        [],
        [{ added: { title }, tag: 'exploring' }],
        effectiveMap ? { map: effectiveMap } : {},
      );
      const candidate = captured[0];
      if (!candidate) continue;
      const slug = candidate.slug as unknown as string;
      if (next.some((r) => (r.slug as unknown as string) === slug)) continue;
      next = [...next, { ...candidate, rank: next.length + 1 }];
      addedCount += 1;
    }
    if (addedCount === 0) {
      setStatus(t('roles.manual.none'));
      return;
    }
    onRolePrefs(next);
    try {
      await saveRolePreferences(store, next);
      setStatus(t('roles.manual.added', { count: addedCount }));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
    setManualText('');
  };

  return (
    <section aria-label={t('roles.heading')} data-role-discovery-screen>
      <h3>{t('roles.heading')}</h3>
      <p>{t('roles.intro')}</p>

      {!effectiveMap ? (
        <EmptyState message={t('roles.needSkillMap')} />
      ) : assistMode === 'ai-only' ? null : (
        <Button onClick={handleSuggest}>{t('roles.suggest')}</Button>
      )}

      {/* Opt-in-first AI recommendations (R20.4): pre-operation choice + the
          destination network/privacy label, surfaced before the operation. */}
      {effectiveMap ? (
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
              <Button onClick={() => void handleAiRecommend()} disabled={aiBusy}>
                {aiBusy ? t('roles.ai.working') : t('roles.ai.recommend')}
              </Button>
            </div>
          ) : null}
        </Stack>
      ) : null}

      {/* Loading indicator shown within 1s of the AI call starting (R58.7). */}
      {aiBusy ? <LoadingIndicator message={t('roles.ai.working')} /> : null}

      {aiError ? (
        <Banner role="status">
          <small>{aiError}</small>
        </Banner>
      ) : null}

      {aiRoles.length > 0 ? (
        <Card style={{ marginTop: tokens.spacing.sm }}>
          <h4>{t('roles.ai.recommendationsHeading')}</h4>
          <ul>
            {aiRoles.map((role) => (
              <li key={role.title}>
                <strong>{role.title}</strong>
                {role.rationale ? <> — <small>{role.rationale}</small></> : null}{' '}
                <Button variant="secondary" onClick={() => void handleAddAiRole(role)}>
                  {t('roles.ai.add')}
                </Button>
              </li>
            ))}
          </ul>
          <p>
            <small>{t('roles.ai.advisory')}</small>
          </p>
        </Card>
      ) : null}

      {/* Add-your-own: the user owns the final list, so they can type any roles
          (comma- or newline-separated) to add before confirming/saving. */}
      {effectiveMap ? (
        <div style={{ marginTop: tokens.spacing.sm, marginBottom: tokens.spacing.sm }}>
          <TextArea
            label={t('roles.manual.label')}
            value={manualText}
            rows={3}
            placeholder={t('roles.manual.placeholder')}
            onChange={(e) => setManualText(e.target.value)}
          />
          <Button
            variant="secondary"
            onClick={() => void handleAddManualRoles()}
            disabled={manualText.trim().length === 0}
          >
            {t('roles.manual.add')}
          </Button>
        </div>
      ) : null}

      {status ? (
        <Banner role="status">
          <small>{status}</small>
        </Banner>
      ) : null}

      {suggestions.length > 0 ? (
        <>
          <ul>
            {suggestions.map((s) => {
              const slug = s.slug as unknown as string;
              const sel = selections[slug] ?? { accepted: false, tag: 'exploring' as RoleTag };
              return (
                <li key={slug} style={{ marginBottom: tokens.spacing.sm }}>
                  <label>
                    <input
                      type="checkbox"
                      checked={sel.accepted}
                      onChange={(e) => update(slug, { accepted: e.target.checked })}
                    />{' '}
                    <strong>{s.title}</strong> <Badge>{s.roleType}</Badge> — {s.scoreLabel}
                  </label>{' '}
                  <Select
                    label={t('roles.tagLabel', { title: s.title })}
                    hideLabel
                    value={sel.tag}
                    onChange={(e) => update(slug, { tag: e.target.value as RoleTag })}
                    disabled={!sel.accepted}
                  >
                    {ROLE_TAGS.map((tag) => (
                      <option key={tag} value={tag}>
                        {t(`roles.tag.${tag}`)}
                      </option>
                    ))}
                  </Select>
                  <br />
                  <small>{s.description}</small>
                  <br />
                  <small>{s.rationale}</small>
                </li>
              );
            })}
          </ul>
          <Button onClick={() => void handleConfirm()} disabled={acceptedCount === 0}>
            {t('roles.confirm')}
          </Button>
        </>
      ) : null}

      {rolePrefs.length > 0 ? (
        <p>
          <small>
            {t('roles.confirmedList', {
              roles: rolePrefs
                .map((r) => `${r.rank}. ${r.title} [${t(`roles.tag.${r.tag}`)}]`)
                .join('; '),
            })}
          </small>
        </p>
      ) : null}
    </section>
  );
}
