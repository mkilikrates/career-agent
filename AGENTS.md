# AGENTS.md

Instructions for AI coding agents (and humans pairing with them) working in this
repository. If you are an automated agent, **read this file first** and follow it
for every task. It complements — and does not replace — [`CONTRIBUTING.md`](./CONTRIBUTING.md),
[`SECURITY.md`](./SECURITY.md), and the developer docs in [`docs/en/developer/`](./docs/en/developer/architecture.md).

## What this project is

Career Agent is a **local-first, no-backend** browser app (TypeScript + WebAssembly,
React + Vite). Read [`docs/en/developer/architecture.md`](./docs/en/developer/architecture.md)
before changing anything.

## Environment & tooling

- **Node.js 24.16.0** (pinned in `.tool-versions`; recent Node 20+ works for local dev). Use the pinned version if you can — don't assume a different one.
- **Package manager: `npm`** (a `package-lock.json` is committed). Install with `npm install`.
- Core commands: `npm run dev` (dev server), `npm run build` (typecheck + static build), `npm run typecheck`, `npm test`, `npm run test:no-fabrication`. See [`docs/en/developer/building-and-testing.md`](./docs/en/developer/building-and-testing.md).
- This is a **static bundle** — there is nothing to deploy to a server; never add one.

## Non-negotiable trust invariants

Never weaken these. A change that breaks one will be rejected:

1. **No backend** — all logic runs in the browser; no server receives/stores user data.
2. **Single Egress Gate** — no module imports or calls a provider client directly; every
   outbound provider request goes through `@core/egress`.
3. **No-Fabrication Rule** — generated output may only contain facts that resolve to a
   source citation or explicit user confirmation; new output paths must be covered by the
   No-Fabrication harness.
4. **Memory Store stays on the device** — never written by a server, container, or
   host-mounted volume.
5. **No hardcoded user-facing strings** — all UI text comes from `locales/` (`en`, `pt-BR`).
6. **`@core` stays framework-agnostic** — no React, DOM, or adapter-implementation imports;
   only interfaces.

## Golden rule: keep the living documents in sync

**Before performing any change — and as part of the same change — update the project's
living documents so code, specs, prompts, and docs never drift apart.** A change is not
complete until all of the following are consistent with it.

### 1. Specs — `.kiro/specs/career-agent/`

Update the spec whenever behavior, requirements, or design change:

- `requirements.md` — add/adjust the EARS requirement(s) for the change.
- `design.md` — reflect the technical design (components, interfaces, data flow).
- `tasks.md` — add/refresh the implementation tasks and mark them complete.

Requirements-first: update `requirements.md` → `design.md` → `tasks.md`, then implement.

### 2. Prompts — `docs/prompts.md`

If you add or change any model prompt (skill discovery, role review, STAR question
generation, the adaptive coaching loop, summaries, CV tailoring, etc.), update
`docs/prompts.md` so the documented prompts match the code.

### 3. Documentation — `docs/` and root docs

Update every user- or developer-facing doc affected by the change:

- User-facing change → `docs/<lang>/user-guide.md`.
- Developer/architecture/structure/build/deploy change → the matching file in
  `docs/<lang>/developer/`.
- Index/overview change → `README.md` (and `README.<lang>.md`).
- Keep `CONTRIBUTING.md` / `SECURITY.md` accurate if process or guarantees change.

### 4. Language parity — update ALL available languages

Documentation is multilingual. The current languages are **English (`en`)** and
**Brazilian Portuguese (`pt-BR`)**; more may be added over time.

- When you change a document, update **every language version that exists** for it so
  translations never drift (e.g. `docs/en/user-guide.md` **and** `docs/pt-BR/user-guide.md`,
  `README.md` **and** `README.pt-BR.md`).
- If a translation does not yet exist for a doc, update the English source and **explicitly
  note that the other-language version is pending** (do not silently leave it stale).
- Treat the language list as dynamic: before finishing, check which language folders/files
  exist (`docs/<lang>/`, `README.<lang>.md`) and update each one.

### 5. Versioning

Keep versions consistent across code and all languages:

- Bump `package.json` `version` for releasable changes (semver).
- If a `CHANGELOG.md` exists, add an entry under the new version.
- Where a doc carries a version or "last updated" marker, update it — and keep that marker
  identical across all language versions of the same doc.

