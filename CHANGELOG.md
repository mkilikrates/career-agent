# Changelog

All notable changes to Career Agent are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] — 2026-08-01

### Added

- **P1 property tests for core domain invariants** — implemented 7 fast-check
  property tests (minimum 200 iterations each) covering stable identifier
  integrity & bi-directionality (Property 2), conservative skill-merge
  guardrails & reversible merges (Property 4), Memory Store round-trip across
  storage tiers (Property 5), ontological match resolution (Property 6),
  employment gap detection (Property 8), conflict completeness & user authority
  (Property 12), and user override supremacy (Property 18).
- **P2 property tests for output, security, and session integrity** — implemented
  9 fast-check property tests covering Markdown identifier round-trip &
  non-printing (Property 11), state-healing detection completeness (Property 14),
  content/delivery firewall metamorphic invariance (Property 15), coaching-loop
  termination & outstanding-set correctness (Property 16), locale formatting &
  verbatim-term preservation (Property 17), CV version immutability & diff
  correctness (Property 13), send-control gating & payload composition
  (Property 20), send-control decision persistence round-trip (Property 21),
  and role-discovery payload minimisation (Property 22).
- **P3 integration and example tests verified** — confirmed that the 8 P3
  supplemental test tasks (4.5, 5.3, 8.12, 10.6, 11.5, 12.8, 16.3, 18.5) are
  already fully covered by existing test files (storage tiers, BYOK flows,
  ingestion, skill-map review, role discovery, coaching, localisation, privacy)
  and marked complete.
- **Remaining test tasks verified and closed** — audited and confirmed that all
  remaining 16 optional test tasks across sections 14, 24, 27–33, 35–41 are
  fully covered by existing test suites (1576 tests across 113 files). Wrote a
  new enriched role-discovery payload test (task 41.10) and a send-control panel
  rendering test (task 24.6). Zero optional test tasks remain.

### Fixed

- **AI-only mode no longer applies deterministic post-filtering (R60.5)** — in
  AI-only mode, the skill map generation now bypasses the conservative
  synonym/abbreviation merge pipeline (`skipNormalisation`), `consolidateExtractionReduced`
  is no longer applied on top of a successful AI consolidation, and AI extraction
  items are marked `userConfirmed: true` when the user accepts them so they pass
  eligibility for CV output. This resolves the issue where 192 AI-extracted skills
  dropped to 131, and where the generated CV was empty because employment/education
  items never reached output eligibility.
- **AI-only skill map auto-generates on confirm** — in AI-only mode, clicking
  "Confirm extraction" or adding manual skills now immediately builds the skill map
  without a separate "Generate" button, removing confusion about what "Generate"
  does when the AI already produced the result.
- **STAR talking point polishing no longer silently discards AI summaries** —
  raised `MAX_POLISHED_LENGTH` from 500 to 800 so that valid AI-produced per-question
  summaries for substantial STAR answers are not incorrectly rejected by the
  deterministic quality gate.

## [0.7.0] — 2026-08-01

### Fixed

- **Interview questions persisted to file immediately** — AI-generated practice
  questions are now written to the interview file via `saveInterview` as soon as
  they are received, ensuring they survive session interruption and browser refresh
  without data loss.
- **Talking point polished text uses AI summary** — the `polished` field of a
  confirmed talking point now uses the AI per-question summary's first-person
  past-tense recap instead of echoing back the raw user input verbatim.
- **CV generation includes education, contact details, certifications, awards,
  and nationality** — `buildCvTailoringPrompt` now falls back to extracting
  education, certifications, awards, and nationality from confirmed evidence when
  the CvModel fields are empty; the user's name and contact info are passed so
  the AI draft uses real data instead of "[Your Name]" placeholders.
- **Compound skill split respects OS/2, L2/L3 via allowlist** —
  `splitCompoundSkills` now includes OS/2, OS/2 Warp, L2/L3, and L2/L3
  Networking in the compound allowlist, and a fragment-detection pass
  (`mergeCompoundFragments`) reassembles incorrectly-split fragments back into
  their canonical compound form.
- **Skill duration uses lastEvidence−since instead of now−since** —
  `experienceDuration` now computes years as `(lastEvidence − since)` so legacy
  skills (e.g. COBOL used 1993–1997) report ~4 years, not ~31 years. Falls back
  to `now` only when `lastEvidence` is absent (skill still active).
