# Requirements Document

## Introduction

Career Agent is a local-first browser web application that helps a single user build an accurate, evidence-backed professional profile, prepare for interviews using the STAR framework, and generate tailored job application materials. It operates as a stateful, session-resumable pipeline of six phases: Ingest → Skill Map → Role Discovery → Interview Coaching → Output Generation → Memory & Maintenance.

This document is scoped strictly to **Phase 1 (Launch)** as defined in the v0.3 product specification §8 Phasing Summary. The launch target is a **local-first browser web app** built in TypeScript with WebAssembly components, runnable by opening a static bundle or a locally served page with no backend server. Native (Tauri) builds, DOCX/OCR ingestion, live video capture, Tier-2 languages, and right-to-left scripts are explicitly deferred to later phases and are out of scope here. In-browser audio recording of interview answers is now in scope for this phase, transcribed through the user's chosen speech-to-text provider via the Egress Gate. Container-based distribution is now in scope as an optional packaging layer: in addition to a local source build, the user may optionally build and run Career Agent as a single static-serving container or as a full local Docker Compose stack. In every one of these run modes the application retains no data or application backend — any web container serves only the static bundle and never receives, stores, or processes the user's career data.

The product's defining promise is trust: user files never leave the device, and every claim in every generated output is traceable to source evidence or explicit user confirmation (the No-Fabrication Rule). The user may connect either a keyed cloud LLM provider supplied through Bring-Your-Own-Key credentials, or a keyless Local Provider that targets a self-hosted OpenAI-Compatible Endpoint (for example Ollama) running on the user's own machine. Only a minimum redacted text payload is ever sent to the user's chosen LLM and speech-to-text providers, after local PII and secrets pre-screening. The application is therefore not fully offline only when a cloud provider is used; when every selected provider is a Local Provider on the user's own device, no Redacted Payload leaves the device and the application is fully offline. The user may select the provider for chat and for speech-to-text independently, and speech-to-text supports optional translation of audio answers to English.

## Glossary

- **Career_Agent**: The overall local-first browser application that orchestrates the six-phase pipeline.
- **Ingestion_Engine**: The component that extracts structured career evidence from uploaded documents.
- **Skill_Mapper**: The component that normalises skills and produces the skill map with evidence and accomplishment links.
- **Role_Matcher**: The component that discovers suitable roles and scores skill matches using ontological inference.
- **Interview_Coach**: The component that generates STAR questions, collects answers, and produces talking points.
- **Output_Engine**: The component that compiles confirmed Markdown into ATS-safe Markdown, PDF (via Typst compiled to WebAssembly), and simplified DOCX rich-text.
- **Storage_Adapter**: The component that reads and writes the Memory Store, selecting between the File System Access tier and the in-browser fallback tier.
- **Provider_Manager**: The component that handles LLM and speech-to-text provider selection, API key entry, validation, and encrypted local storage.
- **PII_Scanner**: The local regex and lightweight JavaScript scanner that screens text for high-risk PII and secrets before any network transmission.
- **No_Fabrication_Harness**: The automated regression suite that verifies every factual claim in generated output resolves to a source citation.
- **Memory Store**: The user-owned set of human-readable Markdown files (and generated output files) that persist all Career_Agent knowledge between sessions, following the §4.6.1 canonical structure.
- **File System Access tier**: The storage mode on Chromium desktop browsers where the user selects a real local folder via the File System Access API and the Storage_Adapter reads/writes the actual Markdown Memory Store.
- **Fallback storage tier**: The documented degraded storage mode on browsers without the File System Access API (Safari, Firefox, mobile), using OPFS or IndexedDB with one-click export/import of the entire Memory Store as a `.zip` archive.
- **BYOK**: Bring-Your-Own-Key — the model where the user supplies their own cloud provider API key; Career_Agent provides no shared or built-in key.
- **Local Provider**: A keyless provider that targets an OpenAI-Compatible Endpoint running on the user's own machine (for example Ollama, LocalAI, LM Studio, llama.cpp server, or vLLM), requiring no API key and configured with a user-editable base URL, model name, and maximum completion-token limit.
- **OpenAI-Compatible Endpoint**: A network endpoint that implements the OpenAI HTTP API surface (chat completions and audio interfaces) so that multiple local or self-hosted runtimes can be addressed through one client.
- **Ollama**: A self-hosted local model runtime that exposes an OpenAI-Compatible Endpoint, defaulting to the base URL `http://localhost:11434/v1`, used as the default target of the Local Provider.
- **Per-capability provider selection**: The user's ability to choose the provider used for chat or LLM operations independently of the provider used for speech-to-text transcription.
- **Audio translation**: The optional speech-to-text mode that transcribes an uploaded audio answer and translates the transcript to English.
- **STAR**: Situation, Task, Action, Result — a structured interview answer framework.
- **STAR ID**: A stable, unique identifier (`STAR-NN`) for a confirmed talking point, used to link skills to proving evidence.
- **BULLET ID**: A stable, unique identifier (`BULLET-NN`) for an accomplishment or résumé bullet.
- **Talking Point**: A concise, polished first-person summary of a STAR answer.
- **Soft-Close**: A coaching mechanism that lets the user finish a partial answer, flag what is missing, and move on without being blocked.
- **Conservative Merge**: The normalisation principle of not merging two skill terms unless they are unambiguously the same skill.
- **Confusable Pair**: A pair of skill terms that must never be merged on the basis of name similarity alone (e.g. Java vs JavaScript).
- **Ontological Matching**: Matching role requirements using structured hierarchical relationships (e.g. PostgreSQL matches a SQL requirement) rather than direct text equivalence.
- **Confidence Level**: A High / Medium / Low rating attached to every extracted data item, determining whether it can appear in outputs.
- **ATS**: Applicant Tracking System — software that parses résumés; drives single-column, selectable-text output requirements.
- **Redacted Payload**: The minimum text content, after PII and secrets redaction, that Career_Agent sends to an external provider.
- **Session Language**: The Tier-1 language (English `en` or Brazilian Portuguese `pt-BR`) the user has selected for all Career_Agent interactions in the current profile.
- **Locale**: A combination of language and region governing communication language and output formatting conventions (e.g. `pt-BR`, `en-GB`).
- **Role Slug**: A URL-safe short identifier derived from a role title, used in file naming.
- **Run Mode**: One of the three optional ways to build and run Career_Agent — a local source build, a single-container Docker static deployment, or a Docker Compose Stack full local stack — exactly one of which the user selects.
- **Web Container**: An unprivileged, non-root nginx container image that serves only the Career_Agent static bundle on a published port and never receives, stores, or processes the user's career data.
- **Docker Compose Stack**: The optional full local-stack composition that runs the Web Container web service together with one or more Local Model Servers, using named volumes to persist downloaded model files.
- **Local Model Server**: An on-device model-inference server running on the user's own machine (for example Ollama for chat, or LocalAI/Whisper for speech-to-text) that the browser calls directly through the Egress Gate using the keyless Local Provider flow.
- **Egress Gate**: The single network chokepoint through which every outbound provider request passes, applying PII pre-screening, operation labelling, and payload minimisation before any payload reaches a provider.
- **Payload Preview**: The pre-transmission review of the exact outbound text payload, which the user may freely edit or redact before a third-party send (Requirement 65).
- **Sensitive Detection**: An individual high-risk PII or secret match that the PII_Scanner identifies within a staged file during ingestion send-control, which the user may allow or redact one detection at a time.
- **Conversion Preview**: The read-only view of the full converted text the Ingestion_Engine produced for an ingested document (Requirement 64).
- **In-Browser Audio Recording**: An interview answer captured by the Interview_Coach directly in the browser using the user's microphone, then transcribed through the user's chosen speech-to-text provider.
- **Target Opportunity**: A specific job posting or vacancy, supplied by the user as uploaded or pasted job details, that the Output_Engine tailors a CV toward.

## Requirements

### Requirement 1: Local-First Browser Distribution

**User Story:** As a privacy-conscious job seeker, I want to run Career Agent entirely in my browser from a static bundle, so that I do not depend on or send my data to any backend server.

#### Acceptance Criteria

1. THE Career_Agent SHALL run as a browser web application loaded from a static bundle or a locally served page without requiring a backend application server.
2. THE Career_Agent SHALL execute all document parsing, skill mapping, output typesetting, and persistence logic on the user's device using TypeScript and WebAssembly components.
3. WHEN the Career_Agent loads, THE Career_Agent SHALL function without any network connection except for explicitly user-initiated calls to the user's chosen LLM provider and speech-to-text provider.
4. WHERE the user has selected a cloud provider, THE Career_Agent SHALL present a privacy statement declaring that user files remain on the device and that the application is not fully offline because it sends a Redacted Payload to a user-chosen external provider.
5. WHERE every selected provider is a Local Provider running on the user's own device, THE Career_Agent SHALL present a privacy statement declaring that user files remain on the device, that no Redacted Payload leaves the device, and that the application is fully offline.

### Requirement 2: Local File Storage via File System Access API

**User Story:** As a Chromium desktop user, I want Career Agent to read and write a real folder on my computer, so that I own the Markdown Memory Store directly.

#### Acceptance Criteria

1. WHERE the browser provides the File System Access API, THE Storage_Adapter SHALL prompt the user to select a local folder as the Memory Store root.
2. WHEN the user selects a Memory Store folder, THE Storage_Adapter SHALL read and write the Memory Store using the canonical directory structure defined in Requirement 24.
3. WHEN the Career_Agent persists any artefact in the File System Access tier, THE Storage_Adapter SHALL write the artefact to the user-selected folder as a human-readable Markdown or output file.
4. IF the user revokes or loses access to the previously selected folder, THEN THE Storage_Adapter SHALL notify the user and prompt the user to re-select the Memory Store folder before continuing persistence operations.

