// Document ingestion screen (@ui) — Phase 1 Ingest (R8–R13).
//
// Surfaces the local, provider-free Ingestion_Engine so the user can input
// their career data: it shows the recommended document checklist (R8.4),
// accepts PDF / Markdown / plain text / LinkedIn export ZIP (or pasted text),
// runs extraction with confidence + provenance (R10, R11, R38), and renders the
// review summary grouped by document (R12.1) with confirm / mark-private /
// delete actions (R12.2, R12.3, R12.4). Detected employment gaps are shown with
// neutral framing (R13.1), and low-confidence PDF text is reported, never
// silently included (R8.5). Confirmed extractions persist to the Memory Store
// (`profile/raw_extractions.md`, R34.1).
//
// Boundary note: extraction is entirely local — no provider is called here, so
// the Egress-Gate-only network boundary is preserved (Requirements 6, 7). Every
// user-facing string is read from the externalised locale resources (R41.8).

import { useMemo, useRef, useState } from 'react';
import type { ExtractedItem, ItemId } from '@core/types';
import { asFileId, asISODate } from '@core/types';
import { MemoryTree, CANONICAL_FILES } from '@core/storage';
import {
  buildSendControlPanelModel,
  toSensitiveDetections,
  type DestinationKind,
  type SendControlDecision,
} from '@core/egress';
import type { PiiScanner } from '@adapters/pii';
import type { AssistMode } from '@core/assist';
import {
  computeFileFingerprint,
  getDecision,
  setDecision,
} from '@adapters/send-control-store';
import { SendControlPanel } from './SendControlPanel';
import { AssistChoice } from './AssistChoice';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  LoadingIndicator,
  Row,
  TextArea,
} from './design-system';
import {
  type IngestionEngine,
  UnsupportedFormatError,
  fileBlobFromBytes,
  fileBlobFromText,
  groupByDocument,
  confirm as confirmItem,
  remove as removeItem,
  markPrivate,
  toEmploymentRecords,
  serializeRawExtractions,
  serializeRawDocuments,
  type ChecklistItem,
  type EmploymentGap,
} from '@core/ingestion';

export interface IngestScreenProps {
  /** The local Ingestion_Engine (PDF/Markdown/text/LinkedIn ZIP). */
  readonly engine: IngestionEngine;
  /** The session Memory Store the confirmed extractions persist into. */
  readonly store: MemoryTree;
  /** The confirmed Session Language (localises the checklist labels, R8.4). */
  readonly locale: string;
  /** The current extracted items (lifted to the shell so later phases can use them). */
  readonly items: ExtractedItem[];
  /** Update the shared extracted items. */
  readonly onItemsChange: (next: ExtractedItem[]) => void;
  /**
   * Raw full text per ingested document, lifted to the shell so the local-only
   * AI skill-discovery pass can read whole documents (R47.1/R47.5). Optional so
   * existing callers/tests need no change.
   */
  readonly rawDocs?: ReadonlyArray<{ doc: string; text: string }>;
  /** Update the shared raw-document texts. */
  readonly onRawDocsChange?: (next: { doc: string; text: string }[]) => void;
  /**
   * Local PII_Scanner used to pre-screen each staged document's content so the
   * per-file Granular Ingestion Send-Control panel can present every Sensitive
   * Detection individually (R57.2). When omitted, the send-control panels are not
   * rendered (e.g. simple test harnesses that exercise extraction only).
   */
  readonly scanner?: PiiScanner;
  /**
   * Where a staged file's content would be bound for, which scopes the
   * send-control defaults: a keyed cloud destination defaults every detection to
   * redacted (R57.6), while a keyless local on-device destination may send the
   * whole file (R57.5). Defaults to the safe `keyed-cloud` scoping.
   */
  readonly destinationKind?: DestinationKind;
  /**
   * The pipeline-wide AI-assist mode (script-only / ai-assisted / ai-only).
   * Surfaced HERE, up front, before the user saves the extractions, so the
   * choice is made once and applied as the default across every later phase.
   */
  readonly assistMode?: AssistMode;
  /** Change the pipeline-wide AI-assist mode (persisted by the shell). */
  readonly onAssistMode?: (mode: AssistMode) => void;
  /** Whether an AI provider key is configured (gates the AI options, R42.1). */
  readonly aiAvailable?: boolean;
  /** The chosen chat provider id for the destination network/privacy label. */
  readonly chatProvider?: string | null;
  /** Whether the chosen chat provider is a keyless local on-device provider. */
  readonly chatIsLocal?: boolean;
  /** Bound i18n translator (resolves externalised strings, R41.8). */
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}

