// The `CvRequest`-based CV generation flow with script-only fallback (task
// 28.1; design "Output_Engine" — Opportunity-driven tailoring flow; Requirements
// 30.5, 30.6, 30.7, 30.8, 30.9, 30.10, 35.6).
//
// {@link generateCv} is the single entry point the Output_Engine offers for
// producing a CV. It takes a {@link CvRequest} (the role, the confirmed evidence,
// the user's opt-in-first {@link AssistChoice}, and — only when the user
// indicated one — a {@link TargetOpportunity}) and returns a {@link CvBundle}:
// the single deterministic {@link CvModel} plus the {@link CvGenerationMode} that
// produced it, so the UI can always indicate WHETHER script-only generation was
// used (R30.7).
//
// The branch follows the design's opportunity-driven flow exactly:
//
//   * No Target Opportunity, OR the user declined AI assist (`script-only`), OR
//     no transport/destination is available → the SCRIPT-ONLY path: the CV is
//     assembled deterministically from confirmed evidence only ({@link
//     buildCvModel}), with ZERO provider calls, and the bundle is marked
//     `script-only` so the UI indicates it (R30.7).
//   * Target Opportunity provided + AI assist opted in → the AI-assisted path
//     runs through the shared opt-in-first {@link runAssist}: the SAME
//     deterministic CV model is the baseline, and the model is asked — via
//     {@link buildTailoringPayload}, routed through the Egress Gate (PII
//     pre-screened, private-excluded for keyed cloud) — for advisory tailoring
//     notes. The emitted CV model is ALWAYS the deterministic baseline; the AI
//     notes are confirm-before-entry suggestions that never alter it, so no
//     skill/metric/date/title/employer that appears only in the posting can ever
//     enter the CV (R30.8, No-Fabrication R37).
//   * The AI request fails → {@link runAssist} falls back to the deterministic
//     baseline with a non-blocking error; the bundle is marked `script-only`
//     with the error attached so the UI indicates script-only generation was
//     used (R30.7).
//
// This module imports NO provider client: the only path to a provider is the
// gate-routed {@link AssistTransport} the caller injects via {@link
// GenerateCvOptions}.

import type { OutputLocale, RolePreference } from '@core/types';
import {
  runAssist,
  type AssistChoice,
  type AssistError,
  type AssistSuggestion,
  type AssistTransport,
  type EgressDestination,
} from '@core/assist';
import { buildCvModel, type ConfirmedEvidence, type CvModel } from './cv-model';
import { createCvTailoringOperation, type CvTailoringSuggestion } from './output-assist';
import { type CvGenerationMode, type TargetOpportunity } from './tailoring';

/**
 * A CV generation request (design "Output_Engine"; R30). The confirmed evidence
 * is the ONLY source of claims (R30.1, R30.8); the optional Target Opportunity
 * is present only when the user indicated one (R30.5, R35.6) and is a tailoring
 * target only (R30.9); the {@link AssistChoice} is the user's pre-operation
 * opt-in-first selection (R30.6, R30.7).
 */
export interface CvRequest {
  /** The role the CV is tailored toward (R30.2). */
  readonly role: RolePreference;
  /** The confirmed evidence — the ONLY source of claims (R30.1, R30.8). */
  readonly src: ConfirmedEvidence;
  /** The user's opt-in-first selection: `script-only` | `ai-assisted` | `ai-only` (R30.6, R30.7). */
  readonly assist: AssistChoice;
  /** The Target Opportunity, present only when the user indicated one (R30.5, R35.6). */
  readonly opportunity?: TargetOpportunity;
  /**
   * The output locale, when the caller has resolved one (R41). Carried for
   * design fidelity; locale formatting is applied by the renderers via
   * `applyLocaleFormatting`, not by {@link generateCv}.
   */
  readonly locale?: OutputLocale;
}

/**
 * The result of {@link generateCv}: the single {@link CvModel} every format is
 * rendered from (R32.5), the {@link CvGenerationMode} that produced it, and —
 * for AI-assisted tailoring — the advisory, confirm-before-entry suggestions
 * (R22.6, R47.3). `scriptOnly` is the explicit indicator the UI surfaces to say
 * script-only generation was used (R30.7).
 */