### Requirement 3: Fallback In-Browser Storage with Export and Import

**User Story:** As a Safari, Firefox, or mobile user, I want Career Agent to still store my data in the browser and let me export it, so that I can use the app and keep a portable copy of my Memory Store.

#### Acceptance Criteria

1. WHERE the browser does not provide the File System Access API, THE Storage_Adapter SHALL persist the Memory Store in browser-local storage using OPFS or IndexedDB.
2. WHILE operating in the Fallback storage tier, THE Career_Agent SHALL display a notice that storage is a documented degraded tier with reduced direct file access.
3. WHEN the user requests an export in the Fallback storage tier, THE Storage_Adapter SHALL produce a single `.zip` archive containing the entire Memory Store in the canonical directory structure.
4. WHEN the user imports a previously exported `.zip` archive, THE Storage_Adapter SHALL restore the entire Memory Store from the archive into browser-local storage.
5. THE Storage_Adapter SHALL support exporting and importing the complete Memory Store through a single user action in the Fallback storage tier.

### Requirement 4: Guided BYOK Provider and Key Setup

**User Story:** As a user, I want a guided setup to connect my own cloud LLM provider, so that I can use the agent with my own account and credentials.

#### Acceptance Criteria

1. WHEN the user first attempts an operation requiring an LLM, THE Provider_Manager SHALL present a guided setup that lets the user select a supported provider and, for a keyed cloud provider, enter a BYOK API key.
2. THE Provider_Manager SHALL provide README-style guidance describing how to generate an API key for each supported keyed cloud provider.
3. WHEN the user submits an API key, THE Provider_Manager SHALL validate the key by issuing a test call to the selected provider and report whether the key is valid.
4. IF the key validation test call fails, THEN THE Provider_Manager SHALL display the failure reason and prompt the user to re-enter or correct the key.
5. WHERE the user selects a Local Provider, THE Provider_Manager SHALL complete setup without requiring an API key and SHALL let the user configure the OpenAI-Compatible Endpoint base URL and the model name.
6. THE Career_Agent SHALL provide no shared or built-in API key and SHALL require a user-supplied key for every keyed cloud LLM and speech-to-text operation.

### Requirement 5: Encrypted Local Key Storage

**User Story:** As a security-minded user, I want my API key stored encrypted and never written into my career files, so that my credentials are not exposed or leaked.

#### Acceptance Criteria

1. WHEN the Provider_Manager stores an API key, THE Provider_Manager SHALL store the key encrypted in browser-local storage on the user's device.
2. THE Provider_Manager SHALL NOT write any API key into the Markdown Memory Store.
3. THE Provider_Manager SHALL transmit a stored API key only to the provider the key belongs to and to no other destination.
4. WHEN the user requests removal of a stored key, THE Provider_Manager SHALL delete the encrypted key from browser-local storage.
5. WHERE the selected provider is a Local Provider, THE Provider_Manager SHALL store no API key for that provider, and the key-storage obligations in this requirement SHALL apply only to keyed cloud providers.

### Requirement 6: Local PII and Secrets Pre-Screening

**User Story:** As a user uploading sensitive documents, I want the app to detect personal identifiers and secrets before anything is sent over the network, so that I do not accidentally leak them to a provider.

#### Acceptance Criteria

1. BEFORE the Career_Agent sends any text payload to an external LLM or speech-to-text provider, THE PII_Scanner SHALL scan the payload locally using regex and lightweight JavaScript pattern matching.
2. THE PII_Scanner SHALL screen for high-risk patterns including Social Security numbers, National Insurance numbers, credit card numbers, and API keys or tokens.
3. IF the PII_Scanner detects a high-risk pattern, THEN THE Career_Agent SHALL notify the user of the detected category and offer an automated redact-and-proceed option before transmission.
4. WHEN the user accepts the redact-and-proceed option, THE Career_Agent SHALL send the Redacted Payload with detected high-risk values removed.
5. THE Career_Agent SHALL NOT echo detected secrets or credentials into any generated output.
6. BEFORE the Career_Agent sends any file content to an external LLM or speech-to-text provider during ingestion, THE Career_Agent SHALL offer the user the per-file send-control choice defined in Requirement 57.

### Requirement 7: Network and Privacy Boundary

**User Story:** As a user, I want a precise guarantee about what leaves my device, so that I can trust the privacy of my career data.

#### Acceptance Criteria

1. THE Storage_Adapter SHALL keep all Memory Store files on the user's device and SHALL NOT transmit any file to a third party.
2. WHEN the Career_Agent calls an external provider, THE Career_Agent SHALL transmit only the minimum Redacted Payload required for that operation to the user's chosen provider.
3. THE Career_Agent SHALL label each operation that involves a third-party API, including speech-to-text transcription, before the operation runs.
4. THE Career_Agent SHALL NOT transmit user career data to any destination other than the user's chosen LLM provider or speech-to-text provider.
5. THE Career_Agent SHALL route every provider request, including a request to a Local Provider, through the single Egress Gate so that consistent operation labelling and PII pre-screening apply to every outbound request.
6. WHERE the destination of a provider request is a Local Provider on the user's own device, THE Career_Agent SHALL label the operation as a local on-device call with no third-party egress before the operation runs.

### Requirement 8: Document Ingestion of Launch Formats

**User Story:** As a job seeker, I want to upload my CVs, certificates, and LinkedIn export, so that the agent can build a knowledge base from my real history.

#### Acceptance Criteria

1. THE Ingestion_Engine SHALL accept PDF files, Markdown files, plain text files, and LinkedIn data export ZIP archives.
2. WHEN a LinkedIn export ZIP archive is provided, THE Ingestion_Engine SHALL parse its contained CSV files including profile, positions, skills, and certifications data.
3. WHERE a document format is outside the launch-supported set, THE Ingestion_Engine SHALL reject the file and inform the user that the format is deferred to a later phase.
4. THE Ingestion_Engine SHALL present the user with a recommended document checklist before ingestion begins.
5. WHEN a PDF is scanned with low extraction confidence, THE Ingestion_Engine SHALL flag the affected text explicitly and SHALL NOT silently include uncertain text in extractions.
6. THE Ingestion_Engine SHALL accept multiple documents in a single ingestion batch and SHALL accept career text pasted directly by the user.
7. WHILE documents are staged for ingestion, THE Ingestion_Engine SHALL allow the user to review and remove any individual staged document before extraction.

### Requirement 9: Multi-Document Reconciliation and Conflict Resolution

**User Story:** As a user with several CV versions, I want the agent to merge them and flag conflicts, so that nothing is silently lost or overwritten.

#### Acceptance Criteria

1. WHEN multiple documents describe the same role, THE Ingestion_Engine SHALL merge the richest description rather than discarding alternatives.
2. IF the same field differs across documents, THEN THE Ingestion_Engine SHALL record all conflicting values with their source documents and present the conflict to the user as an explicit choice.
3. WHEN presenting a conflict, THE Ingestion_Engine SHALL default the recommendation to the value from the most recent document for recent roles and the most detailed document for older roles.
4. WHEN the user resolves a conflict, THE Ingestion_Engine SHALL record the resolution in the session log so the conflict is not re-presented on the next ingestion.
5. WHEN a user-entered value conflicts with a document-derived value, THE Ingestion_Engine SHALL treat the user-entered value as authoritative.

### Requirement 10: Structured Extraction

**User Story:** As a user, I want the agent to extract structured details from my documents, so that my employment history, education, certifications, skills, and results are captured accurately.

#### Acceptance Criteria

1. WHEN a document is ingested, THE Ingestion_Engine SHALL extract employment history including employer name, job title, start and end dates, location, responsibilities, achievements, and technologies used.
2. WHEN a document is ingested, THE Ingestion_Engine SHALL extract education entries, certifications with issuing body and dates, explicitly named skills, and stated language proficiency levels.
3. WHEN a quantified result is present in a document, THE Ingestion_Engine SHALL preserve the numerical outcome together with its surrounding context.
4. IF a period of more than three months exists between consecutive roles, THEN THE Ingestion_Engine SHALL detect the gap and note it for optional user explanation.

### Requirement 11: Confidence Scoring of Extracted Data

**User Story:** As a user, I want each extracted item rated by confidence, so that only verified information reaches my outputs.

#### Acceptance Criteria

1. WHEN the Ingestion_Engine extracts an item, THE Ingestion_Engine SHALL assign the item a Confidence Level of High, Medium, or Low.
2. THE Career_Agent SHALL use only High-confidence items in any output without explicit user confirmation.
3. WHEN an item carries Medium confidence, THE Career_Agent SHALL surface the item to the user for confirmation before using the item in any output.
4. WHEN an item carries Low confidence, THE Career_Agent SHALL store the item in a needs-review bucket and SHALL exclude the item from outputs until the user explicitly promotes it.

### Requirement 12: Ingestion Review and Correction

**User Story:** As a user, I want to review and correct what the agent extracted, so that my knowledge base reflects reality.

#### Acceptance Criteria

1. WHEN extraction completes, THE Ingestion_Engine SHALL present a structured summary grouped by document.
2. THE Ingestion_Engine SHALL allow the user to confirm, edit, or delete any extracted item, and to add information not present in the documents.
3. THE Ingestion_Engine SHALL allow the user to mark any item as private so the item is stored but never included in any output.
4. WHEN the user confirms or edits an item, THE Ingestion_Engine SHALL record the item as user-confirmed and raise the item to the highest reliability status.

