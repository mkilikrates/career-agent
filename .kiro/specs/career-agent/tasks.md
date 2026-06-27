# Implementation Plan: Career Agent (Phase 1 Launch)

## Overview

This plan implements the local-first browser Career Agent in **TypeScript + React/Vite** (static build, WebAssembly via `typst.ts` and `pdf.js`, no backend), exactly as specified in the design document. It is sequenced to build the trust-critical foundations first (provenance, Markdown-as-database, stable IDs, state-healing), then the swappable adapters (Storage, Provider/Crypto, PII/Egress Gate), then the six domain engines (Ingestion → Skill Map → Role Discovery → Interview Coaching → Output), and finally the XState orchestrator, No-Fabrication harness, and UI shell that wire everything together.

Every task references the requirements it implements. Each of the 18 Correctness Properties is implemented as a single `fast-check` + `vitest` property test (minimum 100 iterations) tagged `// Feature: career-agent, Property {number}: {property_text}`. Property and test sub-tasks are marked optional with `*`.

## Tasks

- [x] 1. Project foundation and core domain types
  - [x] 1.1 Scaffold the static-bundle build and test harness
    - Initialise TypeScript + React + Vite project with `base: './'` so the bundle opens from `file://` or any static host with no backend server
    - Configure the `@core/*` framework-agnostic module boundary separate from the React shell and adapters
    - Add `vitest` and `fast-check` dev dependencies and a base test config (default minimum 100 iterations for property runs)
    - Add placeholder adapter interfaces only (no logic) so the core never imports a provider/storage client directly
    - _Requirements: 1.1, 1.2_
  - [x] 1.2 Define core domain type models in `@core/types`
    - Implement `Provenance`, `Confidence`, `ExtractedItem`, `ConflictRecord`, `SkillMapEntry`, `Accomplishment`, `TalkingPoint`, `RolePreference`, `MergeRecord`, `HealingReport`, `LocaleConfig`, `OutputLocale`, and ID brand types (`StarId`, `BulletId`, `SkillId`, `RoleSlug`)
    - Encode invariants in the types: provenance is always `>= 1`, confidence is `High|Medium|Low`, retired flags exist on accomplishments/talking points
    - _Requirements: 10.1, 11.1, 14.1, 18.1, 20.2, 21.2, 23.1, 36.2, 38.1, 41.1_

- [x] 2. Provenance / Citation Service
  - [x] 2.1 Implement the Provenance service in `@core/provenance`
    - Attach a provenance record (source line, user confirmation, or interview answer) to every fact at creation time
    - Build a provenance index that resolves any claim ref to its source trace, and expose a trace lookup for the UI inspector
    - _Requirements: 38.1, 38.2_
  - [x] 2.2 Write unit tests for the Provenance service
    - Cover each provenance kind and unresolved-claim detection
    - _Requirements: 38.1, 38.2_

- [x] 3. Markdown-as-database: serialization, stable-ID registry, and state-healing
  - [x] 3.1 Implement the Markdown serializer/parser in `@core/markdown`
    - Use `remark`/`mdast` + `gray-matter` to read/write human-readable Markdown with embedded stable IDs as HTML anchor comments mirrored in frontmatter
    - Guarantee anchors do not render in printable output
    - _Requirements: 34.1, 34.2_
  - [ ]* 3.2 Write property test for Markdown identifier round trip and non-printing
    - **Property 11: For any Markdown document containing embedded stable identifiers (anchor comments and/or frontmatter), parsing then re-serialising preserves every identifier and all content, and rendering the document to printable output contains none of the identifier anchors.**
    - **Validates: Requirements 34.2**
  - [x] 3.3 Implement the ID Registry and stable-ID assignment
    - Assign `BULLET-NN` and `STAR-NN` identifiers that are unique and never reused or renumbered; build the bi-directional skill↔accomplishment reference graph from frontmatter + anchors
    - Mark retired items rather than deleting them
    - _Requirements: 18.1, 18.3, 18.4, 23.1, 23.2, 23.3_
  - [ ]* 3.4 Write property test for stable identifier integrity and bi-directionality
    - **Property 2: For any sequence of create / edit / retire operations on accomplishments and talking points, every assigned BULLET-NN and STAR-NN identifier is unique, is never reused or renumbered, and retired items remain present and marked rather than deleted; and for every skill→accomplishment link the reverse accomplishment→skill link resolves consistently.**
    - **Validates: Requirements 18.1, 18.3, 18.4, 23.1, 23.2, 23.3, 28.3**
  - [x] 3.5 Implement the state-healing pass in `@core/healing`
    - On a registry, verify all skill evidence references; flag broken references and prompt repair; detect duplicate IDs and prompt re-index; never throw; emit a `HealingReport`
    - _Requirements: 36.1, 36.2, 36.3_
  - [ ]* 3.6 Write property test for state-healing detection completeness
    - **Property 14: For any Memory Store into which dangling identifier references and duplicate identifiers have been injected, the healing pass detects exactly those broken references and duplicates, flags them (prompting repair / re-index) rather than throwing, and a structurally clean store yields an empty healing report.**
    - **Validates: Requirements 36.1, 36.2, 36.3**

- [x] 4. Storage_Adapter (two tiers)
  - [x] 4.1 Implement the canonical `MemoryTree` and shared serialization
    - Model the canonical directory structure (profile/interviews/outputs/config/log) over an in-memory `MemoryTree`; record agent actions, confirmations, and conflict resolutions in `session_log.md`; expose `deleteAll`
    - _Requirements: 34.1, 34.3, 34.4_
  - [x] 4.2 Implement the File System Access tier
    - Capability-detect and prompt folder selection; read/write real Markdown/output files to the user-selected folder; detect lost access and re-prompt before continuing writes; make writes atomic per file
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - [x] 4.3 Implement the fallback OPFS/IndexedDB tier with zip export/import
    - Persist via OPFS (binary) + `idb` (text/index); show the documented degraded-tier notice; implement one-click `.zip` export and import of the entire store; validate malformed archives and leave the existing store intact on failure
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 34.4_
  - [ ]* 4.4 Write property test for Memory Store and session-state round trip
    - **Property 5: For any Memory Store tree (and for any mid-question coaching session state), exporting/serialising and then importing/deserialising reconstructs an identical store/state, and the result is identical across the File System Access tier and the fallback tier.**
    - **Validates: Requirements 3.3, 3.4, 3.5, 25.4**
  - [ ]* 4.5 Write integration tests for both storage tiers
    - Mocked FS Access handle (select/write/lost-access re-prompt); fallback tier selection + degraded notice
    - _Requirements: 2.1, 2.4, 3.1, 3.2_

- [x] 5. Crypto key vault and Provider_Manager (BYOK)
  - [x] 5.1 Implement the Web Crypto key vault
    - Encrypt API keys at rest with AES-GCM (non-extractable derived key) in browser-local storage; decrypt just-in-time; never write a key to the Memory Store
    - _Requirements: 5.1, 5.2_
  - [x] 5.2 Implement the pluggable Provider_Manager
    - Provider registry with README-style setup guidance; key validation via a test call with failure reporting and re-entry; store/remove encrypted keys; transmit a key only to its owning provider; ship no shared/built-in key
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.3, 5.4_
  - [ ]* 5.3 Write integration tests for BYOK setup flows
    - Valid-key and invalid-key paths with a mocked provider; verify no key persists to the Memory Store and removal deletes the encrypted key
    - _Requirements: 4.3, 4.4, 5.2, 5.4_

- [x] 6. PII_Scanner and Egress Gate
  - [x] 6.1 Implement the PII_Scanner
    - Regex + lightweight JS scanning for SSN, NINO, credit card, and API key/token categories; produce detections and a `redact()` that removes detected high-risk values
    - _Requirements: 6.1, 6.2, 6.4, 6.5_
  - [x] 6.2 Implement the single Egress Gate chokepoint
    - Route every outbound provider request through the gate: attach the third-party network-operation label, run PII pre-screening, notify category and offer redact-and-proceed, build the minimised Redacted Payload, then hand off to Provider_Manager; fail closed when screening cannot complete; transmit only to the user's chosen provider and never Memory Store file contents
    - _Requirements: 6.1, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4_
  - [ ]* 6.3 Write property test for redaction completeness and egress boundary
    - **Property 3: For any text payload containing seeded high-risk values (SSN, NINO, credit card, API key/token), the payload actually transmitted to a provider is produced only through the Egress Gate, contains none of the detected secret values, is the minimised redacted form, is addressed only to the user's chosen provider, includes no Memory Store file contents, and no detected secret is echoed into any generated output.**
    - **Validates: Requirements 6.1, 6.4, 6.5, 7.1, 7.2, 7.4**

