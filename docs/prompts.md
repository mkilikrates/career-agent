# Model Prompts Reference

This document catalogues **every interaction Career Agent has with an LLM or STT
model**: what triggers it, the exact prompt text sent, the variables
interpolated, the reply format expected, and how the reply is parsed. It is
hand-maintained — if you change a prompt builder in `src/core/**`, update the
matching section here.

## How prompts reach a model

1. A phase screen builds an **operation** (e.g. `createStarQuestionsOperation`)
   bound to a gate-routed transport.
2. The operation's `aiAssisted` / `fetchSuggestions` path calls a pure
   prompt-builder in `@core/**` to produce a plain string.
3. The string is handed to `aiAssist(prompt)` in `src/ui/App.tsx`, which:
   - appends the **session-language directive** (`assist.languageDirective` from
     the active locale) so the model answers in the user's language;
   - routes the request through `runtime.agent.requestProvider(...)` → the single
     **Egress Gate** (PII pre-screening, operation labelling, payload
     minimisation) → `Provider_Manager` → the chosen provider.
4. The transport sends exactly one chat message:
   `messages: [{ role: 'user', content: <prompt + language directive> }]`.

### Key facts

- **No system prompt is sent at runtime.** Every request is a single `user`
  message. Each prompt therefore embeds its own no-fabrication instructions
  inline.
- **`NO_FABRICATION_SYSTEM_PROMPT` is a test-time artefact only** (see the last
  section). It is used by the offline No-Fabrication harness/CI, never injected
  into live requests.
- **Language**: the directive appended by `aiAssist` is, for `pt-BR`:
  *"Escreva toda a sua resposta em português do Brasil (pt-BR). Mantenha termos
  técnicos, nomes de ferramentas e nomes próprios inalterados."* and for `en`:
  *"Write your entire response in English (en). Keep technical terms, tool names,
  and proper nouns unchanged."*
- **Privacy scoping** is by destination kind:
  - `keyed-cloud` (third-party): items marked **private are excluded**; the
    Egress Gate PII-screens the payload.
  - `keyless-local` (on-device, e.g. Ollama): no third-party egress, so private
    items / whole documents **may** be included.

## Summary of model interactions

| # | Capability | Trigger (screen) | Prompt builder | Reply format | Parser |
|---|------------|------------------|----------------|--------------|--------|
| 1 | Provider key validation | Provider Setup | none (`GET /models`) | — | — |
| 2 | Skill discovery | Skill Map → "Suggest skills with AI" | `buildDiscoveryPrompt` (`@core/skills/skill-discovery.ts`) | comma-separated list | `parseDiscoveredSkills` |
| 2a | Structured career extraction | Document upload → AI extraction | `buildCareerExtractionPrompt` (`@core/skills/career-extraction.ts`) | JSON `{ professional_summary, positions, education, technical_skills, core_competencies, languages, hobbies, causes, additional_info }` | `parseCareerExtraction` |
| 2b | AI consolidation (dedup) | After merge, before deterministic pass (AI modes only) | `buildConsolidationPrompt` (`@core/skills/career-extraction.ts`) | JSON `{ positions, technical_skills, core_competencies }` (deduplicated) | `parseCareerExtraction` |
| 3 | Role discovery | Role Discovery → "Recommend roles with AI" | `buildDiscoveryPrompt` (`@core/role-matcher/role-discovery-payload.ts`) | `Title — reason` per line | `parseAiRoles` |
| 4 | STAR practice questions | Coaching → "Suggest practice questions with AI" | `buildStarQuestionsPrompt` (`@core/interview/coach-assist.ts`) | JSON array of `{competencies, question}` | `parseQuestionPrompts` (JSON-first, tolerant line fallback) |
| 5 | Educational STAR summary | Coaching → educational summary | `buildStarSummaryPrompt` (`@core/interview/coach-assist.ts`) | free-text guidance | trimmed text |
| 5a | Adaptive coaching — adequacy / follow-up | Coaching → submit a STAR answer (per turn) | `buildAdequacyPrompt` (`@core/interview/coach-assist.ts`) | strict `LABEL: value` lines | `parseAdequacyReply` |
| 5b | Adaptive coaching — per-question summary | Coaching → a question's loop ends | `buildPerQuestionSummaryPrompt` (`@core/interview/coach-assist.ts`) | strict `LABEL: value` lines | `parsePerQuestionSummaryReply` |
| 6 | CV tailoring (no posting) | Output → tailor with AI | `buildCvTailoringPrompt` (`@core/output/output-assist.ts`) | complete Markdown CV draft | `parseCvDraft` |
| 7 | CV tailoring (Target Opportunity) | Output → tailor toward a job posting | `buildTailoringPayload` (`@core/output/tailoring.ts`) | complete Markdown CV draft | `parseCvDraft` |
| 8 | Speech-to-text transcription | Coaching → upload/record audio | none (audio upload) | transcript text | — |