### Requirement 13: Employment Gap Handling

**User Story:** As a user with employment gaps, I want them handled neutrally and honestly, so that I am never misrepresented or judged.

#### Acceptance Criteria

1. WHEN the Ingestion_Engine surfaces a detected gap, THE Ingestion_Engine SHALL present the gap with neutral framing.
2. THE Ingestion_Engine SHALL allow the user to annotate a gap and to choose whether the annotation is private or eligible for output.
3. THE Career_Agent SHALL exclude any agent-invented explanation for a gap from all outputs.
4. THE Career_Agent SHALL exclude misleading date formatting intended to conceal a gap from all outputs.

### Requirement 14: Skill Map Generation

**User Story:** As a user, I want a structured skill map linking each skill to evidence, so that I can see and trust what I can claim.

#### Acceptance Criteria

1. WHEN the user advances to skill mapping, THE Skill_Mapper SHALL generate a skill map where each entry contains a skill name, category, evidence-based proficiency signal, evidence trail with dates, accomplishment links, and recency.
2. THE Skill_Mapper SHALL derive each skill only from verified source material or explicit user confirmation.
3. THE Skill_Mapper SHALL record an evidence-based proficiency signal and SHALL exclude any self-reported proficiency score unless the user provides one.
4. WHEN the user confirms the skill map, THE Skill_Mapper SHALL save the skill map to the Memory Store before advancing.
5. BEFORE the Skill_Mapper generates the skill map, THE Skill_Mapper SHALL present the opt-in-first choice defined in Requirement 47 for the user to select either script-only extraction or script extraction with additional AI assist.
6. WHERE the user selects script-only extraction, THE Skill_Mapper SHALL generate the complete skill map using deterministic extraction alone and SHALL make no provider call.

### Requirement 15: Conservative Skill Normalisation

**User Story:** As a user, I want synonymous skills merged carefully and reversibly, so that my expertise is never misrepresented.

#### Acceptance Criteria

1. THE Skill_Mapper SHALL merge two skill terms only when the terms are true synonyms, abbreviations, or spelling or casing variants of the same underlying skill.
2. WHEN the Skill_Mapper merges two non-identical surface terms, THE Skill_Mapper SHALL log the merge with its rationale and SHALL make the merge reversible by the user in one step.
3. THE Skill_Mapper SHALL exclude sub-skills implied by a parent skill from the skill map unless the sub-skill appears in source material.
4. IF the Skill_Mapper is uncertain whether two terms are the same skill, THEN THE Skill_Mapper SHALL keep the terms separate and raise a single optional merge suggestion to the user.

### Requirement 16: Never-Merge Confusable Pairs

**User Story:** As a user, I want distinct technologies kept separate, so that similar names are never collapsed into a wrong claim.

#### Acceptance Criteria

1. THE Skill_Mapper SHALL keep distinct products separate and SHALL NOT merge them under a generic umbrella term unless that umbrella term also appears explicitly in source material.
2. WHERE an umbrella term appears explicitly in source material, THE Skill_Mapper SHALL add the umbrella term as a separate additional skill rather than replacing the named products.
3. THE Skill_Mapper SHALL maintain a Confusable Pair list in an external resource file and SHALL NOT merge any listed pair on the basis of string similarity alone.
4. THE Skill_Mapper SHALL load the Confusable Pair list from the external resource file so the list can be extended without code changes.

### Requirement 17: Skill Taxonomy and Ontological Inference

**User Story:** As a user, I want role matching to understand technology families, so that PostgreSQL counts toward a SQL requirement without inventing claims on my CV.

#### Acceptance Criteria

1. THE Role_Matcher SHALL maintain a taxonomy mapping file defining implements and extends relationships between skills, loaded from an external resource file.
2. WHEN a target role requires a parent skill and the skill map contains a child skill defined in the taxonomy, THE Role_Matcher SHALL recognise the child skill as satisfying the requirement rather than reporting a gap.
3. WHEN the Output_Engine produces a CV, THE Output_Engine SHALL preserve the user's original skill phrasing and SHALL exclude any broadened claim derived from taxonomy inference unless the user explicitly confirms the broadened claim.

### Requirement 18: Bi-Directional Skill and Accomplishment Mapping

**User Story:** As a user, I want skills linked to the accomplishments that prove them with stable identifiers, so that I can move between evidence and claims reliably.

#### Acceptance Criteria

1. WHEN an accomplishment or résumé bullet is confirmed, THE Skill_Mapper SHALL assign it a stable BULLET ID.
2. THE Skill_Mapper SHALL reference the relevant STAR IDs and BULLET IDs in each skill entry's evidence trail.
3. THE Skill_Mapper SHALL maintain the mapping bi-directionally so that each skill resolves to the accomplishments that prove it and each accomplishment resolves to the skills it evidences.
4. THE Skill_Mapper SHALL NOT reuse or renumber a stable identifier once assigned.

### Requirement 19: Skill Map Review

**User Story:** As a user, I want to review and adjust the skill map, so that it accurately reflects my experience before I rely on it.

#### Acceptance Criteria

1. WHEN the skill map is generated, THE Skill_Mapper SHALL present the skill map to the user for review.
2. WHEN the user adds a skill, THE Skill_Mapper SHALL require the user to state the role or project and approximate time in which the skill was used.
3. THE Skill_Mapper SHALL allow the user to remove a skill and to split any automatically merged skill into separate entries in one step.
4. THE Skill_Mapper SHALL allow the user to record a personal proficiency self-assessment stored separately from the evidence-based proficiency signal.

### Requirement 20: Role Discovery and Match Scoring

**User Story:** As a user, I want suggested roles with a clear match score and rationale, so that I understand where I fit and where my gaps are.

#### Acceptance Criteria

1. WHEN the user advances to role discovery, THE Role_Matcher SHALL generate suggested role types covering employed positions, freelance or consulting opportunities, and portfolio or project-based roles.
2. FOR each suggested role, THE Role_Matcher SHALL provide a title and description, a skill-match score labelled as an estimate, a rationale narrative, and the matched skills versus gap skills.
3. WHEN computing a skill-match score, THE Role_Matcher SHALL apply Ontological Matching as defined in Requirement 17.
4. BEFORE the Role_Matcher generates suggested roles, THE Role_Matcher SHALL present an opt-in-first choice for the user to select either script-only role discovery or role discovery with additional AI assist.
5. WHERE the user selects script-only role discovery, THE Role_Matcher SHALL generate suggested roles using deterministic matching alone and SHALL make no provider call.
6. WHERE the user opts in to AI assist for role discovery, THE Role_Matcher SHALL build the role-discovery payload from the skill map, SHALL exclude every employer and company name from the payload, and SHALL include the approximate duration of experience for each skill so the chosen model can infer a level of experience.

### Requirement 21: Role Preference Capture

**User Story:** As a user, I want to choose and rank target roles, so that the agent focuses coaching and outputs on what matters to me.

#### Acceptance Criteria

1. THE Role_Matcher SHALL allow the user to accept or reject any suggested role and to add roles the agent did not suggest.
2. THE Role_Matcher SHALL allow the user to rank roles in order of preference and to tag each role as actively applying, exploring, or interview practice only.
3. WHEN the user confirms role preferences, THE Role_Matcher SHALL store the role preferences in the Memory Store.

### Requirement 22: Interview Question Generation

**User Story:** As a user preparing for interviews, I want STAR questions grounded in my profile and the target role, so that my practice is relevant.

#### Acceptance Criteria

1. WHEN the user selects a role for coaching, THE Interview_Coach SHALL generate a minimum of three STAR-framework questions grounded in the Requirement 20 skill-match result between the user's profile and the target role.
2. WHEN the questions are generated, THE Interview_Coach SHALL include at least one behavioural question per core skill among the Role_Matcher's matched core requirements per Requirement 20, one question on a gap skill identified by the Role_Matcher per Requirement 20, and one professional motivation question.
3. THE Interview_Coach SHALL store the script-based questions, any AI-generated questions, and the user's responses in a per-role interview file keyed to the Role Slug in the Memory Store.
4. WHEN the user selects a role for coaching, THE Interview_Coach SHALL offer the user the option to request AI-generated and AI-reviewed STAR questions for the selected role.
5. WHERE the user declines the AI option, THE Interview_Coach SHALL generate STAR questions using script-based generation alone and SHALL make no provider call.
6. WHERE the user opts in to AI-generated STAR questions, THE Interview_Coach SHALL request the questions through the Egress Gate using a prompt that frames the chosen model as a recruiter for the specific target position, and the AI-generated questions SHALL supplement rather than replace the script-based questions.
7. WHERE the destination is a keyed cloud (third-party) provider, THE Interview_Coach SHALL exclude every item marked private from the question-generation request, consistent with Requirements 46.4 and 46.5.
8. IF the AI question-generation provider call fails, THEN THE Interview_Coach SHALL surface an error and SHALL preserve the user's pending coaching state so that the script-based questions remain available.
9. THE Interview_Coach SHALL treat AI-generated questions as practice prompts that are not factual claims gated by the No-Fabrication Rule in Requirement 37.

### Requirement 23: STAR Identifiers

**User Story:** As a user, I want each confirmed talking point to have a stable identifier, so that my skills and CVs link to it reliably.

#### Acceptance Criteria

