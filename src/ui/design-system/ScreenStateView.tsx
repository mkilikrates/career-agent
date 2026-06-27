// Shared screen-state views (@ui/design-system) — task 29.5 (R58.6, R58.7, R58.8).
//
// The presentational counterparts to the `ScreenState` model, used by every
// phase screen so empty/loading/error rendering is identical everywhere. Each
// view carries the right ARIA semantics so the state change is announced to
// screen readers (R58.4):
//   - <EmptyState>      names ≥1 next action (R58.6);
//   - <LoadingIndicator> a polite live status with aria-busy (R58.7);
//   - <ErrorState>      an alert that describes the failure + recovery (R58.8).
//
// Screens keep their own input state across an error render, so a shown
// <ErrorState> never discards the user's prior input (R58.8).

import type { ReactNode } from 'react';
import { Banner } from './components';

export interface EmptyStateProps {
  /** The empty-state message; MUST name at least one next action (R58.6). */
  readonly message: ReactNode;
  /** Optional inline affordance (e.g. a button) for the named next action. */
  readonly action?: ReactNode;
}

/** Empty state — names at least one action the user can take next (R58.6). */
export function EmptyState({ message, action }: EmptyStateProps) {
  return (
    <Banner role="status" data-testid="screen-empty">
      <span data-screen-state="empty">{message}</span>
      {action ? <div style={{ marginTop: '0.5rem' }}>{action}</div> : null}
    </Banner>
  );
}

export interface LoadingIndicatorProps {
  /** The loading message announced to assistive tech (R58.7). */
  readonly message: ReactNode;
}

/**
 * Loading indicator — rendered the moment an operation starts, so it appears
 * well within the 1s budget, and removed by the screen on completion (R58.7).
 * `aria-busy` + a polite live region announce the in-progress state (R58.4).
 */
export function LoadingIndicator({ message }: LoadingIndicatorProps) {
  return (
    <Banner role="status" data-testid="screen-loading" style={{ }}>
      <span data-screen-state="loading" aria-busy="true">
        {message}
      </span>
    </Banner>
  );
}

export interface ErrorStateProps {
  /** A human description of what failed (R58.8). */
  readonly message: ReactNode;
  /** The recovery action the user can take (R58.8). */
  readonly recovery: ReactNode;
  /** Optional inline affordance (e.g. a retry button) for the recovery action. */
  readonly action?: ReactNode;
}

/**
 * Error state — describes the failure and names the recovery action (R58.8).
 * Rendered as an assertive alert so it is announced. The screen preserves its
 * input state behind this view, so prior input is never lost (R58.8).
 */
export function ErrorState({ message, recovery, action }: ErrorStateProps) {
  return (
    <Banner role="alert" tone="danger" data-testid="screen-error">
      <p data-screen-state="error" style={{ margin: 0 }}>
        {message}
      </p>
      <p data-screen-recovery style={{ margin: '0.25rem 0 0' }}>
        <small>{recovery}</small>
      </p>
      {action ? <div style={{ marginTop: '0.5rem' }}>{action}</div> : null}
    </Banner>
  );
}