- [x] 7. Checkpoint - Trust foundations
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Ingestion_Engine
  - [x] 8.1 Implement format detection, accept/reject, and the document checklist
    - Accept PDF, Markdown, plain text, and LinkedIn export ZIP; reject out-of-scope formats with a "deferred to a later phase" notice; present the recommended document checklist before ingestion
    - _Requirements: 8.1, 8.3, 8.4_
  - [x] 8.2 Implement PDF extraction with confidence flagging
    - Extract text via the `pdf.js` web worker; flag low-confidence regions explicitly and exclude uncertain text from extractions
    - _Requirements: 8.5_
  - [x] 8.3 Implement LinkedIn ZIP CSV parsing
    - Read the ZIP via `JSZip` and parse Profile/Positions/Skills/Certifications CSVs via `PapaParse`
    - _Requirements: 8.2_
  - [x] 8.4 Implement structured extraction with confidence scoring and provenance
    - Extract employment, education, certifications, named skills, language proficiency, and quantified results with surrounding context; assign Confidence (High/Medium/Low); attach a provenance record to every item
    - _Requirements: 10.1, 10.2, 10.3, 11.1, 38.1_
  - [ ]* 8.5 Write property test for employment gap detection
    - **Property 8: For any chronologically ordered list of employment date ranges, every interval greater than three months between consecutive roles is detected and reported, and no interval of three months or less is reported.**
    - **Validates: Requirements 10.4, 13.1**
  - [x] 8.6 Implement multi-document reconciliation and conflict detection
    - Merge the richest description; record all conflicting values with sources; default recommendation to most-recent-for-recent / most-detailed-for-older; treat user-entered values as authoritative; log resolutions so conflicts are not re-presented
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_
  - [ ]* 8.7 Write property test for conflict completeness and user authority
    - **Property 12: For any set of documents describing the same role, every field that differs across documents produces a conflict record listing all candidate values with their source documents (no value is silently chosen), the default recommendation follows the most-recent-for-recent / most-detailed-for-older rule, a user-entered value is always treated as authoritative over document-derived values, and a resolved conflict is not re-presented on a subsequent reload.**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5**
  - [x] 8.8 Implement output eligibility gating
    - Compute the eligible set as High-confidence + user-confirmed Medium + explicitly promoted Low, excluding private items; route Low items to a needs-review bucket; raise user-confirmed/edited items to highest reliability with user-confirmation provenance
    - _Requirements: 11.2, 11.3, 11.4, 12.3, 12.4_
  - [ ]* 8.9 Write property test for output eligibility gating
    - **Property 7: For any set of extracted items with mixed confidence, confirmation, and privacy flags, the set of items eligible to appear in outputs is exactly the High-confidence items plus user-confirmed Medium items plus explicitly promoted Low items, excluding every item marked private; and any user-confirmed or user-edited item carries highest reliability with a user-confirmation provenance.**
    - **Validates: Requirements 11.2, 11.3, 11.4, 12.3, 12.4**
  - [x] 8.10 Implement review/correction, gap handling, and user-override supremacy
    - Present a summary grouped by document; allow confirm/edit/delete/add and mark-private; present detected gaps with neutral framing and private/eligible annotation; exclude invented gap explanations and misleading date formatting; accept the user's version on any override and flag a concern at most once without refusing to proceed
    - _Requirements: 12.1, 12.2, 12.4, 13.1, 13.2, 13.3, 13.4, 39.1, 39.2_
  - [ ]* 8.11 Write property test for user override supremacy
    - **Property 18: For any field on which the user issues an override, the persisted value equals the user-supplied value, and any agent concern about that override is recorded at most once with no refusal to proceed.**
    - **Validates: Requirements 39.1, 39.2**
  - [ ]* 8.12 Write example tests for ingestion behaviours
    - LinkedIn CSV fixtures, checklist, representative structured-field extraction, and review/correction UI capabilities
    - _Requirements: 8.2, 8.4, 10.1, 10.2, 10.3, 12.1, 12.2, 12.3_

- [x] 9. Checkpoint - Ingestion complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Skill_Mapper
  - [x] 10.1 Implement conservative normalisation and confusables guardrails
    - Load `confusables.yaml` (extensible, no code change); merge only true synonyms/abbreviations/casing-or-spelling variants of the same skill; never merge confusable pairs or distinct named products by string similarity; never introduce sub-skills absent from source; add umbrella terms found in source as separate additional skills; keep uncertain pairs separate with one optional merge suggestion
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 16.1, 16.2, 16.3, 16.4_
  - [ ]* 10.2 Write property test for conservative-merge guardrails and reversible merge
    - **Property 4: For any set of skill terms, the normaliser merges two terms only when they are unambiguously the same skill, never merges a pair listed in confusables.yaml or two distinct named products on the basis of string similarity, never introduces a sub-skill absent from source, adds an umbrella term (when present in source) as a separate additional skill rather than a replacement, and for any merge that occurs a reversible MergeRecord exists such that a one-step split restores the original distinct terms.**
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4, 16.1, 16.2, 16.3, 19.3**
  - [x] 10.3 Implement skill-map generation with bi-directional evidence links
    - Generate entries with name (user phrasing preserved), category, evidence-based proficiency signal, dated evidence trail, accomplishment links, and recency; derive skills only from verified source or user confirmation; reference STAR/BULLET IDs bi-directionally; exclude self-reported proficiency unless user-provided
    - _Requirements: 14.1, 14.2, 14.3, 18.2, 18.3_
  - [x] 10.4 Implement reversible merge records, split, and skill-map review
    - Log each merge with rationale and one-step reversibility; present the map for review; require role/project + approximate time when adding a skill; allow remove and one-step split; store personal self-assessment separately from the evidence-based signal
    - _Requirements: 15.2, 19.1, 19.2, 19.3, 19.4_
  - [x] 10.5 Persist the confirmed skill map to the Memory Store
    - Save `skill_map.md` before advancing on user confirmation
    - _Requirements: 14.4_
  - [ ]* 10.6 Write example tests for skill-map review
    - Add-skill (role/project + when required), remove, split, and self-assessment separation
    - _Requirements: 19.2, 19.3, 19.4_

- [x] 11. Role_Matcher
  - [x] 11.1 Implement the taxonomy loader and ontological satisfaction
    - Load `taxonomy.yaml` (`implements`/`extends`, extensible); recognise a child skill as satisfying a required parent skill, affecting scoring only and never rewriting user phrasing
    - _Requirements: 17.1, 17.2, 17.3, 20.3_
  - [ ]* 11.2 Write property test for ontological match resolution
    - **Property 6: For any taxonomy and skill map, when a target role requires a parent skill and the map contains a child skill defined as implements/extends of that parent, the matcher recognises the requirement as satisfied rather than reporting a gap.**
    - **Validates: Requirements 17.2, 20.3**
  - [x] 11.3 Implement role suggestion and match scoring
    - Suggest employed / freelance / portfolio role types; for each produce title+description, a skill-match score labelled an estimate, a rationale, and matched-vs-gap skills using ontological matching
    - _Requirements: 20.1, 20.2_
  - [x] 11.4 Implement role preference capture and persistence
    - Accept/reject/add roles; rank and tag (actively_applying / exploring / practice_only); save `role_preferences.md`
    - _Requirements: 21.1, 21.2, 21.3_
  - [ ]* 11.5 Write example tests for role discovery and preferences
    - Role-type categories and accept/reject/rank/tag capture
    - _Requirements: 20.1, 21.1, 21.2_

