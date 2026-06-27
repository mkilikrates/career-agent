// Shared screen-state model (@ui/design-system) — task 29.5 (R58.6, R58.7, R58.8).
//
// One state machine used by every phase screen so empty/loading/error behaviour
// is identical everywhere:
//   - empty   — the screen has no content; names ≥1 next action (R58.6);
//   - loading — an operation is running; the indicator shows within 1s of start
//               and is removed on completion (R58.7);
//   - error   — an operation failed; describes the failure, names the recovery
//               action, and retains the user's prior input without loss (R58.8);
//   - ready   — content to display.
//
// This module is framework-agnostic (pure data + constructors) so it can be
// asserted directly; `<ScreenStateView>` renders it.

/** A short, user-facing action label (e.g. "Add a document"). */
export type ActionLabel = string;

/** The shared screen-state union (design.md R58.6–R58.8). */
export type ScreenState<T> =
  | { readonly kind: 'empty'; readonly nextAction: ActionLabel }
  | { readonly kind: 'loading'; readonly startedAt: number; readonly message?: string }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly recovery: ActionLabel;
      /**
       * The user's prior input, retained without loss so the screen can restore
       * it after an error (R58.8). Opaque to this module.
       */
      readonly preserved?: unknown;
    }
  | { readonly kind: 'ready'; readonly data: T };

/** Build an empty state naming at least one next action (R58.6). */
export const emptyState = (nextAction: ActionLabel): ScreenState<never> => ({
  kind: 'empty',
  nextAction,
});

/**
 * Build a loading state. `startedAt` defaults to now so callers can begin the
 * operation and render the indicator in the same tick — well within the 1s
 * budget (R58.7).
 */
export const loadingState = (
  message?: string,
  startedAt: number = Date.now(),
): ScreenState<never> => ({ kind: 'loading', startedAt, ...(message ? { message } : {}) });

/**
 * Build an error state that describes the failure, names the recovery action,
 * and carries the user's preserved prior input (R58.8).
 */
export const errorState = (
  message: string,
  recovery: ActionLabel,
  preserved?: unknown,
): ScreenState<never> => ({ kind: 'error', message, recovery, preserved });

/** Build a ready state with content. */
export const readyState = <T>(data: T): ScreenState<T> => ({ kind: 'ready', data });
