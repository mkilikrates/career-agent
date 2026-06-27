<!--
⚠️ PRIVACY: Do not include real personal data, CVs, exports, API keys, or tokens
anywhere in this PR (description, diffs, tests, fixtures, screenshots). Use placeholders.
-->

## What does this PR do?

A clear description of the change and **why** it's needed.

## Related issues

Closes #___ (or links to relevant issues/discussions).

## How was it tested?

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] Added/updated tests for this change
- Notes on what you verified:

## Trust invariants (must stay intact)

See [the architecture doc](../docs/en/developer/architecture.md). Confirm your change preserves:

- [ ] **No backend** — everything still runs in the browser.
- [ ] **Single Egress Gate** — no module calls a provider client directly; all provider calls go through `@core/egress`.
- [ ] **No-Fabrication** — generated output only contains source-cited or user-confirmed facts (covered by the No-Fabrication harness).
- [ ] **Memory Store stays on device** — never written by a server/container/volume.
- [ ] **No hardcoded user-facing strings** — all UI text comes from `locales/`.
- [ ] **`@core` stays framework-agnostic** — no React/DOM/adapter-implementation imports.

## Documentation & spec sync

Per [`AGENTS.md`](../AGENTS.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md), changes must keep the project's living documents in sync:

- [ ] Updated the **spec** (`.kiro/specs/career-agent/`: `requirements.md`, `design.md`, `tasks.md`) where behavior/requirements changed.
- [ ] Updated **prompts** (`docs/prompts.md`) if model prompts changed.
- [ ] Updated **docs** (`docs/en/**`, `README.md`) for any user- or developer-facing change.
- [ ] Updated **every available language** version (e.g. `docs/pt-BR/**`, `README.pt-BR.md`) so translations stay in parity — or noted which translations are pending.
- [ ] Bumped versions where applicable (e.g. `package.json`, `CHANGELOG.md` if present) consistently across languages.

## Additional notes

Anything reviewers should know (trade-offs, follow-ups, screenshots with placeholder data).