- [x] 12. Interview_Coach
  - [x] 12.1 Implement STAR question generation
    - Generate role-grounded STAR questions: at least one behavioural per core skill, one on an identified gap, one motivation; store in a per-role interview file
    - _Requirements: 22.1, 22.2, 22.3_
  - [x] 12.2 Implement the guided text loop with Soft-Close and resume
    - Guide through S/T/A/R; ask only open follow-ups with no suggested facts; loop until complete, Soft-Close, or pass; accept partial answers with an explicit missing-element flag and a later-recommendation; persist mid-question state and show progress; resurface flags on resume
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 25.1, 25.2, 25.3, 25.4, 25.5_
  - [x] 12.3 Implement audio upload and transcription via the Egress Gate
    - Accept MP3/WAV (≤25MB, ≤600s); transcribe through the user's STT provider via the Egress Gate (PII pre-screening); present transcription for confirmation/correction; reject unsupported/oversized files with a reason and retain prior answer state; prompt to configure STT when none is set while preserving audio
    - _Requirements: 26.1, 26.2, 26.3, 26.9, 26.11_
  - [x] 12.4 Implement the content/delivery firewall
    - Analyse content separately from delivery; feed only content into the skill map and CV path; treat verbal tics, hesitations, accent, dialect, non-standard phrasing, and transcription artefacts as neutral
    - _Requirements: 27.1, 27.2_
  - [ ]* 12.5 Write property test for the content/delivery firewall (metamorphic)
    - **Property 15: For any answer transcript, augmenting it with delivery-only variations (filler words, hesitations, dialect or accent markers, transcription artefacts) yields an identical content analysis and an identical contribution to the skill map and CV path.**
    - **Validates: Requirements 27.1, 27.2**
  - [x] 12.6 Implement answer refinement, talking points, and retirement
    - Present a four-element STAR summary with flags; show weaknesses as coaching suggestions not blockers; generate a polished first-person past-tense talking point and assign a STAR ID on confirmation; store with STAR IDs; mark retired talking points rather than deleting
    - _Requirements: 23.1, 23.3, 28.1, 28.2, 28.3, 28.4_
  - [x] 12.7 Implement skill-map update from interview answers
    - At session end, detect skills/roles/achievements not yet in the map; surface for explicit confirmation; on confirmation update the map with new evidence and STAR/accomplishment links
    - _Requirements: 29.1, 29.2, 29.3_
  - [ ]* 12.8 Write example tests for coaching
    - Question grounding and STAR summary rendering
    - _Requirements: 22.1, 28.1, 28.2_

  - [x] 12.9 Wire in-browser audio recording and the answer-input mode choice into the coaching UI
    - The @core RecordingController (MediaRecorder-backed AudioRecorderPort) already exists in src/core/interview/recording.ts; provide the shell-side AudioRecorderPort implementation over navigator.mediaDevices/MediaRecorder (audio only, no video)
    - In CoachingScreen, surface the three answer-input modes — type text, upload audio, and record audio — as a clear selectable choice; always offer text and upload, and offer the record path only when microphone access is available, falling back to upload/text on denial
    - Wire start/stop/re-record/discard, the 600s cap and 25MB guard, request mic permission before recording, transcribe the recording via the STT provider through the Egress Gate, and present the transcript for confirmation/correction before feeding it into the coaching loop
    - _Requirements: 26.4, 26.6, 26.7, 26.8, 26.10, 26.12_

- [x] 13. Checkpoint - Coaching complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Output_Engine
  - [x] 14.1 Implement the single `CvModel` builder from confirmed evidence
    - Build the CV content as the subset of confirmed evidence selected via skill↔accomplishment links; prioritise toward the target role; use quantified results where available; annotate `[needs_metric]` points
    - _Requirements: 30.1, 30.2, 30.3, 30.4_
  - [x] 14.2 Implement the Markdown renderer (primary output)
    - Always render Markdown as the primary output from the `CvModel`
    - _Requirements: 32.1_
  - [x] 14.3 Implement the Typst-Wasm PDF renderer (ATS-safe, accessible)
    - Compile confirmed Markdown to PDF via `typst.ts` client-side using single-column, linear-reading-order, selectable-text templates with sufficient contrast and a proper text layer; on compile failure still deliver the Markdown primary without blocking other formats
    - _Requirements: 32.2, 32.4, 42.4_
  - [x] 14.4 Implement the structured DOCX renderer
    - Generate a simplified structured rich-text DOCX (via `docx`) optimised for ATS upload, single-column with no layout tables/meaningful icons/text-in-images
    - _Requirements: 32.3, 32.4_
  - [ ]* 14.5 Write property test for cross-format output fidelity
    - **Property 9: For any confirmed CvModel, the textual content extracted from the Markdown, Typst-Wasm PDF, and DOCX outputs is equal — no content is added, dropped, or altered between formats.**
    - **Validates: Requirements 32.5**
  - [ ]* 14.6 Write property test for ATS-safe and accessible output structure
    - **Property 10: For any generated CV PDF or DOCX, the document uses a single-column linear reading order, exposes a selectable text layer, and contains no layout tables, no meaning-bearing icons, and no text embedded in images.**
    - **Validates: Requirements 32.4, 42.4**
  - [x] 14.7 Implement the advisory LinkedIn improvement report
    - Generate headline, rewritten about, position rewrites, and recommended skills drawn only from confirmed information; advisory only, never posting or applying changes
    - _Requirements: 31.1, 31.2_
  - [x] 14.8 Implement CV versioning and diffing
    - Store each version as an immutable file by role slug + version number; on edit create a new version; produce a diff of accomplishments added/removed/reordered and skills re-emphasised
    - _Requirements: 33.1, 33.2, 33.3_
  - [ ]* 14.9 Write property test for CV version immutability and diff correctness
    - **Property 13: For any sequence of CV edits for a role, every previously stored version remains byte-identical and each edit yields a new version identifier; and for any two versions, the produced diff enumerates exactly the accomplishments added, removed, or reordered and the skills whose emphasis changed.**
    - **Validates: Requirements 33.1, 33.2, 33.3**
  - [x] 14.10 Implement locale-driven output formatting
    - Ask target country/region; apply locale date/number/currency/page-length/section-name conventions with per-convention override; preserve technical terms/tool names/proper nouns verbatim; default photo/age/marital-status to omitted unless explicitly opted in
    - _Requirements: 41.5, 41.6, 41.7_
  - [ ]* 14.11 Write property test for locale formatting and verbatim-term preservation
    - **Property 17: For any output and any selected locale, listed technical terms, tool names, and proper nouns appear verbatim and untranslated; date, number, currency, page-length, and section-name conventions match the selected locale unless individually overridden; and locale-driven personal-data fields (photo, age, marital status) are omitted unless the user has explicitly opted in.**
    - **Validates: Requirements 41.5, 41.6, 41.7**

- [x] 15. Checkpoint - Output complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. Localisation
  - [x] 16.1 Implement i18next with externalised locale resources
    - Load all user-facing strings from `/locales/en.json` and `/locales/pt-BR.json` (no hardcoded strings); detect preferred language from browser/OS locale and ask to confirm/change; store the choice in the Memory Store and apply to messages, prompts, review steps, and outputs
    - _Requirements: 41.1, 41.2, 41.3, 41.8_
  - [x] 16.2 Implement source-language-independent extraction
    - Extract content from source documents regardless of the Session Language
    - _Requirements: 41.4_
  - [ ]* 16.3 Write example tests for localisation
    - Language detect/confirm/store/apply and externalised-string loading
    - _Requirements: 41.1, 41.2, 41.3, 41.8_

- [x] 17. Career_Agent orchestrator (XState) and session lifecycle
  - [x] 17.1 Implement the XState six-phase statechart and phase hub
    - Model the resumable Ingest→Skill Map→Role Discovery→Interview Coaching→Output→Memory pipeline; allow jump to any phase; route all provider calls through the Egress Gate only
    - _Requirements: 35.2_
  - [x] 17.2 Implement session resume and the outstanding-items summary
    - On return, load and summarise Memory Store state via the healing pass; compute the outstanding set as the union of unanswered questions, flagged talking points, unreviewed skill entries, and unresolved conflicts; allow continue-from-last
    - _Requirements: 35.1_
  - [x] 17.3 Implement re-entry triggers
    - New job description → parse to required/preferred skills, compare to map, identify gaps, propose tailored CV; new document → merge via Requirement 9 rules; post-interview debrief → update talking points and note gaps
    - _Requirements: 35.3, 35.4, 35.5_
  - [ ]* 17.4 Write property test for coaching-loop termination and outstanding-set correctness
    - **Property 16: For any coaching interaction, the per-question loop terminates exactly when the STAR answer is complete, the user invokes Soft-Close, or the user passes (no other exit), and a Soft-Closed answer always produces a persisted flagged point that reappears in the resume outstanding set; and for any Memory Store state, the resume summary's outstanding list equals exactly the union of unanswered questions, flagged talking points, unreviewed skill entries, and unresolved conflicts present in the store.**
    - **Validates: Requirements 24.4, 25.1, 25.2, 35.1**

