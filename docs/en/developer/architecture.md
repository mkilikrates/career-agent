# Architecture & Trust Model

> Read this in: **English** · [Português](../../pt-BR/developer/architecture.md) · [← Back to the README](../../../README.md) · Developer docs: **Architecture** · [Project structure](./project-structure.md) · [Building & testing](./building-and-testing.md) · [Run Modes & deployment](./run-modes-and-deployment.md)

This document explains *how Career Agent works* and the invariants the whole codebase is built to uphold. If you read only one developer doc before contributing, read this one.

## What it is

Career Agent is a **local-first browser web app** (TypeScript + WebAssembly, React + Vite static bundle, **no backend**). It transforms a user's career documents into an evidence-backed profile, coaches STAR interview answers, and generates ATS-safe outputs (Markdown, PDF via Typst-to-WebAssembly, structured DOCX) — entirely on the user's device.

## The non-negotiable invariants

Everything else follows from these. Contributions must preserve all of them.

1. **No backend.** All parsing, skill mapping, typesetting, and persistence run in the browser. No server receives or stores user data.
2. **Single egress chokepoint.** No domain component calls a provider client directly. Every outbound provider request passes through the one **Egress Gate**, which applies PII pre-screening, operation labelling, and payload minimisation before anything leaves the device.
3. **No-Fabrication Rule.** Every factual claim in generated output must resolve to a provenance record — a source-document line, an explicit user confirmation, or a confirmed interview answer. Nothing is invented; a job title alone never implies a skill.
4. **Provenance is mandatory.** Every fact carries a citation from the moment of extraction. Output can only emit facts that carry provenance.
5. **The Memory Store stays on the device.** It is human-readable Markdown owned by the browser; it is never written or received by a server, container, or host-mounted volume in any Run Mode.
6. **Markdown is the database.** The Memory Store *is* the canonical state; in-memory objects are a hydrated projection that must round-trip losslessly.
7. **AI is opt-in and deterministic-first.** Every AI-assistable operation has a complete script-only path that makes no provider call. AI only ever *supplements* a deterministic baseline, and the user must confirm any AI output before it enters the knowledge base.

## High-level shape

```
┌──────────────────────────────────────────────────────────────┐
│ @ui  — React + Vite static SPA (the shell)                     │
│   PhaseWizard · per-phase screens · privacy/network labels     │
└───────────────┬────────────────────────────────────────────────┘
                │  drives
┌───────────────▼────────────────────────────────────────────────┐
│ @core — framework-agnostic domain logic                         │
│   Orchestrator (XState) · Ingestion · Skill Mapper · Role       │
│   Matcher · Interview Coach · Output Engine · Provenance ·      │
│   State-Healing/ID Registry · Egress Gate                       │
└───────────────┬────────────────────────────────────────────────┘
                │  only via interfaces
┌───────────────▼────────────────────────────────────────────────┐
│ @adapters — swappable boundaries                                │
│   Storage (FS Access / OPFS+IDB) · Provider_Manager (OpenAI,    │
│   Anthropic, keyless Local) · PII_Scanner · Web Crypto vault    │
└─────────────────────────────────────────────────────────────────┘
   WebAssembly: Typst typesetter (bundled, no CDN) · pdf.js worker
```

**Separation of core and shell** is the load-bearing principle: all domain logic lives in framework-agnostic `@core/*` modules that never import React, the DOM, or an adapter implementation — only interfaces. The UI shell (`@ui`) and the storage/network/crypto boundaries (`@adapters`) are thin and swappable. This keeps the core packaging-agnostic (browser today, a Tauri wrapper possible later with no rewrite).

## The Egress Gate (the heart of the trust model)

The Egress Gate (`@core/egress`) is the **single chokepoint** through which every outbound provider request flows — including requests to a local provider. No domain component is permitted to import a provider client directly; only the composition root (`@ui/runtime.ts`) constructs provider adapters and the gate.

For an outbound **chat/LLM text** request the gate runs this sequence, in order, before anything leaves the device:

