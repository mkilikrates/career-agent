// Shared design system (@ui/design-system) — task 29 (Requirement 58).
//
// The single source of design tokens plus the reusable layout, accessibility,
// component, phase-chrome, and screen-state primitives that EVERY phase screen
// composes. Consistency is structural — screens never hardcode typography,
// colour, or spacing; they import from here.

export { tokens, COLOUR_PAIRINGS } from './tokens';
export type {
  DesignTokens,
  TokenScale,
  ColourToken,
  ComponentStyle,
} from './tokens';

export {
  BREAKPOINT_PX,
  DESKTOP_MEDIA_QUERY,
  layoutForWidth,
  useViewportLayout,
} from './layout';
export type { LayoutVariant } from './layout';

export { ResponsiveContainer, Stack, Row } from './Layout';

export { Button, TextField, TextArea, Select, Card, Badge, Banner } from './components';
export type {
  ButtonProps,
  ButtonVariant,
  TextFieldProps,
  TextAreaProps,
  SelectProps,
  CardProps,
  BadgeProps,
  BannerProps,
  BannerTone,
} from './components';

export { PhaseChrome } from './PhaseChrome';
export type { PhaseChromeProps } from './PhaseChrome';

export {
  emptyState,
  loadingState,
  errorState,
  readyState,
} from './screen-state';
export type { ScreenState, ActionLabel } from './screen-state';

export { EmptyState, LoadingIndicator, ErrorState } from './ScreenStateView';
export type { EmptyStateProps, LoadingIndicatorProps, ErrorStateProps } from './ScreenStateView';