- **LinkedIn headline uses professional summary + role + competencies** — the
  suggested headline is now composed from the target role title and the top 3
  confirmed core competencies (by evidence strength), joined with `·`. Falls
  back to the most-recent employment title when no role or competencies exist.
- **LinkedIn recommended skills filtered by recency and capped** — recommended
  skills now exclude entries whose `lastEvidence` predates a configurable cutoff
  (default 10 years) and are capped at 50 entries, ordered by role relevance
  then evidence strength.
- **Skill `since` uses earliest employment evidence** — when a standalone skill
  also appears in an employment item's technologies, its `since` date is derived
  from the employment start date if earlier, ensuring accurate experience
  duration rather than using only the standalone extraction date.
- **Talking point serialization cleaned of duplicate nested content** — the
  interview document serializer now deduplicates nested content in talking point
  fields, preventing repeated text blocks from accumulating across
  serialize/parse cycles.
- **Talking point confirm button disabled while AI summary loads** — prevents
  the user from confirming a talking point with the raw-input fallback polished
  text before the AI-produced summary arrives; the button now shows "Generating
  polished summary…" and enables only after the AI recap is ready.

## [0.6.0] — 2026-07-31

### Added

- **6 new OpenAI-compatible cloud providers** — Kimi (Moonshot), DeepSeek, Groq, xAI (Grok), OpenRouter, and a Custom OpenAI-Compatible option. Each has locale-aware setup guidance (en + pt-BR), encrypted key storage, and model auto-discovery via `GET /models`.
- **Custom OpenAI-Compatible provider** — users can enter any OpenAI-compatible endpoint URL + API key to use providers not in the pre-configured list. The base URL is persisted in browser-local storage and the model list is auto-discovered.
- **4 high-priority property tests** — No-Fabrication (Property 1), Redaction completeness (Property 3), Opt-in-first AI orchestration (Property 19), and Output eligibility gating (Property 7). All use fast-check with 100+ iterations.
- **3 medium-priority test suites** — Consolidation dedup (41.9), STAR multi-competency (41.11), and CV tailoring full ATS (41.12). Total 51 new tests.
- **Model dropdown auto-populates on Settings load** — for already-configured providers, available models are fetched automatically without requiring a manual test/validate click.

### Refactored

- **Unified `CareerContext` type** — replaced separate `AtsCareerData` and `AtsContext` with a single interface
- **Unified `deriveCareerContext` function** — replaced 60-line duplicates in two screens with one shared `@core` module
- **Shared `isThirdPartyDestination`** — extracted from 3 core modules into `@core/assist`
- **Shared UI utilities** — `parseCommaSeparatedList`, `buildEgressDest`, `useAiOperation` hook, `AiAssistProps` interface
- **Shared `retryOn429` helper** — consolidated duplicated 429 retry logic in `llm-http.ts`

### Changed

- Documentation fully synced with refactored code — project-structure (en + pt-BR), prompts.md (chunk size 12000, CareerContext references), design.md (shared utilities principle)

## [0.5.1] — 2026-07-31

### Fixed

