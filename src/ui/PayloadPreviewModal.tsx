// Outbound Payload Preview modal (@ui) — task 32.3, 40.2 (Requirements 65, 74.4).
//
// The thin presentation boundary for the Egress Gate's Payload Preview seam
// (R65, R74.4). Before a TEXT payload reaches a provider, the gate calls the
// injected `previewPayload` callback (see `runtime.ts`) which the React shell
// fulfils by rendering THIS modal. It shows the EXACT outbound text in an
// editable textarea so the user may freely edit or remove any wording
// (R65.1, R65.2). Approving resolves the user-approved (possibly edited) text —
// which the gate then PII pre-screens before transmission (R65.3) — while
// Cancel resolves `null`, so the gate fails closed and transmits nothing,
// preserving prior state (R65.4).
//
// For a **Local Provider** (`preview.informational === true`), the modal renders
// as a non-blocking informational notice with a "this stays on your device"
// label (R74.4). The user can dismiss it at any time; it does not block the
// send. The gate fires the callback as fire-and-forget for local providers.
//
// The modal is accessible (R58.4): it is a labelled `role="dialog"` with
// `aria-modal`, moves focus to the editable text on open, and Cancels on Esc.
// Every user-facing string is read from the externalised locale resources via
// `t(...)` (R41.8); none are hardcoded here. It imports no provider client — the
// transmission decision is owned entirely by the Egress Gate (Requirements 6, 7).

import { useEffect, useId, useRef, useState } from 'react';
import type { PayloadPreview } from '@core/egress';
import { Button, TextArea, tokens } from './design-system';

export interface PayloadPreviewModalProps {
  /** The exact outbound text to review, plus the destination provider/operation. */
  readonly preview: PayloadPreview;
  /** Resolve the preview with the user-approved (possibly edited) text (R65.2). */
  readonly onApprove: (text: string) => void;
  /** Resolve the preview with cancellation — transmit nothing (R65.4). */
  readonly onCancel: () => void;
  /** Bound i18n translator (resolves externalised strings, R41.8). */
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}

/**
 * Render the modal that surfaces the exact outbound payload for review/editing
 * before a send (R65, R74.4). When `preview.informational` is true (Local
 * Provider), renders as a non-blocking informational notice with a "this stays
 * on your device" label and a dismiss button. When false (third-party), renders
 * the blocking approval flow. Holds only the editable-text UI state; the
 * approve/cancel decision is handed back to the shell, which resolves the gate's
 * pending `previewPayload` promise.
 */
export function PayloadPreviewModal({ preview, onApprove, onCancel, t }: PayloadPreviewModalProps) {
  const informational = preview.informational === true;
  // The editable working copy, seeded with the exact outbound text (R65.1).
  const [text, setText] = useState(preview.text);
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const descriptionId = useId();

  // Move focus into the editable text on open and Cancel/Dismiss on Esc (R58.4).
  // For an informational preview, Esc dismisses (resolves the original text).
  useEffect(() => {
    if (!informational) {
      dialogRef.current?.querySelector('textarea')?.focus();
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (informational) {
          onApprove(preview.text);
        } else {
          onCancel();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel, onApprove, informational, preview.text]);

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: tokens.spacing.md,
        zIndex: 1000,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
        ref={dialogRef}
        style={{
          ...tokens.component.card,
          background: tokens.colour.bg,
          maxWidth: '40rem',
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <h2 id={headingId} style={{ marginTop: 0 }}>
          {informational
            ? t('payloadPreview.headingLocal')
            : t('payloadPreview.heading')}
        </h2>
        <p id={descriptionId}>
          {informational
            ? t('payloadPreview.introLocal', { provider: preview.provider })
            : t('payloadPreview.intro', { provider: preview.provider })}
        </p>
        {informational && (
          <p
            style={{
              fontWeight: 600,
              color: tokens.colour.accent,
              marginTop: 0,
            }}
            aria-live="polite"
          >
            {t('payloadPreview.localLabel')}
          </p>
        )}
        {informational ? (
          <TextArea
            label={t('payloadPreview.textareaLabel')}
            value={preview.text}
            rows={12}
            readOnly
          />
        ) : (
          <TextArea
            label={t('payloadPreview.textareaLabel')}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={12}
          />
        )}
        <div
          style={{
            display: 'flex',
            gap: tokens.spacing.sm,
            justifyContent: 'flex-end',
            marginTop: tokens.spacing.md,
            flexWrap: 'wrap',
          }}
        >
          {informational ? (
            <Button variant="primary" onClick={() => onApprove(preview.text)}>
              {t('payloadPreview.dismiss')}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={onCancel}>
                {t('payloadPreview.cancel')}
              </Button>
              <Button variant="primary" onClick={() => onApprove(text)}>
                {t('payloadPreview.approve')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
