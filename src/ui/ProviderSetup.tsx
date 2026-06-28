// BYOK provider setup screen (@ui) — Requirements 4, 5.
//
// Surfaces the pluggable Provider_Manager so the user can connect their own
// cloud LLM provider: pick a provider, read the README-style setup guidance,
// enter an API key, validate it with a real test call, and store it encrypted
// (or remove a stored key). The agent ships no shared key (R4.5).
//
// Boundary note: this component talks ONLY to the Provider_Manager (setup) and
// the key vault (to reflect whether a key is stored). It never imports a
// provider client and makes no direct network call — validation/transmission
// happen inside the adapters, and outbound provider CALLS flow through the
// single Egress Gate (Requirements 6, 7). Every user-facing string is read from
// the externalised locale resources via `t(...)` (R41.8).
//
// Keyless providers (the self-hosted Local Provider, R43): when a descriptor is
// `keyless`, the screen swaps the API-key field for editable base-URL / chat-
// model / STT-model fields (seeded from and persisted to local-config, NOT the
// vault) and a "Test connection" button that probes `GET /models` via
// `validateKey(id, '')`. A successful test marks the config configured so AI
// availability updates. No API-key/password field or "Remove key" button is
// shown for keyless providers.

import { useEffect, useMemo, useState } from 'react';
import type { ProviderManager, ProviderId } from '@adapters/provider';
import type { KeyVault } from '@adapters/vault';
import {
  getLocalConfig,
  setLocalConfig,
  validateLocalBaseUrl,
  localCorsGuidance,
  isLikelyCorsRejection,
  type LocalProviderConfig,
} from '@adapters/local-config';
import type { SessionLanguage } from '@core/locale';
import {
  Banner,
  Button,
  Row,
  Select,
  TextField,
  ErrorState,
  tokens,
} from './design-system';

export interface ProviderSetupProps {
  /** The pluggable BYOK Provider_Manager (list/guide/validate/store/remove). */
  readonly providerManager: ProviderManager;
  /** The encrypted key vault, used to reflect whether a key is stored. */
  readonly keyVault: KeyVault;
  /** The confirmed Session Language, used to localise the setup guidance (R4.2). */
  readonly locale: SessionLanguage;
  /** Notify the shell when a key was stored or removed (so AI availability updates). */
  readonly onKeysChanged?: () => void;
  /** Bound i18n translator (resolves externalised strings, R41.8). */
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'validating' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'removed' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'error'; readonly reason: string };

/** Render the connected setup guidance Markdown as a few readable elements. */
function renderGuide(markdown: string): JSX.Element {
  const lines = markdown.split('\n');
  return (
    <div data-testid="provider-setup-guide">
      {lines.map((line, index) => {
        const key = `${index}-${line}`;
        if (line.startsWith('## ')) {
          return <h4 key={key}>{line.slice(3)}</h4>;
        }
        if (line.startsWith('> ')) {
          return (
            <blockquote key={key}>
              <small>{line.slice(2)}</small>
            </blockquote>
          );
        }
        if (/^\d+\.\s/.test(line)) {
          return <p key={key} style={{ margin: `${tokens.spacing.xs} 0` }}>{line}</p>;
        }
        if (line.trim() === '') {
          return null;
        }
        return <p key={key} style={{ margin: `${tokens.spacing.xs} 0` }}>{line}</p>;
      })}
    </div>
  );
}

