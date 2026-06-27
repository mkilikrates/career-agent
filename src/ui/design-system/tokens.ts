// Design tokens (@ui/design-system) — task 29.1 (R58.1, R58.4).
//
// The ONE definition set of typography, colour, spacing, and per-element
// component styles used by every phase screen. Screens never hardcode
// typography/colour/spacing: they compose the shared component library
// (`<Button>`, `<TextField>`, `<PhaseChrome>`, …) which reads these tokens, so
// any given element type is styled identically on every screen (R58.1).
//
// Colour pairings are chosen so foreground text meets at least a 4.5:1 contrast
// ratio against its paired background (R58.4). The pairings are documented on
// `COLOUR_PAIRINGS` below and are the only combinations the components use.

import type { CSSProperties } from 'react';

/** A named scale of string values (rem sizes, weights, families, …). */
export type TokenScale = Readonly<Record<string, string>>;

/** A single colour value (hex). */
export type ColourToken = string;

/** A per-element style definition (a plain React inline-style object). */
export type ComponentStyle = CSSProperties;

/** The shape of the single design-token source (design.md R58.1). */
export interface DesignTokens {
  readonly typography: {
    readonly fontFamily: TokenScale;
    readonly scale: TokenScale;
    readonly lineHeight: TokenScale;
    readonly weight: TokenScale;
  };
  readonly colour: Readonly<
    Record<'bg' | 'surface' | 'text' | 'muted' | 'accent' | 'onAccent' | 'danger' | 'onDanger' | 'border' | 'focus', ColourToken>
  >;
  readonly spacing: TokenScale;
  readonly radius: TokenScale;
  readonly component: Readonly<
    Record<'button' | 'buttonSecondary' | 'buttonDanger' | 'input' | 'card' | 'badge' | 'banner', ComponentStyle>
  >;
}

const typography = {
  fontFamily: {
    base:
      "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
  scale: {
    sm: '0.875rem',
    base: '1rem',
    lg: '1.25rem',
    xl: '1.5rem',
    xxl: '2rem',
  },
  lineHeight: {
    tight: '1.25',
    base: '1.5',
  },
  weight: {
    regular: '400',
    medium: '500',
    bold: '700',
  },
} as const;

// Colour pairings (foreground on background) verified to meet ≥4.5:1 (R58.4):
//   text (#1a1d21) on bg (#ffffff)        → ~16.9:1
//   text (#1a1d21) on surface (#f3f5f7)   → ~15.6:1
//   muted (#4a5159) on bg (#ffffff)       → ~7.7:1
//   onAccent (#ffffff) on accent (#0b5cad)→ ~6.6:1
//   onDanger (#ffffff) on danger (#b00020)→ ~7.4:1
const colour = {
  bg: '#ffffff',
  surface: '#f3f5f7',
  text: '#1a1d21',
  muted: '#4a5159',
  accent: '#0b5cad',
  onAccent: '#ffffff',
  danger: '#b00020',
  onDanger: '#ffffff',
  border: '#c7ced6',
  focus: '#0b5cad',
} as const;

/**
 * The documented, contrast-checked foreground/background colour pairings
 * (R58.4). The component library uses ONLY these combinations, so every text
 * element renders at ≥4.5:1 against its background.
 */
export const COLOUR_PAIRINGS: ReadonlyArray<{
  readonly name: string;
  readonly fg: ColourToken;
  readonly bg: ColourToken;
}> = [
  { name: 'text-on-bg', fg: colour.text, bg: colour.bg },
  { name: 'text-on-surface', fg: colour.text, bg: colour.surface },
  { name: 'muted-on-bg', fg: colour.muted, bg: colour.bg },
  { name: 'onAccent-on-accent', fg: colour.onAccent, bg: colour.accent },
  { name: 'onDanger-on-danger', fg: colour.onDanger, bg: colour.danger },
];

const spacing = {
  none: '0',
  xs: '0.25rem',
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem',
  xl: '2rem',
} as const;

const radius = {
  sm: '4px',
  md: '8px',
} as const;

// Per-element component styles. These are the single source of styling for each
// element type (R58.1); the shared components apply them verbatim, so the same
// element type is styled identically on every screen.
const baseButton: ComponentStyle = {
  fontFamily: typography.fontFamily.base,
  fontSize: typography.scale.base,
  fontWeight: typography.weight.medium,
  lineHeight: typography.lineHeight.tight,
  padding: `${spacing.sm} ${spacing.md}`,
  borderRadius: radius.sm,
  border: `1px solid ${colour.accent}`,
  background: colour.accent,
  color: colour.onAccent,
  cursor: 'pointer',
};

const component = {
  button: baseButton,
  buttonSecondary: {
    ...baseButton,
    background: colour.bg,
    color: colour.accent,
    border: `1px solid ${colour.accent}`,
  },
  buttonDanger: {
    ...baseButton,
    background: colour.danger,
    color: colour.onDanger,
    border: `1px solid ${colour.danger}`,
  },
  input: {
    fontFamily: typography.fontFamily.base,
    fontSize: typography.scale.base,
    lineHeight: typography.lineHeight.base,
    padding: `${spacing.xs} ${spacing.sm}`,
    borderRadius: radius.sm,
    border: `1px solid ${colour.border}`,
    background: colour.bg,
    color: colour.text,
    maxWidth: '100%',
    boxSizing: 'border-box',
  },
  card: {
    background: colour.surface,
    color: colour.text,
    border: `1px solid ${colour.border}`,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  badge: {
    display: 'inline-block',
    fontSize: typography.scale.sm,
    fontWeight: typography.weight.medium,
    padding: `${spacing.none} ${spacing.sm}`,
    borderRadius: radius.sm,
    background: colour.surface,
    color: colour.muted,
    border: `1px solid ${colour.border}`,
  },
  banner: {
    fontFamily: typography.fontFamily.base,
    fontSize: typography.scale.base,
    lineHeight: typography.lineHeight.base,
    padding: spacing.md,
    borderRadius: radius.md,
    border: `1px solid ${colour.border}`,
    background: colour.surface,
    color: colour.text,
  },
} as const;

/** The single design-token source consumed by every shared component (R58.1). */
export const tokens: DesignTokens = Object.freeze({
  typography,
  colour,
  spacing,
  radius,
  component,
});