export interface CvBundle {
  /** The single deterministic CV model from confirmed evidence (R30.1, R32.5). */
  readonly model: CvModel;
  /** Which path produced the CV (R30.7). */
  readonly mode: CvGenerationMode;
  /** `true` when script-only generation was used — surfaced to the user (R30.7). */
  readonly scriptOnly: boolean;
  /** Advisory AI tailoring notes requiring confirmation (empty on script-only). */
  readonly suggestions: readonly AssistSuggestion<CvTailoringSuggestion>[];
  /** Set only when an opted-in AI tailoring request failed (non-blocking, R30.7). */
  readonly error?: AssistError;
}

/** The gate-routed collaborators the AI-assisted path needs (DI). */
export interface GenerateCvOptions {
  /**
   * The gate-routed transport used for AI-assisted tailoring. Omit it (or supply
   * a `script-only` assist choice / no opportunity) to force the deterministic
   * script-only path. The transport MUST route through the Egress Gate.
   */
  readonly transport?: AssistTransport;
  /** The destination the AI request is bound for (provider + keyed/keyless). */
  readonly dest?: EgressDestination;
}

/** Build the deterministic script-only {@link CvBundle} (R30.7). Zero provider calls. */
const scriptOnlyBundle = (
  model: CvModel,
  error?: AssistError,
): CvBundle => ({
  model,
  mode: 'script-only',
  scriptOnly: true,
  suggestions: [],
  ...(error ? { error } : {}),
});

/**
 * Generate a CV for a {@link CvRequest}, applying the opportunity-driven
 * opt-in-first flow with script-only fallback (R30.5–R30.10).
 *
 * Runs the SCRIPT-ONLY path — a deterministic CV from confirmed evidence with
 * zero provider calls (R30.7) — when ANY of the following hold:
 *   - the user declined AI assist (`assist.mode === 'script-only'`),
 *   - the user gave no Target Opportunity (`opportunity` absent), or
 *   - no gate-routed transport / destination is available.
 *
 * Otherwise runs the AI-ASSISTED path via the shared {@link runAssist}: the same
 * deterministic CV model is the baseline, and the model is asked for advisory
 * tailoring notes through the Egress Gate ({@link buildTailoringPayload}: PII
 * pre-screened, private-excluded for keyed cloud, posting treated as a tailoring
 * target only). On provider failure it falls back to the deterministic baseline
 * with a non-blocking error and marks the bundle script-only (R30.7).
 *
 * The emitted CV model is ALWAYS the deterministic baseline, so no posting-only
 * fact can ever enter the CV (R30.8, No-Fabrication R37).
 */
export const generateCv = async (
  req: CvRequest,
  opts: GenerateCvOptions = {},
): Promise<CvBundle> => {
  const { transport, dest } = opts;

  // Script-only when the user declined AI, gave no opportunity, or no transport/
  // destination is available — a complete deterministic CV with zero calls (R30.7).
  if (req.assist.mode === 'script-only' || !req.opportunity || !transport || !dest) {
    return scriptOnlyBundle(buildCvModel(req.role, req.src));
  }

  // AI-assisted: baseline first, then gate-routed advisory tailoring notes. On
  // failure runAssist returns the deterministic baseline plus a non-blocking
  // error (R30.7), so the CV is never blocked.
  const operation = createCvTailoringOperation(transport);
  const { outcome, error } = await runAssist(
    operation,
    { role: req.role, evidence: req.src, opportunity: req.opportunity },
    req.assist,
    dest,
  );

  // A provider failure (or a degraded script-only outcome) → indicate
  // script-only generation was used (R30.7), carrying the non-blocking error.
  if (error || outcome.mode === 'script-only') {
    return scriptOnlyBundle(outcome.baseline, error);
  }

  return {
    model: outcome.baseline,
    mode: 'ai-tailored',
    scriptOnly: false,
    suggestions: outcome.suggestions,
  };
};