- **AI-only coaching shows no deterministic script questions** — in AI-only mode, the coaching screen starts with an empty question list and waits for AI-generated questions instead of showing formulaic deterministic questions like "Tell me about a time your Jenkins made a difference"
- **Talking point polish uses AI summary** — in AI-only mode, the per-question AI summary's first-person past-tense recap is used as the polished talking point instead of repeating the raw user input verbatim
- **CV includes Education and Core Competencies** — `buildCvTailoringPrompt` now falls back to extracting education and competency items from confirmed evidence when the CvModel fields are empty
- **CV includes user name and contact** — the tailoring prompt now passes the user's name and contact info so the AI draft uses real data instead of "[Your Name]" placeholders
- **Generate CV respects AI-only mode** — clicking "Generate CV" in AI-only mode now directly calls the AI tailoring path instead of running the deterministic script path (no need for a separate "AI tailor" button click)
- **AI CV draft stripped of code fences and preamble** — `parseCvDraft` now strips markdown code fences and any preamble text the model prepends before the actual CV content
- **Chunk size increased from 6000 to 12000 chars** — career extraction chunks are now larger, giving the model more context per call and better skill-to-position correlation across the full CV
- **"Firewall Manager" no longer misclassified as Leadership** — the skill categoriser regex excludes product names containing "Manager" (Firewall Manager, Package Manager, etc.)
- **Comma-separated technology lists split into individual skills** — entries like "Unified communications using SIP, SKINNY, MGCP, H323" are now split when they contain 3+ comma-separated parts
- **Model dropdown auto-populates on Settings page load** — for already-configured providers (both local and cloud), available models are fetched automatically without requiring a manual "Test connection" or "Validate" click
- **Extraction items persisted after AI extraction confirmation** — `raw_extractions.md` is now updated when items are added from the Skill Map AI extraction, ensuring downstream phases and session resume have full ATS data
- **Career context derivation includes all extracted items** — `deriveCareerContext` (the unified function replacing the old `deriveAtsCareerData`/`deriveAtsContext`) no longer gates on `userConfirmed`, so role discovery and STAR questions receive the full career trajectory even before individual item confirmation
- **Phase stepper sync fix** — `phases()` now accepts an override current phase from the UI to prevent desync between the async orchestrator pointer and the displayed view
- **Ingest Save button in AI-only mode** — the Save button is now rendered in AI-only mode so the phase artefact is persisted and the stepper shows "Done"
- **Candidate profile includes all skills when no role match** — for user-added roles with 0 matched skills, the STAR question prompt now includes up to 30 skill map entries so the model has full context for question calibration

### Changed

- **Education strings stripped of markdown formatting** — bold markers and separator artifacts are removed before inclusion in prompts
- **Professional summary stripped of duplicate "Summary:" prefix** — prevents "Summary: Summary: ..." in role discovery and coaching prompts
- **Education dedup uses case-insensitive comparison** — prevents duplicate education entries in career context blocks

### Refactored

- **Unified `CareerContext` type** — replaced separate `AtsCareerData` (role-matcher) and `AtsContext` (coach-assist) with a single `CareerContext` interface in `@core/types`
- **Unified `deriveCareerContext` function** — replaced duplicated 60-line `deriveAtsCareerData` (RoleDiscoveryScreen) and `deriveAtsContext` (CoachingScreen) with a single function in `@core/career-context`
- **Shared `isThirdPartyDestination`** — extracted the one-liner duplicated in 3 core modules into `@core/assist`
- **Shared `parseCommaSeparatedList`** — extracted duplicated parse utility into `src/ui/ui-utils.ts`
- **Shared `buildEgressDest`** — extracted duplicated EgressDestination ternary into `src/ui/ui-utils.ts`
- **Shared `useAiOperation` hook** — eliminated duplicated busy/error/try-catch boilerplate across screens
- **Shared `AiAssistProps` interface** — eliminated 6 duplicated prop declarations across screen interfaces
- **Shared `retryOn429` helper** — consolidated duplicated 429 retry logic in `llm-http.ts`

## [0.5.0] — 2026-07-26

### Added

- **AI consolidation dedup prompt runs before deterministic pass in AI modes**
  (R71.15–R71.18): ensures context-aware deduplication happens first, with the
  deterministic pass acting only as a lightweight safety net.
- **Skills grouped by category and sorted by relevance in CV output** (R30.2,
  R32.4): skills are ordered by target-relevance then category in both the CV
  model and rendered Markdown.
- **AI CV draft displayed as primary output with toggle between AI and
  deterministic views** (R30.11–R30.13): when AI tailoring succeeds, the
  AI-generated draft is shown as the primary view; users can switch between it
  and the deterministic version before confirming.
- **STAR questions now receive full ATS career context** (R22.6, R62.5): job
  titles, competencies, education, and professional summary are passed to the
  STAR prompt for better candidate-calibrated questions.
- **Role discovery receives full ATS career context** (R20.6, R47.2): the
  role-discovery prompt includes previous titles, competencies, education, and
  summary for trajectory-aware suggestions.
- **Extraction items persisted to `raw_extractions.md` on Skill Map confirmation**
  so downstream phases and session resume have full ATS data available.
