# Contributing to Career Agent

Thanks for your interest in improving Career Agent! This is a short, friendly overview — the deep technical detail lives in the [developer documentation](./docs/en/developer/architecture.md).

## Before you start

- Read the [Architecture & trust model](./docs/en/developer/architecture.md) doc. Career Agent has a few **non-negotiable invariants** (local-first, single Egress Gate, No-Fabrication Rule). Changes that weaken them won't be accepted, so it's worth understanding them first.
- Set up your environment with the [Building & testing](./docs/en/developer/building-and-testing.md) guide.

## Ground rules (the trust invariants)

These are the rules the whole project is built around. Please preserve them:

1. **No backend.** Everything runs in the browser. Do not introduce a server that receives or stores user data.
2. **Single egress chokepoint.** No module may import or call a provider client directly. Every outbound provider request must go through the **Egress Gate** (`@core/egress`), which handles PII pre-screening, operation labelling, and payload minimisation.
3. **No fabrication.** Generated output may only contain facts that resolve to a source citation or an explicit user confirmation. New output paths must be covered by the No-Fabrication harness.
4. **The Memory Store stays on the device** and is never written by a server, container, or host-mounted volume.
5. **No hardcoded user-facing strings.** All UI text comes from the locale files in `locales/` (currently `en` and `pt-BR`).
6. **Keep `@core` framework-agnostic.** Domain logic must not import React, the DOM, or any adapter implementation — only interfaces. DOM/network/storage live behind adapters in `@adapters` and the shell in `@ui`.

## Workflow

1. Fork the repo and create a feature branch (never commit directly to `main`).
2. Make your change with tests. See [Building & testing](./docs/en/developer/building-and-testing.md):
   - `npm run typecheck` must pass.
   - `npm test` (the full Vitest suite) must pass.
   - Add or update tests for your change. New domain logic should have unit tests; behaviour with broad input spaces should have a `fast-check` property test.
3. Keep changes scoped and focused. Match the existing code style and conventions.
4. Open a pull request against a new branch with a clear description of *what* changed and *why*, and what you tested.

## Contributing with an AI agent (Kiro or other)

This repository is set up to be safe for AI-assisted contributions — as long as the agent follows the project rules.

- **Point your agent at [`AGENTS.md`](./AGENTS.md) first.** It's tool-agnostic and carries the trust invariants, the spec/prompts/docs sync rule, language parity, versioning, and a Definition of Done.
- **Using Kiro?** It auto-loads `AGENTS.md` and the steering file at `.kiro/steering/contributing-with-kiro.md`, so the rules apply with no setup. Use the **spec workflow** — drive changes through `.kiro/specs/career-agent/` (requirements → design → tasks) and keep `tasks.md` status accurate; don't bypass it.
- **The spec is the source of truth.** Don't make a behavioral change without updating the spec, and keep the prompts (`docs/prompts.md`) and docs (in every available language) in sync — see `AGENTS.md`.
- **Never let an agent commit real personal data** (CVs, exports, API keys). Review its diffs before committing.

## Reporting bugs and requesting features

Open a GitHub issue. For bugs, include steps to reproduce, what you expected, what happened, and your browser/OS. **Do not include real personal data** (CVs, API keys, etc.) in issues — use placeholders.

## Security

Please do **not** open public issues for security problems. See [`SECURITY.md`](./SECURITY.md) for how to report them responsibly.

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](./LICENSE).