- [x] 18. No-Fabrication harness, privacy, and consent
  - [x] 18.1 Implement the No_Fabrication_Harness
    - Maintain a fixture library of sample profiles including sparse and adversarial cases; extract every factual claim from a generated output and resolve each against the provenance index; fail any unresolved claim or invented skill/tool; exclude title-implied skills; require user confirmation before an item reaches final output; version the no-fabrication system prompt alongside its evaluation results
    - _Requirements: 37.1, 37.2, 37.3, 37.4, 40.1, 40.2, 40.3, 40.4_
  - [ ]* 18.2 Write property test for No-Fabrication (every output claim resolves to provenance)
    - **Property 1: For any confirmed evidence set and any generated output (CV, LinkedIn report, talking point, or skill-map entry), every factual claim in that output resolves to at least one provenance record (a source document line, an explicit user confirmation, or a confirmed interview answer); no skill, metric, date, title, or employer name appears unless it is sourced or user-confirmed, and no skill is added solely because a job title implies it.**
    - **Validates: Requirements 13.3, 13.4, 14.2, 17.3, 29.2, 29.3, 30.1, 31.1, 37.1, 37.2, 37.3, 37.4, 38.1, 40.2, 40.3**
  - [x] 18.3 Wire the No-Fabrication harness as a dedicated CI suite
    - Run the harness in CI over the fixture library; fail the build on any unresolved claim or invented skill/tool; record the prompt version with eval results
    - _Requirements: 40.2, 40.3, 40.4_
  - [x] 18.4 Implement the privacy statement, consent gating, and network labels
    - Render the privacy statement (files stay on device; not fully offline due to Redacted Payload); label each third-party operation before it runs; exclude user data from training/improvement without explicit informed consent; prompt for clarification on incomplete/ambiguous documents
    - _Requirements: 1.3, 1.4, 7.3, 42.1, 42.2, 42.3_
  - [ ]* 18.5 Write example tests for privacy and consent
    - Privacy notice render, consent gating, and clarify-on-ambiguity
    - _Requirements: 1.4, 42.1, 42.3_

- [x] 19. UI shell wiring and integration
  - [x] 19.1 Wire the phase wizard and review screens to the orchestrator
    - Connect React phase-wizard and review screens to the XState orchestrator and domain engines via the adapter boundaries; persist after every confirmed step
    - _Requirements: 1.1, 35.2_
  - [x] 19.2 Wire the source-trace inspector and privacy/network labels
    - Present each claim's source trace on inspection and render the Egress Gate network-operation labels in the UI
    - _Requirements: 7.3, 38.2_
  - [x] 19.3 Write the end-to-end smoke/integration test
    - Static bundle loads from `file://`, the privacy notice renders, and no network call occurs except via the Egress Gate
    - _Requirements: 1.1, 1.3, 1.4_

- [ ] 20. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 21. Completed since original plan (UI shell + provider integrations)
  - [x] 21.1 Full six-phase React wizard with dedicated per-phase screens
    - Build `ProviderSetup`, `IngestScreen`, `SkillMapScreen`, `RoleDiscoveryScreen`, `CoachingScreen`, `OutputScreen`, and `MemoryScreen` plus a composition-root `runtime.ts`; phase status badges derive from pipeline position
    - _Requirements: 48_
  - [x] 21.2 Real BYOK cloud provider clients (OpenAI + Anthropic)
    - Implement OpenAI chat completions and Anthropic messages clients; validate keys via a `GET /models` probe; route exclusively through the Egress Gate; store keys encrypted in the Web Crypto vault
    - _Requirements: 4, 5, 45_
  - [x] 21.3 No-training egress control
    - Derive the `noTraining` flag from consent state → `RedactedPayload` → client; set OpenAI `store:false`; exclude private items from payloads
    - _Requirements: 46_
  - [x] 21.4 Opt-in AI assist for Skill Mapping and Role Discovery
    - Add "suggest skills" (Skill Mapping) and "recommend roles" (Role Discovery) AI assist over non-private content only, behind explicit user confirmation
    - _Requirements: 47_
  - [x] 21.5 Multi-file ingestion UI and improved local extraction
    - Multi-file upload + paste + per-document review/remove; improved local text extraction (inline "Skills:" lines, vertical lists under plain headings, known section names)
    - _Requirements: 8.6, 8.7, 10_
  - [x] 21.6 Lossless `raw_extractions.md` round-trip and session rehydration
    - Human summary + embedded JSON round-trip; rehydrate session on resume and on Memory import (extractions, skill map, role preferences, talking points)
    - _Requirements: 49_
  - [x] 21.7 Talking-point persistence to per-role interview files
    - Persist confirmed talking points to the per-role interview file
    - _Requirements: 28.4_
  - [x] 21.8 Full interview coaching loop UI
    - Element-by-element STAR, open follow-ups, Soft-Close, Pass, progress indicator, mid-question persistence/resume, refine → confirm, and end-of-session skill sync
    - _Requirements: 22, 23, 24, 25, 27, 28, 29_
  - [x] 21.9 Audio upload + OpenAI Whisper STT via the Egress Gate
    - Accept uploaded audio, transcribe through the Egress Gate, and present the transcript for confirmation
    - _Requirements: 26_
  - [x] 21.10 Output downloads (Markdown, DOCX, ATS-safe Typst-Wasm PDF) and LinkedIn report
    - Markdown, structured DOCX, and ATS-safe Typst-Wasm PDF with the compiler wasm bundled locally (no CDN); advisory LinkedIn report
    - _Requirements: 30, 31, 32, 33_
  - [x] 21.11 Toolchain upgrade
    - Upgrade to Vite 8 (Rolldown) + Vitest 4 + `@vitejs/plugin-react` 6; add `Buffer` polyfill for `gray-matter`; resolve to 0 dependency vulnerabilities
    - _Requirements: 1.1, 1.2_
  - [x] 21.12 Opt-in AI skill discovery flow (full-corpus, chunked, destination-scoped)
    - Add a pure core module `@core/skills/skill-discovery.ts` (exported from `@core/skills`) providing full-corpus assembly with a destination-scoped private-item rule, chunking that is never truncated, a discovery-oriented prompt, and a parser for model-proposed skill names; unit-tested in `skill-discovery.test.ts`
    - Rework the `SkillMapScreen` AI assist into a full-corpus, chunked "discover skills with AI" flow that includes items marked private ONLY when the chosen chat provider is a keyless local on-device provider and excludes them for a keyed cloud provider; loop all chunks and aggregate/de-dupe suggestions; every suggestion still requires explicit user confirmation, and confirmed skills are recorded with user-confirmation provenance
    - Compute in `App.tsx` whether the chosen chat provider is keyless/local and thread it to the screen; leave the deterministic evidence-only `generate()` path unchanged
    - Add new locale strings (`noteLocal`/`noteCloud`/`progress`) to en and pt-BR
    - The Ingestion_Engine now returns `rawText` (the full document text fed to extraction — PDF confident text or the raw Markdown/plain-text body; empty for LinkedIn ZIPs), retained in-session only and never persisted to the Memory Store
    - `IngestScreen`/`App` thread the per-document raw text in session (same replace-on-reupload / remove-document semantics as items)
    - `@core/skills/skill-discovery.ts` adds `buildRawDiscoveryCorpus` (shared chunking); the SkillMapScreen discovery now uses the full raw document text for a keyless local on-device provider and falls back to the structured non-private corpus for a cloud provider or after a resume with no raw text
    - Unit tests added for the raw-corpus chunking
    - _Requirements: 46.4, 46.5, 47.1, 47.3, 47.4, 47.5, 47.6_

  - [x] 21.13 Persist raw document text so local AI skill discovery survives session resume / Memory import
    - Currently raw document text is in-session only, so after a reload the local discovery corpus falls back to the structured items. Persist the raw text (or a discovery-ready corpus) in the Memory Store — or re-derive it on resume — so whole-document local discovery works after resume/import, while keeping it out of any cloud payload
    - _Requirements: 47.1, 47.5, 49_

