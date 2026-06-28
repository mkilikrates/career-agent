# Project Structure

> Read this in: **English** · [Português](../../pt-BR/developer/project-structure.md) · [← Back to the README](../../../README.md) · Developer docs: [Architecture](./architecture.md) · **Project structure** · [Building & testing](./building-and-testing.md) · [Run Modes & deployment](./run-modes-and-deployment.md)

This is a map of the codebase: the layered layout, the key modules, and where to find things. Read [Architecture](./architecture.md) first for the *why*; this doc covers the *where*.

## The three layers

The repo enforces a strict dependency direction: **`@ui` → `@core` → (interfaces only) → `@adapters`**.

- **`@core/*`** — framework-agnostic domain logic. No React, no DOM, no provider/storage client imports — only interfaces. This is where correctness lives.
- **`@adapters/*`** — swappable boundaries that touch the outside world (storage, network/providers, crypto, PII, file parsing).
- **`@ui/*`** — the React shell. Composes everything at the `runtime.ts` root and renders the phase wizard.

Tests are **co-located** with the code they cover as `*.test.ts(x)` files.

## Top-level layout

```
.
├── README.md                  # index landing page (this doc set's entry)
├── CONTRIBUTING.md            # contribution guide
├── SECURITY.md                # security & privacy policy
├── LICENSE                    # MIT
├── index.html                 # Vite entry HTML
├── package.json               # scripts + dependencies
├── Dockerfile                 # multi-stage: build → unprivileged nginx (static only)
├── docker-compose.yml         # full local stack (web + ollama + optional localai)
├── docker/nginx.conf          # SPA static-serving config
├── .tool-versions             # pinned Node version
├── locales/                   # externalised UI strings (no hardcoded text)
│   ├── en.json
│   └── pt-BR.json
├── docs/                       # documentation (this folder)
│   └── en/ …
└── src/
    ├── core/                  # @core — domain logic
    ├── adapters/              # @adapters — boundaries
    └── ui/                    # @ui — React shell
```

## `src/core` — domain logic

| Module | What it does |
|---|---|
| `core/types` | Shared domain types and branded IDs (`Provenance`, `Confidence`, `ExtractedItem`, `SkillMapEntry`, `Accomplishment`, `TalkingPoint`, `RolePreference`, `StarId`/`BulletId`/`SkillId`/`RoleSlug`, …). |
| `core/provenance` | The Provenance / Citation Service: attaches a source trace to every fact and resolves any claim ref back to its source (powers the UI source-trace inspector and the No-Fabrication harness). |
| `core/egress` | The **single Egress Gate** (`egress-gate.ts`) + granular ingestion **send-control** (`send-control.ts`). The only path to any provider. |
| `core/ingestion` | The Ingestion_Engine and its parts: format detection (`formats.ts`), structured extraction (`extraction.ts`), date/gap logic (`dates.ts`, `eligibility.ts`), DOCX decode (`docx.ts`), the lossless `raw_extractions.md` and `raw_documents.md` documents, and `ingestion-engine.ts`. |
| `core/skills` | The Skill_Mapper: conservative normalisation + confusables guardrail, the bi-directional skill↔accomplishment graph, skill-map (de)serialisation, and the opt-in AI **skill-discovery** flow (`skill-discovery.ts`, `skill-assist.ts`). |
| `core/role-matcher` | Role discovery, ontological match scoring (taxonomy of implements/extends), and role-preference capture/persistence. |
| `core/interview` | The Interview_Coach: STAR question generation, the guided answer loop with Soft-Close, the adaptive AI coaching loop, talking-point refinement, in-browser **audio recording** (`recording.ts`) and uploaded-audio handling (`audio.ts`), and the content/delivery firewall. |
| `core/output` | The Output_Engine: the single `CvModel`, Markdown/PDF/DOCX renderers, cross-format fidelity, immutable versioning + diffing, locale formatting, and the advisory LinkedIn report. |
| `core/healing` | State-healing pass + the stable-ID registry: detects dangling/duplicate IDs on resume and reports rather than throwing. |
| `core/registry` | The `IdRegistry` that allocates stable, never-reused `STAR-NN` / `BULLET-NN` identifiers. |
| `core/storage` | The canonical `MemoryTree`, the canonical path model (`paths.ts`, `CANONICAL_FILES`), and shared serialisation shared by both storage tiers. |
| `core/orchestrator` | The XState six-phase statechart, session resume, and re-entry triggers (`resume.ts`). |
| `core/assist` | The shared opt-in-first AI-assist contract (`runAssist`, `AssistMode`, `AssistChoice`) and the persisted assist-mode preference (`assist-preference.ts`). |
| `core/privacy` | The privacy statement model, consent state, and the network-label channel. |
| `core/no-fabrication` | The No_Fabrication_Harness and its fixtures (the CI backbone of Property 1). |
| `core/locale` | i18next setup, language detection/confirmation, and locale config. |

