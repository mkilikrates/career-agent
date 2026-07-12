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

## Spec files are current-state documentation, not a changelog

The spec files (`requirements.md`, `design.md`, `tasks.md`) must always read as a
**complete, coherent description of the system as it is right now**. They are NOT
an append-only log of changes.

When making a change:

1. **Integrate, don't append.** If a new capability extends or modifies an existing
   requirement, UPDATE that requirement in place — add acceptance criteria, adjust
   wording, expand the user story. Do NOT just add a "Requirement 74" at the bottom
   that says "also do X from Requirement 71 but better." Instead, make Requirement 71
   say the right thing directly.
2. **Remove stale content.** If behaviour changed, delete or rewrite the old text so a
   reader never sees contradictions or "this was added later" artifacts.
3. **Design.md describes the system, not the history.** Write it so someone reading it
   fresh understands the architecture today. Sections like "the current extraction
   prompt asks for…" should always describe the ACTUAL current prompt, not the original
   one with a later section overriding it.
4. **Tasks.md tracks work status.** Completed tasks stay marked `[x]` as a record of
   what was done. But the requirements and design they implement should already be
   integrated into the main body of those documents — not left dangling as appended
   sections.
5. **Validate impact on existing content.** Before adding a new requirement or design
   change, read the existing related sections and ask: does this contradict, supersede,
   or extend something already written? If so, update the existing text first.

## Conflict detection — always ask

Before applying any change to the spec or code, verify it does not contradict an
existing requirement, design decision, or trust invariant. If a conflict is found:

1. Present BOTH sides (the existing rule and the proposed change) to the user.
2. Ask which takes precedence — never silently override an existing decision.
3. Only proceed after the user resolves the conflict.

This includes: requirements that overlap, design choices that compete, mode semantics
that would change (e.g. redefining what "AI-only" means), and trust invariants that a
feature might weaken.

## Documentation sync — after each task

After completing each implementation task (not just at the end of a batch):

1. Update **developer docs** (`docs/en/developer/`, `docs/pt-BR/developer/`) if the task
   changed architecture, data flow, build, or project structure.
2. Update **user-facing docs** (`docs/en/user-guide.md`, `docs/pt-BR/user-guide.md`) if
   the task changed user-visible behaviour.
3. Update **prompts** (`docs/prompts.md`) if any model prompt was added or changed.
4. Update **`CHANGELOG.md`** with the specific change from this task.
5. Ensure **all available languages** are updated (never leave one stale).

Do not consider a task complete until the docs are in sync.

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