- **Save button added to Ingest screen in AI-only mode** so the phase artefact
  is persisted and the phase stepper can mark Ingest as complete.

### Changed

- Career context derivation no longer gates on `userConfirmed` — all extracted
  items (except those marked private for cloud) feed into downstream prompts.
- Phase stepper derives status from artefact presence in Memory Store, not
  positional index (R48.2–R48.4).
- Phase stepper uses the UI's current phase (not the async orchestrator pointer)
  for consistent display.

### Fixed

- AI CV draft was shown only as an advisory note instead of primary output in
  AI-only mode.
- Phase stepper showed "done" for phases that were merely navigated past without
  confirmation.
- Phase stepper showed "in progress" for phases ahead of the current one due to
  orchestrator/UI desync.
- Employment dedup handles OCR-garbled company names (e.g. "T RIP A DVISOR" =
  "TripAdvisor").
- Skill dedup catches containing-term relationships, slash-compound retention,
  and GitHub casing variants.
- Education entries in prompts stripped of markdown bold formatting artifacts.
- Professional summary stripped of duplicate "Summary:" prefix in prompts.
- Education dedup in career context uses case-insensitive comparison.
- Ingest phase showed "in progress" instead of "done" in AI-only mode because
  `raw_extractions.md` was never written.

## [0.4.0] — 2026-07-05

### Added

- **Skills grouped by category and sorted by relevance in CV output** (R30.2,
  R32.4): `buildCvModel()` now sorts skills by target-relevance (matched first),
  then by category (Technical → Tools → Domain → Leadership → Communication →
  Core_Competency), then alphabetically within each group. `renderSkills()`
  groups skills by category with bold sub-labels in the rendered Markdown.

- **AI consolidation prompt for dedup** (R71.15, R71.16, R71.17, R71.18):
  `buildConsolidationPrompt` sends the merged career extraction to the AI for
  context-aware deduplication (OCR noise, company-name variants, vendor-qualified
  skills, semantic duplicates, synonymous competencies) before the deterministic
  safety net. Only active in AI-only/AI-assisted modes; script-only mode skips it.
- **Reduced deterministic consolidation** (R71.16, R71.17): new
  `consolidateExtractionReduced` function performs only exact case-insensitive
  duplicate collapsing as a lightweight safety net after AI consolidation.
  Replaces the full fuzzy/synonym/vendor-prefix logic when AI handled the
  context-aware dedup.
- **Graceful AI consolidation failure handling** (R71.18): on AI error or
  unparseable response, the system falls back to `consolidateExtractionReduced`
  and logs a non-blocking warning.
- **Atomic technology naming in extraction prompt** (R41.8): the career extraction
  instruction now explicitly tells the model to list each technology as a separate,
  standalone item ("S3", "Lambda", "DynamoDB") rather than vendor-grouped entries
  ("AWS (S3, Lambda, DynamoDB)"), producing cleaner skill maps.
- **Vendor-prefix skill deduplication** (R71.15): `consolidateExtraction()` sub-pass 1
  collapses vendor-qualified duplicates ("AWS S3" + "S3" → "S3", "Azure DevOps" +
  "DevOps" → "DevOps") in both standalone skills and per-position technology arrays,
  keeping the earliest `since` date.
- **Fuzzy position deduplication** (R71.16): `consolidateExtraction()` sub-pass 2
  deduplicates positions with fuzzy matching on (company + title) and overlapping
  dates, keeping the richest entry (most technologies, longest description, most
  achievements).
