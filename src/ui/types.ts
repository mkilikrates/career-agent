// @ui/types — shared UI type definitions.
//
// Type-only module for interfaces shared across multiple screens.

import type { AssistMode } from '@core/assist';

/**
 * The common AI-assist props repeated across every screen that wires the opt-in
 * AI assist surface. Extracted to avoid duplication. Screens extend or intersect
 * this interface for their specific props.
 */
export interface AiAssistProps {
  /** Whether an AI provider key is configured (opt-in assist, R42.1). */
  readonly aiAvailable?: boolean;
  /** Routes a prompt through the Egress Gate; returns the model's text. */
  readonly aiAssist?: (prompt: string) => Promise<string>;
  /** The chosen chat provider id for the destination label, or null. */
  readonly chatProvider?: string | null;
  /** Whether the chosen chat provider is a keyless local on-device provider. */
  readonly chatIsLocal?: boolean;
  /** The pipeline-wide AI-assist mode (chosen up front, applied as default). */
  readonly assistMode: AssistMode;
  /** Change the pipeline-wide AI-assist mode (persisted by the shell). */
  readonly onAssistMode: (mode: AssistMode) => void;
}