> Every prompt below is sent with the language directive appended as a final
> paragraph. The text shown here is the prompt builder's raw output.

---

## 1. Provider key validation

- **File**: `src/adapters/llm-http.ts` (`openAiCompatibleChat`, Anthropic client)
- **Trigger**: saving a provider in Provider Setup.
- **Prompt**: none. A no-token `GET /models` auth probe is issued. For a keyless
  Local Provider the auth header is omitted.

---

## 2. Skill discovery (`skill_discovery`)

- **File**: `src/core/skills/skill-discovery.ts`
- **Builder**: `buildDiscoveryPrompt(corpusChunk)` =
  `DISCOVERY_PROMPT_INSTRUCTION` + `"\n\nCAREER EVIDENCE:\n"` + chunk.
- **Corpus**: the full career evidence, split into chunks of ≤12000 chars
  (`DEFAULT_DISCOVERY_CHUNK_CHARS`) so nothing is truncated. One request **per
  chunk**. For `keyless-local` the chunks may be the **raw whole-document text**
  (`buildRawDiscoveryCorpus`) and include private items; for `keyed-cloud` they
  are structured non-private item lines (`buildDiscoveryCorpus`).

**Instruction (`DISCOVERY_PROMPT_INSTRUCTION`):**

```
You are analysing a person's career evidence to identify their professional
skills. List every distinct skill that is demonstrated or strongly implied by
the evidence below — include technical skills, tools, methodologies, domains,
and soft/leadership skills that the described work clearly required. Do not
invent skills that the evidence does not support. For each skill, infer the
approximate year the person first started using it based on the employment
dates in the evidence. Return ONLY a comma-separated list where each entry
is either "skill name (since YYYY)" when a start year can be inferred, or
just "skill name" when it cannot. No commentary, numbering, or explanation.
```

Followed by `CAREER EVIDENCE:` and the corpus chunk (each item rendered as a
flattened line, e.g. `employment; title: SRE; employer: Acme; technologies: Kubernetes, Go`).

- **Reply format**: comma-separated, each optionally `"skill name (since YYYY)"`.
- **Parser**: `parseDiscoveredSkills` (splits on `, ; • newline`, strips markers,
  extracts an optional `(since YYYY)` or `(YYYY)` suffix into a `since` field,
  de-dupes case-insensitively against the existing map/baseline, drops
  fragments >60 chars). Returns `DiscoveredSkill[]` with `{ name, since? }`.
- **Trust**: each suggestion is a proposal; the user confirms each before it
  becomes a user-confirmed skill.

---

## 2a. Structured career extraction (`career_extraction`)

- **File**: `src/core/skills/career-extraction.ts`
- **Builder**: `buildCareerExtractionPrompt(corpusChunk)` =
  `CAREER_EXTRACTION_INSTRUCTION` + `"\n\nDOCUMENT CONTENT:\n"` + chunk.
- **Corpus**: the full career document text, split into chunks of ≤12000 chars
  (same chunking as skill discovery). One request **per chunk**. For
  `keyless-local` the chunks are the **raw whole-document text** (via
  `buildRawDiscoveryCorpus`); for `keyed-cloud` they are structured non-private
  item lines (via `buildDiscoveryCorpus`).

**Instruction (`CAREER_EXTRACTION_INSTRUCTION`):**

