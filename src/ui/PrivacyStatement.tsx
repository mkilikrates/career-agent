// Privacy statement, consent control, and network-operation labels (@ui).
//
// Thin presentation for the @core/privacy models (R1.3, R1.4, R7.3, R42.1). It
// renders, in order:
//   * the privacy statement — every mandated declaration from
//     PRIVACY_STATEMENT_DECLARATIONS, resolved through i18n (R1.4, R42.1, R41.8);
//   * the informed-consent control for model training/improvement, defaulting
//     to NOT consented and reflecting the live ConsentState (R42.1);
//   * the third-party network-operation labels surfaced by the Egress Gate via
//     the NetworkLabelChannel, so the user sees each call (R7.3).
//
// All strings come from the externalised locale resources (R41.8); none are
// hardcoded here.

import {
  PRIVACY_STATEMENT_HEADING_KEY,
  privacyDeclarations,
  mayUseForTraining,
  type ConsentState,
} from '@core/privacy';
import type { NetworkOperationLabel } from '@core/egress';

export interface PrivacyStatementProps {
  /** Bound i18n translator (resolves externalised strings, R41.8). */
  readonly t: (key: string, options?: Record<string, unknown>) => string;
  /** The live consent decision for training/improvement use (R42.1). */
  readonly consent: ConsentState;
  /** Record an explicit grant of consent (R42.1). */
  readonly onGrantConsent: () => void;
  /** Record an explicit withdrawal of consent (R42.1). */
  readonly onRevokeConsent: () => void;
  /** Third-party network labels emitted by the Egress Gate so far (R7.3). */
  readonly networkLabels: readonly NetworkOperationLabel[];
  /**
   * Whether every selected provider is a Local Provider on the user's own
   * device (R1.5). When `true`, the statement declares the app is fully offline
   * and that no Redacted Payload leaves the device; when `false` (the default,
   * including when no provider is selected yet), it presents the cloud variant
   * declaring the app is not fully offline (R1.4).
   */
  readonly allLocal?: boolean;
}

/** Render the privacy statement, consent control, and network labels. */
export function PrivacyStatement({
  t,
  consent,
  onGrantConsent,
  onRevokeConsent,
  networkLabels,
  allLocal = false,
}: PrivacyStatementProps) {
  const consented = mayUseForTraining(consent);
  // Select the cloud (R1.4) or fully-offline (R1.5) declaration variant.
  const declarations = privacyDeclarations(allLocal);

  return (
    <section aria-label={t(PRIVACY_STATEMENT_HEADING_KEY)}>
      <h2>{t(PRIVACY_STATEMENT_HEADING_KEY)}</h2>

      {/* Every mandated declaration (R1.4, R1.5, R42.1), rendered from i18n (R41.8). */}
      {declarations.map((declaration) => (
        <p key={declaration.id} data-declaration={declaration.id}>
          {t(declaration.i18nKey)}
        </p>
      ))}

      {/* Informed-consent control — off by default (R42.1). */}
      <section aria-label={t('privacy.consent.heading')}>
        <h3>{t('privacy.consent.heading')}</h3>
        <p>{t('privacy.consent.description')}</p>
        <p>
          <small>
            {consented
              ? t('privacy.consent.statusGranted')
              : t('privacy.consent.statusExcluded')}
          </small>
        </p>
        {consented ? (
          <button type="button" onClick={onRevokeConsent}>
            {t('privacy.consent.revoke')}
          </button>
        ) : (
          <button type="button" onClick={onGrantConsent}>
            {t('privacy.consent.grant')}
          </button>
        )}
      </section>

      {/* Third-party network-operation labels surfaced by the Egress Gate (R7.3). */}
      <section aria-label={t('privacy.networkLabel.heading')}>
        <h3>{t('privacy.networkLabel.heading')}</h3>
        {networkLabels.length === 0 ? (
          <p>
            <small>{t('privacy.networkLabel.none')}</small>
          </p>
        ) : (
          <ul>
            {networkLabels.map((label, index) => (
              <li key={`${label.provider}-${label.operation}-${index}`}>
                <strong>
                  {label.thirdParty
                    ? t('privacy.networkLabel.thirdParty')
                    : t('privacy.networkLabel.localOnDevice')}
                </strong>
                : {label.description}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