- **Synonym competency deduplication** (R71.17): `consolidateExtraction()` sub-pass 3
  loads `competency_synonyms.yaml` and canonicalises synonymous competencies to their
  canonical form (e.g. "Team Leadership" → "Leadership", "Cross-functional
  Collaboration" → "Collaboration").
- **Core competencies prompt broadened to all seniority levels** (R71.5): the
  example list in the extraction instruction expanded to 26 competencies spanning
  entry-level through senior leadership, with a note about inferring the
  appropriate level from the candidate's demonstrated career patterns.
- **Role discovery ATS enrichment** (R20.6): the role-discovery prompt now receives
  `AtsCareerData` (previous job titles, core competencies, education summaries,
  professional summary) appended as a "Career context" block so the model can match
  on the candidate's career trajectory without seeing employer names.
- **STAR questions multi-competency format** (R62): the STAR question prompt now
  requests `"competencies"` (an array of one or more behaviours) instead of a
  singular `"competency"`, and passes `AtsContext` (previous titles, competencies,
  education, summary) for richer candidate-profile calibration. Backward-compatible
  parsing accepts the legacy singular field.
- **CV tailoring full ATS draft** (R30.9, R30.10, R30.14): both the no-posting and
  Target Opportunity CV tailoring paths now produce a complete ATS-formatted Markdown
  CV draft (professional summary, experience with adjusted emphasis, skills by
  relevance, education, core competencies) instead of 5 advisory bullet suggestions.
  The draft includes full confirmed career data and explicit No-Fabrication
  instructions, and is presented for user review before acceptance.
- **Egress transparency and LLM interaction logging** (R74): every prompt sent
  to and response received from any provider (cloud or local) is now logged to
  `log/egress_log.md` in the Memory Store. The log is viewable from the Memory &
  Maintenance screen. Local Provider requests also show an informational prompt
  preview so the user can inspect what is being sent regardless of provider type.
- **Inference transparency and decision surfacing** (R75): all automated
  post-processing decisions (date normalisation, skill splitting, category
  assignment, merge decisions, bullet-to-position matching) are now surfaced in
  the review UI. Users can see original vs. normalised values, override
  categories, reject merges, and view matching rationale for CV bullet placement.
- **Employment deduplication in CV generation** (R76):
  `deduplicateEmployment()` removes duplicate employment entries by
  (company, title, start date) before rendering, keeping the richest entry.
  Redundant company names in title fields are stripped automatically.
- **Role preference re-scoring** (R77): `rescorePreferences()` recomputes
  match scores for all saved role preferences whenever the skill map changes.
  User-added roles with no explicit required skills now parse skills from the
  description field for scoring rather than leaving the score at 0%.
- **Auto-save CV on generation** (R33.4): generated CVs are automatically saved
  to the Memory Store without requiring an explicit Save action.
- **AI-only mode clarity labels** (R60.11, R60.12): phase UIs now clearly
  communicate when AI is performing operations and distinguish between CV
  structure (from confirmed evidence) and AI tailoring (advisory suggestions).
- **Date normalization for career extraction** (R71.8, R71.9): `normalizeDate()`
  converts natural-language dates (written month names in English and Portuguese,
  numeric formats, date ranges) to ISO `YYYY-MM` or `YYYY` format before they
  enter the skill map. "Present"/"current"/"atual" and empty values yield
  `undefined`; already-ISO strings pass through unchanged.
- **Compound skill splitting** (R71.11, R71.12): `splitCompoundSkills()` expands
  parenthetical entries (`"AWS SAM (Python, Lambda)"` → three separate skills)
  and slash-separated entries (`"Terraform/Terragrunt"` → two skills) while
  preserving an allowlist of known compound names (CI/CD, TCP/IP, Node.js, C#,
  C++, .NET, GitLab CI/CD, IDS/IPS).
- **AI-polished talking-point validation** (R28.3): when the AI coaching summary
  produces a talking point, the `polished` field is validated to be a concise
  first-person past-tense summary; if validation fails, a deterministic
  sentence-trimming fallback is applied.

### Changed

- **Core competency extraction prompt strengthened** (R71.5, R71.6): the
  `CAREER_EXTRACTION_INSTRUCTION` now explicitly instructs the model to INFER
  behavioural competencies from career patterns and achievements (role
  progression, scope of responsibility, cross-team work, quantified outcomes) —
  not only literal keywords. Example competencies listed: Leadership, Innovation,
  Stakeholder Management, Crisis Management, Strategic Planning, Mentoring,
  Cross-functional Collaboration, Change Management, Cost Optimization, Technical
  Vision, Team Building, Process Improvement.

### Fixed

- **Role match scoring for user-added roles** (R71.21, R71.20): user-added roles
  (which have no structured `requiredSkills`) now parse mentioned skills from
  their description field and match against the confirmed skill map using
  ontological matching, computing a percentage score rather than returning 0%.
- **AI CV draft now displayed as primary output in AI-only/AI-assisted mode**
  (R30.11, R30.12, R30.13): when AI tailoring succeeds, the AI-generated CV
  draft is shown as the primary view with a toggle to switch between the AI
  draft and the deterministic version. Users confirm the AI draft before it is
  persisted; until then auto-save keeps the deterministic version.
- **AI consolidation dedup runs before deterministic pass in AI modes**
  (R71.15, R71.16, R71.17, R71.18): `buildConsolidationPrompt` sends the merged
  career extraction to the AI for context-aware deduplication (OCR noise,
  company-name variants, vendor-qualified skills, semantic duplicates) before
  the deterministic safety net. On failure, falls back gracefully to the reduced
  deterministic pass.
- **Phase stepper shows "done" only on confirmed artefact presence, not
  position** (R48.2, R48.3, R48.4): the phase stepper no longer marks phases
  complete based solely on their index being less than the current phase. A
  phase is complete only when its defining artefact is present in the Memory
  Store (e.g. `profile/skill_map.md` for the Skill Map phase).
- **Employment dedup handles OCR-garbled company/title names** (R76.1, R76.2):
  `deduplicateEmployment()` now normalizes company and title keys by stripping
  non-alphanumeric characters and common legal suffixes (GmbH, Ltd, Inc, etc.)
  before comparison, so OCR-damaged entries like "T RIP A DVISOR" match their
  clean counterpart.
- **Skill dedup catches containing-term, slash-compound, and GitHub variants**
  (R71.15): the deduplication pipeline now detects when one skill name fully
  contains another as a word/token and merges them, handles slash-compound
  retention (keeping "IDS/IPS" over standalone "IDS"), and normalizes GitHub
  capitalization variants.

## [0.3.0] — 2026-07-04

### Added

- **Rich ATS-compatible AI extraction schema** (R73): the career extraction prompt
  now produces a comprehensive structured profile including professional summary,
  per-position location/description/quantified achievements, core competencies
  (distinct from technical skills), spoken language proficiency, hobbies, causes,
  and extensible additional_info (publications, patents, awards, etc.).
- **New CV sections**: professional summary, core competencies, languages, hobbies
  & causes (rendered only when confirmed items exist).
- **`Core_Competency` skill category**: distinguishes soft skills and leadership
  qualities from technical skills in the skill map.

- **Zip session export** (R72.1, R72.2, R72.4, R72.5): a "Download session as zip"
  button in the Memory phase and the Save & Exit sidebar produces a timestamped
  `.zip` archive (`career-agent-YYYY-MM-DD.zip`) containing all Memory Store files
  in their canonical directory structure plus the JSON snapshot at the root.
- **Import from Welcome Page** (R72.3, R72.6, R72.7): an "Import a previous session"
  action on the Welcome Page accepts `.zip` or `.json` files, restores the Memory
  Store, and transitions to the Resume Screen. On failure the user stays on Welcome
  with an error message (non-destructive).

### Changed

- **Markdown CV renderer now uses structured employment entries** (R71.7, R73.5):
  the CV renders positions as grouped subsections (`### Title — Company (dates)`)
  with technologies, achievements, and talking-point bullets placed underneath,
  rather than a flat bullet list. Also renders professionalSummary, coreCompetencies,
  languages, and hobbiesAndCauses from confirmed extraction items.

### Fixed

- **Duplicate locale keys in extraction review** (R41.8): both `locales/en.json` and
  `locales/pt-BR.json` contained a duplicate `skillMap.extraction` JSON key — the
  second block (missing `positionItem`, `dates`, `datesOngoing`) silently overwrote
  the first, causing the UI to show raw locale key strings.
- **AI CV tailoring incorrectly required a Target Opportunity** (R30.7): selecting
  AI-assisted mode without providing a job posting caused silent fallback to
  script-only generation. The AI path now runs whenever the user opts in, tailoring
  toward the role alone when no posting is provided.

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

- **Local provider "Test connection" appears to do nothing**: after a successful
  connection test, the model-picker update immediately reset the status banner
  from "Connection successful" back to idle, so the user never saw confirmation.
  The success message now persists after the model list populates.
- **Duplicate locale keys** in `locales/en.json` and `locales/pt-BR.json`
  (duplicate `stepper`, `saveExit`, `shell` keys) that could cause raw keys
  rendering in the UI.
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
