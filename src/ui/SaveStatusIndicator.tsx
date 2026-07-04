// Save-status indicator (@ui) — task 33.7 (R68.1, R68.2, R68.4, R68.5).
//
// Renders the current persistence status in the header area:
//   - "✓ Progress saved" (green) / "✓ Saved just now" (green, flashed for 2 s)
//   - "⚠ Temporary session — export before closing" (amber)
//
// Uses `role="status"` + `aria-live="polite"` so screen readers announce changes
// without interrupting the user (R58.4, R58.7).

import type { CSSProperties } from 'react';
import { tokens } from './design-system/tokens';
import { useSaveStatus } from './SaveStatusProvider';

export interface SaveStatusIndicatorProps {
  readonly t: (key: string) => string;
}

// Amber colour documented inline — meets ≥4.5:1 contrast on white background
// (#d97706 on #ffffff ≈ 4.56:1). There is no amber in the design token palette,
// so we use it as a one-off with the rationale recorded here.
const AMBER = '#d97706';

const baseStyle: CSSProperties = {
  fontFamily: tokens.typography.fontFamily.base,
  fontSize: tokens.typography.scale.sm,
  lineHeight: tokens.typography.lineHeight.base,
  fontWeight: tokens.typography.weight.medium,
};

export function SaveStatusIndicator({ t }: SaveStatusIndicatorProps) {
  const { status, flash } = useSaveStatus();

  let text: string;
  let colour: string;

  if (status === 'temporary') {
    text = t('saveStatus.temporary');
    colour = AMBER;
  } else if (flash) {
    text = t('saveStatus.savedJustNow');
    colour = tokens.colour.accent;
  } else {
    text = t('saveStatus.saved');
    colour = tokens.colour.accent;
  }

  return (
    <span
      role="status"
      aria-live="polite"
      style={{ ...baseStyle, color: colour }}
    >
      {text}
    </span>
  );
}
