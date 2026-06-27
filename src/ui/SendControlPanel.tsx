// Per-file Granular Ingestion Send-Control panel (@ui) — Requirement 57.
//
// Rendered once per staged file before any of its content could be sent to an
// external provider. It presents each Sensitive Detection individually with its
// category (R57.2) and offers the two send choices (R57.1):
//   - whole-file — send the entire file content; and
//   - per-detection — allow or redact each detection one at a time.
// When the file has no detections it still offers the whole-file option and shows
// the explicit "no Sensitive Detections were found" notice (R57.8). The user must
// confirm a choice before the Egress Gate will build any payload (R57.1); the
// confirmed decision is persisted and reapplied when the same file is re-staged
// (R57.9, handled by the parent IngestScreen).
//
// This is a controlled, presentational component: it renders the supplied working
// `decision` and reports changes/confirmation upward. All strings are read from
// the externalised locale resources (R41.8).

import type {
  SendControlDecision,
  SendControlPanelModel,
} from '@core/egress';
import type { DetectionId } from '@core/types';
import { Button } from './design-system';

export interface SendControlPanelProps {
  /** The source document name this panel governs (for the heading). */
  readonly docName: string;
  /** The per-file model: detections, destination scoping, default decision, notice. */
  readonly model: SendControlPanelModel;
  /** The current working decision (may be unconfirmed). */
  readonly decision: SendControlDecision;
  /** Report a working-decision change (mode toggle or per-detection allow/redact). */
  readonly onChange: (next: SendControlDecision) => void;
  /** Confirm the current decision so the gate may build the payload (R57.1). */
  readonly onConfirm: () => void;
  /** Bound i18n translator (resolves externalised strings, R41.8). */
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}

/** Per-file send-control panel presenting each Sensitive Detection individually. */
export function SendControlPanel({
  docName,
  model,
  decision,
  onChange,
  onConfirm,
  t,
}: SendControlPanelProps) {
  const isLocal = model.destinationKind === 'keyless-local';
  const allowed = new Set<DetectionId>(decision.allowedDetectionIds);

  const setMode = (mode: SendControlDecision['mode']) =>
    onChange({ ...decision, mode, confirmed: false });

  const toggleDetection = (id: DetectionId, allow: boolean) => {
    const nextAllowed = decision.allowedDetectionIds.filter((d) => d !== id);
    if (allow) nextAllowed.push(id);
    onChange({ ...decision, allowedDetectionIds: nextAllowed, confirmed: false });
  };

  return (
    <section aria-label={t('ingest.sendControl.heading', { doc: docName })} data-send-control-panel>
      <h5>{t('ingest.sendControl.heading', { doc: docName })}</h5>

      {/* Destination scoping notice: cloud defaults everything to redacted (R57.6);
          local on-device may send the whole file incl. sensitive values (R57.5). */}
      <p>
        <small>
          {isLocal
            ? t('ingest.sendControl.localNotice')
            : t('ingest.sendControl.cloudNotice')}
        </small>
      </p>

      {/* Send-mode choice (R57.1). Whole-file is always offered (R57.5, R57.8). */}
      <fieldset>
        <legend>{t('ingest.sendControl.modeLegend')}</legend>
        <label>
          <input
            type="radio"
            name={`send-mode-${model.fileId as unknown as string}`}
            checked={decision.mode === 'whole-file'}
            onChange={() => setMode('whole-file')}
          />{' '}
          {t('ingest.sendControl.wholeFile')}
        </label>
        {model.detections.length > 0 ? (
          <label>
            <input
              type="radio"
              name={`send-mode-${model.fileId as unknown as string}`}
              checked={decision.mode === 'per-detection'}
              onChange={() => setMode('per-detection')}
            />{' '}
            {t('ingest.sendControl.perDetection')}
          </label>
        ) : null}
      </fieldset>

      {/* No-detections notice with the whole-file option still offered (R57.8). */}
      {model.noDetectionsNotice ? (
        <p role="status">
          <small>{t('ingest.sendControl.noDetections')}</small>
        </p>
      ) : (
        // Each Sensitive Detection presented individually with its category (R57.2),
        // with an allow/redact choice — only meaningful in per-detection mode.
        <ul data-detection-list>
          {model.detections.map((d) => {
            const isAllowed = allowed.has(d.id);
            return (
              <li key={d.id as unknown as string} data-detection-category={d.category}>
                <strong>{t(`ingest.sendControl.category.${d.category}`)}</strong>{' '}
                <label>
                  <input
                    type="checkbox"
                    checked={isAllowed}
                    disabled={decision.mode !== 'per-detection'}
                    onChange={(e) => toggleDetection(d.id, e.target.checked)}
                  />{' '}
                  {isAllowed
                    ? t('ingest.sendControl.allowed')
                    : t('ingest.sendControl.redacted')}
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <p>
        <Button onClick={onConfirm} disabled={decision.confirmed}>
          {decision.confirmed
            ? t('ingest.sendControl.confirmed')
            : t('ingest.sendControl.confirm')}
        </Button>
      </p>
    </section>
  );
}
