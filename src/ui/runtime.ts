// Career Agent runtime composition root (@ui) — task 19.1.
//
// Assembles the object graph the React shell drives: the XState orchestrator
// wired to the SINGLE Egress Gate, the Egress Gate wired to the local PII
// scanner + Provider_Manager + the network-label channel, and the Memory Store
// projection used for resume and persistence. This is the one place provider
// adapters are constructed; the UI components themselves never import a provider
// client and reach a provider only by calling the orchestrator, which delegates
// exclusively to the Egress Gate (Requirements 6, 7).
//
// The wizard navigation/persistence path (task 19.1) makes no provider call, so
// no key, network, or audio is touched here — but the gate is fully wired so the
// per-phase engines (other tasks) can request providers through the same
// chokepoint without any further plumbing.
//
// Requirements: 1.1, 6, 7, 35.2.

import { createCareerAgent, type CareerAgent } from '@core/orchestrator';
import {
  createEgressGate,
  type RedactProposal,
  type EgressGate,
  type PayloadPreview,
} from '@core/egress';
import { type NetworkLabelChannel } from '@core/privacy';
import { ProvenanceIndex } from '@core/provenance';
import { MemoryTree } from '@core/storage';
import { createPiiScanner, type PiiScanner } from '@adapters/pii';
import {
  DefaultProviderManager,
  defaultProviderPlugins,
} from '@adapters/provider-manager';
import { createDefaultLlmClients } from '@adapters/llm-http';
import { WebCryptoKeyVault, type KeyVault } from '@adapters/vault';
import type { ProviderManager } from '@adapters/provider';
import { createIngestionEngine, type IngestionEngine } from '@core/ingestion';
import { createPdfTextExtractor } from '@adapters/pdf-extractor';
import { createZipReader, createCsvParser } from '@adapters/linkedin-zip';
import { createTypstPdfCompiler } from '@adapters/typst-pdf';
import type { TypstCompiler } from '@core/output';
// Vite bundles the pdf.js worker as a real module Worker via the `?worker`
// import, so pdf.js receives a ready `workerPort` and never has to fetch and
// dynamically import the worker `.mjs` itself. That fake-worker fallback fails
// on a statically served bundle (e.g. the nginx Run Mode) with "Setting up fake
// worker failed: Failed to fetch dynamically imported module"; a bundled worker
// loads identically in dev and from the static bundle.
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import {
  createMemoryTreePersistence,
  createMemoryTreeResumeReader,
  PhaseWizardController,
} from './phase-wizard-controller';
import type { TraceLookup } from './source-trace-inspector';

/** Asks the user to redact-and-proceed when the Egress Gate detects PII (R6.3). */
export type ConfirmRedactAndProceed = (proposal: RedactProposal) => boolean | Promise<boolean>;

/**
 * Surfaces the exact outbound text for review/editing before a third-party send
 * (R65). Resolving a string transmits THAT user-approved text; resolving `null`
 * cancels (fail-closed — nothing is transmitted, R65.4). Optional: when omitted
 * the gate performs no Payload Preview and behaves exactly as before.
 */
export type PreviewPayload = (preview: PayloadPreview) => Promise<string | null>;

/** Options for {@link createCareerAgentRuntime}. */
export interface CareerAgentRuntimeOptions {
  /** The canonical in-memory Memory Store projection (shared with the shell). */
  readonly store: MemoryTree;
  /**
   * The channel the shell subscribes to for third-party network-operation
   * labels (R7.3). The gate publishes every label here before a call runs.
   */
  readonly labelChannel: NetworkLabelChannel;
  /** Redact-and-proceed prompt presented on PII detection (R6.3). */
  readonly confirmRedactAndProceed: ConfirmRedactAndProceed;
  /**
   * OPTIONAL Payload Preview prompt presented before a third-party `llm-chat`
   * send (R65). The shell wires this to a modal that shows the exact outbound
   * text for free editing/removal. Omitting it disables the preview (the gate
   * behaves exactly as before).
   */
  readonly previewPayload?: PreviewPayload;
  /**
   * The Provenance / Citation Service index the source-trace inspector resolves
   * against (R38.2). Optional so the shell can run before any provenance has
   * been recorded; the per-phase engines populate this same index as facts are
   * created (R38.1). Defaults to an empty index, against which every claim
   * resolves as unresolved until provenance is attached.
   */
  readonly provenanceIndex?: ProvenanceIndex;
}