```
You are analysing a career document to extract a structured, ATS-compatible
profile. Extract ONLY what the document explicitly states — do NOT invent or
infer information that is not present in the source text (No-Fabrication Rule).

Return a single JSON object with this exact structure:
{
  "professional_summary": "A brief 2-3 sentence career summary drawn from the document",
  "positions": [
    { "title": "…", "company": "…", "location": "…", "start": "YYYY-MM or YYYY", "end": "YYYY-MM or YYYY or null", "description": "…", "achievements": ["…"], "technologies": ["…"] }
  ],
  "education": [
    { "institution": "…", "degree": "…", "start": "YYYY-MM or YYYY", "end": "YYYY-MM or YYYY or null", "skills": ["…"] }
  ],
  "technical_skills": [
    { "name": "…", "since": "YYYY or null" }
  ],
  "core_competencies": ["…"],
  "languages": [
    { "language": "…", "proficiency": "…" }
  ],
  "hobbies": ["…"],
  "causes": ["…"],
  "additional_info": [
    { "category": "…", "value": "…" }
  ]
}

Rules:
- For positions: extract title, company, location (city/region when present),
  start/end dates, a brief role description, quantified achievements (use
  numbers where possible), and technologies/skills used in that role. Map skills
  and technologies to each specific position where they were used.
- For technologies: list each technology as a separate, standalone item. Write
  'S3', 'Lambda', 'DynamoDB' — NOT 'AWS (S3, Lambda, DynamoDB)'. Each entry
  should be one atomic skill name without embedded sub-skills or vendor-prefixed
  groupings.
- For education: extract institution, degree/course, start/end dates, and skills
  gained.
- For technical_skills: list standalone technical skills not tied to a specific
  position or course. Include an approximate start year if determinable.
- For core_competencies: INFER behavioural competencies from career patterns
  and achievements, not only literal keywords. Look at role progression, scope
  of responsibility, cross-team work, and quantified outcomes to identify
  competencies the candidate demonstrates even if they are not explicitly named.
  Examples of competencies to look for: Organisation, Customer Focus, Attention
  to Detail, Time Management, Adaptability, Problem Solving, Analytical
  Thinking, Teamwork, Communication, Continuous Learning, Quality Assurance,
  Prioritisation, Self-Motivation, Resilience, Leadership, Innovation,
  Stakeholder Management, Crisis Management, Strategic Planning, Mentoring,
  Cross-functional Collaboration, Change Management, Cost Optimization,
  Technical Vision, Team Building, Process Improvement. These examples span all
  seniority levels — from entry-level strengths through senior leadership.
  Infer competencies appropriate to the candidate's demonstrated level. Include
  both explicitly stated and pattern-inferred competencies distinct from
  technical skills.
- For languages: list spoken/written languages with proficiency levels (e.g.
  "Native", "Fluent", "Professional", "Intermediate", "Basic").
- For hobbies: list hobbies and interests if mentioned.
- For causes: list causes, volunteering, or community involvement if mentioned.
- For additional_info: surface any other CV-relevant categories (e.g.
  publications, patents, awards, memberships) that do not fit the fields above.
- Leave date fields as null when the document does not specify them.
- Omit empty arrays and null/empty string fields rather than including them as
  empty.
- Be tolerant of varied document formats and languages.
- Return ONLY the JSON object, no commentary or explanation.
```

Followed by `DOCUMENT CONTENT:` and the corpus chunk.

- **Reply format**: a single JSON object with
  `{ "professional_summary", "positions": [...], "education": [...], "technical_skills": [...], "core_competencies": [...], "languages": [...], "hobbies": [...], "causes": [...], "additional_info": [...] }`.
- **Parser**: `parseCareerExtraction` — fence-tolerant, preamble-stripping JSON
  extraction (same pattern as `parseQuestionPrompts`):
  1. Strip markdown code fences (`` ```json … ``` ``).
  2. Attempt to parse the whole reply first, then the first `{`…last `}` slice
     (object embedded in preamble/chatter).
  3. Validate shape and normalise each field tolerantly.
  4. Return an empty extraction if nothing parseable is found.

  Field normalisation tolerates alternative field names (`employer`/`startDate`/
  `endDate`, `skills`/`technologies`, `technical_skills`/`technicalSkills`/`skills`),
  null dates, and comma-separated technology strings.

  New fields are normalised tolerantly:
  - `professional_summary` / `professionalSummary` → optional string.
  - `core_competencies` / `coreCompetencies` → string array.
  - `languages` → array of `{ language, proficiency }` objects (name/level
    aliases accepted).
  - `hobbies` → string array.
  - `causes` → string array.
  - `additional_info` / `additionalInfo` → array of `{ category, value }` objects.
  - Positions: `location`/`city`, `description`/`summary`,
    `achievements`/`accomplishments` are all accepted aliases.
- **Merge**: `mergeCareerExtractions` — combines results from multiple chunks
  into a single de-duplicated extraction:
  - Professional summary: longest non-empty summary wins.
  - Positions de-duplicated by (company + title + start date); on collision the
    entry with the richest data (tech list, location, description, achievements)
    wins.
  - Education de-duplicated by (institution + degree); richest skills list wins.
  - Technical skills de-duplicated by name (case-insensitive); keeps the entry
    with the earliest `since` date.
  - Core competencies: merged and de-duplicated case-insensitively.
  - Languages: de-duplicated by language name (case-insensitive).
  - Hobbies, causes: merged and de-duplicated case-insensitively.
  - Additional info: de-duplicated by (category + value).
- **Post-processing** (applied during normalisation, before merge/conversion):
  - **Date normalization** (`normalizeDate`, R71.8, R71.9): position and education
    `start`/`end` dates and standalone skill `since` fields are converted from
    natural-language strings to ISO format (`YYYY-MM` or `YYYY`). Handles written
    month names (English + Portuguese), numeric `MM/YYYY`, date ranges (extracts
    start), and "Present"/"current"/"atual" → `undefined`. Already-ISO strings
    pass through unchanged.
  - **Compound skill splitting** (`splitCompoundSkills`, R71.11, R71.12): each
    position's `technologies` array is expanded — parenthetical entries become
    prefix + inner items, slash-separated entries become individual items —
    while an allowlist of known compounds (CI/CD, TCP/IP, Node.js, C#, C++,
    .NET, GitLab CI/CD, IDS/IPS) are preserved intact.