type Notice =
  | { readonly kind: 'none' }
  | { readonly kind: 'processing' }
  | { readonly kind: 'summary'; readonly added: number; readonly rejected: string[]; readonly errors: string[] }
  | { readonly kind: 'error'; readonly reason: string }
  | { readonly kind: 'saved' };

const now = (): ReturnType<typeof asISODate> => asISODate(new Date().toISOString());

/**
 * Read a File's bytes by STARTING a FileReader synchronously in the caller's
 * tick. This is deliberately preferred over `File.arrayBuffer()`: the promise
 * API can defer the actual read, by which point Chromium may have invalidated
 * the file snapshot (e.g. the file was modified or locked by another program —
 * such as an editor that has it open), throwing a DOMException NotFoundError
 * ("A requested file or directory could not be found"). Kicking off
 * `readAsArrayBuffer` immediately, while still in the user-gesture tick,
 * maximises the chance the snapshot is still valid.
 */
const readFileOnce = (file: File): Promise<Uint8Array> =>
  new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () =>
      reject(reader.error ?? new DOMException('Failed to read file.', 'NotReadableError'));
    reader.readAsArrayBuffer(file);
  });

/** Does an error look like the transient "file snapshot invalidated" read failure? */
const isTransientReadError = (error: unknown): boolean => {
  if (error instanceof DOMException) {
    return error.name === 'NotFoundError' || error.name === 'NotReadableError';
  }
  if (error instanceof Error) {
    return /not\s*found|could not be found|notreadable/i.test(`${error.name} ${error.message}`);
  }
  return false;
};

/**
 * Read a File's bytes, retrying ONCE on a transient NotFoundError/NotReadableError
 * (the Chromium "file snapshot invalidated" failure). A brief delay lets a
 * program that briefly held the file (e.g. an editor mid-save) release it, so a
 * transient lock no longer blocks ingestion. A persistent failure rejects so the
 * caller can surface the actionable error.
 */
const readFileBytes = async (file: File, retries = 1): Promise<Uint8Array> => {
  try {
    return await readFileOnce(file);
  } catch (error) {
    if (retries > 0 && isTransientReadError(error)) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return readFileBytes(file, retries - 1);
    }
    throw error;
  }
};

/** One-line, human-readable summary of an item's fields for the review list. */
const summarise = (item: ExtractedItem): string => {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(item.fields)) {
    if (value === undefined || value === null || value === '') continue;
    const text = Array.isArray(value) ? value.join(', ') : String(value);
    if (text.trim().length === 0) continue;
    parts.push(`${key}: ${text}`);
  }
  return parts.join('; ');
};

/** The outcome of ingesting one file in a batch. */
type IngestOutcome =
  | { readonly status: 'ok'; readonly doc: string; readonly items: ExtractedItem[]; readonly low: number; readonly rawText: string }
  | { readonly status: 'rejected'; readonly name: string; readonly message: string }
  | { readonly status: 'error'; readonly name: string; readonly message: string };