/** The wired runtime the React shell consumes. */
export interface CareerAgentRuntime {
  readonly agent: CareerAgent;
  readonly controller: PhaseWizardController;
  /**
   * The pluggable BYOK Provider_Manager (R4). The shell's provider-setup screen
   * uses it to list providers, show setup guidance, validate a key with a test
   * call, and store/remove the encrypted key. Reached for provider SETUP only;
   * outbound provider CALLS still flow exclusively through the Egress Gate.
   */
  readonly providerManager: ProviderManager;
  /**
   * The encrypted key vault (R5). Exposed so the setup screen can reflect
   * whether a key is currently stored for a provider. Never exposes plaintext
   * beyond the just-in-time decrypt the Provider_Manager performs.
   */
  readonly keyVault: KeyVault;
  /**
   * The Ingestion_Engine (R8–R13), constructed with the real pdf.js / JSZip /
   * PapaParse adapters so the ingest screen can accept PDF, Markdown, plain
   * text, and LinkedIn export ZIPs. It touches no provider — extraction is
   * local and provider-free.
   */
  readonly ingestionEngine: IngestionEngine;
  /**
   * The Typst-Wasm PDF compiler (R32.2). Injected into the Output_Engine's
   * `renderPdf`; the wasm is bundled locally (no CDN) and loaded lazily on the
   * first compile. A compile failure degrades gracefully — never blocking the
   * Markdown/DOCX outputs.
   */
  readonly pdfCompiler: TypstCompiler;
  /**
   * The single Egress Gate chokepoint (Requirements 6, 7). Exposed so the
   * coaching screen can route audio transcription (R26.2) through the same
   * PII-screening, labelling, redact-and-proceed path as every other provider
   * call. No domain/UI component bypasses it.
   */
  readonly egressGate: EgressGate;
  /**
   * The local, provider-free PII_Scanner (R6.1) used to pre-screen each staged
   * document so the Ingest screen can present the per-file Granular Ingestion
   * Send-Control panel with every Sensitive Detection individually (R57.2). Pure
   * and local — it makes no network call.
   */
  readonly scanner: PiiScanner;
  /**
   * The trace lookup the source-trace inspector calls to resolve any claim ref
   * to its source trace (R38.2). Bound to the session's provenance index; it
   * touches no provider, preserving the Egress-Gate-only boundary.
   */
  readonly traceLookup: TraceLookup;
}

/**
 * Build the orchestrator + Egress Gate object graph and the phase-wizard
 * controller that drives it. Default OpenAI/Anthropic provider descriptors are
 * registered (no clients/keys are wired here — BYOK setup is a separate flow),
 * so the gate can route a request the moment a provider is configured while
 * never shipping a built-in key (R4.5).
 */
export function createCareerAgentRuntime(
  options: CareerAgentRuntimeOptions,
): CareerAgentRuntime {
  const { store, labelChannel, confirmRedactAndProceed, previewPayload } = options;

  // The Provenance / Citation Service index the source-trace inspector resolves
  // against (R38.2). The engines that create facts attach provenance to this
  // same index at creation time (R38.1); the inspector reads it via the trace
  // lookup below. Pure resolution — no provider, no network, no Memory Store.
  const provenanceIndex = options.provenanceIndex ?? new ProvenanceIndex();
  const traceLookup: TraceLookup = (ref) => provenanceIndex.lookup(ref);

  // Local, provider-free PII pre-screening on the egress hot path (R6.1).
  const scanner = createPiiScanner();
  // Encrypted BYOK key vault + pluggable Provider_Manager (R4.1, R5.1). No key
  // material is present until the user supplies one through the setup flow. The
  // real OpenAI/Anthropic HTTP clients are injected here at the composition root
  // so a configured provider can be reached through the gate; the agent still
  // ships no built-in key (R4.5).
  const vault = new WebCryptoKeyVault();
  const providerManager = new DefaultProviderManager({
    vault,
    providers: defaultProviderPlugins(createDefaultLlmClients()),
  });

  // The single chokepoint: every outbound provider call passes through here.
  const egressGate = createEgressGate({
    scanner,
    providerManager,
    notifyLabel: labelChannel.notify,
    confirmRedactAndProceed,
    // OPTIONAL Payload Preview seam (R65): present the exact outbound text for
    // review/editing before a third-party `llm-chat` send. When omitted, the
    // gate performs no preview.
    previewPayload,
  });

  // The orchestrator holds the Egress Gate and the Memory Store resume reader;
  // it never imports a provider client directly (Requirements 6, 7).
  const agent = createCareerAgent({
    egressGate,
    memoryStoreReader: createMemoryTreeResumeReader(store),
  });

  const controller = new PhaseWizardController({
    agent,
    persistence: createMemoryTreePersistence(store),
  });

  // The local, provider-free Ingestion_Engine with the real external adapters
  // (R8.1, R8.2, R8.5). The pdf.js worker is handed in as a Vite-bundled module
  // Worker so PDF parsing works in the browser and from the static bundle.
  const ingestionEngine = createIngestionEngine({
    pdfExtractor: createPdfTextExtractor({ createWorker: () => new PdfWorker() }),
    zipReader: createZipReader(),
    csvParser: createCsvParser(),
  });

  return {
    agent,
    controller,
    providerManager,
    keyVault: vault,
    ingestionEngine,
    pdfCompiler: createTypstPdfCompiler(),
    egressGate,
    scanner,
    traceLookup,
  };
}
