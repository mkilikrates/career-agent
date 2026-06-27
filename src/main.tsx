// Polyfills must load before any module that uses Node globals (gray-matter →
// Buffer). Keep this import first.
import './polyfills';

// Shared design-system base styles: responsive container + 768px breakpoint
// (R58.3, R58.9), the visible :focus-visible indicator (R58.10), and the
// token-driven document base typography/colour (R58.1). Loaded once here so the
// rules apply uniformly to every phase screen.
import './ui/design-system/global.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@ui/App';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