## Standard workflow for any change

1. **Read** this file, the [architecture doc](./docs/en/developer/architecture.md), and the
   relevant spec sections.
2. **Update the spec** (`requirements.md` → `design.md` → `tasks.md`) for the change.
3. **Implement** the code change, preserving every trust invariant above.
4. **Update prompts** (`docs/prompts.md`) if any prompt changed.
5. **Update docs** in **all** available languages (§3, §4), and **versions** (§5).
6. **Verify:** `npm run typecheck` and `npm test` must pass; add/Update tests
   (unit, and a `fast-check` property test for broad-input invariants).
7. **Summarize** what changed across code, spec, prompts, and docs in your PR description
   (the PR template has a checklist for this).

## Testing expectations

- Add or update tests for every code change. New domain logic gets unit tests; behavior
  with a broad input space and a clear universal invariant gets a **`fast-check` property
  test** (minimum **100 iterations**), tagged `// Feature: career-agent, Property N: …`.
- The **No-Fabrication harness must stay green** (`npm run test:no-fabrication`). Any new
  path that produces generated output must be covered by it.
- External boundaries (LLM, STT, File System Access, Typst-Wasm, `MediaRecorder`) are
  **mocked** in tests — never hit a real provider or network in a test.
- `npm run typecheck` and `npm test` must both pass before a change is done.

## Repo conventions (don't fight them)

These already exist — follow them (details in
[`docs/en/developer/project-structure.md`](./docs/en/developer/project-structure.md)):

- **Branded IDs** (`StarId`, `SkillId`, …) are constructed via the `as*` helpers in
  `@core/types`, never by raw casting.
- **Adapters are injected** at the `@ui/runtime.ts` composition root — the only place
  provider adapters and the Egress Gate are constructed. Core takes collaborators via DI.
- **Tests are co-located** next to the code as `*.test.ts(x)`.
- **No hardcoded user-facing strings** — add them to `locales/en.json` and `locales/pt-BR.json`.

## The spec is the source of truth

This repository is driven by a **Kiro spec** at `.kiro/specs/career-agent/`
(`requirements.md`, `design.md`, `tasks.md`). Do **not** make a behavioral code change
without reflecting it there first (requirements → design → tasks), and keep `tasks.md`
status accurate as you complete work. Treat the spec as authoritative when code and spec
disagree — reconcile them, don't silently diverge.

## Definition of Done

A change is complete only when **all** of these are true:

- [ ] `npm run typecheck` passes and `npm test` passes (incl. the No-Fabrication suite).
- [ ] Tests added/updated for the change (unit + property test where applicable).
- [ ] All six trust invariants still hold.
- [ ] Spec updated (`requirements.md` → `design.md` → `tasks.md`).
- [ ] Prompts updated (`docs/prompts.md`) if any prompt changed.
- [ ] Docs updated in **every** available language (`docs/en/**`, `docs/pt-BR/**`, `README*`),
      or pending translations explicitly flagged.
- [ ] Versions bumped consistently across code and all languages (§5).
- [ ] No real personal data committed.

## Hard don'ts

- ❌ Do not introduce a backend, a data store outside the browser, or a host-mounted
  Memory Store.
- ❌ Do not call a provider/LLM/STT client outside the Egress Gate.
- ❌ Do not commit real personal data (CVs, LinkedIn exports, API keys, tokens). Use
  placeholders. `spec/raw/` and similar local inputs are intentionally git-ignored.
- ❌ Do not hardcode user-facing strings — add them to `locales/`.
- ❌ Do not land a code change while leaving the spec, prompts, or any language's docs
  out of date.

## Quick reference

| Concern | Where |
|---|---|
| Trust model & invariants | [`docs/en/developer/architecture.md`](./docs/en/developer/architecture.md) |
| Code map / modules | [`docs/en/developer/project-structure.md`](./docs/en/developer/project-structure.md) |
| Build & test | [`docs/en/developer/building-and-testing.md`](./docs/en/developer/building-and-testing.md) |
| Run modes & deployment | [`docs/en/developer/run-modes-and-deployment.md`](./docs/en/developer/run-modes-and-deployment.md) |
| Spec (source of truth) | `.kiro/specs/career-agent/` |
| Prompts | `docs/prompts.md` |
| UI strings (i18n) | `locales/en.json`, `locales/pt-BR.json` |
