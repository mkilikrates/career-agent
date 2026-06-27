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

## Storage tiers

A single `Storage_Adapter` interface with two capability-detected tiers:
- **File System Access** (Chromium desktop) — reads/writes a real user-selected local folder of Markdown.
- **Fallback** (Safari/Firefox/mobile) — OPFS + IndexedDB with one-click `.zip` export/import of the entire store.

Both serialise to the **identical** canonical directory structure, so the store round-trips identically across tiers.

## Where to go next

- [Project structure](./project-structure.md) — the concrete modules and files behind each piece above.
- [Building & testing](./building-and-testing.md) — how the property tests and No-Fabrication harness enforce these invariants.
- [Run Modes & deployment](./run-modes-and-deployment.md) — how the same bundle ships three ways without ever adding a backend.