1. **Label** the network operation (so the UI can show it *before* the call runs). A keyed cloud provider is marked a *third-party network call*; a keyless local provider is marked a *local on-device call with no third-party egress*.
2. **Payload Preview** *(third-party only)* — surface the exact outbound text for the user to review, freely edit, or cancel. Cancelling fails closed (nothing is transmitted). Skipped for local providers, ingestion content, and audio.
3. **PII pre-screening** on the user-approved text via the `PII_Scanner` (regex + lightweight JS matching for SSN, NINO, credit-card numbers, API keys/tokens).
4. **Redact-and-proceed** — if high-risk values are detected, notify the user of the *categories* (never the secret values) and offer to redact and continue; declining fails closed.
5. **Build the minimised Redacted Payload** and attach the consent-derived `noTraining` flag.
6. **Hand off to the Provider_Manager**, which transmits only to the user's chosen provider and decrypts that provider's key just-in-time.

The gate **fails closed**: if screening can't complete or a collaborator is missing, it raises and transmits nothing. It has **no reference to the Storage_Adapter**, so it physically cannot transmit Memory Store files.

Two related, finer-grained controls sit alongside it:
- **Granular ingestion send-control** — before any *file content* is sent during ingestion, the user makes a per-file decision: send the whole file, or allow/redact each individual sensitive detection. The gate refuses to build a payload until that decision is confirmed. Cloud destinations default every detection to redacted; a keyless local destination may send the whole file (nothing leaves the device).
- **Per-capability routing** — the chat/LLM provider and the speech-to-text provider are chosen independently; each capability routes through the gate to its own chosen provider.

## The six-phase pipeline

A stateful, **session-resumable** pipeline modelled as an XState statechart. The user can stop at any point (including mid-question) and resume exactly there; each phase reads from and writes to the Memory Store after every confirmed step.

```
Ingest → Skill Map → Role Discovery → Interview Coaching → Output Generation → Memory & Maintenance
```

- **Ingest** — accept PDF / Markdown / plain text / DOCX / LinkedIn export ZIP; extract structured records with **confidence** (High/Medium/Low) and **provenance**; detect employment gaps and multi-document conflicts; offer a read-only **Conversion Preview** of the decoded text per document.
- **Skill Map** — conservative, reversible skill normalisation with a never-merge "confusables" guardrail; a bi-directional skill↔accomplishment graph with stable IDs (`SKILL-…`, `BULLET-NN`, `STAR-NN`).
- **Role Discovery** — suggested roles scored with ontological matching (e.g. PostgreSQL satisfies a SQL requirement) using an extensible taxonomy.
- **Interview Coaching** — STAR question generation; a guided answer loop with Soft-Close; text, uploaded-audio, or in-browser-recorded answers (transcribed through the gate); a content/delivery firewall so accent/disfluency never affect assessed quality.
- **Output Generation** — a single `CvModel` rendered to Markdown (primary), ATS-safe selectable-text PDF (Typst/Wasm, bundled locally), and structured DOCX, with cross-format fidelity and immutable versioning.
- **Memory & Maintenance** — export/import and full delete of the Memory Store.

## Opt-in, deterministic-first AI

Four components offer optional AI help — Skill Mapper (skill discovery), Role Matcher (role recommendations), Interview Coach (STAR questions, educational summaries, the adaptive coaching loop), and Output Engine (CV tailoring). They share **one** opt-in-first contract:

- **`script-only`** → a complete deterministic result with **zero** provider calls. This is always available and is the default trust-preserving path.
- **`ai-assisted` / `ai-only`** → the deterministic baseline plus provider-derived supplements routed through the Egress Gate; AI output is presented as *suggestions* the user must confirm. On provider failure the orchestrator falls back to the baseline with a non-blocking error.

The chosen mode is a single pipeline-wide preference, surfaced up front on Ingest and persisted to the Memory Store (`config/assist_preference.md`).

## Providers

- **Keyed cloud (BYOK):** OpenAI (chat completions + Whisper STT, incl. translate-to-English) and Anthropic (messages). Keys are validated with a cheap `GET /models` probe, encrypted at rest (AES-GCM via Web Crypto), decrypted just-in-time, transmitted only to their owning provider, and never written to the Memory Store. The app ships **no** shared key.
- **Keyless local:** a generic OpenAI-compatible client (auth header omitted) targeting a server on the user's own machine — Ollama (default `http://localhost:11434/v1`), LocalAI, LM Studio, llama.cpp, vLLM. Base URL and model names live in browser-local storage (never the Memory Store). When every selected provider is local, the app is fully offline.