1. WHEN a talking point is confirmed, THE Interview_Coach SHALL assign the talking point a stable unique STAR ID.
2. THE Interview_Coach SHALL NOT reuse or renumber a STAR ID, even when the talking point is later edited or retired.
3. WHEN a talking point is retired, THE Interview_Coach SHALL mark the talking point as retired rather than deleting it.

### Requirement 24: Text Response Collection and Follow-ups

**User Story:** As a user, I want guided STAR follow-ups without being fed answers, so that I produce complete, truthful talking points.

#### Acceptance Criteria

1. WHEN the user provides a text answer, THE Interview_Coach SHALL guide the user through the Situation, Task, Action, and Result elements.
2. IF any STAR element is missing or vague, THEN THE Interview_Coach SHALL ask a targeted open follow-up question to elicit that element.
3. THE Interview_Coach SHALL ask only open questions and SHALL exclude any suggested specific facts or outcomes for the user to claim.
4. THE Interview_Coach SHALL continue the coaching loop for a question until a complete STAR answer is captured, the user invokes Soft-Close, or the user explicitly passes.

### Requirement 25: Soft-Close and Fatigue Management

**User Story:** As a user, I want to stop or flag an answer at any point, so that coaching never holds me hostage to a complete answer.

#### Acceptance Criteria

1. WHEN the user cannot or does not want to provide a STAR element, THE Interview_Coach SHALL accept the partial answer, attach an explicit flag identifying the missing element, and move on.
2. THE Interview_Coach SHALL store flagged talking points so the flags are visible in the interview file and resurface on session resume.
3. WHILE a coaching session is in progress, THE Interview_Coach SHALL display progress through the session.
4. WHEN the user pauses in the middle of a question, THE Interview_Coach SHALL persist the partial state so the next session resumes at that point.
5. WHERE a STAR element is missing, THE Interview_Coach SHALL offer a recommendation for how the user could find or phrase the element later rather than requiring it immediately.

### Requirement 26: Audio Answer Upload and Transcription

**User Story:** As a user, I want to upload or record a spoken answer and have it transcribed, so that I can practise by speaking instead of typing.

#### Acceptance Criteria

1. THE Interview_Coach SHALL accept an uploaded MP3 or WAV audio file of at most 25 MB and at most 600 seconds in duration as an interview answer.
2. WHEN audio is uploaded, THE Interview_Coach SHALL transcribe the audio using the user's chosen speech-to-text provider after PII pre-screening as defined in Requirement 6.
3. WHEN transcription completes, THE Interview_Coach SHALL present the transcription to the user for confirmation and correction before any further processing.
4. THE Interview_Coach SHALL provide an in-browser record-audio control offering start, stop, re-record, and discard actions, SHALL request microphone permission before recording, and SHALL limit a recording to a maximum duration of 600 seconds, capturing the user's spoken answer within the browser as an In-Browser Audio Recording.
5. WHERE the user selects audio translation, THE Interview_Coach SHALL transcribe and translate the audio answer to English using the user's chosen speech-to-text provider, after PII pre-screening as defined in Requirement 6, and SHALL present the translated transcript to the user for confirmation and correction before any further processing.
6. WHEN the user completes an In-Browser Audio Recording, THE Interview_Coach SHALL transcribe the recording using the user's chosen speech-to-text provider through the Egress Gate after PII pre-screening as defined in Requirement 6.
7. WHEN transcription of an In-Browser Audio Recording completes, THE Interview_Coach SHALL present the transcript to the user for confirmation and correction before any further processing.
8. WHEN the user confirms the transcript of an In-Browser Audio Recording, THE Interview_Coach SHALL feed the confirmed transcript into the coaching loop and SHALL send the confirmed transcript to the user's chosen chat provider through the Egress Gate.
9. IF an uploaded audio file is an unsupported format, exceeds 25 MB, or exceeds 600 seconds, THEN THE Interview_Coach SHALL reject the file with an error indicating the reason and SHALL retain the prior answer state.
10. IF the user denies microphone permission, THEN THE Interview_Coach SHALL present an error explaining that recording is unavailable and SHALL offer the upload path and the text-answer path instead.
11. IF no speech-to-text provider is configured WHEN the user attempts transcription, THEN THE Interview_Coach SHALL prompt the user to configure a speech-to-text provider and SHALL preserve the captured audio.
12. WHEN the user is answering an interview question, THE Interview_Coach SHALL present the available answer-input modes — type text, upload an audio file, and create an In-Browser Audio Recording — as a clear, selectable choice, SHALL always offer the type-text path and the upload-audio path, and WHERE microphone access is available SHALL offer the In-Browser Audio Recording path.

### Requirement 27: Content and Delivery Firewall

**User Story:** As a user, I want my answers judged on substance not delivery, so that accent, disfluencies, or transcription artefacts never lower my assessed quality.

#### Acceptance Criteria

1. THE Interview_Coach SHALL analyse answer content separately from answer delivery and SHALL feed only content analysis into the skill map and CV outputs.
2. THE Interview_Coach SHALL treat verbal tics, hesitations, accent, dialect, non-standard phrasing, and transcription artefacts as neutral with respect to assessed content quality.

### Requirement 28: Answer Refinement and Talking Points

**User Story:** As a user, I want a polished talking point and clear coaching suggestions after each answer, so that I can memorise and improve my responses.

#### Acceptance Criteria

1. WHEN a STAR answer is captured or Soft-Closed, THE Interview_Coach SHALL present a structured summary that identifies each of the four STAR elements and marks each element as complete or flagged.
2. THE Interview_Coach SHALL present outstanding weaknesses as coaching suggestions, and these coaching suggestions SHALL NOT block confirmation, generation, or progression.
3. THE Interview_Coach SHALL generate a first-person, past-tense talking point in complete sentences derived only from confirmed answer content.
4. WHEN the user confirms the talking point, THE Interview_Coach SHALL assign the talking point a STAR ID.
5. WHERE the user declines AI assist, THE Interview_Coach SHALL produce the talking point via the script-only path and SHALL make no provider call.
6. THE Interview_Coach SHALL store confirmed talking points with their STAR IDs in the interview file.
7. WHERE the user has opted in to AI assist AND a STAR answer is captured or Soft-Closed, THE Interview_Coach SHALL produce a written educational summary of the user's STAR answer that identifies the Situation, Task, Action, and Result components and explains what a good STAR-format answer looks like, the educational summary being a teaching artefact distinct from the polished talking point.
8. WHEN producing the educational summary, THE Interview_Coach SHALL base the summary only on the content of the user's own answer and SHALL exclude any invented fact, consistent with the No-Fabrication Rule in Requirement 37.

### Requirement 29: Skill Map Update from Interview Answers

**User Story:** As a user, I want new skills revealed during coaching to update my skill map after I confirm them, so that my knowledge base stays current.

#### Acceptance Criteria

1. WHEN a coaching session ends, THE Interview_Coach SHALL check whether any answers reveal skills, roles, or achievements not yet in the skill map.
2. WHEN newly revealed skills are found, THE Interview_Coach SHALL surface them to the user for explicit confirmation before adding them.
3. WHEN the user confirms newly revealed skills, THE Skill_Mapper SHALL update the skill map with the new evidence and the corresponding accomplishment and STAR links.

### Requirement 30: Tailored CV Generation

**User Story:** As a user, I want a CV tailored to a target role using only my confirmed evidence, so that I can apply with accurate, relevant materials.

#### Acceptance Criteria

1. WHEN the user requests a CV for a role tagged actively applying, THE Output_Engine SHALL generate a tailored CV containing only information present in the confirmed skill map and interview files.
2. WHEN generating a CV, THE Output_Engine SHALL prioritise content toward the target role's requirements using the bi-directional skill and accomplishment links.
3. WHEN a quantified result is available from a STAR answer, THE Output_Engine SHALL use the quantified result in the CV.
4. WHERE a talking point is flagged as needing a metric, THE Output_Engine SHALL note to the user that the talking point would be stronger with a metric when including it.
5. WHEN the user requests a CV, THE Output_Engine SHALL first ask the user whether the user has a Target Opportunity to tailor the CV toward.
6. WHERE the user indicates a Target Opportunity, THE Output_Engine SHALL allow the user to upload or paste the job posting details and SHALL offer AI-assisted tailoring of the CV to that Target Opportunity using only confirmed evidence from the confirmed skill map and interview files.
7. WHERE the user declines a Target Opportunity, declines AI assistance, or the AI tailoring request fails, THE Output_Engine SHALL generate the CV using script-only generation from the confirmed evidence and SHALL indicate that script-only generation was used.
8. WHEN AI-assisted tailoring is performed, THE Output_Engine SHALL exclude any skill, metric, date, title, or employer name not present in confirmed evidence, including any such item appearing only in the Target Opportunity text, consistent with the No-Fabrication Rule in Requirement 37.
9. WHEN the user supplies a Target Opportunity, THE Output_Engine SHALL pass the Target Opportunity text through the Egress Gate with PII pre-screening as defined in Requirement 6, and SHALL treat the Target Opportunity text only as a tailoring target and never as a claim source.
10. WHERE the destination is a keyed cloud (third-party) provider, THE Output_Engine SHALL exclude every item marked private from the payload, consistent with Requirement 46.4.

### Requirement 31: LinkedIn Improvement Report

**User Story:** As a user, I want advisory LinkedIn improvement suggestions, so that I can strengthen my profile myself.

#### Acceptance Criteria

1. WHEN the user requests LinkedIn recommendations, THE Output_Engine SHALL generate a report containing headline suggestions, a rewritten about section, position rewrites, and recommended skills, all drawn only from confirmed information.
2. THE Output_Engine SHALL present the LinkedIn report as advisory and SHALL exclude any action that posts or applies changes on the user's behalf.