- **AI Consolidation** (`buildConsolidationPrompt`, applied after merge in
  AI-only/AI-assisted modes, R71.15, R71.18): serializes the merged positions,
  skills, and competencies into a prompt asking the model to identify and merge
  duplicates that pattern-based code cannot reliably detect (OCR noise,
  company-name variants, vendor-qualified skill forms, semantic duplicates,
  synonymous competencies). The model returns the same `CareerExtraction` JSON
  schema (deduplicated), parsed by `parseCareerExtraction`. On failure, falls
  back to the reduced deterministic pass.
- **Deterministic Safety Net** (`consolidateExtractionReduced`, applied after AI
  consolidation or alone in script-only mode): performs ONLY exact
  case-insensitive duplicate collapsing for skills, positions (by
  company+title+start), per-position technologies, and competencies. Does NOT
  apply fuzzy matching, vendor-prefix stripping, or synonym resolution.
- **Full Deterministic Consolidation** (`consolidateExtraction`, legacy):
  - **Sub-pass 1 — vendor-prefix skill deduplication** (R71.15): collapses
    vendor-qualified duplicates ("AWS S3" + "S3" → "S3", "Azure DevOps" +
    "DevOps" → "DevOps") in both `technicalSkills` and per-position
    `technologies` arrays, keeping the earliest `since` date.
  - **Sub-pass 2 — fuzzy position deduplication** (R71.16): deduplicates
    positions with fuzzy matching on (company + title) and overlapping dates,
    keeping the richest entry (most technologies, longest description, most
    achievements).
  - **Sub-pass 3 — synonym competency deduplication** (R71.17): loads
    `competency_synonyms.yaml` and canonicalises synonymous competencies to
    their canonical form (e.g. "Team Leadership" → "Leadership",
    "Cross-functional Collaboration" → "Collaboration").
- **Conversion**: `careerExtractionToItems` converts the extraction into
  `ExtractedItem[]` for the ingestion pipeline. Item types:
  `professional_summary`, `employment`, `education`, `skill`,
  `core_competency`, `language_proficiency`, `hobby`, `cause`,
  `additional_info`. All carry `confidence: 'Medium'`, `userConfirmed: false`.
- **Trust**: the extraction requires user review/confirmation before entering the
  knowledge base (R71.6, R12, R73.9). The prompt forbids inventing information
  not in the source (No-Fabrication Rule, R71.10).

---

## 2b. AI consolidation (`career_consolidation`)

- **File**: `src/core/skills/career-extraction.ts`
- **Builder**: `buildConsolidationPrompt(extraction)` serializes the merged
  positions, technical skills, and core competencies as JSON and asks the model
  to deduplicate them.
- **Trigger**: after `mergeCareerExtractions()`, only in `ai-only` or
  `ai-assisted` mode. Skipped in `script-only` mode.
- **Reply format**: same `CareerExtraction` JSON schema (positions,
  technical_skills, core_competencies — deduplicated).
- **Parser**: reuses `parseCareerExtraction` (same JSON schema contract).

**Prompt summary (condensed):**

```
You are deduplicating a structured career extraction. The following JSON contains
positions, technical skills, and core competencies that may have duplicates.

Your task:
1. MERGE duplicate positions (OCR noise, company-name variants, abbreviations).
   Keep the richest entry and preserve the earliest start date.
2. MERGE duplicate skills (vendor-qualified variants, semantic duplicates).
   Preserve the earliest `since` date.
3. COLLAPSE synonymous competencies to the shorter canonical form.

Return ONLY a JSON object with: { positions, technical_skills, core_competencies }
Rules: Do not invent. Do not remove distinct entries. Preserve richest data.
```

Followed by `INPUT:` and the extraction data as JSON.

- **Failure handling**: on error or unparseable response, the system falls back to
  `consolidateExtractionReduced` (exact case-insensitive dedup only) and logs a
  non-blocking warning.
- **After AI consolidation**: `consolidateExtractionReduced` runs as a lightweight
  safety net (exact case-insensitive dedup only — no fuzzy matching, no
  vendor-prefix stripping, no synonym resolution).

---

## 3. Role discovery (`role_discovery`)

- **File**: `src/core/role-matcher/role-discovery-payload.ts`
- **Builder**: `buildDiscoveryPrompt(payload)` where the payload is built by
  `buildDiscoveryPayload(map, dest, atsData?)` — **employer-free**: each skill is projected
  to `{ name, approxDurationMonths, category }` only. No employer/company name is
  ever included. For `keyed-cloud`, private skills are excluded.
  `approxDurationMonths` is computed as `(now − since)` — i.e. the elapsed time
  since the user first used the skill (R70.7). When `CareerContext` is provided
  (via `deriveCareerContext()` from `@core/career-context`), it is
  appended as a "Career context" block so the model can match on the candidate's
  career arc without seeing employer names (R20.6, R47.2).

