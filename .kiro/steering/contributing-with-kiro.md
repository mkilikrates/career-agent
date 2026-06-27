---
inclusion: always
---

# Contributing to Career Agent with Kiro

This is the Kiro-native entry point for working in this repository. The **single
source of truth for the rules is [`AGENTS.md`](../../AGENTS.md) at the repo root** —
read it first and follow it for every task. This file adds only the Kiro-specific
"how"; it does not restate (or override) the rules in `AGENTS.md`.

## Read these before changing anything

1. [`AGENTS.md`](../../AGENTS.md) — trust invariants, the doc/spec/prompt sync rule,
   language parity, versioning, and the Definition of Done.
2. [`docs/en/developer/architecture.md`](../../docs/en/developer/architecture.md) — how it works.
3. The spec at `.kiro/specs/career-agent/` — the source of truth for behavior.

## Use the spec workflow — do not bypass it

This repo is driven by a Kiro spec. For any behavioral change:

1. Update **requirements** (`.kiro/specs/career-agent/requirements.md`) in EARS format.
2. Update the **design** (`design.md`).
3. Update the **tasks** (`tasks.md`) and keep task status accurate as you implement.
4. Then write the code, then sync prompts/docs in **all** languages, then verify.

When running tasks, prefer Kiro's spec task execution so `tasks.md` status stays in sync.
If code and spec disagree, reconcile them — never let them silently drift.

## Definition of Done (mirror of `AGENTS.md`)

`npm run typecheck` + `npm test` (incl. `npm run test:no-fabrication`) pass · tests added ·
trust invariants intact · spec + prompts + docs updated in every available language ·
versions bumped · no real personal data committed.

## Hooks & automation

This project may define Kiro hooks (e.g. run tests after a task, or remind you to sync
docs). If a hook fires, follow it. Do not disable project hooks to land a change.

## Other agents

Contributors using a different AI agent should point it at [`AGENTS.md`](../../AGENTS.md),
which is tool-agnostic and carries the same rules.