### Requirement 32: Output Engine and ATS Compatibility

**User Story:** As a user, I want ATS-safe outputs in Markdown, PDF, and DOCX generated on my device, so that my résumé survives parsing and never leaves my machine to be typeset.

#### Acceptance Criteria

1. THE Output_Engine SHALL always generate Markdown as the primary output.
2. WHEN producing a PDF, THE Output_Engine SHALL compile the confirmed Markdown source into PDF using Typst compiled to WebAssembly, running client-side on the user's device.
3. WHEN producing a DOCX, THE Output_Engine SHALL generate a simplified structured rich-text DOCX optimised for upload into ATS portals.
4. THE Output_Engine SHALL produce CV PDF and DOCX output using clean single-column templates with a linear reading order, selectable text, and no layout tables, meaningful icons, or text embedded in images.
5. THE Output_Engine SHALL preserve all content from the confirmed Markdown source in every output format without altering, dropping, or adding content.
6. THE Output_Engine SHALL load the Typst WebAssembly typesetter from a locally bundled asset and SHALL NOT fetch the typesetter from a content delivery network or other remote source.
7. WHEN an output is generated, THE Output_Engine SHALL allow the user to download the output in each generated format.

### Requirement 33: CV Versioning and Diffing

**User Story:** As a user, I want each CV version preserved and comparable, so that I can track how tailored versions differ.

#### Acceptance Criteria

1. WHEN the Output_Engine produces a CV version, THE Output_Engine SHALL store the version as an immutable file using the role slug and version number.
2. WHEN the user edits a stored CV, THE Output_Engine SHALL create a new version rather than modifying the existing version.
3. WHEN the user requests a comparison of two CV versions, THE Output_Engine SHALL summarise which accomplishments were added, removed, or reordered and which skills were emphasised.

### Requirement 34: Memory Store Structure

**User Story:** As a user, I want all my data stored as portable Markdown in a predictable structure, so that I own it and can read it without the app.

#### Acceptance Criteria

1. THE Storage_Adapter SHALL persist all knowledge as human-readable Markdown files organised into the canonical profile, interviews, outputs, config, and log directories.
2. THE Storage_Adapter SHALL store stable identifiers within Markdown using HTML anchor comments or frontmatter metadata so the identifiers parse reliably and do not appear in printed output.
3. THE Storage_Adapter SHALL record agent actions, user confirmations, and conflict resolutions in the session log file.
4. THE Storage_Adapter SHALL allow the user to export and fully delete the entire Memory Store.

### Requirement 35: Session Resume and Re-entry Triggers

**User Story:** As a returning user, I want the agent to summarise my state and let me continue or start something new, so that I never lose my place.

#### Acceptance Criteria

1. WHEN the user returns, THE Career_Agent SHALL load and summarise the current state of the Memory Store and identify outstanding items including unanswered questions, flagged talking points, unreviewed skill entries, and unresolved conflicts.
2. THE Career_Agent SHALL allow the user to continue from the last point or jump to any phase.
3. WHEN the user provides a new job description, THE Career_Agent SHALL parse it into required and preferred skills, compare against the skill map, identify gaps, and propose a tailored CV.
4. WHEN the user uploads a new document, THE Career_Agent SHALL merge it into the existing knowledge base using the conflict resolution rules in Requirement 9.
5. WHEN the user reports a post-interview debrief, THE Career_Agent SHALL update talking points and note gaps from the reported questions and answers.
6. WHEN the user begins CV generation, THE Career_Agent SHALL prompt the user to indicate whether a Target Opportunity applies, and WHERE the user provides job posting details, THE Career_Agent SHALL route those details into the tailored CV generation defined in Requirement 30.

### Requirement 36: Markdown ID State Healing

**User Story:** As a user who may edit my Markdown files by hand, I want the agent to detect and repair broken or duplicate identifiers, so that the app never crashes on my edits.

#### Acceptance Criteria

1. WHEN the user resumes a session, THE Career_Agent SHALL verify all skill evidence references against existing identifiers.
2. IF a skill references an identifier that no longer exists, THEN THE Career_Agent SHALL flag the entry as a broken reference and prompt the user to repair it rather than terminating.
3. IF duplicate identifiers are found, THEN THE Career_Agent SHALL prompt the user to re-index the duplicate identifiers.

### Requirement 37: No-Fabrication Rule

**User Story:** As a user, I want a guarantee that nothing is invented, so that every output is something I can honestly stand behind.

#### Acceptance Criteria

1. THE Career_Agent SHALL exclude from all outputs any skill not present in verified source material or explicitly confirmed by the user.
2. THE Career_Agent SHALL exclude from all outputs any metric, date, title, or employer name not found in source material or explicitly confirmed by the user.
3. THE Career_Agent SHALL exclude from all outputs any skill implied solely by a job title without supporting evidence.
4. THE Career_Agent SHALL present every output item to the user for confirmation before the item appears in a final output.

### Requirement 38: Auditability

**User Story:** As a user, I want every claim traceable to its source, so that I can verify and defend everything in my materials.

#### Acceptance Criteria

1. WHEN the Career_Agent includes a claim in an output, THE Career_Agent SHALL maintain in the Memory Store a trace from the claim to a source document line, an explicit user confirmation, or a confirmed interview answer.
2. WHEN the user inspects an output claim, THE Career_Agent SHALL present the claim's source trace.

### Requirement 39: User Override Supremacy

**User Story:** As a user, I want my version to always win, so that the agent supports me rather than overriding me.

#### Acceptance Criteria

1. WHEN the user disagrees with an extraction, interpretation, or suggestion, THE Career_Agent SHALL accept the user's version.
2. WHEN the Career_Agent has a concern about a user override, THE Career_Agent SHALL flag the concern once and SHALL proceed without repeating the concern or refusing to continue.

### Requirement 40: No-Fabrication Evaluation Harness

**User Story:** As a maintainer, I want the no-fabrication promise to be automatically testable, so that it is verified rather than merely asserted.

#### Acceptance Criteria

1. THE No_Fabrication_Harness SHALL maintain a regression suite of sample profiles including sparse and ambiguous cases.
2. FOR each generated output in the suite, THE No_Fabrication_Harness SHALL verify that every factual claim resolves to a source citation in the Memory Store and SHALL fail any output containing an unresolved claim.
3. THE No_Fabrication_Harness SHALL include adversarial cases that tempt inference and SHALL assert that no skills or tools are invented in those cases.
4. THE No_Fabrication_Harness SHALL version the no-fabrication system prompt together with its evaluation results so prompt changes can be regression-tested.

### Requirement 41: Tier-1 Multilingual Support and Localised Formatting

**User Story:** As an English or Brazilian Portuguese speaker, I want the agent to work in my language with locale-appropriate output formatting, so that my materials fit my target market.

#### Acceptance Criteria

1. THE Career_Agent SHALL fully support English and Brazilian Portuguese as Tier-1 Session Languages.
2. WHEN a profile is first used, THE Career_Agent SHALL detect the user's preferred language from the browser or operating system locale and ask the user to confirm or change the Session Language.
3. WHEN the user sets or changes the Session Language, THE Career_Agent SHALL store the choice in the Memory Store and apply it to subsequent agent messages, prompts, review steps, and generated outputs.
4. WHEN a source document is in a language other than the Session Language, THE Ingestion_Engine SHALL extract content from the source document regardless of the Session Language.
5. THE Career_Agent SHALL preserve technical terms, tool names, and proper nouns verbatim and SHALL exclude them from translation across all outputs.
6. WHEN generating a CV, THE Output_Engine SHALL ask the user for the target country or region and apply that locale's date format, page-length norm, currency and number format, and section naming, allowing the user to override any individual convention.
7. WHEN generating a CV, THE Output_Engine SHALL default locale-driven personal-data fields including photo, age, and marital status to the privacy-preserving option and SHALL include such a field only on explicit user opt-in.
8. THE Career_Agent SHALL load all user-facing text from external locale resource files rather than from hardcoded strings.

### Requirement 42: Privacy, Accuracy, and Accessibility

**User Story:** As a user, I want strong privacy defaults, accurate extraction, and accessible outputs, so that the tool is trustworthy and usable.

#### Acceptance Criteria

1. THE Career_Agent SHALL exclude user data from any model training or improvement use without explicit informed consent.
2. WHEN processing an ingestion batch, THE Career_Agent SHALL prioritise extraction accuracy and completeness over response latency.
3. IF a document is incomplete or ambiguous, THEN THE Career_Agent SHALL prompt the user for clarification rather than making assumptions.
4. THE Output_Engine SHALL produce PDF output with sufficient contrast, logical reading order, and a proper selectable text layer for screen-reader compatibility.

### Requirement 43: Local / Self-Hosted OpenAI-Compatible Provider

**User Story:** As a privacy-conscious user, I want to use a local or self-hosted OpenAI-compatible model runtime, so that I can run the agent fully offline on my own hardware with no third-party egress.

#### Acceptance Criteria