/** The BYOK provider/key setup screen. */
export function ProviderSetup({ providerManager, keyVault, locale, onKeysChanged, t }: ProviderSetupProps) {
  const providers = useMemo(() => providerManager.listProviders(), [providerManager]);
  const [selected, setSelected] = useState<ProviderId>(providers[0]?.id ?? '');
  const [keyInput, setKeyInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [stored, setStored] = useState<Record<ProviderId, boolean>>({});
  // Editable config for the keyless local provider (R43.2); seeded from, and
  // persisted to, browser-local storage rather than the encrypted vault.
  const [localCfg, setLocalCfg] = useState<LocalProviderConfig>(() => getLocalConfig());

  // Reflect which providers already have a stored (encrypted) key (R5.1).
  const refreshStored = useMemo(
    () => async () => {
      const entries = await Promise.all(
        providers.map(async (p) => [p.id, await keyVault.has(p.id)] as const),
      );
      setStored(Object.fromEntries(entries));
    },
    [providers, keyVault],
  );

  useEffect(() => {
    void refreshStored();
  }, [refreshStored]);

  if (providers.length === 0) {
    return null;
  }

  const guide = providerManager.setupGuide(selected, locale);
  const isStored = stored[selected] === true;
  // Keyless providers (the self-hosted Local Provider) show base-URL/model
  // fields and a "Test connection" button instead of the API-key flow (R43.2).
  const keyless = providers.find((p) => p.id === selected)?.keyless === true;

  // Validate the key with a real test call (R4.3); on success store it encrypted
  // (R5.1); on failure show the reason and let the user re-enter (R4.4).
  const handleValidateAndSave = async () => {
    setBusy(true);
    setStatus({ kind: 'validating' });
    try {
      const result = await providerManager.validateKey(selected, keyInput);
      if (!result.valid) {
        setStatus({ kind: 'invalid', reason: result.reason ?? '' });
        return;
      }
      await providerManager.storeKey(selected, keyInput);
      setKeyInput('');
      await refreshStored();
      onKeysChanged?.();
      setStatus({ kind: 'saved' });
    } catch (error) {
      setStatus({ kind: 'error', reason: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    try {
      await providerManager.removeKey(selected);
      await refreshStored();
      onKeysChanged?.();
      setStatus({ kind: 'removed' });
    } catch (error) {
      setStatus({ kind: 'error', reason: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  // Edit a local-config field: persist it (so the local client reads it per
  // call) and reflect it in local state. Editing clears any prior status.
  // React state is updated optimistically so the typed value always shows; the
  // persistence layer (`setLocalConfig`) silently refuses to save an unreachable
  // base URL, preserving the last usable saved configuration (R54.2).
  const updateLocalField = (patch: Partial<LocalProviderConfig>) => {
    setLocalCfg((prev) => ({ ...prev, ...patch }));
    setLocalConfig(patch);
    setStatus({ kind: 'idle' });
  };

  // Test the keyless local provider via a real `GET /models` probe (R43.2):
  // validateKey(selected, '') bypasses the empty-key guard. On success mark the
  // config configured so AI availability updates, then notify the shell.
  const handleTestConnection = async () => {
    setBusy(true);
    setStatus({ kind: 'validating' });
    try {
      // Reject an unreachable base URL (e.g. a Compose internal service name)
      // BEFORE probing or persisting — the host browser can only reach a model
      // server via a host-published localhost address (R54.1, R54.2). The saved
      // configuration is left untouched.
      const urlCheck = validateLocalBaseUrl(localCfg.baseUrl);
      if (!urlCheck.ok) {
        setStatus({ kind: 'invalid', reason: urlCheck.error });
        return;
      }
      // Ensure the latest edits are persisted before the client reads them.
      setLocalConfig({
        baseUrl: localCfg.baseUrl,
        model: localCfg.model,
        sttModel: localCfg.sttModel,
        maxTokens: localCfg.maxTokens,
      });
      const result = await providerManager.validateKey(selected, '');
      if (!result.valid) {
        // When the model server rejected the browser's origin (CORS / allowed
        // origins), attach guidance for adding the served origin to the server's
        // allowed-origins config. The current provider configuration is NOT
        // changed here (we do not flip `configured`), so it is preserved (R54.5).
        const reason = isLikelyCorsRejection(result.reason)
          ? `${result.reason ?? ''}\n\n${localCorsGuidance()}`.trim()
          : result.reason ?? '';
        setStatus({ kind: 'invalid', reason });
        return;
      }
      setLocalCfg(setLocalConfig({ configured: true }));
      onKeysChanged?.();
      setStatus({ kind: 'saved' });
    } catch (error) {
      setStatus({ kind: 'error', reason: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={t('provider.heading')} data-provider-setup>
      <h2>{t('provider.heading')}</h2>
      <p>{t('provider.intro')}</p>

      <Select
        label={t('provider.selectLabel')}
        value={selected}
        onChange={(e) => {
          setSelected(e.target.value as ProviderId);
          setStatus({ kind: 'idle' });
          setKeyInput('');
          setLocalCfg(getLocalConfig());
        }}
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.displayName}
          </option>
        ))}
      </Select>

      <p data-key-status={keyless ? (localCfg.configured ? 'configured' : 'unconfigured') : isStored ? 'stored' : 'absent'}>
        <small>
          {keyless
            ? localCfg.configured
              ? t('provider.local.configured')
              : t('provider.local.notConfigured')
            : isStored
              ? t('provider.stored')
              : t('provider.notStored')}
        </small>
      </p>

      {renderGuide(guide)}

      {keyless ? (
        <div data-local-config>
          <Row>
            <TextField
              label={t('provider.local.baseUrlLabel')}
              type="text"
              autoComplete="off"
              value={localCfg.baseUrl}
              onChange={(e) => updateLocalField({ baseUrl: e.target.value })}
              disabled={busy}
            />
            <TextField
              label={t('provider.local.chatModelLabel')}
              type="text"
              autoComplete="off"
              value={localCfg.model}
              onChange={(e) => updateLocalField({ model: e.target.value })}
              disabled={busy}
            />
            <TextField
              label={t('provider.local.sttModelLabel')}
              type="text"
              autoComplete="off"
              value={localCfg.sttModel}
              onChange={(e) => updateLocalField({ sttModel: e.target.value })}
              disabled={busy}
            />
            <TextField
              label={t('provider.local.maxTokensLabel')}
              type="number"
              inputMode="numeric"
              min={1}
              autoComplete="off"
              value={String(localCfg.maxTokens)}
              onChange={(e) => {
                const next = Number.parseInt(e.target.value, 10);
                // Show what the user types; persistence drops a non-positive value
                // so a usable saved limit is preserved (R43.6).
                updateLocalField({
                  maxTokens: Number.isFinite(next) ? next : localCfg.maxTokens,
                });
              }}
              disabled={busy}
            />
            <Button
              onClick={() => void handleTestConnection()}
              disabled={busy || localCfg.baseUrl.trim().length === 0}
            >
              {t('provider.local.testConnection')}
            </Button>
          </Row>
        </div>
      ) : (
        <Row>
          <TextField
            label={t('provider.keyLabel')}
            type="password"
            autoComplete="off"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            disabled={busy}
          />
          <Button
            onClick={() => void handleValidateAndSave()}
            disabled={busy || keyInput.trim().length === 0}
          >
            {t('provider.validateAndSave')}
          </Button>
          {isStored ? (
            <Button variant="danger" onClick={() => void handleRemove()} disabled={busy}>
              {t('provider.remove')}
            </Button>
          ) : null}
        </Row>
      )}

      {status.kind === 'error' ? (
        <ErrorState
          message={t('provider.status.error', { reason: status.reason })}
          recovery={t('provider.errorRecovery')}
        />
      ) : (
        <Banner role="status">
          <small>
            {status.kind === 'validating'
              ? keyless
                ? t('provider.local.status.testing')
                : t('provider.status.validating')
              : null}
            {status.kind === 'saved'
              ? keyless
                ? t('provider.local.status.tested')
                : t('provider.status.saved')
              : null}
            {status.kind === 'removed' ? t('provider.status.removed') : null}
            {status.kind === 'invalid'
              ? keyless
                ? t('provider.local.status.failed', { reason: status.reason })
                : t('provider.status.invalid', { reason: status.reason })
              : null}
          </small>
        </Banner>
      )}
    </section>
  );
}
