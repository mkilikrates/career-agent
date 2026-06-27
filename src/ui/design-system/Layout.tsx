// Responsive layout primitives (@ui/design-system) — task 29.2 (R58.3, R58.9).
//
// A single layout primitive used by every screen so the responsive rule applies
// uniformly. `<ResponsiveContainer>` constrains content to the viewport width
// (no horizontal scrolling on mobile, R58.9) and surfaces the active layout
// variant as a `data-layout` attribute switched on the 768px breakpoint (R58.3).
// `<Stack>` and `<Row>` are the wrapping/stacking building blocks: a `<Row>`
// lays controls out horizontally on desktop and stacks them vertically below the
// breakpoint, so nothing overflows horizontally.

import type { CSSProperties, ReactNode } from 'react';
import { tokens } from './tokens';
import { useViewportLayout, type LayoutVariant } from './layout';

export interface ResponsiveContainerProps {
  readonly children: ReactNode;
  /** Optional render-prop access to the active layout variant. */
  readonly render?: (layout: LayoutVariant) => ReactNode;
  readonly style?: CSSProperties;
}

/**
 * The single responsive container (R58.3, R58.9). Applies the `.ca-container`
 * rule (max-width, centring, no horizontal overflow) and exposes the active
 * layout variant via `data-layout` for styling/tests.
 */
export function ResponsiveContainer({ children, render, style }: ResponsiveContainerProps) {
  const layout = useViewportLayout();
  return (
    <div className="ca-container" data-layout={layout} style={style}>
      {render ? render(layout) : children}
    </div>
  );
}

export interface StackProps {
  readonly children: ReactNode;
  /** Gap between items, from the spacing token scale. Defaults to `md`. */
  readonly gap?: keyof typeof tokens.spacing;
  readonly style?: CSSProperties;
}

/** A vertical stack with token-driven spacing (never hardcoded). */
export function Stack({ children, gap = 'md', style }: StackProps) {
  return (
    <div
      className="ca-stack"
      style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[gap], ...style }}
    >
      {children}
    </div>
  );
}

export interface RowProps {
  readonly children: ReactNode;
  readonly style?: CSSProperties;
}

/**
 * A horizontal row that wraps and, below the breakpoint, stacks vertically
 * (R58.9). The wrapping/stacking behaviour lives in the `.ca-row` CSS so it is
 * uniform across screens.
 */
export function Row({ children, style }: RowProps) {
  return (
    <div className="ca-row" style={style}>
      {children}
    </div>
  );
}