**Prompt template:**

```
Based ONLY on the following skills, experience durations, and career context,
suggest up to 5 realistic job roles that fit, inferring a level of experience
from the durations and career trajectory. Do not assume any employer or industry
beyond what the skills and context imply. Return one role per line as
"Title — short reason". No preamble.

Skills:
- <skill name> (<category>, ~<duration>)
- ...

Career context:
Previous roles: <comma-separated job titles — no company names>
Core competencies: <comma-separated competencies from extraction>
Education: <comma-separated degrees/fields>
Summary: <professional summary text>
```

`<duration>` is rendered as `~N mo` (<12 months) or `~N yr`. The "Career
context" block is included only when `AtsCareerData` is provided; when absent
(e.g. no extraction ran or no ATS data available), the prompt omits it and uses
a simpler phrasing without "and career context" / "and career trajectory".

- **Reply format**: one role per line, `Title — short reason`.
- **Parser**: `parseAiRoles` (accepts `—`, `–`, `-`, or `:` separators; de-dupes
  by title; drops titles >80 chars). AI roles are surfaced with `matchScore: 0`
  and label "AI-suggested — review before adding"; the user must accept one
  before it enters preferences.

---

## 4. STAR practice questions (`star_questions`)

- **File**: `src/core/interview/coach-assist.ts`
- **Builder**: `buildStarQuestionsPrompt(role, map, dest)`.
- **Note**: this **supplements** the deterministic, role-grounded script
  questions (`generateQuestions`) — it never replaces them. For `keyed-cloud`,
  private skills are excluded from the background skills.

**Prompt template:**

```
You are an experienced interviewer preparing behavioural practice questions for
a candidate applying to the role of "<role.title>". The role: <role.description>.
First, identify the few behaviours and qualities that matter MOST for succeeding
in this specific role, whatever the industry or seniority. Then write up to 5
open behavioural STAR-format practice questions that probe those qualities and
ask the candidate to recount their own Situation, Task, Action, and Result.
Calibrate the depth and seniority of your questions to match the candidate's
profile below. Prioritise behaviours and qualities; include at most one question
focused on technical depth, since technical topics are easier to prepare for. Do
NOT suggest facts or outcomes for them to claim. Return ONLY a JSON array and
nothing else, where each element is an object with two fields:
"competencies" (an array of one or more behaviour/quality strings that the
question probes) and "question" (the open behavioural practice question).
Example: [{"competencies": ["Leadership", "Stakeholder Management"], "question":
"Tell me about a time you led a team through a difficult change."}].

CANDIDATE PROFILE (for question-level calibration):
- Target role: <role.title>
- Profile: <N> matched skills, <M> total evidence points
- Matched skills:
  - <skill name>, <evidence count> evidence, ~<N> years experience, <proficiency signal>
  - ...
- Gap skills (developing):
  - <gap skill name> (gap — developing)
  - ...
- Previous titles: <comma-separated job titles>
- Core competencies: <comma-separated competencies from extraction>
- Education: <comma-separated degrees/fields>
- Summary: <professional summary text>
```

The model infers the role's key behaviours/qualities itself (no hardcoded
competency list), so it generalises to any job/background. The structured
candidate profile gives the model enough context to calibrate question depth and
seniority — a candidate with ~15 years experience and many evidence points gets
senior-level questions, while someone with < 1 year gets appropriately scoped
ones. Experience duration is derived from the skill's `since` date (the year the
user first used the skill, R70.6). Only role-relevant skills (matched + gaps)
are sent, keeping the prompt compact; for a keyed cloud (third-party)
destination, private skills are excluded (R22.7). The additional ATS context
lines (previous titles, competencies, education, summary) are included when a
`CareerContext` is provided (converted via `toAtsContext()` from
`@core/career-context`), giving the model richer career-arc calibration data.
In AI-only mode, the deterministic script questions are NOT generated — the
interview file starts empty and waits for AI-generated questions only.

(The `The role: …` sentence is included only when the role has a description.)

- **Reply format**: a JSON array of `{ "competencies", "question" }` objects
  (multi-competency). JSON is self-delimiting, so any model preamble or trailing
  chatter falls outside the array and is ignored. The legacy singular
  `"competency"` field is accepted for backward compatibility and wrapped into a
  single-element `competencies` array.