- [x] 22. Local provider, per-capability selection, and audio translate (new)
  - [x] 22.1 Finish keyless provider plumbing in the Provider_Manager
    - Export `LOCAL_PROVIDER_ID = 'local'`; add `keyless?: boolean` to `ProviderPlugin` and `keyless` to `ProviderDescriptor`; bypass the empty-key guard and skip vault decrypt for keyless providers in `validateKey`/`send`/`transcribe`; register the local plugin in `defaultProviderPlugins` with a setup guide
    - _Requirements: 43.2, 43.3_
  - [x] 22.2 Add local provider clients in `llm-http`
    - Implement `createLocalLlmProvider` + `createLocalSttProvider` that read base URL/model from `local-config` per call; include `local` in `createDefaultLlmClients`; auth header already omitted when the key is empty
    - _Requirements: 43_
  - [x] 22.3 Update the `local-config` adapter and default base URL
    - Keep editable `baseUrl`/`model`/`sttModel` in browser-local storage (never the Memory Store); change the DEFAULT base URL to Ollama `http://localhost:11434/v1` (currently defaults to LocalAI `:8080`) while keeping it user-editable so LocalAI/LM Studio/etc. still work
    - _Requirements: 43.1, 43.3, 43.4_
  - [x] 22.4 ProviderSetup UI for the keyless local provider
    - For the keyless local provider, show base URL + chat model + STT model fields and a "Test connection" button (validate via `GET /models`) instead of the API key field
    - _Requirements: 43_
  - [x] 22.5 Per-capability provider selection UI and wiring
    - Let the user choose the chat/LLM provider and the STT provider independently; thread the chosen chat provider into AI-assist/orchestrator calls and the chosen STT provider into the coaching audio path
    - _Requirements: 44_
  - [x] 22.6 Local provider availability detection
    - Treat the local provider as available when `local-config` is configured (not via the key vault)
    - _Requirements: 43, 48_
  - [x] 22.7 Whisper translate-to-English option
    - Add an `/audio/translations` path to the OpenAI STT client and a local equivalent; surface a translate toggle in the coaching audio UI
    - _Requirements: 26.5_
  - [x] 22.8 Privacy statement variant for all-local providers
    - When every selected provider is local, render the fully-offline message (no Redacted Payload leaves the device); for local destinations, the Egress Gate network label marks a local on-device call with no third-party egress
    - _Requirements: 1.5, 7.6, 43.5_
  - [x] 22.9 README LocalAI/Ollama setup section
    - Add a LocalAI/Ollama setup section to the README (Docker run, model pull, CORS/origins config) for the local provider
    - _Requirements: 43_
  - [x] 22.10 Write integration tests for keyless local provider and per-capability routing
    - Keyless validate/send/transcribe (auth header omitted), `local-config` round-trip, per-capability routing (chat → provider A, STT → provider B), no-payload-leaves-device when all-local, and the Whisper translate path
    - _Requirements: 43, 44, 26.5, 46_

- [x] 23. Deployment and packaging (Run Modes)
  - [x] 23.1 Multi-stage Dockerfile for the static-only unprivileged Web Container
    - Add a multi-stage `Dockerfile`: a `node` build stage that runs the existing Vite static build (`base: './'`) producing `dist/`, and a runtime stage that copies **only `dist/`** into `nginxinc/nginx-unprivileged` (non-root, listening on port `8080`) with no application source and no build toolchain in the runtime image
    - Add an nginx SPA static-file serving config that returns `index.html` for the SPA and only ever serves static files — it never proxies or app-processes a request
    - Add a `.dockerignore` so source, `node_modules`, and local artefacts are excluded from the build context / runtime image
    - _Requirements: 52.1, 52.2, 52.3, 52.4, 52.5_
  - [x] 23.2 docker-compose.yml full local stack
    - Add a `docker-compose.yml` with a `web` service built from the Dockerfile and publishing `8080:8080` (no Memory Store volume or host mount)
    - Add an `ollama` chat service publishing `11434:11434`, set `OLLAMA_ORIGINS` to the served web origin, mount named volume `ollama_models` for model files only, started by default
    - Add a `localai`/whisper STT service publishing `8081:8080`, set CORS allow-origins to the served web origin, mount named volume `localai_models` for model files only, placed behind `profiles: ["stt"]` so it starts only with `--profile stt`
    - Declare the `ollama_models` and `localai_models` named volumes; deliberately declare **no** Memory Store volume or host mount
    - _Requirements: 53.1, 53.2, 53.3, 53.4, 54.3, 54.4, 55.3, 55.4_
  - [x] 23.3 local-config base-URL validation for host-published reachability
    - In the `local-config`/Provider_Manager configuration path, reject a base URL that is a Docker Compose internal service name (e.g. `http://ollama:11434`) with an error explaining that the host browser can only reach a model server via a host-published localhost address
    - Accept host-published localhost base URLs and keep the host-published defaults (chat `http://localhost:11434`, STT `http://localhost:8081`)
    - Surface allowed-origins/CORS rejection guidance (instructions to add the served origin to `OLLAMA_ORIGINS` / LocalAI CORS) that preserves the current provider configuration
    - _Requirements: 54.1, 54.2, 54.5_
  - [x] 23.4 Local Model Server unreachable handling in the compose/local path
    - When a call to a Compose Local Model Server fails to connect or returns no response, surface an "unreachable" error scoped to that operation and retain the user's pending request state, reusing the existing Local-Provider-unreachable handling
    - _Requirements: 53.6_
  - [x] 23.5 Documentation updates (README + in-app docs)
    - Document the three Run Modes (local source build; Docker static single container; Docker Compose full local stack)
    - Document the host-published-port-not-service-name caveat, the `OLLAMA_ORIGINS` / LocalAI CORS allow-origins setup, and that named volumes hold model files only
    - Document the browser-owned Memory Store guarantee across all Run Modes, and recommend Chromium-based desktop browsers (Chrome, Edge) for the File System Access tier versus the fallback `.zip` export/import tier for other browsers
    - _Requirements: 50.1, 50.2, 50.3, 51.1, 51.2, 55.1, 55.2, 56.1, 56.2, 56.3, 56.4_
  - [x] 23.6 Write smoke/build-artefact tests for the container image and compose
    - Assert the runtime image contains `dist/` only (no application source or build toolchain), nginx runs as a non-root UID and binds a port ≥ 1024, and the root path returns `index.html` with no app processing
    - Assert `docker compose up` starts `web` + `ollama` by default and starts `localai` only with `--profile stt`
    - Assert the declared volumes are model-only with no Memory Store mount
    - _Requirements: 52.1, 52.2, 52.3, 53.1, 53.2, 53.3, 53.4, 55.4_
  - [x] 23.7 Write integration tests for run-mode wiring
    - Assert `local-config` rejects a Compose internal service-name base URL and accepts a host-published localhost base URL
    - Assert an allowed-origins rejection surfaces guidance and preserves the current provider configuration
    - Assert a Local-Model-Server connection failure yields an "unreachable" error while retaining pending request state
    - Reaffirm the cross-mode egress boundary by reusing Property 3 and the all-local fully-offline assertion (R1.5/R43.5)
    - _Requirements: 54.2, 54.5, 53.6, 50.6_

- [x] 24. Granular Ingestion Send-Control (per-file, per-detection)
  - [x] 24.1 Implement the send-control models and the browser-local SendControlStore
    - Implement `SensitiveDetection` (an individual high-risk PII/secret match with its category), `SendControlDecision` (`mode: 'whole-file' | 'per-detection'` plus the allowed-detection id set and a `confirmed` flag), and `SendControlPanelModel` (per-staged-file: the detections list, `destinationKind: 'keyed-cloud' | 'keyless-local'`, the scoped `defaultDecision`, and a `noDetectionsNotice` flag)
    - Implement `SendControlStore` as `Record<FileFingerprint, SendControlDecision>` persisted in browser-local storage, keyed by a stable file fingerprint; it records send choices only — never the staged file content or detected secret values — so it is never part of the Memory Store and never reaches a provider
    - _Requirements: 6.6, 57.1, 57.3, 57.4, 57.6, 57.9_
  - [x] 24.2 Gate ingestion payloads on a confirmed SendControlDecision and compose the payload
    - Extend the Egress Gate (task 6.2) so that for ingestion file content it consults the file's `SendControlDecision` and refuses to build or transmit any payload until that decision is `confirmed`
    - On a `whole-file` decision build the payload from the full file content; on a `per-detection` decision build the Redacted Payload by retaining exactly the allowed detection values and removing every redacted one
    - Apply destination-scoped defaults: for a keyed cloud destination every detection defaults to redacted and a detection value appears in the payload only when explicitly opted in; for a keyless local destination the whole file (including sensitive values) may be sent; offer the whole-file option even when there are no detections
    - _Requirements: 6.6, 57.1, 57.3, 57.4, 57.5, 57.6, 57.7, 57.10_
  - [x] 24.3 Wire the IngestScreen per-file send-control panel
    - Render a per-staged-file send-control panel that presents each Sensitive Detection individually with its category and offers whole-file vs per-detection allow/redact choices; show the explicit "no Sensitive Detections were found" notice when a file has no detections while still offering the whole-file option; persist the confirmed decision and reapply it when the same file is re-staged
    - _Requirements: 57.2, 57.8, 57.9_
  - [ ]* 24.4 Write property test for send-control gating and payload composition
    - **Property 20: For any staged file, any set of Sensitive Detections, and any destination kind: no payload is built or transmitted until a SendControlDecision is confirmed; a whole-file decision yields a payload equal to the full file content; a per-detection decision yields a payload containing exactly the user-allowed detection values and none of the redacted ones; for a keyed cloud destination every detection defaults to redacted and a detection value appears in the payload iff it was explicitly opted in; and for a keyless local destination the whole file (including sensitive values) may be sent.**
    - **Validates: Requirements 6.6, 57.1, 57.3, 57.4, 57.5, 57.6, 57.7, 57.10**
  - [ ]* 24.5 Write property test for send-control decision persistence round trip
    - **Property 21: For any SendControlDecision, persisting the decision and then re-staging the same file reproduces an identical decision (same mode and same allowed-detection set), so the user's per-file and per-detection choices are reapplied without change.**
    - **Validates: Requirements 57.9**
  - [ ]* 24.6 Write example tests for the send-control panel rendering
    - Each detection rendered individually with its category; the no-detections notice with the whole-file option still offered
    - _Requirements: 57.2, 57.8_