1. THE Provider_Manager SHALL offer a Local Provider that targets an OpenAI-Compatible Endpoint and SHALL default the Local Provider base URL to `http://localhost:11434/v1` for Ollama.
2. THE Provider_Manager SHALL operate the Local Provider without an API key.
3. THE Provider_Manager SHALL allow the user to edit the Local Provider base URL and model name so the Local Provider can target Ollama, LocalAI, LM Studio, llama.cpp server, or vLLM.
4. WHERE the user runs on lower-capacity hardware, THE Provider_Manager SHALL allow the user to set the Local Provider chat model name to a model sized to the user's hardware capacity.
5. WHILE every selected provider is a Local Provider on the user's own device, THE Career_Agent SHALL transmit no Redacted Payload off the device.
6. THE Provider_Manager SHALL allow the user to configure the Local Provider's maximum completion-token limit, SHALL default that limit to a value large enough for reasoning models that emit chain-of-thought before their answer (2048 tokens), and SHALL apply the configured limit to every Local Provider chat completion so that a model which consumes tokens reasoning before answering still has budget to return its full answer.

### Requirement 44: Per-Capability Provider Selection

**User Story:** As a user, I want to choose a different provider for chat and for transcription, so that I can combine a local chat model with a cloud transcription service, or the reverse.

#### Acceptance Criteria

1. THE Provider_Manager SHALL allow the user to select the provider used for chat or LLM operations independently of the provider used for speech-to-text transcription.
2. WHEN the Career_Agent performs a chat or LLM operation, THE Career_Agent SHALL route the operation through the Egress Gate to the provider the user selected for chat operations.
3. WHEN the Career_Agent performs a speech-to-text transcription, THE Career_Agent SHALL route the operation through the Egress Gate to the provider the user selected for transcription.

### Requirement 45: Cloud Provider Implementations and Key Validation

**User Story:** As a user, I want working OpenAI and Anthropic integrations whose keys are validated before use, so that I know my credentials work and my data routes correctly.

#### Acceptance Criteria

1. THE Provider_Manager SHALL support OpenAI using the chat completions interface and Anthropic using the messages interface as keyed cloud providers.
2. WHEN the user submits an API key for a keyed cloud provider, THE Provider_Manager SHALL validate the key by issuing a low-cost model-listing probe to the selected provider and report whether the key is valid.
3. THE Provider_Manager SHALL route every keyed cloud provider request through the Egress Gate and to no other path.

### Requirement 46: No-Training Egress Control and Private-Item Exclusion

**User Story:** As a user, I want a no-training signal attached to my requests and private items never transmitted to a third party, so that cloud providers neither retain nor train on my data while keyless local on-device inference can still use my full corpus.

#### Acceptance Criteria

1. THE Egress Gate SHALL derive a no-training flag from the user's consent state and SHALL include the no-training flag in every provider payload.
2. WHERE the no-training flag is set and the selected provider is OpenAI, THE Egress Gate SHALL set the OpenAI store option to false in the provider payload.
3. WHERE the selected provider is Anthropic, THE Egress Gate SHALL transmit the request without enabling any provider training option, relying on the provider's no-training default.
4. WHERE the destination is a keyed cloud (third-party) provider, THE Career_Agent SHALL exclude every item marked private from the provider payload.
5. WHERE the destination is a keyless Local Provider running on the user's own device with no third-party egress, THE Career_Agent MAY include items marked private in the provider payload, because the payload does not leave the device.

### Requirement 47: Opt-In AI Assist for Skill Mapping and Role Discovery

**User Story:** As a user, I want optional AI suggestions for skills and roles that I must confirm, so that I get help without compromising the No-Fabrication Rule.

#### Acceptance Criteria

1. WHERE the user opts in to AI assist during skill mapping AND the chosen chat provider is a keyless Local Provider running on the user's own device, THE Skill_Mapper SHALL build the discovery corpus from the full raw text of the ingested documents (whole-document content); and WHERE the chosen chat provider is a keyed cloud (third-party) provider, THE Skill_Mapper SHALL build the discovery corpus from the structured non-private extracted items only, because raw text carries no per-item private flag and cannot be sent to a third party without violating Requirement 46.4.
2. WHERE the user opts in to AI assist during role discovery, THE Role_Matcher SHALL request role recommendations through the Egress Gate using only non-private content, SHALL exclude every employer and company name from the request, and SHALL include the approximate duration of experience for each skill so the chosen model can infer a level of experience.
3. THE Career_Agent SHALL require explicit user confirmation of any AI-suggested skill or role before the suggestion enters the knowledge base.
4. WHERE the destination is a keyed cloud (third-party) provider, THE Career_Agent SHALL exclude every item marked private from the AI assist request.
5. WHERE the user opts in to AI assist during skill mapping, THE Skill_Mapper SHALL send the discovery corpus through the Egress Gate split into chunks rather than a single truncated payload, so that no evidence is silently dropped, consistent with the private-item exclusion in Requirements 46.4 and 46.5.
6. WHEN the user confirms an AI-discovered skill, THE Career_Agent SHALL record the skill with user-confirmation provenance, consistent with the No-Fabrication Rule.
7. BEFORE the deterministic skill extraction runs during skill mapping, THE Skill_Mapper SHALL present an opt-in-first choice for the user to select either script-only extraction or script extraction with additional AI assist.
8. WHERE the user selects script-only extraction, THE Skill_Mapper SHALL produce a complete skill map using deterministic extraction alone and SHALL make no provider call for skill discovery, preserving a complete script-only path.

### Requirement 48: Six-Phase Wizard Interface and Phase Status

**User Story:** As a user, I want a guided wizard with a dedicated screen for each phase and visible progress, so that I always know where I am and what remains.

#### Acceptance Criteria

1. THE Career_Agent SHALL present a wizard interface with a dedicated screen for Provider Setup, Ingest, Skill Map, Role Discovery, Interview Coaching, Output, and Memory & Maintenance.
2. THE Career_Agent SHALL display a status badge for each phase that reflects the phase's current progress.
3. THE Career_Agent SHALL allow the user to navigate to any available phase screen from the wizard.

### Requirement 49: Session Rehydration and Lossless Working-State Round-Trip

**User Story:** As a returning user, I want my full working session restored from the Memory Store, so that I can resume exactly where I left off.

#### Acceptance Criteria

1. THE Storage_Adapter SHALL persist raw extractions as a human-readable summary together with embedded machine-readable data such that reading then writing the raw extractions file preserves the extractions losslessly.
2. WHEN the user resumes a session, THE Career_Agent SHALL rehydrate the extractions, skill map, role preferences, and confirmed talking points from the Memory Store.
3. WHEN the user imports a Memory Store, THE Career_Agent SHALL rehydrate the extractions, skill map, role preferences, and confirmed talking points from the imported Memory Store.

### Requirement 50: Optional Deployment and Packaging Run Modes

**User Story:** As a self-hosting user, I want optional ways to package and run Career Agent, so that I can choose a deployment without giving up the no-backend trust guarantee.

#### Acceptance Criteria

1. THE Career_Agent SHALL support exactly three Run Modes — a local source build, a single-container Docker static deployment, and a Docker Compose Stack full local stack — where each running deployment instantiates exactly one of these three Run Modes.
2. WHERE the user selects any one of the three Run Modes, THE Career_Agent SHALL serve the same static application bundle and SHALL expose functionally equivalent application behavior across all three Run Modes.
3. WHERE the user selects any Run Mode, THE Career_Agent SHALL operate with no data backend and no application backend, and SHALL perform all document parsing, skill mapping, output typesetting, and Memory Store persistence within the browser on the user's device.
4. WHERE a Web Container serves the Career_Agent, THE Web Container SHALL serve only the static application bundle and SHALL NOT receive, store, or process the user's career data.
5. IF a request directed at the Web Container contains the user's career data, THEN THE Web Container SHALL NOT persist or process that data, and the user's career data SHALL remain on the user's device.
6. THE Career_Agent SHALL enforce the network and privacy boundary defined in Requirement 7 identically across all three Run Modes, such that the set of permitted egress destinations is the same in every Run Mode.

### Requirement 51: Local Source Build Run Mode

**User Story:** As a developer, I want to build the static bundle from source and serve it locally, so that I can run the browser-only app without any container.

#### Acceptance Criteria

1. THE Career_Agent SHALL provide a source build process that produces a static bundle requiring no application backend, and the bundle SHALL be servable from any URL base path without modification.
2. WHEN the static bundle is served locally by a development server or any static file server, THE Career_Agent SHALL load and run entirely in the browser and SHALL NOT contact any application backend.
3. WHERE the Career_Agent runs as a local source build, THE Provider_Manager SHALL allow the user to select either a keyed cloud BYOK provider or a user-run Local Provider for each capability.
4. WHERE the Career_Agent runs as a local source build and every selected provider is a Local Provider on the user's own device, THE Career_Agent SHALL transmit no Redacted Payload off the device.

### Requirement 52: Docker Static Single-Container Run Mode

**User Story:** As a self-hosting user, I want a single hardened container that serves the static bundle, so that I can deploy the app without running any application backend.

#### Acceptance Criteria

1. THE Career_Agent SHALL provide a multi-stage container build in which a build stage compiles the static bundle and a runtime stage receives only the built `dist/` output, such that the runtime Web Container image contains no application source code and no build toolchain.
2. WHILE the Web Container is running, THE Web Container SHALL serve the contents of the copied `dist/` static bundle via an nginx process that runs as a non-root user (effective UID not equal to 0) and binds to a non-privileged published port (port number greater than or equal to 1024).
3. WHEN a client requests the application root path from the published port, THE Web Container SHALL respond with the static bundle's entry document without invoking any server-side application processing.
4. WHERE the Career_Agent runs as a Docker static deployment, THE Career_Agent SHALL run as exactly one container with no application backend process and SHALL NOT transmit the user's career data to any server-side process for storage or computation.
5. THE Web Container SHALL NOT mount a host folder for writing the Memory Store, and IF a write to a host-mounted Memory Store path is attempted, THEN THE Web Container SHALL NOT persist the user's career data to the host filesystem.

