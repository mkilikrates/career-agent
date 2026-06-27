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
| 3 | Role discovery | Role Discovery → "Recommend roles with AI" | `buildDiscoveryPrompt` (`@core/role-matcher/role-discovery-payload.ts`) | `Title — reason` per line | `parseAiRoles` |
| 4 | STAR practice questions | Coaching → "Suggest practice questions with AI" | `buildStarQuestionsPrompt` (`@core/interview/coach-assist.ts`) | `<competency> :: <question>` per line | `parseQuestionPrompts` |
| 5 | Educational STAR summary | Coaching → educational summary | `buildStarSummaryPrompt` (`@core/interview/coach-assist.ts`) | free-text guidance | trimmed text |
| 5a | Adaptive coaching — adequacy / follow-up | Coaching → submit a STAR answer (per turn) | `buildAdequacyPrompt` (`@core/interview/coach-assist.ts`) | strict `LABEL: value` lines | `parseAdequacyReply` |
| 5b | Adaptive coaching — per-question summary | Coaching → a question's loop ends | `buildPerQuestionSummaryPrompt` (`@core/interview/coach-assist.ts`) | strict `LABEL: value` lines | `parsePerQuestionSummaryReply` |
| 6 | CV tailoring (no posting) | Output → tailor with AI | `buildCvTailoringPrompt` (`@core/output/output-assist.ts`) | one suggestion per line | `parseTailoringNotes` |
| 7 | CV tailoring (Target Opportunity) | Output → tailor toward a job posting | `buildTailoringPayload` (`@core/output/tailoring.ts`) | one suggestion per line | `parseTailoringNotes` |
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
- **Corpus**: the full career evidence, split into chunks of ≤6000 chars
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
invent skills that the evidence does not support. Return ONLY a comma-separated
list of concise skill names, with no commentary, numbering, or explanation.
```

Followed by `CAREER EVIDENCE:` and the corpus chunk (each item rendered as a
flattened line, e.g. `employment; title: SRE; employer: Acme; technologies: Kubernetes, Go`).

- **Reply format**: comma-separated skill names.
- **Parser**: `parseDiscoveredSkills` (splits on `, ; • newline`, strips markers,
  de-dupes case-insensitively against the existing map/baseline, drops
  fragments >60 chars).
- **Trust**: each suggestion is a proposal; the user confirms each before it
  becomes a user-confirmed skill.

---

## 3. Role discovery (`role_discovery`)

- **File**: `src/core/role-matcher/role-discovery-payload.ts`
- **Builder**: `buildDiscoveryPrompt(payload)` where the payload is built by
  `buildDiscoveryPayload(map, dest)` — **employer-free**: each skill is projected
  to `{ name, approxDurationMonths, category }` only. No employer/company name is
  ever included. For `keyed-cloud`, private skills are excluded.

**Prompt template:**

```
Based ONLY on the following skills and the approximate experience duration for
each, suggest up to 5 realistic job roles that fit, inferring a level of
experience from the durations. Do not assume any employer or industry beyond
what the skills imply. Return one role per line as "Title — short reason". No
preamble.

Skills:
- <skill name> (<category>, ~<duration>)
- ...
```

`<duration>` is rendered as `~N mo` (<12 months) or `~N yr`.

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
Prioritise behaviours and qualities; include at most one question focused on
technical depth, since technical topics are easier to prepare for. Do NOT
suggest facts or outcomes for them to claim. Return one question per line in the
exact format "<competency> :: <question>", where <competency> is the single
behaviour or quality that question probes. Use no preamble and no numbering.

Use the candidate's background only as context: <comma-separated skill names>
```

The model infers the role's key behaviours/qualities itself (no hardcoded
competency list), so it generalises to any job/background; skills are background
context only, so the questions stay behaviour-first rather than a tools quiz.

(The `The role: …` sentence is included only when the role has a description.)

- **Reply format**: one question per line as `<competency> :: <question>`.
- **Parser**: `parseQuestionPrompts` splits each line on the first `::` into
  `{ competency, question }` (strips list markers, de-dupes by question, drops
  lines lacking the `::` delimiter — which also discards model preambles — and
  drops empty/too-short questions). The `question` is shown to the user while the
  `competency` is retained for the adaptive coaching loop and per-question
  summary (R62.3, R63.2, R63.6).
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
- **Builder**: `buildCvTailoringPrompt(model)` from the deterministic CV model.

**Prompt template:**

```
You are helping tailor a CV for the role of "<targetRole.title>". Suggest up to
5 short, advisory edits to better target this role (emphasis, ordering,
phrasing). Do NOT invent experience, metrics, or skills the candidate did not
provide. Return one suggestion per line, no preamble.

Skills: <comma-separated skill names>

Experience bullets:
- <bullet text>
- ...
```

- **Reply format**: one suggestion per line.
- **Parser**: `parseTailoringNotes`.
- **Trust**: suggestions are advisory; nothing is woven into the CV until the
  user confirms it.

---

## 7. CV tailoring — with a Target Opportunity (`cv_tailoring`)

- **File**: `src/core/output/tailoring.ts`
- **Builder**: `buildTailoringPayload(evidence, opportunity, dest)`. The job
  posting is a **tailoring target only — never a claim source**. For
  `keyed-cloud`, private items are excluded from the confirmed evidence.

**Prompt template:**

```
You are helping tailor a CV to a Target Opportunity. The Target Opportunity is a
TAILORING TARGET ONLY — it is NEVER a source of facts. Use ONLY the confirmed
evidence below as the source of skills, metrics, dates, job titles, and
employers. Do NOT add, infer, or import any skill, metric, date, title, or
employer that appears only in the Target Opportunity and not in the confirmed
evidence. Suggest up to 5 short, advisory edits — emphasis, ordering, and
phrasing only — to better target this opportunity using that confirmed evidence.
Return one suggestion per line, no preamble.

Confirmed skills:
- <skill name> (<category>)
- ...

Confirmed experience:
- <accomplishment / talking-point text>
- ...

Target Opportunity (tailoring target only — NOT a source of facts):
<job posting text>
```

- **Reply format / parser**: same as #6 (`parseTailoringNotes`).

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