- [x] 25. AI Assist Opt-In-First shared pattern
  - [x] 25.1 Implement the shared opt-in-first contract
    - Implement `AssistMode` (`'script-only' | 'ai-assisted'`), `AssistChoice` (the pre-operation selection plus the capability), and the `AssistableOperation` contract: `scriptOnly(input)` produces a complete deterministic result and MUST issue zero provider calls; `aiAssisted(input, dest)` establishes the deterministic baseline then adds provider-derived supplements routed through the Egress Gate, never replacing the baseline and requiring explicit user confirmation before a suggestion enters the knowledge base
    - _Requirements: 14.5, 14.6, 20.4, 20.5, 22.5, 28.5, 30.7, 47.7, 47.8_
  - [x] 25.2 Wire the four AI-assistable components to the shared pattern and surface the choice
    - Route `Skill_Mapper`, `Role_Matcher`, `Interview_Coach`, and `Output_Engine` through the shared `AssistableOperation` so `script-only` calls `scriptOnly(...)` and never constructs an Egress request, while `ai-assisted` computes the baseline first then calls `aiAssisted(...)`; on provider failure fall back to the already-computed baseline with a non-blocking error, preserving phase state
    - Surface the pre-operation `script-only` vs `script + AI assist` choice on each phase screen alongside the network/privacy label for the destination
    - _Requirements: 14.5, 20.4, 22.4, 28.5, 30.7, 47.3, 47.7_
  - [ ]* 25.3 Write property test for opt-in-first AI orchestration
    - **Property 19: For any AI-assistable operation (skill discovery, role discovery, STAR question generation, educational summary, or CV tailoring) and any input: (a) when the user selects script-only, the operation produces a complete deterministic result and issues zero provider calls; and (b) when the user selects ai-assisted, the result still contains the full deterministic baseline (AI supplements, never replaces it) and every AI suggestion requires explicit user confirmation before it enters the knowledge base.**
    - **Validates: Requirements 14.5, 14.6, 20.4, 20.5, 22.4, 22.5, 22.6, 28.5, 30.7, 47.3, 47.7, 47.8**

- [x] 26. Role Discovery AI-assist payload
  - [x] 26.1 Implement the employer-free role-discovery payload and AI recommendation
    - Implement `RoleDiscoveryPayload` (per-skill: user phrasing, approximate experience duration in months, category) plus `buildDiscoveryPayload(map, dest)` which derives the request from the skill map only, excludes every employer and company name, and includes an approximate per-skill experience duration so the model can infer a level of experience; implement `recommendRolesAi(map, dest)` which sends the payload through the Egress Gate and, for a keyed cloud (third-party) destination, excludes every item marked private; returned roles are suggestions the user must explicitly accept before they enter preferences
    - _Requirements: 20.6, 47.2, 47.4_
  - [ ]* 26.2 Write property test for role-discovery payload minimisation
    - **Property 22: For any skill map, the role-discovery AI-assist payload contains no employer or company name and includes an approximate experience duration for every skill it carries; and for a keyed cloud (third-party) destination it excludes every item marked private.**
    - **Validates: Requirements 20.6, 47.2, 47.4**

- [-] 27. Interview_Coach: AI STAR questions, in-browser recording, and educational summary
  - [x] 27.1 Implement opt-in AI STAR question generation
    - Implement `generateQuestionsAi(role, map, dest)` using a prompt that frames the chosen model as a recruiter for the specific target position, routed through the Egress Gate; AI questions supplement and never replace the script questions (the returned set is always a superset); exclude every private item for a keyed cloud (third-party) destination; on provider failure surface a non-blocking error and preserve pending coaching state so the script questions remain available; AI-generated questions are practice prompts and are not gated by the No-Fabrication harness
    - _Requirements: 22.4, 22.6, 22.7, 22.8, 22.9_
  - [x] 27.2 Implement in-browser audio recording (no video)
    - Implement `RecordingController` (start / stop / re-record / discard) and `RecordedAudio` backed by the browser `MediaRecorder` API; request microphone permission before recording and, on denial, present an error explaining recording is unavailable while offering the upload path and the text-answer path; enforce a ≤600s duration guard and the ≤25MB size guard, rejecting oversized/unsupported takes with the reason while retaining the prior answer state; capture audio only, never video
    - _Requirements: 26.4, 26.9, 26.10_
  - [x] 27.3 Implement recording transcription and feed into the coaching loop
    - Implement `transcribeRecording(rec, opts)` that sends the take to the user's chosen STT provider through the Egress Gate after PII pre-screening, optionally translating to English; present the transcript for confirmation/correction before any further processing; on confirmation feed it into the coaching loop and send it to the chosen chat provider through the Egress Gate; when no STT provider is configured, prompt the user to configure one and preserve the captured audio
    - _Requirements: 26.6, 26.7, 26.8, 26.11_
  - [x] 27.4 Implement the opt-in educational STAR summary
    - Implement `educationalSummary(answer, dest)` producing a teaching artefact that identifies the Situation, Task, Action, and Result components of the user's own answer and explains what a good STAR-format answer looks like; bind it strictly to the content of the user's answer so it invents no fact (No-Fabrication Rule), keep it distinct from and never a substitute for the polished talking point, and make the script-only path produce no provider call
    - _Requirements: 28.5, 28.6, 28.7, 28.8_
  - [ ]* 27.5 Write integration tests for AI questions and in-browser recording
    - AI question generation (recruiter persona for the target position, supplement-not-replace, failure preserves coaching state); recording capture, microphone-denied fallback, no-STT-configured prompt preserving audio, and transcript → coaching loop + chat provider
    - _Requirements: 22.4, 22.6, 22.8, 26.4, 26.6, 26.7, 26.8, 26.10, 26.11_
  - [ ]* 27.6 Write example tests for AI questions and the educational summary
    - AI-generated questions are practice prompts not gated by the No-Fabrication harness; educational STAR summary rendering (S/T/A/R identification distinct from the polished talking point)
    - _Requirements: 22.9, 28.7_

- [x] 28. Output_Engine: opportunity-driven AI CV tailoring
  - [x] 28.1 Implement the CvRequest-based tailoring flow with script-only fallback
    - Change `generateCv` to a `CvRequest` signature; first ask whether the user has a Target Opportunity (upload or paste) to tailor toward, reachable from the new-CV re-entry point; implement `buildTailoringPayload(src, opp, dest)` that passes the Target Opportunity text through the Egress Gate with PII pre-screening and, for a keyed cloud (third-party) destination, excludes every item marked private; the AI tailors emphasis and ordering using only confirmed evidence; treat the Target Opportunity as a tailoring target and never a claim source, excluding any skill/metric/date/title/employer that appears only in the posting; when no opportunity is given, AI is declined, or the AI request fails, run the script-only path and indicate that script-only generation was used; wire the new-CV re-entry prompt
    - _Requirements: 30.5, 30.6, 30.7, 30.8, 30.9, 30.10, 35.6_
  - [ ]* 28.2 Write integration tests for the opportunity-driven tailoring flow
    - Target Opportunity intake (upload/paste); AI-declined and AI-failure fallback to script-only with the script-only indication; private-item exclusion for a keyed cloud destination
    - _Requirements: 30.5, 30.6, 30.7, 30.10_
  - Note: The No-Fabrication guarantee for Target-Opportunity-tailored CVs and educational STAR summaries is already covered by **Property 1** (task 18.2); no new property is added here — it ranges over these outputs.

