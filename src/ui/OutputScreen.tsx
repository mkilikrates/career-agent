// Output Generation screen (@ui) — Phase 5 (R30–R33, R31).
//
// Builds the single CvModel from confirmed evidence (skill map + confirmed
// talking points + confirmed extracted items) tailored to a target role, renders
// the Markdown CV (primary output, R32.1), and the advisory LinkedIn report
// (R31). Saves both to the Memory Store `outputs/`. Pure engine calls
// (`@core/output`) — no provider is touched (PDF/DOCX renderers need an injected
// Wasm/OOXML boundary and are left for a later UI pass).

import { useMemo, useState } from 'react';
import type { ExtractedItem, RolePreference, TalkingPoint } from '@core/types';
import { MemoryTree, CANONICAL_FILES, cvPath } from '@core/storage';
import type { SkillMap } from '@core/skills';
import {
  renderMarkdown,
  renderDocx,
  renderPdf,
  buildLinkedInReport,
  renderLinkedInReportMarkdown,
  generateCv,
  targetOpportunity,
  type ConfirmedEvidence,
  type CvModel,
  type CvRequest,
  type TypstCompiler,
} from '@core/output';
import { type AssistMode, type AssistTransport, type EgressDestination } from '@core/assist';
import { AssistChoice } from './AssistChoice';
import {
  Banner,
  Button,
  EmptyState,
  LoadingIndicator,
  Row,
  Select,
  TextArea,
  tokens,
} from './design-system';

/** How the user chose to supply a Target Opportunity to tailor toward (R30.5). */
type OpportunityChoice = 'none' | 'paste' | 'upload';

export interface OutputScreenProps {
  readonly skillMap: SkillMap | null;
  readonly rolePrefs: RolePreference[];
  readonly talkingPoints: TalkingPoint[];
  readonly extractions: ExtractedItem[];
  readonly store: MemoryTree;
  /** Typst-Wasm compiler for client-side ATS-safe PDF (R32.2). */
  readonly pdfCompiler: TypstCompiler;
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
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}