### Requirement 53: Docker Compose Full Local Stack Run Mode

**User Story:** As a user who wants a fully local AI stack, I want a Compose file that runs the web app alongside local model servers, so that I can run everything on my own machine with no third-party egress.

#### Acceptance Criteria

1. THE Docker Compose Stack SHALL define a web service that serves the static bundle through the Web Container and a chat-inference Local Model Server, and SHALL start both services by default when the stack is brought up.
2. WHERE the speech-to-text Docker Compose profile is enabled, THE Docker Compose Stack SHALL start an optional Local Model Server that provides speech-to-text transcription.
3. WHERE the speech-to-text Docker Compose profile is not enabled, THE Docker Compose Stack SHALL NOT start the speech-to-text Local Model Server.
4. THE Docker Compose Stack SHALL define one named volume per Local Model Server that persists that server's downloaded model files across container restarts, and SHALL NOT define or mount any volume that writes the Memory Store.
5. WHEN the browser served by the Docker Compose Stack calls a Local Model Server over its host-published port, THE Career_Agent SHALL route the call directly through the Egress Gate using the keyless Local Provider flow, identical to a user-run Local Provider.
6. IF a call from the browser to a Local Model Server fails to connect or returns no response, THEN THE Career_Agent SHALL surface an error indicating the Local Model Server is unreachable and SHALL retain the user's pending request state.
7. WHILE the Career_Agent runs in the Docker Compose Stack and every selected provider is a Local Model Server, THE Career_Agent SHALL transmit no Redacted Payload off the device and SHALL complete all inference and transcription operations with zero third-party network egress.

### Requirement 54: Browser-to-Model-Server Reachability and Allowed Origins

**User Story:** As a user running the Compose stack, I want the app's provider URLs and the model servers' allowed-origin settings configured for browser access, so that my browser can actually reach the local model servers.

#### Acceptance Criteria

1. WHERE the Career_Agent runs in the Docker Compose Stack, THE Provider_Manager SHALL configure each Local Provider base URL as a host-published port address reachable from the host browser, for example `http://localhost:11434` for the chat Local Provider and `http://localhost:8080` for the speech-to-text Local Provider.
2. WHERE the Career_Agent runs in the Docker Compose Stack, IF a Local Provider base URL is set to a Docker Compose internal service name, THEN THE Provider_Manager SHALL reject the configuration and SHALL report an error indicating that browser access requires a host-published localhost address.
3. WHERE the Career_Agent runs in the Docker Compose Stack, THE Docker Compose Stack SHALL configure each Local Model Server to allow the exact origin (scheme, host, and port) from which the Career_Agent static bundle is served, including setting the chat Local Model Server's Ollama allowed-origins to that served origin.
4. WHERE the Career_Agent runs in the Docker Compose Stack, THE Docker Compose Stack SHALL set the speech-to-text Local Model Server's LocalAI CORS allow-origins to the exact origin (scheme, host, and port) from which the Career_Agent static bundle is served.
5. IF a Local Model Server rejects a browser request because the served origin is not allowed, THEN THE Provider_Manager SHALL report the rejection reason to the user, SHALL display instructions to add the served origin to that Local Model Server's allowed-origins configuration, AND SHALL preserve the current provider configuration.

### Requirement 55: Browser-Owned Memory Store Across Run Modes

**User Story:** As a user, I want my Memory Store always written by my own browser, so that no container or server ever holds my career data in any deployment.

#### Acceptance Criteria

1. WHEN the Career_Agent persists any Memory Store artefact in any Run Mode, THE Storage_Adapter SHALL write the artefact from the browser, using the File System Access tier where the browser provides the File System Access API and the Fallback storage tier otherwise.
2. THE Career_Agent SHALL NOT use a host-folder volume mount, container, or server to write or receive the Memory Store in any Run Mode.
3. WHERE the Career_Agent runs in the Docker Compose Stack, THE Docker Compose Stack SHALL use named volumes solely to persist downloaded model files for the Local Model Servers.
4. WHERE the Career_Agent runs in the Docker Compose Stack, THE Docker Compose Stack SHALL NOT define or mount any volume or host folder for storing Memory Store data.

### Requirement 56: Recommended Browser Documentation

**User Story:** As a user choosing a browser, I want guidance on which browser gives the best storage experience, so that I can pick the right one for owning my data.

#### Acceptance Criteria

1. THE Career_Agent SHALL document, in both the README and the in-app documentation, a recommendation that Chromium-based desktop browsers, specifically Chrome and Edge, be used to obtain the File System Access tier local-folder Memory Store.
2. THE Career_Agent documentation SHALL state that the File System Access tier persists the Memory Store directly to a user-selected local folder without requiring manual export or import.
3. THE Career_Agent documentation SHALL state that browsers other than Chromium-based desktop browsers (including non-Chromium desktop browsers and all mobile browsers) use the Fallback storage tier, which persists the Memory Store to browser-managed storage (OPFS/IndexedDB) and relies on manual `.zip` export and import to move or back up the Memory Store.
4. THE Career_Agent documentation SHALL identify, for each of the two tiers, which browser categories receive that tier, such that a reader can determine from the documentation alone which tier their browser will use.

### Requirement 57: Granular Ingestion Send-Control

**User Story:** As a user, I want fine-grained control over what file content is sent to an AI provider during ingestion, so that I decide per file whether to send everything or redact specific sensitive detections before any payload leaves my control.

#### Acceptance Criteria

1. WHEN a file is staged for transmission to an external LLM or speech-to-text provider during ingestion, THE Career_Agent SHALL present, for that file, a choice between sending the entire file content and selecting per Sensitive Detection which detections are sent and which are redacted, and SHALL gate any payload build or transmission for that file until the user confirms a send choice for that file.
2. WHEN the PII_Scanner completes its scan of a staged file, THE Career_Agent SHALL present each Sensitive Detection individually with its category so the user can allow or redact that detection.
3. WHEN the user chooses to send the entire file content, THE Egress Gate SHALL build the payload from the full content of that file.
4. WHEN the user selects per Sensitive Detection which detections to redact, THE Egress Gate SHALL build the Redacted Payload with the user-redacted detections removed and the user-allowed detections retained.
5. WHERE the chosen provider is a keyless Local Provider running on the user's own device, THE Career_Agent SHALL allow the user to send the entire file content, including detected sensitive values, because the payload does not leave the device.
6. WHERE the chosen provider is a keyed cloud (third-party) provider, THE Career_Agent SHALL default every Sensitive Detection to redacted.
7. WHERE the chosen provider is a keyed cloud (third-party) provider, THE Career_Agent SHALL include a Sensitive Detection in the payload only on explicit per-detection user opt-in.
8. WHEN a staged file has no Sensitive Detections, THE Career_Agent SHALL still present the whole-file send option and SHALL indicate that no Sensitive Detections were found.
9. THE Career_Agent SHALL persist the user's per-file and per-detection send choices and SHALL reapply them WHEN the same file is re-staged.
10. THE Egress Gate SHALL respect the user's per-file and per-detection send choices when building every payload, consistent with the single-chokepoint rule in Requirement 7 and the AI-assist corpus rules in Requirement 47.

### Requirement 58: Comprehensive User Interface and Experience

**User Story:** As a user, I want a cohesive, accessible, and responsive interface across the six-phase wizard, so that the application is clear and trustworthy throughout my workflow.

#### Acceptance Criteria

1. THE Career_Agent SHALL render every phase screen of the six-phase wizard using a single shared set of typography, colour, spacing, and component style definitions, such that any given UI element type is styled identically on every phase screen.
2. THE Career_Agent SHALL display, on each of the Provider Setup, Ingest, Skill Map, Role Discovery, Interview Coaching, Output, and Memory & Maintenance screens, the current phase name and controls to move to the next phase and to the previous phase, consistent with the wizard interface in Requirement 48.
3. WHILE the viewport width is at least 768 CSS pixels, THE Career_Agent SHALL present the desktop layout.
4. THE Career_Agent SHALL allow every interactive control to be reached and operated using the keyboard alone, provide a screen-reader text label for every interactive control, and render all text at a contrast ratio of at least 4.5 to 1 against its background, consistent with the accessibility requirement in Requirement 42.4.
5. THE Career_Agent SHALL surface the network and privacy labels defined in Requirement 7 and the AI assist opt-in choices defined in Requirements 22, 28, 30, and 47 within the interface before the corresponding operation runs.
6. WHILE a phase screen has no content to display, THE Career_Agent SHALL present an empty-state message that names at least one action the user can take next.
7. WHILE an operation is in progress, THE Career_Agent SHALL display a loading indicator for that operation, shown within 1 second of the operation starting and removed when the operation completes.
8. IF an operation fails, THEN THE Career_Agent SHALL present an error state that describes the failure, names the available recovery action, and retains the user's prior input without loss.
9. WHILE the viewport width is at least 320 CSS pixels and below 768 CSS pixels, THE Career_Agent SHALL present the mobile layout with no horizontal scrolling of page content.
10. WHILE an interactive control has keyboard focus, THE Career_Agent SHALL display a visible focus indicator on that control.

### Requirement 59: DOCX Document Ingestion

**User Story:** As a job seeker whose CV is a Word document, I want to upload a `.docx` file directly, so that I do not have to convert it to PDF or Markdown first.

#### Acceptance Criteria