- [x] 29. Comprehensive UI/UX (shared design system, responsiveness, accessibility, states)
  - [x] 29.1 Implement the shared design system and PhaseChrome
    - Implement a single `DesignTokens` source (typography, colour, spacing, per-element component styles) and a shared component library (`<Button>`, `<TextField>`, `<PhaseChrome>`, …) consumed by every phase screen so each element type is styled identically everywhere with no screen hardcoding typography/colour/spacing; `<PhaseChrome>` renders the current phase name plus next/previous controls on all seven wizard screens
    - _Requirements: 58.1, 58.2_
  - [x] 29.2 Implement the responsive layout primitive
    - Implement a single layout primitive that switches on a 768 CSS-pixel breakpoint: desktop layout at ≥768px and a mobile layout with no horizontal scrolling of page content at 320–767px; constrain content to the viewport width with wrapping/stacking so the rule applies uniformly across screens
    - _Requirements: 58.3, 58.9_
  - [x] 29.3 Implement accessibility in the shared components
    - Bake full keyboard operability (every interactive control reachable and operable by keyboard in a logical tab order), a visible `:focus-visible` indicator, screen-reader labels on every interactive control, and ≥4.5:1 text/background contrast (guaranteed by the token colour pairings) into the component library
    - _Requirements: 58.4, 58.10_
  - [x] 29.4 Surface network/privacy and AI opt-in choices before gated operations
    - On every screen that can trigger egress, render — before the operation runs — both the network/privacy label (third-party network call vs local on-device, no third-party egress) and the relevant AI opt-in-first choice, reusing the `AssistChoice` surface and the gate's operation label
    - _Requirements: 58.5_
  - [x] 29.5 Implement the shared empty / loading / error state primitives
    - Implement a shared `ScreenState` used by all phase screens: empty state names at least one next action; loading indicator appears within 1 second of start and is removed on completion; error state describes the failure, names the recovery action, and retains the user's prior input without loss
    - _Requirements: 58.6, 58.7, 58.8_
  - [ ]* 29.6 Write example/snapshot/integration and automated accessibility tests for the UI/UX
    - Snapshot/example tests that each element type renders identically across screens and that `<PhaseChrome>` shows the phase name + next/previous on all seven screens; responsive rendering at representative widths (e.g. 360px, 768px, 1280px) asserting the layout variant and absence of horizontal overflow; automated accessibility checks (e.g. axe in jsdom) plus focus-order and contrast assertions; empty/loading/error state behaviours including state preservation on error. UI concerns are verified by example/snapshot/a11y tests, not property tests
    - _Requirements: 58.1, 58.2, 58.3, 58.4, 58.5, 58.6, 58.7, 58.8, 58.9, 58.10_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each of the 22 Correctness Properties is implemented as a single `fast-check` + `vitest` property test (minimum 100 iterations) tagged `// Feature: career-agent, Property {number}: {property_text}`; external boundaries (LLM, STT, FS Access, Typst-Wasm) are mocked in property tests for speed and determinism.