/** The document ingestion + review screen. */
export function IngestScreen({
  engine,
  store,
  locale,
  items,
  onItemsChange,
  rawDocs = [],
  onRawDocsChange,
  scanner,
  destinationKind = 'keyed-cloud',
  assistMode,
  onAssistMode,
  aiAvailable = false,
  chatProvider = null,
  chatIsLocal = false,
  t,
}: IngestScreenProps) {
  const checklist = useMemo<ChecklistItem[]>(
    () => engine.recommendedChecklist(locale),
    [engine, locale],
  );
  const [lowConfidenceCount, setLowConfidenceCount] = useState(0);
  // Per-document count of low-confidence PDF regions, so the read-only Conversion
  // Preview can indicate where extraction was uncertain for THAT document (R64.3).
  // This is session-only UI state derived from each batch's IngestionResult; it
  // needs no new @core behaviour and no change to the persisted rawDocs shape.
  const [lowConfByDoc, setLowConfByDoc] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<Notice>({ kind: 'none' });
  const [pasted, setPasted] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  // Hidden file input driven by the "add document" button so the affordance is
  // a friendly "+ Add documents" rather than a bare file control.
  const fileInputRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => groupByDocument(items), [items]);
  const gaps = useMemo<EmploymentGap[]>(
    () => engine.detectGaps(toEmploymentRecords(items)),
    [engine, items],
  );

  // Granular Ingestion Send-Control (R57): one panel per staged document. Working
  // (possibly unconfirmed) decisions are held here; the confirmed decision is
  // persisted to browser-local storage and reapplied when the same file is
  // re-staged (R57.9). The store records send choices only — never the staged
  // file content or detected secret values.
  const [workingDecisions, setWorkingDecisions] = useState<
    Record<string, SendControlDecision>
  >({});

  const sendControlPanels = useMemo(() => {
    if (!scanner) return [];
    return rawDocs.map(({ doc, text }) => {
      const fingerprint = computeFileFingerprint(doc, text);
      const detections = toSensitiveDetections(scanner.scan(text));
      const model = buildSendControlPanelModel({
        fileId: asFileId(doc),
        detections,
        destinationKind,
        // Reapply a persisted choice for this file when present (R57.9).
        existingDecision: getDecision(fingerprint),
      });
      return { doc, text, fingerprint, model };
    });
  }, [scanner, rawDocs, destinationKind]);

  const decisionFor = (
    fingerprint: ReturnType<typeof computeFileFingerprint>,
    fallback: SendControlDecision,
  ): SendControlDecision => workingDecisions[fingerprint as unknown as string] ?? fallback;

  const onDecisionChange = (
    fingerprint: ReturnType<typeof computeFileFingerprint>,
    next: SendControlDecision,
  ) =>
    setWorkingDecisions((prev) => ({
      ...prev,
      [fingerprint as unknown as string]: next,
    }));

  const onDecisionConfirm = (
    fingerprint: ReturnType<typeof computeFileFingerprint>,
    current: SendControlDecision,
  ) => {
    const confirmed: SendControlDecision = { ...current, confirmed: true };
    // Persist the confirmed choice so it is reapplied on re-stage (R57.9).
    setDecision(fingerprint, confirmed);
    setWorkingDecisions((prev) => ({
      ...prev,
      [fingerprint as unknown as string]: confirmed,
    }));
  };

  /** Ingest one blob, returning a structured outcome (never throws). */
  const ingestOne = async (
    name: string,
    blob: Parameters<IngestionEngine['ingest']>[0],
  ): Promise<IngestOutcome> => {
    try {
      const result = await engine.ingest(blob);
      return {
        status: 'ok',
        doc: result.doc as unknown as string,
        items: result.items,
        low: result.lowConfidencePdfText.length,
        rawText: result.rawText,
      };
    } catch (error) {
      if (error instanceof UnsupportedFormatError) {
        return { status: 'rejected', name, message: error.notice.message };
      }
      return { status: 'error', name, message: error instanceof Error ? error.message : String(error) };
    }
  };

  /**
   * Ingest a batch of blobs and merge them in one update. Each accepted document
   * replaces any prior items from the SAME document name (re-upload refreshes),
   * and the rest are appended — so several CVs, a LinkedIn export, and
   * certificates all accumulate together (R8.1, R8.2).
   */
  const ingestBatch = async (
    blobs: ReadonlyArray<{ name: string; blob: Parameters<IngestionEngine['ingest']>[0] }>,
  ) => {
    if (blobs.length === 0) return;
    setNotice({ kind: 'processing' });
    const outcomes = await Promise.all(blobs.map(({ name, blob }) => ingestOne(name, blob)));

    const replacedDocs = new Set<string>();
    const accepted: ExtractedItem[] = [];
    const acceptedRaw: { doc: string; text: string }[] = [];
    const acceptedLowByDoc: Record<string, number> = {};
    let low = 0;
    const rejected: string[] = [];
    const errors: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === 'ok') {
        replacedDocs.add(outcome.doc);
        accepted.push(...outcome.items);
        if (outcome.rawText.trim().length > 0) {
          acceptedRaw.push({ doc: outcome.doc, text: outcome.rawText });
        }
        acceptedLowByDoc[outcome.doc] = outcome.low;
        low += outcome.low;
      } else if (outcome.status === 'rejected') {
        rejected.push(`${outcome.name}: ${outcome.message}`);
      } else {
        errors.push(`${outcome.name}: ${outcome.message}`);
      }
    }

    if (accepted.length > 0 || replacedDocs.size > 0) {
      onItemsChange([
        ...items.filter((it) => !replacedDocs.has(it.sourceDoc as unknown as string)),
        ...accepted,
      ]);
      // Mirror the same replace-by-document semantics for the raw texts.
      onRawDocsChange?.([
        ...rawDocs.filter((d) => !replacedDocs.has(d.doc)),
        ...acceptedRaw,
      ]);
      // Refresh the per-document low-confidence counts with the same replace
      // semantics (a re-uploaded document supersedes its prior count).
      setLowConfByDoc((prev) => {
        const next: Record<string, number> = {};
        for (const [doc, count] of Object.entries(prev)) {
          if (!replacedDocs.has(doc)) next[doc] = count;
        }
        return { ...next, ...acceptedLowByDoc };
      });
    }
    setLowConfidenceCount(low);
    setNotice({ kind: 'summary', added: replacedDocs.size, rejected, errors });
  };

  const handleFiles = async (files: readonly File[]) => {
    if (files.length === 0) return;
    setNotice({ kind: 'processing' });
    // Start every read SYNCHRONOUSLY (in this user-gesture tick) and snapshot the
    // bytes into in-memory blobs, so the later async ingestion never touches the
    // live file handle. Reading lazily / via the deferred File.arrayBuffer()
    // promise races with the input being reset or the file being modified/locked
    // by another program, surfacing as a DOMException NotFoundError ("A requested
    // file or directory could not be found"). FileReader started up front avoids
    // both.
    let blobs: { name: string; blob: ReturnType<typeof fileBlobFromBytes> }[];
    try {
      blobs = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          blob: fileBlobFromBytes(file.name, await readFileBytes(file), file.type),
        })),
      );
    } catch (error) {
      setNotice({
        kind: 'error',
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    await ingestBatch(blobs);
  };

  const handlePaste = () => {
    if (pasted.trim().length === 0) return;
    const name = `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.md`;
    void ingestBatch([{ name, blob: fileBlobFromText(name, pasted) }]);
    setPasted('');
  };

  const onConfirm = (id: ItemId) => onItemsChange(confirmItem(items, id, now()));
  const onDelete = (id: ItemId) => onItemsChange(removeItem(items, id));
  const onTogglePrivate = (id: ItemId, isPrivate: boolean) =>
    onItemsChange(markPrivate(items, id, isPrivate));

  /** Remove every item from one source document (a whole uploaded file). */
  const onRemoveDocument = (doc: string) => {
    onItemsChange(items.filter((it) => (it.sourceDoc as unknown as string) !== doc));
    onRawDocsChange?.(rawDocs.filter((d) => d.doc !== doc));
    setLowConfByDoc((prev) => {
      if (!(doc in prev)) return prev;
      const next = { ...prev };
      delete next[doc];
      return next;
    });
  };

  const handleSave = () => {
    try {
      store.write(CANONICAL_FILES.rawExtractions, serializeRawExtractions(items));
      // Persist the full raw document text too, so whole-document LOCAL AI skill
      // discovery survives reload/resume/Memory import (R47.1/R47.5/R49). This
      // is a local-only Storage_Adapter write — the Memory Store never leaves
      // the device (R7.1), and only the keyless local discovery path ever reads
      // this text (the cloud path keeps using structured non-private items,
      // R46.4). Documents with no prose body (e.g. a LinkedIn ZIP) carry empty
      // text and are dropped by the serializer.
      store.write(CANONICAL_FILES.rawDocuments, serializeRawDocuments([...rawDocs]));
      store.logAction(`Saved ${items.length} reviewed extraction(s) to raw_extractions.md.`);
      setNotice({ kind: 'saved' });
    } catch (error) {
      setNotice({ kind: 'error', reason: error instanceof Error ? error.message : String(error) });
    }
  };

  /**
   * Per-document READ-ONLY Conversion Preview (R64). Surfaces the full converted
   * text the engine produced for a document (`rawDocs[].text`, sourced from the
   * shell's `profile/raw_documents.md`) for inspection only — there is no
   * in-place editing of the converted text (R64.2). Low-confidence PDF regions
   * are indicated when present (R64.3). When a document has no convertible prose
   * body — e.g. a LinkedIn export ZIP, whose rawText is empty and so carries no
   * `rawDocs` entry — a "no converted text to preview" notice is shown instead
   * (R64.5). To fix a bad conversion the user discards the document (the existing
   * "Remove document" affordance) and pastes the equivalent text (R64.4).
   */
  const renderConversionPreview = (docName: string) => {
    const entry = rawDocs.find((d) => d.doc === docName);
    const text = entry?.text ?? '';
    const hasText = text.trim().length > 0;
    const lowCount = lowConfByDoc[docName] ?? 0;
    return (
      <details data-conversion-preview={docName}>
        <summary>{t('ingest.conversionPreview.toggle')}</summary>
        {hasText ? (
          <>
            <p>
              <small>{t('ingest.conversionPreview.intro')}</small>
            </p>
            {lowCount > 0 ? (
              <p data-low-confidence={lowCount}>
                <small>{t('ingest.conversionPreview.lowConfidence', { count: lowCount })}</small>
              </p>
            ) : null}
            <TextArea
              label={t('ingest.conversionPreview.label', { doc: docName })}
              hideLabel
              readOnly
              value={text}
              rows={12}
            />
            <p>
              <small>{t('ingest.conversionPreview.discardHint')}</small>
            </p>
          </>
        ) : (
          <p data-no-preview>
            <small>{t('ingest.conversionPreview.none')}</small>
          </p>
        )}
      </details>
    );
  };

  return (
    <section aria-label={t('ingest.heading')} data-ingest-screen>
      <h2>{t('ingest.heading')}</h2>
      <p>{t('ingest.intro')}</p>

      {/* Recommended document checklist (R8.4). */}
      <h3>{t('ingest.checklistHeading')}</h3>
      <ul>
        {checklist.map((c) => (
          <li key={c.id}>
            {c.label}
            {c.recommended ? ` (${t('ingest.recommended')})` : ''}
          </li>
        ))}
      </ul>

      {/* Pipeline-wide AI-assist choice, surfaced UP FRONT (before saving) so it
          is decided once and applied as the default across every later phase
          (script / AI / both). Persisted by the shell via onAssistMode. */}
      {assistMode !== undefined && onAssistMode ? (
        <section aria-label={t('ingest.assistHeading')}>
          <h3>{t('ingest.assistHeading')}</h3>
          <p>
            <small>{t('ingest.assistIntro')}</small>
          </p>
          <AssistChoice
            mode={assistMode}
            onMode={onAssistMode}
            aiAvailable={aiAvailable}
            provider={chatProvider}
            destinationKind={chatIsLocal ? 'keyless-local' : 'keyed-cloud'}
            t={t}
          />
        </section>
      ) : null}

      {/* Multi-file upload (R8.1). The hidden input is driven by a friendly
          "+ Add documents" button; selecting several files at once ingests them
          all, and the button can be used repeatedly to add more. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        aria-label={items.length === 0 ? t('ingest.addFirst') : t('ingest.addAnother')}
        accept=".pdf,.md,.markdown,.txt,.text,.zip,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        style={{ display: 'none' }}
        onChange={(e) => {
          const input = e.currentTarget;
          const files = input.files ? Array.from(input.files) : [];
          // Reset the input only AFTER the bytes have been read, so the selected
          // File references stay valid throughout the eager read.
          void handleFiles(files).finally(() => {
            input.value = '';
          });
        }}
      />
      <Row>
        <Button onClick={() => fileInputRef.current?.click()}>
          {items.length === 0 ? t('ingest.addFirst') : t('ingest.addAnother')}
        </Button>
        <Button variant="secondary" onClick={() => setShowPaste((v) => !v)}>
          {t('ingest.pasteToggle')}
        </Button>
      </Row>
      <p>
        <small>{t('ingest.multiHint')}</small>
      </p>

      {showPaste ? (
        <div>
          <TextArea
            label={t('ingest.pasteLabel')}
            value={pasted}
            rows={6}
            placeholder={t('ingest.pastePlaceholder')}
            onChange={(e) => setPasted(e.target.value)}
          />
          <Button onClick={handlePaste} disabled={pasted.trim().length === 0}>
            {t('ingest.pasteButton')}
          </Button>
        </div>
      ) : null}

      {/* Status line: loading within 1s (R58.7), error state with recovery
          that preserves prior input (R58.8). */}
      {notice.kind === 'processing' ? (
        <LoadingIndicator message={t('ingest.processing')} />
      ) : null}
      {notice.kind === 'error' ? (
        <ErrorState
          message={t('ingest.error', { reason: notice.reason })}
          recovery={t('ingest.errorRecovery')}
        />
      ) : null}
      {notice.kind === 'summary' || notice.kind === 'saved' ? (
        <Banner role="status">
          <small>
            {notice.kind === 'summary'
              ? t('ingest.batchSummary', { added: notice.added }) +
                (notice.rejected.length > 0
                  ? ' ' + t('ingest.batchRejected', { items: notice.rejected.join(' | ') })
                  : '') +
                (notice.errors.length > 0
                  ? ' ' + t('ingest.batchErrors', { items: notice.errors.join(' | ') })
                  : '')
              : null}
            {notice.kind === 'saved' ? t('ingest.saved') : null}
          </small>
        </Banner>
      ) : null}

      {lowConfidenceCount > 0 ? (
        <p>
          <small>{t('ingest.lowConfidence', { count: lowConfidenceCount })}</small>
        </p>
      ) : null}

      {/* Detected employment gaps, neutral framing (R13.1). */}
      {gaps.length > 0 ? (
        <section aria-label={t('ingest.gapsHeading')}>
          <h3>{t('ingest.gapsHeading')}</h3>
          <ul>
            {gaps.map((gap) => (
              <li key={`${gap.afterEmployer}-${gap.beforeEmployer}-${gap.startLabel}`}>
                {t('ingest.gap', {
                  after: gap.afterEmployer,
                  before: gap.beforeEmployer,
                  months: gap.months,
                  start: gap.startLabel,
                  end: gap.endLabel,
                })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Granular Ingestion Send-Control: one panel per staged document (R57). */}
      {sendControlPanels.length > 0 ? (
        <section aria-label={t('ingest.sendControl.sectionHeading')}>
          <h3>{t('ingest.sendControl.sectionHeading')}</h3>
          <p>
            <small>{t('ingest.sendControl.sectionIntro')}</small>
          </p>
          {sendControlPanels.map(({ doc, fingerprint, model }) => {
            const decision = decisionFor(fingerprint, model.defaultDecision);
            return (
              <SendControlPanel
                key={fingerprint as unknown as string}
                docName={doc}
                model={model}
                decision={decision}
                onChange={(next) => onDecisionChange(fingerprint, next)}
                onConfirm={() => onDecisionConfirm(fingerprint, decision)}
                t={t}
              />
            );
          })}
        </section>
      ) : null}

      {/* In AI-only mode the parser's structured extraction is NOT the detection
          method — the AI reads the decoded document text and detects skills in
          the Skill Map step. So we show the ingested documents (ready for the
          AI) rather than the parser's "Review what we extracted" item list. */}
      {assistMode === 'ai-only' ? (
        <section aria-label={t('ingest.aiDocsHeading')}>
          <h3>{t('ingest.aiDocsHeading')}</h3>
          {groups.length === 0 ? (
            <EmptyState message={t('ingest.empty')} />
          ) : (
            <>
              <p>
                <small>{t('ingest.aiDocsNote')}</small>
              </p>
              <ul>
                {groups.map((group) => (
                  <li key={group.doc as unknown as string}>
                    {group.doc as unknown as string}{' '}
                    <Button
                      variant="danger"
                      onClick={() => onRemoveDocument(group.doc as unknown as string)}
                    >
                      {t('ingest.removeDocument')}
                    </Button>
                    {renderConversionPreview(group.doc as unknown as string)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : (
        <>
          {/* Review summary grouped by document (R12.1). */}
          <h3>{t('ingest.resultsHeading')}</h3>
          {items.length === 0 ? (
            <EmptyState message={t('ingest.empty')} />
          ) : (
            <>
              <p>
                <small>{t('ingest.documentCount', { count: groups.length })}</small>
              </p>
              {groups.map((group) => (
                <section key={group.doc as unknown as string} aria-label={group.doc as unknown as string}>
                  <h4>
                    {group.doc as unknown as string}{' '}
                    <Button variant="danger" onClick={() => onRemoveDocument(group.doc as unknown as string)}>
                      {t('ingest.removeDocument')}
                    </Button>
                  </h4>
                  {renderConversionPreview(group.doc as unknown as string)}
                  <ul>
                    {group.items.map((item) => (
                      <li key={item.id as unknown as string} data-confidence={item.confidence}>
                        <strong>{item.type}</strong> <Badge>{item.confidence}</Badge>
                        {item.userConfirmed ? <small> ✓ {t('ingest.item.confirmed')}</small> : null}
                        {item.private ? <small> 🔒 {t('ingest.item.privateFlag')}</small> : null}
                        {summarise(item) ? <> — {summarise(item)}</> : null}{' '}
                        <Button onClick={() => onConfirm(item.id)} disabled={item.userConfirmed}>
                          {t('ingest.item.confirm')}
                        </Button>{' '}
                        <Button variant="secondary" onClick={() => onTogglePrivate(item.id, !item.private)}>
                          {item.private ? t('ingest.item.makePublic') : t('ingest.item.makePrivate')}
                        </Button>{' '}
                        <Button variant="danger" onClick={() => onDelete(item.id)}>
                          {t('ingest.item.delete')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <Button onClick={handleSave}>{t('ingest.save')}</Button>
            </>
          )}
        </>
      )}
    </section>
  );
}
