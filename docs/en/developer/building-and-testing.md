# Building & Testing

> Read this in: **English** · [Português](../../pt-BR/developer/building-and-testing.md) · [← Back to the README](../../../README.md) · Developer docs: [Architecture](./architecture.md) · [Project structure](./project-structure.md) · **Building & testing** · [Run Modes & deployment](./run-modes-and-deployment.md)

How to build Career Agent from source and run its test suites.

## Prerequisites

- **Node.js 24.16.0** (pinned in `.tool-versions`; any recent Node 20+ should work for local dev).
- A modern browser. **Chromium-based desktop browsers (Chrome, Edge)** get the full experience including the File System Access storage tier; Safari / Firefox / mobile fall back to in-browser storage with `.zip` export/import.

## Quick start (development)

```bash
npm install        # install dependencies
npm run dev        # start the Vite dev server (prints a localhost URL, e.g. http://localhost:5173)
```

Open the printed URL in your browser.

## Production build

```bash
npm run build      # type-checks (tsc -b) then builds the static bundle to dist/
npm run preview    # serve the built dist/ locally to verify
```

The build sets `base: './'`, so every asset path is **relative** and `dist/` is a self-contained static bundle you can host on any static host (GitHub Pages, S3, Netlify, a plain web server) under any path, with no server-side code.

> **Why you can't just open `dist/index.html` from `file://`:** modern browsers block ES-module scripts and web workers (the app uses a `pdf.js` worker, and the Typst PDF path loads a WASM asset + worker chunk) on the `file://` origin. **Serve** the folder instead:
>
> ```bash
> npm run preview
> # or any static server:
> npx serve dist
> python3 -m http.server --directory dist 8080
> ```

## npm scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Vite dev server. |
| `npm run build` | Type-check (`tsc -b`) + static production build to `dist/`. |
| `npm run preview` | Serve the built `dist/` locally. |
| `npm run typecheck` | Type-check without emitting (`tsc -b --noEmit`). |
| `npm test` | Run the full Vitest suite (unit + property + smoke). |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:no-fabrication` | Run only the No-Fabrication regression suite. |

## Testing strategy

The suite is **dual**: example-based tests for concrete behaviours and external boundaries, and **property-based** tests for universal correctness invariants. Tests are co-located with the code as `*.test.ts(x)`.

### Example / unit / integration tests

Used for concrete cases and boundaries: LinkedIn ZIP/CSV parsing fixtures, BYOK key validation flows (with a mocked provider), per-capability routing, audio upload/record → mocked STT → confirm, the send-control gate, session/Memory-import rehydration, the six-phase wizard screens, accessibility checks, and so on. External boundaries (LLM, STT, File System Access, Typst-Wasm, `MediaRecorder`) are **mocked**.

### Property-based tests (`fast-check`)

Each correctness property is implemented as a single `fast-check` + Vitest test running a **minimum of 100 iterations**, tagged with a comment:

```ts
// Feature: career-agent, Property 3: <property text>
```

Property tests carry the burden of broad input coverage. Examples of what they pin down:
- redaction completeness + the egress boundary (nothing transmitted except via the gate; no secret values leak);
- conservative-merge guardrails and reversible merges in the Skill Mapper;
- Memory Store round-trips identically across both storage tiers;
- stable-ID integrity and bi-directionality;
- ontological match resolution;
- output eligibility gating and cross-format output fidelity;
- the opt-in-first AI orchestration guarantee (script-only makes zero provider calls; AI only supplements).

When adding domain logic with a broad input space and a clear universal invariant, prefer a property test over a handful of examples.

### The No-Fabrication harness

`npm run test:no-fabrication` runs the executable backbone of the No-Fabrication Rule against a fixture library that includes deliberately **sparse** and **adversarial** profiles (e.g. a bare job title with no listed tools). It extracts every factual claim from generated output, resolves each against the provenance index, and **fails** on any unresolved claim or invented skill/tool. Any new output-producing path must be covered here.

## What CI / a PR expects

Before opening a pull request:

```bash
npm run typecheck   # must pass (exit 0)
npm test            # full suite must pass
```

Add or update tests for your change, and keep the [trust invariants](./architecture.md#the-non-negotiable-invariants) intact. See [CONTRIBUTING.md](../../../CONTRIBUTING.md) for the full workflow.

## Troubleshooting the build

- **`tsc` errors after pulling:** run `npm install` (dependencies or types may have changed).
- **PDF/worker errors when testing the built bundle:** make sure you're **serving** `dist/` (`npm run preview`), not opening it from `file://`.
- **A property test fails intermittently:** `fast-check` prints the counterexample (the seed + the shrunk input). Reproduce it with that seed; a flaky property usually means the invariant — not the test — is wrong.