export function OutputScreen({
  skillMap,
  rolePrefs,
  talkingPoints,
  extractions,
  store,
  pdfCompiler,
  aiAvailable = false,
  aiAssist,
  chatProvider = null,
  chatIsLocal = false,
  assistMode,
  onAssistMode,
  t,
}: OutputScreenProps) {
  const [roleSlug, setRoleSlug] = useState<string>(
    rolePrefs[0] ? (rolePrefs[0].slug as unknown as string) : '',
  );
  const [cvMarkdown, setCvMarkdown] = useState<string>('');
  const [cvModel, setCvModel] = useState<CvModel | null>(null);
  const [linkedIn, setLinkedIn] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [pdfBusy, setPdfBusy] = useState(false);

  // Opt-in-first AI CV tailoring (R30.7): the pipeline-wide choice surfaced by
  // <AssistChoice>, plus advisory AI tailoring notes that never alter the
  // deterministic CV until the user acts on them (R22.6, R47.3).
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNotes, setAiNotes] = useState<string[]>([]);
  const [aiError, setAiError] = useState<string>('');
  // The Target Opportunity intake (R30.5, R30.6): does the user have a posting to
  // tailor toward, and (when so) its text — held in-session only as a tailoring
  // target, never a claim source (R30.9).
  const [oppChoice, setOppChoice] = useState<OpportunityChoice>('none');
  const [oppText, setOppText] = useState<string>('');
  const [oppSource, setOppSource] = useState<'pasted' | 'uploaded'>('pasted');
  // Which generation path produced the current CV, surfaced to the user (R30.7).
  const [genNote, setGenNote] = useState<string>('');

  /** A gate-routed transport for the AI path; empty reply when no AI is wired. */
  const transport = useMemo<AssistTransport>(
    () => (prompt) => (aiAssist ? aiAssist(prompt) : Promise.resolve('')),
    [aiAssist],
  );

  const role = rolePrefs.find((r) => (r.slug as unknown as string) === roleSlug);

  const evidence = useMemo<ConfirmedEvidence | null>(
    () =>
      skillMap
        ? { skillMap, talkingPoints, items: extractions }
        : null,
    [skillMap, talkingPoints, extractions],
  );

  /** The chosen destination for an AI request (provider + keyed/keyless). */
  const dest = useMemo<EgressDestination | null>(
    () =>
      chatProvider
        ? { provider: chatProvider, kind: chatIsLocal ? 'keyless-local' : 'keyed-cloud' }
        : null,
    [chatProvider, chatIsLocal],
  );

  /** Build the in-session TargetOpportunity from the intake, when one applies (R30.6). */
  const buildOpportunity = () =>
    oppChoice !== 'none' && oppText.trim().length > 0
      ? targetOpportunity(oppSource, oppText)
      : undefined;

  /** Apply a generated CvBundle to the screen, surfacing the generation mode (R30.7). */
  const applyBundle = (
    model: CvModel,
    scriptOnly: boolean,
    notes: readonly string[],
    fallbackReason?: string,
  ) => {
    setCvModel(model);
    setCvMarkdown(renderMarkdown(model));
    if (evidence) setLinkedIn(renderLinkedInReportMarkdown(buildLinkedInReport(evidence)));
    setAiNotes([...notes]);
    setGenNote(scriptOnly ? t('output.scriptOnlyUsed') : t('output.aiTailoredUsed'));
    setAiError(fallbackReason ? t('assist.fallback', { reason: fallbackReason }) : '');
  };

  // Deterministic, script-only generation: a complete CV from confirmed evidence
  // with ZERO provider calls (R30.7). Used when the user has not opted into AI.
  const handleGenerate = async () => {
    if (!role || !evidence) return;
    const req: CvRequest = {
      role,
      src: evidence,
      assist: { mode: 'script-only', capability: 'cv_tailoring' },
    };
    const bundle = await generateCv(req);
    applyBundle(bundle.model, bundle.scriptOnly, bundle.suggestions.map((s) => s.value));
    setStatus('');
  };

  // AI-assisted, opportunity-driven tailoring (R30.6): the CV model is the SAME
  // deterministic baseline; the AI returns advisory notes routed through the
  // Egress Gate, and on failure generateCv falls back to script-only (R30.7).
  const handleAiTailor = async () => {
    if (!role || !evidence) return;
    setAiBusy(true);
    setAiError('');
    try {
      const req: CvRequest = {
        role,
        src: evidence,
        assist: { mode: assistMode, capability: 'cv_tailoring' },
        opportunity: buildOpportunity(),
      };
      const bundle = await generateCv(req, {
        transport,
        dest: dest ?? undefined,
      });
      applyBundle(
        bundle.model,
        bundle.scriptOnly,
        bundle.suggestions.map((s) => s.value),
        bundle.error?.message,
      );
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setAiBusy(false);
    }
  };

  /** Trigger a client-side download of `data` as `filename`. */
  const download = (data: BlobPart, filename: string, mime: string) => {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadMarkdown = () => {
    if (!role || cvMarkdown.length === 0) return;
    download(cvMarkdown, `cv_${role.slug as unknown as string}.md`, 'text/markdown');
  };

  const handleDownloadDocx = async () => {
    if (!role || !cvModel) return;
    try {
      const bytes = await renderDocx(cvModel);
      // Copy into a definite ArrayBuffer so the Blob type-checks (the renderer
      // returns Uint8Array<ArrayBufferLike>).
      const buffer = bytes.slice().buffer as ArrayBuffer;
      download(
        buffer,
        `cv_${role.slug as unknown as string}.docx`,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDownloadPdf = async () => {
    if (!role || !cvModel) return;
    setPdfBusy(true);
    setStatus(t('output.pdfGenerating'));
    // renderPdf never throws: it returns a graceful result, so a Typst failure
    // can never block the Markdown/DOCX formats (R32.2).
    const result = await renderPdf(cvModel, pdfCompiler);
    setPdfBusy(false);
    if (!result.ok) {
      setStatus(t('output.pdfFailed', { reason: result.error }));
      return;
    }
    const buffer = result.bytes.slice().buffer as ArrayBuffer;
    download(buffer, `cv_${role.slug as unknown as string}.pdf`, 'application/pdf');
    setStatus(t('output.pdfReady'));
  };

  const handleSave = () => {
    if (!role || cvMarkdown.length === 0) return;
    try {
      store.write(cvPath(role.slug, 1, 'md'), cvMarkdown);
      if (linkedIn.length > 0) {
        store.write(CANONICAL_FILES.linkedinRecommendations, linkedIn);
      }
      store.logAction(`Generated CV + LinkedIn report for "${role.title}".`);
      setStatus(t('output.saved'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  if (rolePrefs.length === 0 || !skillMap) {
    return (
      <section aria-label={t('output.heading')} data-output-screen>
        <h3>{t('output.heading')}</h3>
        <EmptyState message={t('output.needRoles')} />
      </section>
    );
  }

  return (
    <section aria-label={t('output.heading')} data-output-screen>
      <h3>{t('output.heading')}</h3>
      <p>{t('output.intro')}</p>

      <Row>
        <Select
          label={t('output.roleLabel')}
          value={roleSlug}
          onChange={(e) => {
            setRoleSlug(e.target.value);
            setCvMarkdown('');
            setCvModel(null);
            setLinkedIn('');
            setAiNotes([]);
            setGenNote('');
          }}
        >
          {rolePrefs.map((r) => (
            <option key={r.slug as unknown as string} value={r.slug as unknown as string}>
              {r.title}
            </option>
          ))}
        </Select>
        <Button onClick={() => void handleGenerate()}>{t('output.generate')}</Button>
      </Row>

      {/* Target Opportunity intake (R30.5, R30.6): ask whether the user has a
          posting to tailor toward; the posting is a tailoring target only and
          never a claim source (R30.9). */}
      <fieldset style={{ margin: '0.5rem 0' }} data-opportunity-intake>
        <legend>{t('output.opportunity.legend')}</legend>
        <p>
          <small>{t('output.opportunity.question')}</small>
        </p>
        <label>
          <input
            type="radio"
            name="opportunity-choice"
            checked={oppChoice === 'none'}
            onChange={() => setOppChoice('none')}
          />{' '}
          {t('output.opportunity.none')}
        </label>{' '}
        <label>
          <input
            type="radio"
            name="opportunity-choice"
            checked={oppChoice === 'paste'}
            onChange={() => {
              setOppChoice('paste');
              setOppSource('pasted');
            }}
          />{' '}
          {t('output.opportunity.paste')}
        </label>{' '}
        <label>
          <input
            type="radio"
            name="opportunity-choice"
            checked={oppChoice === 'upload'}
            onChange={() => {
              setOppChoice('upload');
              setOppSource('uploaded');
            }}
          />{' '}
          {t('output.opportunity.upload')}
        </label>
        {oppChoice === 'upload' ? (
          <p>
            <input
              type="file"
              accept=".txt,.md,text/plain,text/markdown"
              aria-label={t('output.opportunity.upload')}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setOppText(await file.text());
              }}
            />
          </p>
        ) : null}
        {oppChoice !== 'none' ? (
          <p>
            <TextArea
              label={t('output.opportunity.pasteLabel')}
              value={oppText}
              onChange={(e) => setOppText(e.target.value)}
              placeholder={t('output.opportunity.pastePlaceholder')}
              rows={5}
            />
          </p>
        ) : null}
        <p>
          <small>{t('output.opportunity.note')}</small>
        </p>
      </fieldset>

      {/* Opt-in-first AI CV tailoring (R30.7): pre-operation choice + the
          destination network/privacy label, surfaced before the operation.
          AI notes are advisory and never alter the deterministic CV (R22.6). */}
      <div style={{ margin: `${tokens.spacing.sm} 0` }}>
        <AssistChoice
          mode={assistMode}
          onMode={onAssistMode}
          aiAvailable={aiAvailable}
          provider={chatProvider}
          destinationKind={chatIsLocal ? 'keyless-local' : 'keyed-cloud'}
          t={t}
        />
        {aiAvailable && assistMode !== 'script-only' ? (
          <p>
            <Button onClick={() => void handleAiTailor()} disabled={aiBusy || !role}>
              {aiBusy ? t('output.ai.working') : t('output.ai.tailor')}
            </Button>
          </p>
        ) : null}
        {aiBusy ? <LoadingIndicator message={t('output.ai.working')} /> : null}
        {aiError ? (
          <Banner role="status">
            <small>{aiError}</small>
          </Banner>
        ) : null}
        {aiNotes.length > 0 ? (
          <div data-ai-tailoring-notes>
            <h4>{t('output.ai.heading')}</h4>
            <ul>
              {aiNotes.map((note) => (
                <li key={note}>
                  <small>{note}</small>
                </li>
              ))}
            </ul>
            <p>
              <small>{t('output.ai.advisory')}</small>
            </p>
          </div>
        ) : null}
      </div>

      {status ? (
        <Banner role="status" data-testid="output-status">
          <small>{status}</small>
        </Banner>
      ) : null}

      {genNote ? (
        <Banner role="status" data-generation-mode>
          <small>{genNote}</small>
        </Banner>
      ) : null}

      {cvMarkdown ? (
        <>
          <h4>{t('output.cvHeading')}</h4>
          <Row>
            <Button onClick={handleDownloadMarkdown}>{t('output.downloadMd')}</Button>
            <Button variant="secondary" onClick={() => void handleDownloadDocx()}>
              {t('output.downloadDocx')}
            </Button>
            <Button variant="secondary" onClick={() => void handleDownloadPdf()} disabled={pdfBusy}>
              {pdfBusy ? t('output.pdfGenerating') : t('output.downloadPdf')}
            </Button>
          </Row>
          <p>
            <small>{t('output.pdfNote')}</small>
          </p>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              background: tokens.colour.surface,
              color: tokens.colour.text,
              border: `1px solid ${tokens.colour.border}`,
              borderRadius: tokens.radius.md,
              padding: tokens.spacing.md,
              fontFamily: tokens.typography.fontFamily.mono,
            }}
          >
            {cvMarkdown}
          </pre>
          <h4>{t('output.linkedInHeading')}</h4>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              background: tokens.colour.surface,
              color: tokens.colour.text,
              border: `1px solid ${tokens.colour.border}`,
              borderRadius: tokens.radius.md,
              padding: tokens.spacing.md,
              fontFamily: tokens.typography.fontFamily.mono,
            }}
          >
            {linkedIn}
          </pre>
          <Button onClick={handleSave}>{t('output.save')}</Button>
        </>
      ) : null}
    </section>
  );
}
