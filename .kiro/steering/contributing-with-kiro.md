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

This repo is driven by a **single** Kiro spec at `.kiro/specs/career-agent/`. For any
behavioral change — whether a bug fix, a new feature, or an adjustment:

1. Update **requirements** (`.kiro/specs/career-agent/requirements.md`) in EARS format.
2. Update the **design** (`design.md`).
3. Update the **tasks** (`tasks.md`) and keep task status accurate as you implement.
4. Then write the code, then sync prompts/docs in **all** languages, then verify.

When running tasks, prefer Kiro's spec task execution so `tasks.md` status stays in sync.
If code and spec disagree, reconcile them — never let them silently drift.

## NEVER create a new spec folder

**All changes — bugs, features, adjustments — go into the existing spec at
`.kiro/specs/career-agent/`.** Do NOT create a new spec folder (e.g.
`.kiro/specs/some-bug-fix/`). This project has one living spec that evolves
incrementally. A new folder produces disconnected, duplicative artifacts that
conflict with the single-source-of-truth principle above.

## Definition of Done (mirror of `AGENTS.md`)

`npm run typecheck` + `npm test` (incl. `npm run test:no-fabrication`) pass · tests added ·
trust invariants intact · spec + prompts + docs updated in every available language ·
versions bumped · `CHANGELOG.md` updated · no real personal data committed.

## Changelog

Every change that affects behavior, fixes a bug, or adds a feature **must** have a
corresponding entry in [`CHANGELOG.md`](../../CHANGELOG.md) at the repo root. Follow the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format with
Added / Changed / Fixed / Removed sections under the current unreleased version heading.
If the version was bumped, use the new version number as the heading.

## Hooks & automation

This project may define Kiro hooks (e.g. run tests after a task, or remind you to sync
docs). If a hook fires, follow it. Do not disable project hooks to land a change.

## Other agents

Contributors using a different AI agent should point it at [`AGENTS.md`](../../AGENTS.md),
which is tool-agnostic and carries the same rules.