1. THE Ingestion_Engine SHALL accept `.docx` (Office Open XML WordprocessingML) files as a supported ingestion format, in addition to the formats in Requirement 8.
2. WHEN a `.docx` file is ingested, THE Ingestion_Engine SHALL extract its text by reading the archive's `word/document.xml` part entirely on the user's device, without any network request.
3. WHEN extracting `.docx` text, THE Ingestion_Engine SHALL convert paragraphs and line breaks to line breaks, preserve run text, and exclude field-instruction codes, then feed the recovered text through the same structured extraction path used for Markdown and plain text.
4. THE Ingestion_Engine SHALL continue to reject legacy `.doc` files with the deferred-to-a-later-phase notice defined in Requirement 8.3.

### Requirement 60: AI-Assist Mode Selection and Persistence

**User Story:** As a user, I want to choose once, up front, whether each phase uses script detection, AI detection, or both, so that the choice is applied consistently across the whole pipeline and I am never surprised by what runs.

#### Acceptance Criteria

1. THE Career_Agent SHALL offer three AI-assist modes for the AI-assistable phases: script-only, AI-only, and both (script plus AI).
2. THE Career_Agent SHALL present the AI-assist mode choice during the Ingest phase before the user saves, and SHALL persist the chosen mode to the Memory Store so it survives reload, resume, and Memory Store import.
3. THE Career_Agent SHALL apply the persisted AI-assist mode as the default on every AI-assistable phase, and SHALL allow the user to change it on any such phase.
4. WHERE the mode is script-only, THE Career_Agent SHALL produce the phase result using deterministic detection alone and SHALL make no provider call.
5. WHERE the mode is AI-only, THE Career_Agent SHALL produce the phase result from the AI output alone, excluding the deterministic detection from the result.
6. WHERE the mode is both, THE Career_Agent SHALL pass the deterministic detection to the AI and request that the AI review and refine it — keeping supported items, correcting them, dropping unsupported ones, and adding evidenced items the deterministic detection missed.
7. WHERE AI assist is used (AI-only or both), THE Career_Agent SHALL send the AI the full decoded document text, because the chat model cannot parse PDF or DOCX binary and the document is decoded to text on the user's device first.
8. WHERE the chosen provider is a keyless Local Provider on the user's own device, THE Egress Gate SHALL skip PII pre-screening and transmit the full content, consistent with the no-third-party-egress guarantee in Requirement 7.6.
9. WHERE the chosen provider is a keyed cloud (third-party) provider, THE Egress Gate SHALL redact detected PII and secrets from the transmitted text, consistent with Requirement 6.
10. WHILE the mode is AI-only, THE Ingestion_Engine SHALL present the ingested documents as items prepared for the AI rather than presenting the deterministic structured-extraction review.

### Requirement 61: User-Authored Skills and Roles

**User Story:** As the person ultimately responsible for my profile, I want to add my own skills and target roles in my own words before saving, so that the final list reflects my judgement regardless of what the script or AI detected.

#### Acceptance Criteria

1. BEFORE the user finalises the skill map, THE Skill_Mapper SHALL provide an input that accepts user-authored skills as a comma-separated or one-per-line list.
2. BEFORE the user saves role preferences, THE Role_Matcher SHALL provide an input that accepts user-authored target roles as a comma-separated or one-per-line list.
3. WHEN the user adds skills or roles through that input, THE Career_Agent SHALL record each as user-confirmed with user-confirmation provenance and SHALL include them in the result regardless of the selected AI-assist mode.
4. THE Career_Agent SHALL de-duplicate user-authored entries against the existing entries before adding them.

### Requirement 62: Behaviour-First STAR Question Generation

**User Story:** As a user from any background applying to any kind of job, I want AI-generated practice questions focused on the behaviours and qualities that matter for the role, so that I prepare for what interviewers actually probe rather than only technical trivia.

#### Acceptance Criteria

1. WHERE the user opts into AI-generated STAR questions, THE Interview_Coach SHALL instruct the model to first infer the behaviours and qualities most important for succeeding in the target role, whatever the industry or seniority, and then generate questions that probe those qualities.
2. THE Interview_Coach SHALL request that the AI limit technical-depth questions to at most one per generated set.
3. THE Interview_Coach SHALL request the AI questions as a structured JSON array in which each element pairs a question with the competency or quality it probes, and SHALL retain that competency for use in the coaching loop and summary.
4. THE Interview_Coach SHALL pass the candidate's skills to the question generator only as background context, not as the primary driver of the questions.
5. WHEN the model reply does not conform to the requested JSON format, THE Interview_Coach SHALL still surface every usable practice question contained in the reply — extracting and parsing the structured JSON when it is present anywhere in the reply, and otherwise recovering every question-like line from the reply text — assigning a generic competency to any question whose competency cannot be determined, and SHALL treat the generation as producing no questions only when the reply contains no usable question text, so that a local model that ignores the exact format still yields supplemental practice questions consistent with Requirements 22.6 and 22.8.

### Requirement 63: AI Adaptive STAR Coaching Loop

**User Story:** As a user practising for interviews, I want to answer a question and have the AI check whether my answer covers the full STAR model and ask targeted follow-ups until it is complete, so that I learn to give strong, complete answers and discover skills I can claim.

#### Acceptance Criteria

1. THE Interview_Coach SHALL let the user select a question (AI-generated, script-generated, or user-authored) and provide an answer either as typed text or as recorded/uploaded audio transcribed through the user's speech-to-text provider via the Egress Gate.
2. WHEN the user submits an answer, THE Interview_Coach SHALL send the competency, the original question, and all answers so far to the AI through the Egress Gate and request an assessment of which STAR elements (Situation, Task, Action, Result) are covered, whether the answer is sufficient, and one follow-up question when it is not.
3. WHILE the AI reports the answer is not sufficient and a follow-up is available, THE Interview_Coach SHALL present the follow-up question and collect a further answer, repeating up to a maximum of three AI follow-ups per question.
4. WHEN the third follow-up round is reached, THE Interview_Coach SHALL offer the user the choice to continue digging deeper beyond the cap or to stop, and SHALL continue only if the user opts in and the AI still has a follow-up.
5. THE Interview_Coach SHALL allow the user to stop the loop for a question at any round.
6. WHEN the loop for a question ends, THE Interview_Coach SHALL produce, through the Egress Gate, a summary containing the question and its competency, a summary of the answer drawn only from the user's own words, the STAR coverage, the skills evidenced in the answer, and improvement tips.
7. THE Interview_Coach SHALL derive the answer summary, STAR assessment, follow-up questions, and detected skills only from the user's own words and SHALL invent no facts, consistent with the No-Fabrication Rule in Requirement 37; follow-up questions are practice prompts and are not factual claims.
8. WHEN a coaching session ends, THE Interview_Coach SHALL present the skills detected across the session's answers that are not already in the skill map, and SHALL add a detected skill to the skill map only after explicit user confirmation, consistent with Requirements 29.2 and 29.3.
9. WHERE the user has not opted into AI assist (script-only), THE Interview_Coach SHALL provide the existing deterministic guided STAR loop so the user can build their own questions and answers without any provider call.

### Requirement 64: Ingestion Conversion Preview

**User Story:** As a user uploading career documents, I want to inspect the full text that Career Agent extracted from each document in a read-only view, so that I can judge conversion quality and, if it looks wrong, discard the document and paste the equivalent text myself.

#### Acceptance Criteria

1. WHEN a document has been ingested and converted, THE Ingestion_Engine SHALL make the full converted text of that document available to the user in a read-only Conversion Preview, per document.
2. THE Conversion Preview SHALL present the converted text for inspection only and SHALL NOT allow the user to edit the converted text in place.
3. WHERE low-confidence regions were flagged during PDF extraction per Requirement 8.5, THE Conversion Preview SHALL indicate those regions so the user can see where extraction was uncertain.
4. THE Ingestion_Engine SHALL allow the user to discard an ingested document after inspecting its Conversion Preview, and SHALL allow the user to provide the equivalent career text manually by pasting through the existing paste path defined in Requirement 8.6.
5. WHERE an ingested document carries no convertible prose body (for example a LinkedIn export ZIP), THE Conversion Preview SHALL indicate that there is no converted text to preview for that document.

### Requirement 65: Outbound Payload Preview and User Redaction

**User Story:** As a privacy-conscious user, I want to see and edit the exact text that will be sent to a cloud provider before it leaves my device, so that I can remove any wording I do not want transmitted beyond the auto-detected PII.

#### Acceptance Criteria

1. BEFORE the Career_Agent transmits a text payload to a keyed cloud (third-party) provider, THE Career_Agent SHALL present the exact text payload to be transmitted to the user for review as a Payload Preview.
2. THE Career_Agent SHALL allow the user to edit or remove any content from the Payload Preview before it is sent, and THE transmitted payload SHALL be the user-approved edited text.
3. WHEN the user approves the Payload Preview, THE Career_Agent SHALL apply the local PII pre-screening of Requirement 6 to the user-approved text before transmission, so the preview supplements and does not bypass PII pre-screening.
4. IF the user cancels at the Payload Preview, THEN THE Career_Agent SHALL transmit nothing and SHALL preserve the user's prior state.
5. WHERE the destination of a text payload is a keyless Local Provider on the user's own device with no third-party egress per Requirement 7.6, THE Career_Agent MAY skip the Payload Preview because no payload leaves the device.
6. THE Career_Agent SHALL route the Payload Preview through the single Egress Gate defined in Requirement 7.5 so the review occurs before any transmission, consistent with the network-operation labelling of Requirement 7.3.
7. THE Payload Preview SHALL apply to outbound chat and LLM text operations, and audio transcription SHALL continue to surface the resulting transcript for confirmation and correction per Requirement 26.