- **Parser**: `parseQuestionPrompts(reply, { defaultCompetency })` is **tolerant
  and layered** so a local model that ignores the format still yields questions
  (R62.5):
  1. **JSON-first** — locate and parse the JSON array anywhere in the reply
     (tolerating ```` ```json ```` fences and surrounding prose), accept
     `{ competencies, question }` or `{ competency, question }` objects, a
     `{ questions: [...] }` wrapper, or bare question strings, and default a
     **generic competency** for any element that omits one;
  2. **line fallback** — when no usable JSON is found, scan lines and keep only
     those that read as a question: a `<competency> :: <question>` line
     (competency preserved), a line ending in `?`, or a line opening with a
     behavioural lead-in (Tell/Describe/Share/Explain/Walk/Give/How/What/Why/…),
     dropping all other lines (preamble, headers, chatter).

  The result is empty **only** when the reply contains no usable question text;
  on an empty result the UI keeps the deterministic script questions (R22.6/22.8).
  The `competencies` array is shown to the user (all behaviours the question
  probes) and retained for the adaptive coaching loop and per-question summary
  (R62.3, R63.2, R63.6). The generic-competency label is supplied by the UI from
  `locales/` (`coaching.ai.genericCompetency`), so no user-facing string is
  hardcoded in `@core`.
- **Trust**: AI questions are practice prompts, surfaced as unconfirmed
  suggestions; they never enter the knowledge base, so they are not gated by the
  No-Fabrication harness.

---

## 5. Educational STAR summary (`star_summary`)

- **File**: `src/core/interview/coach-assist.ts`
- **Builder**: `buildStarSummaryPrompt(summary)` where `summary` is the
  deterministic `StarTeachingSummary` built from the user's own delivery-stripped
  answer content. The four S/T/A/R components remain the user's own words; only
  the `guidance` text is AI-elaborated.

**Prompt template:**

```
Here is a candidate's STAR interview answer, broken into the content they
provided for each element. Write a short educational summary that identifies the
Situation, Task, Action, and Result in their answer and explains what a good
STAR-format answer looks like. Use ONLY the content below — do not add, assume,
or invent any fact, metric, or outcome the candidate did not state. Return only
the teaching summary.

Situation: <user content or "(not provided)">
Task: <user content>
Action: <user content>
Result: <user content>
```

- **Reply format**: free-text teaching guidance.
- **Trust**: only the guidance text is taken from the reply; the S/T/A/R content
  is never replaced by model output. On provider failure the deterministic
  `STAR_GUIDANCE` baseline is used.

---

## 5a. Adaptive coaching — adequacy / follow-up (`star_coaching`)

- **File**: `src/core/interview/coach-assist.ts`
- **Builder**: `buildAdequacyPrompt({ role, competency, question, answersSoFar })`.
- **Operation**: `assessAdequacy(input, dest, transport)` — sends ONE gated
  request per coaching turn and parses the reply with `parseAdequacyReply`.
- **Stateless**: the chat model holds no memory across turns, so each call
  carries the **full context** — the role, the competency the question probes
  (from #4), the original question, and **every answer so far** in order. The
  operation persists no state of its own; the loop controller owns turn counting,
  the 3-follow-up cap, and failure handling.

**Prompt template:**

```
You are an experienced interview coach assessing a candidate's STAR practice
answer for the role of "<role.title>". The role: <role.description>. The
competency being practised is "<competency>". The original question was:
"<question>".

Here is everything the candidate has said so far, in order:
1. <answer 1>
2. <answer 2>
...

Assess the answer using ONLY the candidate's own words above — do not add,
assume, or invent any fact, detail, metric, or outcome they did not state.
Decide whether each STAR element (Situation, Task, Action, Result) is covered or
missing, whether the answer is now sufficient overall, and, when it is not
sufficient, ONE open follow-up question that would help the candidate cover what
is missing. The follow-up is a practice prompt, never a statement of fact.

Reply in EXACTLY this format, one field per line, and nothing else:
SITUATION: covered or missing
TASK: covered or missing
ACTION: covered or missing
RESULT: covered or missing
ENOUGH: yes or no
FOLLOWUP: <one open follow-up question, or "none">
```

(The `The role: …` sentence is included only when the role has a description.
When no answer has been given yet, the answers block renders `(no answer yet)`.)

- **Reply format**: six strict `LABEL: value` lines as above.
- **Parser**: `parseAdequacyReply` reads each label tolerantly (leading list
  markers / blockquote / markdown-bold around the label, surrounding emphasis or
  placeholder brackets/quotes on the value) but interprets meaning
  **conservatively**: a STAR element is `covered` only when its line explicitly
  says "covered" (else `missing`); `ENOUGH` is `true` only on an explicit "yes"
  (else not-enough); `FOLLOWUP` is `null` when absent, empty, or "none". The loop
  continues while `enough` is `false` and a `followUp` exists, capped at 3 AI
  follow-ups (R63.3/R63.4).
- **Trust**: the assessment and follow-up derive only from the candidate's own
  words; follow-ups are practice prompts, never factual claims, so they are not
  gated by the No-Fabrication harness (R63.2, R63.7).

---

## 5b. Adaptive coaching — per-question summary (`star_coaching`)

- **File**: `src/core/interview/coach-assist.ts`
- **Builder**: `buildPerQuestionSummaryPrompt({ role, competency, question, fullAnswer })`.
- **Operation**: `perQuestionSummary(input, dest, transport)` — sends ONE gated
  request when a question's coaching loop **ends** and parses the reply with
  `parsePerQuestionSummaryReply`.
- **Stateless**: the chat model holds no memory across turns, so the call carries
  the **full context** — the role, the competency the question probed (from #4),
  the original question, and the candidate's **full answer** (every turn, joined).
  The operation persists no state of its own.

**Prompt template:**

```
You are an experienced interview coach summarising a candidate's completed STAR
practice answer for the role of "<role.title>". The role: <role.description>. The
competency being practised is "<competency>". The original question was:
"<question>".

Here is the candidate's full answer:
<full answer>

Summarise the answer using ONLY the candidate's own words above — do not add,
assume, or invent any fact, detail, metric, skill, or outcome they did not state.
The summary and the listed skills MUST be drawn solely from what the candidate
actually said; list a skill only when the answer clearly evidences it. Write the
summary in the first person and the past tense.

Reply in EXACTLY this format, one field per line, and nothing else:
SUMMARY: <2-3 sentences, first person, past tense>
STAR: <which of Situation, Task, Action, Result the answer covered>
SKILLS: <comma-separated skills evidenced in the answer, or "none">
TIPS: <1-2 short actionable tips to improve the answer>
```

(The `The role: …` sentence is included only when the role has a description.
When no answer was given, the full-answer block renders `(no answer given)`.)

- **Reply format**: four strict `LABEL: value` blocks as above.
- **Parser**: `parsePerQuestionSummaryReply` reads each labelled section
  tolerantly (leading list markers / blockquote / markdown-bold around the label,
  multi-line `SUMMARY`/`TIPS` values): `summary` and `star` are the trimmed text
  blocks; `SKILLS` is split on commas/semicolons/newlines with "none"/empties
  dropped and de-duplicated case-insensitively; `TIPS` is one entry per line. The
  `competency` is **not parsed** — it is carried in from the coaching loop
  (R62.3) and shown alongside the summary.
- **Persistence**: the per-question summary is a **display artefact** and persists
  nothing itself. The polished talking point is confirmed/persisted through the
  **existing path** — `refine()` → `confirmTalkingPoint()` → `withTalkingPoint()`
  → `saveInterview()` (R28.3, R28.4) — exactly as for the guided text loop; no new
  persistence mechanism is introduced.
- **Trust**: the `summary` and `skills` derive only from the candidate's own
  words; the prompt forbids inventing any fact, metric, skill, or outcome
  (No-Fabrication, R63.6, R63.7). Detected skills still require explicit
  confirmation before entering the skill map (end-of-session merge, R63.8).

---

## 6. CV tailoring — no Target Opportunity (`cv_tailoring`)

- **File**: `src/core/output/output-assist.ts`
- **Builder**: `buildCvTailoringPrompt(model, evidence?)` from the deterministic
  CV model and optional confirmed evidence.

**Prompt template:**

```
You are producing a complete ATS-formatted CV draft in Markdown for the role of
"<targetRole.title>". Use ONLY the confirmed career data below. Do NOT invent
any skill, metric, date, title, or employer not present in the confirmed data.

Produce a complete CV in Markdown with the following sections:
1. Professional Summary (2-3 sentences targeting this role)
2. Experience (employment entries with adjusted bullet emphasis for the role)
3. Skills (ordered by relevance to this role)
4. Education
5. Certifications (if applicable)
6. Core Competencies (if applicable)
7. Awards (if applicable)

Use the provided Name and Contact info for the header — do NOT use placeholders
like [Full Name] or [Email].

Confirmed career data:
- Name: <user's name or omitted>
- Contact: <contact lines joined, or omitted>
- Professional summary: <summary text or "(none)">
- Positions:
  - <title> at <company> (<dates>); technologies: <comma-separated>; achievements: <semicolon-separated>
  - ...
- Core competencies: <comma-separated competencies or "(none)">
- Education:
  - <degree> at <institution> (<dates>)
  - ...
- Certifications:
  - <name> (<issuer>)
  - ...
- Awards:
  - <award value>
  - ...
- Nationality: <nationality values, or omitted>
- Skills:
  - <skill name> (~<N> years)
  - ...
```

The prompt now includes:
- **Name and contact** (derived from the CvModel header or evidence header) so
  the AI draft uses real data instead of "[Your Name]" placeholders.
- **Education** with a fallback to eligible `education`-type items when the CvModel
  field is empty.
- **Certifications** from the CvModel or eligible `certification`-type items.
- **Awards** from eligible `additional_info` items whose category matches "award".
- **Nationality** from eligible `additional_info` items whose category matches
  "nationalit…".
- **Skill duration** computed as `lastEvidence − since` (not `now − since`), so
  legacy skills report their actual usage window, not time since first use.

- **Reply format**: a complete Markdown CV draft.
- **Parser**: `parseCvDraft` — extracts the Markdown body and derives a short
  summary from the first significant line. Returns `undefined` when the reply is
  too short (< 20 chars) to constitute a meaningful draft. The result is wrapped
  as a `CvDraft` with `{ markdown, summary }`.
- **Trust**: the draft is advisory; the user reviews and confirms it before it
  replaces the deterministic CV. Nothing from the draft enters confirmed outputs
  without user acceptance.

---

## 7. CV tailoring — with a Target Opportunity (`cv_tailoring`)

- **File**: `src/core/output/tailoring.ts`
- **Builder**: `buildTailoringPayload(evidence, opportunity, dest)`. The job
  posting is a **tailoring target only — never a claim source**. For
  `keyed-cloud`, private items are excluded from the confirmed evidence.

**Prompt template:**

```
You are producing a complete ATS-formatted CV draft in Markdown, tailored to a
Target Opportunity. The Target Opportunity is a TAILORING TARGET ONLY — it is
NEVER a source of facts. Use ONLY the confirmed evidence below. Do NOT invent
any skill, metric, date, title, or employer not present in the confirmed data.

Produce a complete CV in Markdown with the following sections:
1. Professional Summary (2-3 sentences targeting this opportunity)
2. Experience (employment entries with adjusted bullet emphasis for the
   opportunity)
3. Skills (ordered by relevance to this opportunity)
4. Education
5. Certifications (if applicable)
6. Core Competencies (if applicable)
7. Awards (if applicable)

Use the provided Name and Contact info for the header — do NOT use placeholders
like [Full Name] or [Email].

Adapt emphasis and phrasing toward the Target Opportunity's language and
priorities, but EXCLUDE any skill, metric, date, title, or employer appearing
only in the Target Opportunity and not in confirmed evidence.

Confirmed career data:
- Name: <user's name or omitted>
- Contact: <contact lines joined, or omitted>
- Professional summary: <summary text or "(none)">
- Positions:
  - <title> at <company> (<dates>); technologies: <comma-separated>; achievements: <semicolon-separated>
  - ...
- Core competencies: <comma-separated competencies or "(none)">
- Education:
  - <degree> at <institution> (<dates>)
  - ...
- Certifications:
  - <name> (<issuer>)
  - ...
- Awards:
  - <award value>
  - ...
- Nationality: <nationality values, or omitted>
- Skills:
  - <skill name> (~<N> years)
  - ...

Target Opportunity (tailoring target only — NOT a source of facts):
<job posting text>
```

- **Reply format / parser**: same as #6 (`parseCvDraft` → `CvDraft`). The full
  Markdown CV draft is advisory and presented alongside the deterministic
  baseline for user review and confirmation.

---

## 8. Speech-to-text transcription

- **File**: `src/adapters/llm-http.ts` (`openAiCompatibleTranscribe`)
- **Trigger**: uploading or recording an interview answer in Coaching.
- **Prompt**: none. The audio file is posted to `/audio/transcriptions`
  (same-language) or `/audio/translations` (translate-to-English) with the STT
  model name. The Egress Gate PII-screens the **resulting transcript** before it
  is released.

---

## Appendix — No-Fabrication system prompt (test-time only)

- **File**: `src/core/no-fabrication/prompt-version.ts`
- **Status**: **NOT sent to the model at runtime.** It is the versioned system
  prompt the offline No-Fabrication harness and CI suite use to regression-test
  generated outputs against the provenance index. Editing it changes its content
  hash, which forces a fresh evaluation run.

**`NO_FABRICATION_SYSTEM_PROMPT` (v1.0.0):**

```
You generate professional materials under a strict No-Fabrication Rule.

1. Include a skill only if it appears in verified source material or the user
   explicitly confirmed it. Never add a skill that is merely implied by a job
   title, seniority, or industry (R37.1, R37.3).
2. Include a metric, date, job title, or employer name only if it is found in
   source material or explicitly confirmed by the user (R37.2).
3. Every item must be traceable to a source document line, an explicit user
   confirmation, or a confirmed interview answer before it appears in a final
   output (R37.4, R38.1).
4. If evidence is missing, omit the claim or ask the user — never invent it.
```

> The same no-fabrication intent is enforced at runtime by embedding inline
> "do not invent" instructions in each live prompt above, plus the deterministic
> baseline-then-confirm flow (the user confirms every AI suggestion before it
> enters the knowledge base).
