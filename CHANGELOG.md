# Changelog

All notable changes to Career Agent are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-07-04

### Added

- **Card-based navigation and AppShell** (R66–R69): the UI is restructured from a
  single scrolling page into a multi-view app with a persistent sidebar, phase
  stepper, and one-phase-at-a-time card layout.
  - `AppShell.tsx` — two-area layout: header (title + save status) + sidebar + main.
  - `NavSidebar.tsx` — phase stepper, Settings link, Save & Exit button.
  - `PhaseStepper.tsx` — visual progress stepper with status badges and a
    "→ recommended" indicator on the next incomplete phase.
  - `WelcomePage.tsx` — first-run landing explaining the pipeline and privacy.
  - `ResumeScreen.tsx` — return-visit "Continue from [phase]" screen.
  - `SettingsPage.tsx` — all config (providers, model, tokens, language, privacy)
    in a dedicated view separated from the pipeline.
- **First-run flow**: Language → Welcome → Settings ("Continue — upload your
  documents →") → Ingest. Returns go Language → Resume → last phase.
- **Phase-specific completion actions** — "Save and generate skill map", "Save and
  discover roles", etc. replace the generic "Confirm and continue."
- **Progressive disclosure** in each phase card — sections reveal as the user
  completes prior steps; later sections are absent from the DOM.
- **Save-status indicator** — header shows "✓ Progress saved" or "⚠ Temporary
  session — export before closing" with a transient flash on each auto-save.
- **Save & Exit button** — triggers a Memory Store JSON export download from any
  view; accessible in the sidebar and header.
- **Experience duration replaces recency** (R70): the skill-map data model now
  uses `since?: ISODate` (when the user first used a skill) instead of `recency`.
  - Computed `experienceYears(since)` helper for display and prompt calibration.
  - Auto-derived from earliest evidence date on generation; user-editable in the
    Skill Map review screen ("Since" field).
  - Migration: old Memory Stores with `recency` are transparently migrated.
  - The coaching prompt and role-discovery payload now show "~N years experience"
    instead of "last used YYYY-MM-DD."
  - Standalone skills without employment context get `since: undefined` (prompting
    the user to fill it in) instead of today's date.
  - Cross-reference: when a standalone skill appears in an employment item's
    technologies, its `since` is derived from the employment start date.
  - The skill-discovery prompt now asks the LLM to infer "since YYYY" for each
    skill based on employment dates, and the parser extracts it.
- **Model discovery from validation** (R43.7, R43.8): on successful key
  validation or test-connection, the `GET /models` response is captured, filtered
  to chat-capable models, and shown as a selectable dropdown.
  - `extractChatModels` / `isChatModel` helpers filter by known patterns.
  - Per-provider model choice persisted in `career-agent.provider-prefs`
    (browser-local storage).
  - Cloud clients (OpenAI, Anthropic) read the user's model choice per call.
- **Adaptive rate-limit handling** (`src/adapters/rate-limits.ts`):
  - Static model-capabilities table (context-window sizes for known model families).
  - Runtime cache populated from `x-ratelimit-*` response headers after each call.
  - On a 429 "request too large" error: captures limit from headers, trims the
    prompt proportionally, and retries once — recovers automatically instead of
    surfacing the error.
- **`maxTokens` visible for all providers** — the completion-token field is now
  shown regardless of which provider is selected (not just Local). `0 = no limit`
  omits `max_tokens` from the request.
- **Structured candidate profile in STAR prompt** — replaces the flat
  comma-separated skill-name list with a compact profile showing matched skills
  (with evidence count + experience years + proficiency signal) and gap skills,
  plus a "Calibrate depth and seniority" instruction.
- Locale strings for all new components (en + pt-BR).
- Developer docs updated (project-structure, user-guide) in both languages.

### Changed

- **STAR question prompt** now requests a JSON array (`[{competency, question}]`)
  instead of the `<competency> :: <question>` line format. The parser is tolerant
  and layered (JSON-first → line fallback) so local models that ignore the format
  still yield questions (R62.5 conformance fix).
- **`parseQuestionPrompts`** rewritten: handles JSON arrays (clean, fenced,
  embedded in preamble), `{questions:[…]}` wrappers, bare-string arrays, and falls
  back to a positive-criteria line scan (lines ending in `?` or starting with a
  behavioural lead-in). Generic competency assigned from `locales/` when missing.
- **Local Provider `max_tokens` default** raised from 512 to 2048. Cloud providers
  keep the 512 fallback but now also read the shared setting so the user can
  override it.
- **STAR prompt background context** trimmed to only role-relevant skills
  (matched + gap) instead of the entire skill map, dramatically reducing token
  usage and avoiding 429s on large profiles.
- `starQuestionSkillNames` replaced by `buildCandidateProfile` — a richer,
  structured summary the model uses for depth calibration.
- Cloud LLM clients (OpenAI, Anthropic) now read the user's model choice from
  `getProviderModel()` per call instead of using hardcoded defaults.
- Version bumped from 0.1.2 → 0.3.0 (minor: new features, breaking data-model
  change from `recency` → `since`).

### Fixed

- **STAR questions blank-UI bug**: local models that ignored the `::` format
  returned zero suggestions (the parser dropped every line), causing the UI to
  silently bounce back to the same prompt with no error. Now any model's output
  is parsed tolerantly.
- **Reasoning-model empty answer**: deepseek-r1 and similar reasoning models
  consumed the entire 512-token completion budget on chain-of-thought, leaving
  `message.content` empty. Fixed by raising the local default to 2048 and making
  it user-configurable.
- **First-run Settings "Back to pipeline" confusion**: after Welcome → Settings,
  the button said "Back to pipeline" (no pipeline existed yet). Now shows
  "Continue — upload your documents →" on first-run.
- **Pipeline still rendered as old PhaseWizard**: the UI restructure was
  incomplete — the pipeline view was still a flat vertical page. Now rendered
  inside `AppShell` with a proper sidebar stepper.
- **No "next step" action after completing a phase**: after reviewing ingested
  documents, there was no button guiding the user to the next phase. Each phase
  card now has a prominent phase-specific action at the bottom ("Save and generate
  skill map →", "Save and discover roles →", etc.) that persists and advances.
- **Source Trace Inspector shown on every phase**: it appeared below the Ingest
  content with no context, confusing new users. Now only shown on Output and
  Memory phases where confirmed claims exist to inspect.

### Removed

- `recency: ISODate` field from `SkillMapEntry` — replaced by `since?: ISODate`.
  Existing stores are migrated transparently on load.

## [0.1.2] — 2026-07-04

### Fixed

- Coaching prompt and parser: initial JSON format + tolerant parsing fix
  (pre-release internal iteration, committed as `024e641`).

## [0.1.1] — 2026-07-04

### Fixed

- Documentation: badges, GHCR visibility, model-tag guidance.

## [0.1.0] — 2026-07-04

### Added

- Initial release: full six-phase pipeline (Ingest → Skill Map → Role Discovery →
  Interview Coaching → Output → Memory), local-first browser app with no backend,
  BYOK provider support (OpenAI + Anthropic + Local/Ollama), Egress Gate,
  PII scanning, No-Fabrication harness, File System Access + Fallback storage,
  Docker Compose stack, adaptive STAR coaching loop, in-browser audio recording,
  CV generation (Markdown + PDF + DOCX), LinkedIn report, i18n (en + pt-BR).