## No-Fabrication harness

The executable backbone of the No-Fabrication Rule: a CI suite over a fixture library (including sparse and adversarial profiles) that extracts every factual claim from generated output, resolves each against the provenance index, and fails the build on any unresolved claim or invented skill/tool. New output paths must be covered by it.

## Transparency principles

Career Agent is built around full transparency of automated decisions. Nothing the system does to your data is hidden — every outbound request and every post-processing transformation is surfaced in the UI so you can inspect, verify, and override.

### Egress Transparency

Every outbound request through the Egress Gate is fully transparent to the user:

- **Egress logging.** Every prompt sent and response received — regardless of provider type (cloud or local) — is persisted to `log/egress_log.md` in the Memory Store. Each `EgressLogEntry` contains:
  - Timestamp (ISO 8601)
  - Provider destination (e.g. `openai`, `anthropic`, `local`)
  - Operation kind (e.g. `chat`, `stt`, `skill-discovery`, `role-discovery`, `star-questions`, `coaching-loop`, `cv-tailoring`)
  - Full prompt text sent
  - Full response text received

  Entries are stored in a machine-readable Markdown format (one section per entry). For very large payloads (>10KB), the in-UI display truncates but the persisted log always contains the full text. The log is viewable from the Memory & Maintenance phase screen as a read-only chronological view.

- **Prompt preview for all providers.** For keyed cloud providers the Payload Preview gate shows the exact outbound text before transmission and the user can edit or cancel. For keyless local providers an informational (non-blocking) preview shows the same text with a "this stays on your device" label, so users can always inspect what the model sees regardless of provider type.

- **Operation labelling.** Every provider call is labelled in the UI before it runs — either as a "third-party network call" (cloud) or a "local on-device call" (local) — so the user always knows where their data is going.

### Inference Transparency

Every automated post-processing decision is surfaced in the review UI:

- **Date normalisation annotations.** When `normalizeDate()` converts a natural-language date to ISO format (e.g. "March 2020" → "2020-03"), the Skill Map review screen shows the original value alongside the normalised result in a "Post-processing" section. Each transformation is also logged to the session log.

- **Compound skill splitting annotations.** When `splitCompoundSkills()` expands a compound entry (e.g. "AWS SAM (Python, Lambda)" → "AWS SAM", "Python", "Lambda"), the review screen displays what was split so the user can verify and override.

- **Editable skill categories.** Each skill's regex-assigned category (Technical, Leadership, Communication, Domain, Tools, Core Competency) is shown in the Skill Map review with a dropdown to override it. The user has the final word on how their skills are categorised.

- **Merge rationale display.** When the Skill Mapper normalises two terms (e.g. "k8s" → "Kubernetes"), the merge rationale is surfaced in the review UI showing what was merged and why. The user can reject any merge with a one-click undo.

- **Bullet-to-position matching rationale.** In the Output screen, each CV bullet can be expanded to show why it was placed under a given position — the matching is based on skill overlap between the bullet's evidence links and the position's technologies (e.g. "Matched via skill overlap: Kubernetes, Docker").

- **AI-only mode clarity.** When the user selects AI-only mode, the UI clearly labels what is happening at each phase: the Skill Map explains that it is building from AI-extracted career data, the Output screen explains that CV structure comes from confirmed evidence with AI tailoring as advisory suggestions, and Role Discovery explains that suggestions are AI-generated from the confirmed skill map.

## Storage tiers

A single `Storage_Adapter` interface with two capability-detected tiers:
- **File System Access** (Chromium desktop) — reads/writes a real user-selected local folder of Markdown.
- **Fallback** (Safari/Firefox/mobile) — OPFS + IndexedDB with one-click `.zip` export/import of the entire store.

Both serialise to the **identical** canonical directory structure, so the store round-trips identically across tiers.

## Where to go next

- [Project structure](./project-structure.md) — the concrete modules and files behind each piece above.
- [Building & testing](./building-and-testing.md) — how the property tests and No-Fabrication harness enforce these invariants.
- [Run Modes & deployment](./run-modes-and-deployment.md) — how the same bundle ships three ways without ever adding a backend.