## `src/adapters` — boundaries

| File | What it does |
|---|---|
| `provider.ts` | Provider interfaces (`ProviderManager`, `LlmProvider`, `SttProvider`, `RedactedPayload`, `AudioBlob`, …). |
| `provider-manager.ts` | The pluggable `DefaultProviderManager` + default provider plugins (OpenAI, Anthropic, keyless Local). |
| `llm-http.ts` | The OpenAI-compatible HTTP clients (cloud + local), incl. Whisper transcription/translation. |
| `local-config.ts` | Editable base URL / chat model / STT model / max completion tokens for the keyless local provider, in browser-local storage. |
| `vault.ts` | The Web Crypto (AES-GCM) key vault for encrypted-at-rest BYOK keys. |
| `pii.ts` | The `PII_Scanner` (regex + lightweight JS) and `redact()`. |
| `send-control-store.ts` | Browser-local persistence of per-file/per-detection send-control decisions (choices only, never content). |
| `storage.ts`, `storage-fs-access.ts`, `storage-fallback.ts`, `fallback-persistence.ts` | The two-tier Storage_Adapter (File System Access; OPFS/IndexedDB). |
| `memory-store-zip.ts` | `.zip` export/import of the entire Memory Store (fallback tier). |
| `pdf-extractor.ts` | pdf.js text extraction with low-confidence flagging. |
| `linkedin-zip.ts` | ZIP reading + CSV parsing for the LinkedIn export. |
| `typst-pdf.ts` | The Typst-to-WebAssembly PDF compiler (wasm bundled locally, no CDN). |

## `src/ui` — the React shell

| File | What it does |
|---|---|
| `App.tsx` | The shell root: localisation, consent, provider selection, the phase wizard, and the modals (redact-and-proceed, Payload Preview). |
| `runtime.ts` | The composition root — the **only** place provider adapters and the Egress Gate are constructed and wired. |
| `PhaseWizard.tsx`, `phase-wizard-controller.ts` | Wizard navigation/persistence driving the orchestrator. |
| `ProviderSetup.tsx`, `ProviderSelection.tsx`, `provider-availability.ts` | BYOK / local provider setup and per-capability selection. |
| `IngestScreen.tsx` | Phase 1 — upload/paste, review, send-control panel, and the read-only **Conversion Preview**. |
| `SkillMapScreen.tsx`, `RoleDiscoveryScreen.tsx`, `CoachingScreen.tsx`, `OutputScreen.tsx`, `MemoryScreen.tsx` | The remaining phase screens. |
| `RecordAnswer.tsx`, `audio-recorder-port.ts` | In-browser microphone recording (the DOM seam over `MediaRecorder`) and its UI. |
| `PayloadPreviewModal.tsx` | The pre-send "review the exact outbound text" modal. |
| `SendControlPanel.tsx` | The per-file ingestion send-control UI. |
| `AssistChoice.tsx` | The opt-in-first AI mode + network/privacy label surface. |
| `SourceTraceInspector.tsx` | Resolve any claim ref to its provenance trace. |
| `PrivacyStatement.tsx` | The privacy statement + consent + network-label rendering. |
| `design-system/` | Shared tokens + components (`Button`, `TextField`, `TextArea`, `PhaseChrome`, layout primitives, state primitives) so every screen is styled and behaves consistently. |

## Conventions

- **Branded IDs** (e.g. `StarId`, `SkillId`) are nominal types — construct them via the `as*` helpers in `core/types`, never by raw casting.
- **No hardcoded user-facing strings** — everything goes through `t(...)` and lives in `locales/en.json` + `locales/pt-BR.json`.
- **Adapters are injected** at `runtime.ts`; tests inject fakes. Core modules accept collaborators via parameters/DI, never via global imports of an implementation.
- **Tests live next to the code** as `*.test.ts(x)`; property tests are tagged with a `// Feature: career-agent, Property N: …` comment.
