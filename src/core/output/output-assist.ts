// Output_Engine AI-assist operation (capability `cv_tailoring`) routed through
// the shared opt-in-first contract (task 25.2; design "AI Assist Opt-In-First
// Pattern" + "Output_Engine").
//
// Adapts the Output_Engine to the shared {@link BaseAssistableOperation}:
//   - `scriptOnly` → the deterministic single {@link buildCvModel} tailored from
//     confirmed evidence (R30.1–R30.4) with ZERO provider calls (R30.7). The
//     transport is never reached, so the CV is produced entirely on-device.
//   - `aiAssisted` → the SAME deterministic CV model PLUS AI tailoring notes as
//     confirm-before-entry {@link AssistSuggestion}s (R47.3): phrasing/emphasis
//     suggestions the user reviews and confirms before they change the CV. The
//     baseline model is always carried in full, so AI supplements never replace
//     the evidence-derived CV (R22.6 supplement-not-replace).
//
// All provider access is via the injected gate-routed {@link AssistTransport};
// the prompt sends only the already-confirmed, output-eligible CV text (no raw
// Memory Store files). Suggestions are advisory until confirmed — nothing the
// model returns is woven into the CV automatically (No-Fabrication, R47.6).

import {
  BaseAssistableOperation,
  type AssistTransport,
  type EgressDestination,
} from '@core/assist';
import type { RolePreference } from '@core/types';
import { buildCvModel, type ConfirmedEvidence, type CvModel } from './cv-model';
import { buildTailoringPayload, type TargetOpportunity } from './tailoring';

/** Input to the CV-tailoring assist operation. */
export interface CvTailoringInput {
  /** The target role the CV is tailored toward (R30.2). */
  readonly role: RolePreference;
  /** The confirmed evidence the deterministic CV model is built from (R30.1). */
  readonly evidence: ConfirmedEvidence;
  /**
   * The Target Opportunity to tailor toward, when the user supplied one (R30.6).
   * When present, the AI request carries the job-posting text as a tailoring
   * target (never a claim source, R30.9) via {@link buildTailoringPayload};
   * when absent, the model is asked to tailor toward the role alone. Either way
   * the deterministic baseline is unchanged, so no posting-only fact can leak.
   */
  readonly opportunity?: TargetOpportunity;
}

/** A single AI CV-tailoring note (a suggestion requiring confirmation, R47.3). */
export type CvTailoringSuggestion = string;

/** Parse a model reply into distinct tailoring notes (one per non-empty line). */
export function parseTailoringNotes(reply: string): CvTailoringSuggestion[] {
  const out: CvTailoringSuggestion[] = [];
  const seen = new Set<string>();
  for (const raw of reply.split('\n')) {
    const line = raw.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim();
    if (line.length < 4) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/** Build the tailoring prompt from the deterministic CV model (skills + bullets). */
export function buildCvTailoringPrompt(model: CvModel): string {
  const skills = model.skills.map((s) => s.name).join(', ');
  const bullets = model.experience.map((b) => `- ${b.text}`).join('\n');
  return (
    `You are helping tailor a CV for the role of "${model.targetRole.title}". ` +
    'Suggest up to 5 short, advisory edits to better target this role (emphasis, ' +
    'ordering, phrasing). Do NOT invent experience, metrics, or skills the ' +
    'candidate did not provide. Return one suggestion per line, no preamble.\n\n' +
    `Skills: ${skills}\n\nExperience bullets:\n${bullets}`
  );
}

/**
 * The Output_Engine's `cv_tailoring` operation. `scriptOnly` is the
 * deterministic single CV model; `aiAssisted` adds AI tailoring notes as
 * confirm-before-entry suggestions alongside the model (R22.6, R47.3).
 */
export class CvTailoringOperation extends BaseAssistableOperation<
  CvTailoringInput,
  CvModel,
  CvTailoringSuggestion
> {
  constructor(private readonly transport: AssistTransport) {
    super();
  }

  /** Deterministic single CV model from confirmed evidence (R30). Zero calls. */
  protected computeBaseline(input: CvTailoringInput): CvModel {
    return buildCvModel(input.role, input.evidence);
  }

  /** Ask the model for advisory tailoring notes on the built CV model. */
  protected async fetchSuggestions(
    input: CvTailoringInput,
    dest: EgressDestination,
    baseline: CvModel,
  ): Promise<readonly CvTailoringSuggestion[]> {
    // With a Target Opportunity, the request carries the job-posting text as a
    // tailoring target (never a claim source, R30.9), routed through the gate
    // by the transport; without one, tailor toward the role alone (R30.2).
    // Either way the deterministic baseline is unchanged, so no posting-only
    // fact can enter the CV (R30.8, No-Fabrication R37).
    const prompt = input.opportunity
      ? buildTailoringPayload(input.evidence, input.opportunity, dest)
      : buildCvTailoringPrompt(baseline);
    const reply = await this.transport(prompt, dest);
    return parseTailoringNotes(reply);
  }
}

/** Construct a {@link CvTailoringOperation} bound to a gate-routed transport. */
export function createCvTailoringOperation(
  transport: AssistTransport,
): CvTailoringOperation {
  return new CvTailoringOperation(transport);
}