- Example/Integration/Smoke criteria are covered by the dedicated example/integration tests (tasks 4.5, 5.3, 8.12, 10.6, 11.5, 12.8, 16.3, 18.5, 19.3).
- The No-Fabrication harness (task 18) is the executable backbone of Property 1 and runs as a dedicated CI suite.
- Every task references the specific requirements it implements; checkpoints ensure incremental validation.
- Section 21 records work already completed (UI shell + provider integrations), verified by the passing suite. Section 22 targets the local-AI direction (keyless Local Provider, per-capability provider selection, and audio translate-to-English) plus the remaining in-flight work.
- Section 23 covers the optional deployment/packaging Run Modes (local source build, Docker static container, Docker Compose stack). Because these are packaging/config concerns rather than input-varying domain logic, they are verified by smoke/integration tests (not property tests), reusing existing Correctness Property 3 for the cross-mode egress boundary.
- Sections 24–29 add the newly mapped requirements and the four new Correctness Properties (19–22), bringing the total to 22. Section 24 (Granular Ingestion Send-Control, Req 57) covers per-file/per-detection send gating and persistence (Properties 20, 21). Section 25 establishes the shared opt-in-first AI-assist pattern (Property 19) that Sections 26–28 build on. Section 26 covers the employer-free role-discovery AI payload (Property 22). Section 27 covers AI STAR questions, in-browser audio recording, and the educational summary. Section 28 covers opportunity-driven AI CV tailoring (No-Fabrication coverage reuses Property 1, task 18.2 — no new property). Section 29 (Comprehensive UI/UX, Req 58) and the send-control panel rendering are verified by example/snapshot/integration and automated-accessibility tests rather than property tests, as noted.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "3.1", "5.1", "6.1"] },
    { "id": 3, "tasks": ["2.2", "3.2", "3.3", "4.1", "5.2"] },
    { "id": 4, "tasks": ["3.4", "3.5", "4.2", "4.3", "6.2"] },
    { "id": 5, "tasks": ["3.6", "4.4", "4.5", "5.3", "6.3"] },
    { "id": 6, "tasks": ["8.1", "8.2", "8.3"] },
    { "id": 7, "tasks": ["8.4"] },
    { "id": 8, "tasks": ["8.5", "8.6", "8.8"] },
    { "id": 9, "tasks": ["8.7", "8.9", "8.10"] },
    { "id": 10, "tasks": ["8.11", "8.12"] },
    { "id": 11, "tasks": ["10.1"] },
    { "id": 12, "tasks": ["10.2", "10.3"] },
    { "id": 13, "tasks": ["10.4", "10.5"] },
    { "id": 14, "tasks": ["10.6", "11.1"] },
    { "id": 15, "tasks": ["11.2", "11.3"] },
    { "id": 16, "tasks": ["11.4", "11.5"] },
    { "id": 17, "tasks": ["12.1"] },
    { "id": 18, "tasks": ["12.2", "12.3", "12.4"] },
    { "id": 19, "tasks": ["12.5", "12.6"] },
    { "id": 20, "tasks": ["12.7", "12.8", "12.9"] },
    { "id": 21, "tasks": ["14.1"] },
    { "id": 22, "tasks": ["14.2", "14.3", "14.4"] },
    { "id": 23, "tasks": ["14.5", "14.6", "14.7", "14.8"] },
    { "id": 24, "tasks": ["14.9", "14.10"] },
    { "id": 25, "tasks": ["14.11"] },
    { "id": 26, "tasks": ["16.1", "16.2"] },
    { "id": 27, "tasks": ["16.3", "17.1"] },
    { "id": 28, "tasks": ["17.2", "17.3"] },
    { "id": 29, "tasks": ["17.4"] },
    { "id": 30, "tasks": ["18.1"] },
    { "id": 31, "tasks": ["18.2", "18.3", "18.4"] },
    { "id": 32, "tasks": ["18.5", "19.1"] },
    { "id": 33, "tasks": ["19.2"] },
    { "id": 34, "tasks": ["19.3"] },
    { "id": 35, "tasks": ["22.1", "22.3"] },
    { "id": 36, "tasks": ["22.2", "22.6"] },
    { "id": 37, "tasks": ["22.7", "22.4"] },
    { "id": 38, "tasks": ["22.5"] },
    { "id": 39, "tasks": ["22.8", "22.9"] },
    { "id": 40, "tasks": ["22.10"] },
    { "id": 41, "tasks": ["23.1", "23.3", "23.4", "23.5"] },
    { "id": 42, "tasks": ["23.2"] },
    { "id": 43, "tasks": ["23.6", "23.7"] },
    { "id": 44, "tasks": ["24.1", "25.1", "27.2", "29.1"] },
    { "id": 45, "tasks": ["24.2", "25.2", "29.2", "29.3"] },
    { "id": 46, "tasks": ["24.3", "26.1", "27.1", "28.1", "29.4", "29.5"] },
    { "id": 47, "tasks": ["24.4", "24.5", "26.2", "27.3"] },
    { "id": 48, "tasks": ["24.6", "27.4", "29.6"] },
    { "id": 49, "tasks": ["25.3", "27.5", "27.6", "28.2"] },
    { "id": 50, "tasks": ["32.1", "32.2", "32.3"] },
    { "id": 51, "tasks": ["32.4", "32.5"] }
  ]
}
```


## Post-Phase-1 Updates

These tasks were added after the original plan. Section 30 records work already completed in this iteration (verified by the passing suite); Section 31 is the new Adaptive STAR Coaching Loop to be implemented in fresh task sessions. Section 32 adds the Ingestion Conversion Preview (R64) and Outbound Payload Preview (R65) — UI/gate affordances over data the engine and gate already hold, verified by example/integration tests with no new correctness property. New work here is verified by example/integration tests; the No-Fabrication guarantee continues to be covered by Property 1 (task 18.2), which ranges over coaching-derived outputs.

- [x] 30. Completed this iteration (assist modes, DOCX, decoded-text AI, user-authored entries)
  - [x] 30.1 DOCX ingestion via the ZipReader port
    - Add `docx` format (extension + OOXML MIME); `@core/ingestion/docx.ts` decodes `word/document.xml` to text on-device (paragraphs/breaks → newlines, tabs, drop `<w:instrText>`, decode entities); feed through `extractFromText`; keep legacy `.doc` deferred
    - _Requirements: 59.1, 59.2, 59.3, 59.4_
  - [x] 30.2 Third AI-assist mode (`ai-only`) and persisted pipeline-wide preference
    - Add `ai-only` to `AssistMode` + `runAssist`; persist the chosen mode to `config/assist_preference.md` (`@core/assist/assist-preference.ts`, fail-safe to script-only); choose it up front on Ingest and apply as the default on every AI phase, overridable anywhere
    - _Requirements: 60.1, 60.2, 60.3, 60.4, 60.5_
  - [x] 30.3 Full-decoded-text AI corpus + local-skip-PII at the Egress Gate
    - AI skill discovery sends the full decoded document text for local and cloud (structured-item fallback only when no decoded text); Egress Gate skips PII for a keyless local provider and redacts for cloud
    - _Requirements: 60.7, 60.8, 60.9, 7.6, 6_
  - [x] 30.4 Discovery → review → generate → save flow and AI-only ingest view
    - Reorder Skill Map to discover → review → finalise → save; in `ai-only` build the map from AI items only, in `script-only` from script items, in `both` from the AI-reviewed list; show the documents (not the parser review) on Ingest in `ai-only`
    - _Requirements: 60.5, 60.6, 60.10_
  - [x] 30.5 Both-mode AI review/refine of script detections (skills and roles)
    - `buildReviewPrompt` (skills) and `buildRoleReviewPrompt` (roles) pass the parser's detections to the AI to keep/correct/drop/add
    - _Requirements: 60.6_
  - [x] 30.6 User-authored skills and roles
    - Comma/newline input on Skill Map and Role Discovery before generate/save; user-confirmed provenance; always included regardless of mode; de-duped
    - _Requirements: 61.1, 61.2, 61.3, 61.4_
  - [x] 30.7 Behaviour-first STAR question prompt
    - Prompt infers the role's key behaviours/qualities then asks behaviour-first questions, technical capped at one, skills as context only
    - _Requirements: 62.1, 62.2, 62.4_

- [x] 31. Adaptive STAR Coaching Loop (new)
  - [x] 31.1 Competency-tagged question parsing
    - Update the `star_questions` prompt to return one line per question as `<competency> :: <question>`; parse into `{ competency, question }`; drop lines without the delimiter (also removes model preambles); keep the question shown and retain the competency for the loop and summary
    - _Requirements: 62.3_
  - [x] 31.2 Adequacy / follow-up AI operation (stateless, gate-routed)
    - New op: input `{ role, competency, question, answersSoFar }`; strict reply `SITUATION/TASK/ACTION/RESULT: covered|missing`, `ENOUGH: yes|no`, `FOLLOWUP: <question|none>`; route through the Egress Gate; derive only from the user's words, invent nothing
    - _Requirements: 63.2, 63.7_
  - [x] 31.3 Loop control with cap and user-extend
    - Drive the question selection → answer (text or audio via the existing gated Whisper path) → adequacy → follow-up loop; cap at 3 AI follow-ups; on the cap offer a "dig deeper" opt-in to continue if the model still has a follow-up; allow Stop at any round
    - _Requirements: 63.1, 63.3, 63.4, 63.5_
  - [x] 31.4 Per-question summary AI operation
    - New op: input `{ role, competency, question, fullAnswer }`; strict reply `SUMMARY / STAR / SKILLS / TIPS`; summary and skills derived only from the user's words; render competency + summary + STAR coverage + skills + tips and persist the confirmed talking point
    - _Requirements: 63.6, 63.7_
  - [x] 31.5 End-of-session detected-skills merge
    - Union the per-answer `SKILLS` across the session, exclude skills already in the map, and present them through the existing confirm-before-add path
    - _Requirements: 63.8_
  - [x] 31.6 AI-mode coaching UI and script-only fallback
    - STAR explainer + question list (competency hidden) + selection + answer (type/record/upload) + follow-up loop with cap/dig-deeper + per-question summary; tidy the suggestion-list layout (heading and Add on their own rows); keep the deterministic guided loop for script-only
    - _Requirements: 63.1, 63.9_
  - [ ]* 31.7 Tests for the coaching loop
    - Competency parsing; adequacy-reply parsing and loop termination at `ENOUGH=yes`, at the 3-follow-up cap, on user stop, and on user dig-deeper; summary-reply parsing; end-of-session detected-skills excludes in-map skills and requires confirmation; failure paths preserve coaching state
    - _Requirements: 63.2, 63.3, 63.4, 63.5, 63.6, 63.8_
- [ ] 32. Conversion Preview and Outbound Payload Preview (R64, R65)
  - [x] 32.1 Implement the read-only Ingestion Conversion Preview in IngestScreen
    - Add a per-document, READ-ONLY Conversion Preview that shows the full converted text for each ingested document, sourced from the data the shell already holds (rawDocs / `IngestionResult.rawText`, persisted at `profile/raw_documents.md`); inspection only — no in-place editing of the converted text
    - Indicate low-confidence PDF regions (`IngestionResult.lowConfidencePdfText`) within the preview so the user sees where extraction was uncertain
    - Let the user discard an ingested document after inspecting it and provide equivalent text via the existing paste path; show a "no converted text to preview" notice for documents with no prose body (e.g. LinkedIn ZIP, empty `rawText`)
    - Add all new user-facing strings to `locales/en.json` and `locales/pt-BR.json` (no hardcoded strings)
    - _Requirements: 64.1, 64.2, 64.3, 64.4, 64.5_
  - [x] 32.2 Add the Payload Preview seam to the Egress Gate
    - Add an optional injected, UI-owned callback to the gate (e.g. `previewPayload?: PayloadPreviewPrompt = (preview: { provider; operation; text }) => Promise<string | null>`) consistent with the existing `confirmRedactAndProceed`/`notifyLabel` collaborators; keep the gate framework-agnostic
    - In `request()` for the `llm-chat` TEXT path: when the destination is a keyed cloud (third-party) provider and the callback is present, after emitting the network label, present the exact outbound text for review; use the user-approved edited text as the payload; on cancel (`null`) fail closed — transmit nothing — and propagate a cancellation the caller can treat as preserving prior state
    - Run the existing local PII pre-screening on the USER-APPROVED text (R6 still applies as defense in depth), then the existing redact-and-proceed and minimised-payload build, then send
    - Skip the preview entirely for a keyless Local Provider (`thirdParty=false`). Do NOT add the preview to `requestIngestion` (ingestion already has per-file send-control, R57) and do NOT block the STT audio path
    - _Requirements: 65.1, 65.2, 65.3, 65.4, 65.5, 65.6, 65.7_
  - [x] 32.3 Wire the Payload Preview modal in the UI shell and runtime
    - Implement the `previewPayload` callback in the React shell (`App.tsx`/`runtime.ts`) as a modal that shows the exact text, lets the user freely edit/remove wording, and returns the approved text or `null` on cancel — mirroring the existing redact-and-proceed wiring; surface it before the third-party chat/LLM send across the AI-assist paths
    - Add all new user-facing strings to `locales/en.json` and `locales/pt-BR.json`
    - _Requirements: 65.1, 65.2, 65.4, 65.6_
  - [ ]* 32.4 Write integration tests for the Payload Preview gate behaviour
    - Cloud chat send presents the preview; the user-approved edited text is what is transmitted; cancel transmits nothing and preserves state; PII pre-screening still runs on the approved text; keyless local provider skips the preview; ingestion (`requestIngestion`) and STT paths are unaffected
    - _Requirements: 65.1, 65.2, 65.3, 65.4, 65.5, 65.7_
  - [ ]* 32.5 Write example tests for the Conversion Preview
    - Read-only rendering of converted text per document; low-confidence indication; discard + paste path; no-converted-text notice for a LinkedIn ZIP
    - _Requirements: 64.1, 64.2, 64.3, 64.5_
