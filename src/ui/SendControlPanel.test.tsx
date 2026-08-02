// Task 24.6 — Example tests for the send-control panel rendering (R57).
//
// Rendered to static markup (node environment, no DOM event loop) — asserts
// that all structural elements are present, locale strings resolve, and the
// panel reflects the model's state correctly.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createI18n, SUPPORTED_LANGUAGES } from '@core/locale';
import { asDetectionId, asFileId } from '@core/types';
import type { SendControlDecision, SendControlPanelModel } from '@core/egress';
import { SendControlPanel, type SendControlPanelProps } from './SendControlPanel';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FILE = asFileId('cv.pdf');

const detections = [
  { id: asDetectionId('ssn-10-21'), category: 'ssn' as const, start: 10, end: 21, value: '123-45-6789' },
  { id: asDetectionId('cc-30-49'), category: 'credit_card' as const, start: 30, end: 49, value: '4111-1111-1111-1111' },
];

const panelModel = (dest: 'keyed-cloud' | 'keyless-local', hasDetections = true): SendControlPanelModel => ({
  fileId: FILE,
  detections: hasDetections ? detections : [],
  destinationKind: dest,
  defaultDecision: {
    fileId: FILE,
    mode: dest === 'keyless-local' ? 'whole-file' : 'per-detection',
    allowedDetectionIds: [],
    confirmed: false,
  },
  noDetectionsNotice: !hasDetections,
});

const decision = (mode: 'whole-file' | 'per-detection', confirmed = false): SendControlDecision => ({
  fileId: FILE,
  mode,
  allowedDetectionIds: [],
  confirmed,
});

const renderPanel = async (
  model: SendControlPanelModel,
  dec: SendControlDecision,
  lng = 'en' as 'en' | 'pt-BR',
) => {
  const i18n = await createI18n(lng);
  const props: SendControlPanelProps = {
    docName: 'cv.pdf',
    model,
    decision: dec,
    onChange: vi.fn(),
    onConfirm: vi.fn(),
    t: i18n.t.bind(i18n),
  };
  return renderToStaticMarkup(<SendControlPanel {...props} />);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SendControlPanel — rendering (R57.2, R57.8)', () => {
  it('renders detection categories when detections are present', async () => {
    const html = await renderPanel(panelModel('keyed-cloud'), decision('per-detection'));
    // Should show the SSN and credit card categories
    expect(html).toContain('ssn');
    expect(html).toContain('credit_card');
  });

  it('renders the no-detections notice when the file is clean (R57.8)', async () => {
    const html = await renderPanel(panelModel('keyed-cloud', false), decision('whole-file'));
    // The panel should indicate no sensitive detections were found
    expect(html.toLowerCase()).toMatch(/no.*detect|clean|none/i);
  });

  it('renders the confirm button', async () => {
    const html = await renderPanel(panelModel('keyed-cloud'), decision('per-detection'));
    expect(html.toLowerCase()).toContain('confirm');
  });

  it.each(SUPPORTED_LANGUAGES)('resolves locale strings without raw keys for %s', async (lng) => {
    const html = await renderPanel(
      panelModel('keyed-cloud'),
      decision('per-detection'),
      lng as 'en' | 'pt-BR',
    );
    // No unresolved i18n key pattern (e.g. "sendControl.xxx") should appear
    expect(html).not.toMatch(/sendControl\.\w+/);
    expect(html).not.toMatch(/ingest\.sendControl\.\w+(?!.*<)/);
  });
});
