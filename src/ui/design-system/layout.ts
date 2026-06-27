// Responsive layout logic (@ui/design-system) — task 29.2 (R58.3, R58.9).
//
// A single source for the responsive breakpoint and the pure width→layout
// mapping, kept framework-agnostic so it is unit-testable without a DOM:
//
//   - viewport width ≥ 768 CSS px → desktop layout (R58.3);
//   - 320–767 px              → mobile layout (R58.9).
//
// The container component (`<ResponsiveContainer>`) and the global stylesheet
// constrain content to the viewport width with wrapping/stacking so there is no
// horizontal scrolling of page content on mobile (R58.9). This module owns only
// the breakpoint and the decision function; the visual rule lives in CSS so it
// applies uniformly across every screen.

import { useEffect, useState } from 'react';

/** The single responsive breakpoint, in CSS pixels (R58.3, R58.9). */
export const BREAKPOINT_PX = 768;

/** The two layout variants the app switches between. */
export type LayoutVariant = 'desktop' | 'mobile';

/**
 * Pure width→layout mapping (R58.3, R58.9). A viewport at least
 * {@link BREAKPOINT_PX} wide is the desktop layout; anything narrower is the
 * mobile layout. Deterministic and DOM-free so it can be asserted directly.
 */
export function layoutForWidth(widthPx: number): LayoutVariant {
  return widthPx >= BREAKPOINT_PX ? 'desktop' : 'mobile';
}

/** The CSS media query that selects the desktop layout (≥ breakpoint). */
export const DESKTOP_MEDIA_QUERY = `(min-width: ${BREAKPOINT_PX}px)`;

/**
 * Observe the current layout variant from the live viewport width (R58.3,
 * R58.9). Subscribes to a `matchMedia` change so the variant updates on resize
 * / orientation change. In a non-DOM environment (SSR / tests) it falls back to
 * the desktop layout; the CSS media queries still drive the actual rendering, so
 * this hook only surfaces the variant as a `data-layout` attribute.
 */
export function useViewportLayout(): LayoutVariant {
  const read = (): LayoutVariant => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return 'desktop';
    }
    return window.matchMedia(DESKTOP_MEDIA_QUERY).matches ? 'desktop' : 'mobile';
  };

  const [variant, setVariant] = useState<LayoutVariant>(read);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const onChange = () => setVariant(mql.matches ? 'desktop' : 'mobile');
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return variant;
}
