# Career Agent — User Guide

> Read this in: **English** · [Português](../pt-BR/user-guide.md) · [← Back to the README](../../README.md)

This guide is for **anyone who just wants to use Career Agent** on their own computer — no programming experience needed. We'll go step by step.

By the end you'll have Career Agent running in your web browser, connected either to a **cloud AI service** (using your own account key) or to a **fully local AI model** that runs on your own machine so nothing leaves your device.

---

## What is Career Agent?

Career Agent helps you:
- turn your CVs, certificates, and LinkedIn export into an organised, evidence-backed profile,
- practise interview answers using the **STAR** method (Situation, Task, Action, Result),
- generate a tailored CV in Markdown, PDF, and Word formats.

**Your files stay on your computer.** Career Agent never uploads your documents to a server. The only thing it ever sends out is a small, cleaned-up piece of text to the AI service *you* choose — and only when you ask it to. If you use a local AI model, **nothing leaves your computer at all**.

---

## Before you begin: what you'll need

1. **A computer running Windows or macOS.**
2. **A modern web browser.** For the best experience (saving your data straight to a folder on your computer), use **Google Chrome** or **Microsoft Edge** on a desktop. Safari and Firefox also work, but you'll save and load your data using a downloadable `.zip` file instead.
3. **One of the following for the AI features:**
   - a **cloud AI account** (OpenAI or Anthropic) where you can create an API key — this usually costs money per use, billed by the provider; **or**
   - enough computer power to run a **local AI model** (no account, no per-use cost, fully private — but needs a reasonably capable machine, ideally 16 GB of RAM or more).

> You can install and explore Career Agent first, and decide on the AI part later.

---

## Step 1 — Install Docker Desktop

We'll run Career Agent using **Docker**, a free tool that packages the app so it "just runs" the same way on every computer. **Docker Desktop** is the friendly app version with a window and buttons.

### On Windows

1. Go to the Docker website: <https://www.docker.com/products/docker-desktop/>.
2. Click **Download for Windows**.
3. Open the downloaded installer (`Docker Desktop Installer.exe`) and follow the prompts. Accept the default options. If it asks about **WSL 2**, allow it — it's required.
4. When it finishes, **restart your computer** if asked.
5. Open **Docker Desktop** from the Start menu. The first launch may take a minute. Accept the service agreement. You do **not** need to create a Docker account to use it.
6. You'll know it's ready when the Docker whale icon in your taskbar (bottom-right) is steady (not animating).

> **If Docker Desktop says virtualization is disabled:** you may need to enable it in your computer's BIOS/UEFI settings (often called "Virtualization Technology", "VT-x", or "SVM"). Search your PC model + "enable virtualization" for the exact steps, or ask whoever manages your computer.

### On macOS

1. Go to <https://www.docker.com/products/docker-desktop/>.
2. Click **Download for Mac**. Pick the right chip:
   - **Apple silicon** (M1/M2/M3/M4) — most Macs from 2020 onward.
   - **Intel chip** — older Macs.
   - Not sure? Click the Apple menu  → **About This Mac** and look at the "Chip" or "Processor" line.
3. Open the downloaded `Docker.dmg` and drag the **Docker** whale icon into your **Applications** folder.
4. Open **Docker** from Applications. Approve the permission prompts macOS shows. You do **not** need a Docker account.
5. You'll know it's ready when the whale icon in the top menu bar is steady.

---

## Step 2 — Download Career Agent

You need the project files on your computer. Two easy options:

**Option A — Download a ZIP (no extra tools):**
1. Open the project's GitHub page in your browser.
2. Click the green **Code** button → **Download ZIP**.
3. Unzip it somewhere easy to find, like your **Documents** folder. You'll get a folder named something like `career-agent`.

**Option B — If you have Git installed:** clone the repository with `git clone <repository-url>`.

---

## Step 3 — Open a terminal in the project folder

We'll type a couple of commands. Don't worry — it's copy-and-paste.

- **Windows:** open the `career-agent` folder in File Explorer. Click the address bar at the top, type `powershell`, and press **Enter**. A blue terminal window opens already pointed at the folder.
- **macOS:** open the `career-agent` folder in Finder. Right-click the folder → **New Terminal at Folder**. (If you don't see that option, open the **Terminal** app, type `cd ` — with a space — then drag the folder onto the window and press **Enter**.)

To confirm Docker is ready, type this and press Enter:

```bash
docker --version
```

You should see a version number. If you get an error, make sure Docker Desktop is open and fully started, then try again.

---

## Step 4 — Choose how you want to use the AI

Career Agent needs an AI model for features like skill suggestions and interview coaching. Pick the path that fits you:

- **Path A — Cloud AI (easiest to set up):** you use a paid cloud service (OpenAI or Anthropic) with your own key. Quick to start; you pay the provider per use; a small, redacted piece of text is sent to them.
- **Path B — Local AI (most private):** everything runs on your own computer. No account, no per-use cost, nothing leaves your machine. Needs a capable computer and a larger initial download.

You can start with Path A and switch to Path B later, or vice versa.

---

### Path A — Run with a cloud AI provider

1. **Start Career Agent.** In the terminal you opened in Step 3, type:

   ```bash
   docker compose up web
   ```

   The first time, Docker downloads and builds the app — this can take a few minutes. When it's ready you'll see it is "listening" and the window keeps running (that's normal — leave it open).

2. **Open the app.** In your browser, go to:

   ```
   http://localhost:8080
   ```

3. **Get an API key from your provider:**
   - **OpenAI:** sign in at <https://platform.openai.com/api-keys>, click **Create new secret key**, and copy it.
   - **Anthropic:** sign in at <https://console.anthropic.com/settings/keys>, click **Create Key**, and copy it.
   - Keep this key private — treat it like a password. You'll usually need to add billing details on the provider's site for the key to work.

4. **Enter your key in Career Agent.** When the app asks, paste your key. Career Agent checks it works, then stores it **encrypted, only in your browser** — never in your files, never anywhere else. You can remove it any time.

5. You're ready — jump to [Step 5: Using Career Agent](#step-5--using-career-agent).

> To stop the app later: go back to the terminal window and press **Ctrl + C**, or click the stop button next to the running container in Docker Desktop.

---

### Path B — Run with a fully local AI model

This runs the AI on your own computer, so **nothing leaves your device**. It downloads an AI model the first time (often several gigabytes), so use a good internet connection and allow some time.

1. **Start Career Agent together with a local chat model.** In the terminal:

   ```bash
   docker compose up
   ```

   This starts the app **and** a local model server (Ollama), and automatically downloads the default chat model the first time. The download can take a while — you can watch progress in Docker Desktop or in the terminal.

2. **(Optional) Also enable spoken-answer transcription.** If you want to *speak* your interview answers and have them transcribed, start the stack with the speech add-on instead:

   ```bash
   docker compose --profile stt up
   ```

   This additionally starts a local speech-to-text model.

3. **Open the app** in your browser:

   ```
   http://localhost:8080
   ```

4. **Point Career Agent at your local model.** In the app's provider setup, choose the **Local (self-hosted)** provider and use these settings:
   - **Chat base URL:** `http://localhost:11434`
   - **Speech-to-text base URL** (only if you enabled it in step 2): `http://localhost:8081`
   - **Model names:** use the defaults shown unless you changed them.
   - **Max completion tokens:** leave at the default (2048). This is how many tokens the local model may use for its reply. Raise it if you use a *reasoning* model that "thinks" before answering (see [What about DeepSeek?](#what-about-deepseek)) or if answers look cut off; the default suits most models.

   Click **Test connection**. A green "ready" message means you're set.

5. You're ready — continue to [Step 5: Using Career Agent](#step-5--using-career-agent).

### Which local model should I use?

Bigger models are smarter but need more memory and run slower. Pick one that fits your computer. The rule of thumb: you want **a few GB of free memory beyond the model's size**, and a model runs *much* faster if your computer has a dedicated graphics card (GPU) or Apple Silicon (M1/M2/M3/M4) — on an older laptop with no GPU, stick to the smaller models.

To use a model other than the default, set its name when you start the stack. For example:

```bash
OLLAMA_MODEL=llama3.2:3b docker compose up
```

| Your computer | Try this chat model | Command | What to expect |
|---|---|---|---|
| Older / low-spec laptop, ~8 GB RAM, no GPU | `llama3.2:3b` (or `gemma3:4b`) | `OLLAMA_MODEL=llama3.2:3b docker compose up` | Light and quick on modest machines; answers are basic but usable. Great for trying things out. |
| Typical laptop/desktop, ~16 GB RAM (or an 8 GB GPU / M1–M2) | `llama3` (8B — the **default**) or `qwen2.5:7b` | `docker compose up` (default) | Solid all-round quality; the recommended starting point for most people. |
| Gaming PC with a 12–16 GB GPU, or Apple Silicon 16 GB+ | `gemma3:12b` or `qwen2.5:14b` | `OLLAMA_MODEL=qwen2.5:14b docker compose up` | A noticeable step up in quality; comfortable on a good GPU. |
| High-end 24 GB GPU (RTX 3090/4090) or Apple Silicon 32 GB | `qwen2.5:32b` or `gemma3:27b` | `OLLAMA_MODEL=qwen2.5:32b docker compose up` | Near top-tier quality on a single strong card. |
| Workstation, 48 GB+ unified memory or dual 24 GB GPUs | `llama3.3:70b` | `OLLAMA_MODEL=llama3.3:70b docker compose up` | Best quality available locally; runs slower, but fine for back-and-forth use. |

> **Tiny/fastest option:** on a very limited machine, `llama3.2:1b` is the lightest of all (lowest quality, but it runs almost anywhere).
>
> The model you choose **must match the pulled tag exactly, including the version suffix** — type the full name into the app's Local-provider setup (e.g. `deepseek-r1:8b`, **not** `deepseek-r1`). If it doesn't match, the app shows a `model '…' not found` error, because Ollama treats the bare name as `:latest`, which wasn't downloaded. The first run downloads the model (small models are ~1–2 GB; large ones can be 20–40 GB), so allow time and disk space. If a model is slow or your computer runs out of memory, drop to the next smaller one. See the [developer run-modes guide](./developer/run-modes-and-deployment.md#local-model-sizing) for full per-model memory figures.

### What about DeepSeek?

You can use DeepSeek locally too — the **DeepSeek-R1** models (for example `deepseek-r1:8b`, which needs about the same memory as `llama3`). Two things worth knowing:

- **It stays on your computer.** Running it through the local stack means the model runs on your own machine — nothing is sent to DeepSeek's servers.
- **It "thinks out loud."** DeepSeek-R1 is a *reasoning* model: it works through its thinking step by step before giving an answer. Because that thinking consumes part of the reply budget, give it room: keep the **Max completion tokens** setting at the default 2048 or higher. If it's set too low, the model can use up the whole budget thinking and return an empty answer — so if a reasoning model produces nothing, raise that number. Reasoning models are also slower (you may wait a while for each reply, especially without a GPU). With enough budget it works fine; if you prefer faster, tidier responses, `llama3` or `qwen2.5` are good non-reasoning alternatives.

To try it: `OLLAMA_MODEL=deepseek-r1:8b docker compose up` (and set the same name in the app's Local-provider setup).

### Speech-to-text models (only if you record/upload audio answers)

If you started the stack with `--profile stt`, a local Whisper model transcribes your spoken answers. The default is `whisper-1`. To change it, set `LOCALAI_STT_MODEL` when starting:

```bash
LOCALAI_STT_MODEL=whisper-base docker compose --profile stt up
```

| Whisper model | Approx. download | Good for |
|---|---|---|
| `whisper-base` | ~150 MB | Fast, low memory; fine for clear English. |
| `whisper-small` | ~500 MB | Better accuracy, still light. |
| `whisper-medium` | ~1.5 GB | Strong accuracy, incl. other languages. |
| `whisper-large` | ~3 GB | Best accuracy; needs more memory and time. |

Transcription models are far smaller than chat models and run comfortably on most computers.

---

## Step 5 — Using Career Agent

### Welcome page & resume screen

The first time you open Career Agent you see a **Welcome page** — a quick 5-step pipeline overview explaining how the process works, plus a privacy callout reminding you that your data stays on your device.

If you've used the app before, you'll land on a **Resume screen** instead. It shows the state of your last session, any outstanding items, and lets you **Continue** where you left off or **Start fresh**.

### Navigating the app

Career Agent uses a **card-based layout** with two main areas:

- **Sidebar** (left) — contains the **Phase Stepper**, which shows your progress through the pipeline at a glance. Each phase displays "Done" only when its defining artefact is confirmed in your Memory Store (not based on position alone), so the status always reflects what you've actually completed — phases you merely navigated past without confirming won't be marked done. Below the stepper you'll find a **Settings** link and a **Save & Exit** button.
- **Main area** (right) — displays the active phase content. Each phase reveals its sections progressively as you work through it (progressive disclosure), so you're never overwhelmed with options you haven't reached yet.

At the top of the screen a **Save status indicator** tells you whether your progress has been saved ("Progress saved") or if you're running in a temporary session ("Temporary session" — meaning you should export before closing).

When you complete a phase, a phase-specific action button appears (for example, "Save and generate skill map") so you always know how to move forward.

### Settings page

Click **Settings** in the sidebar to access all configuration in one place:

- **Providers** — switch between cloud/local AI, manage API keys, test connections.
- **Language** — choose English or Portuguese.
- **Privacy & Consent** — review the privacy statement and manage your consent preferences.

### The six phases

Career Agent walks you through six steps (it saves your progress automatically, so you can stop and come back any time):

1. **Add your documents** — upload your CV, certificates, or LinkedIn export, or paste text. Everything is read on your computer. You can **preview the converted text** of each document to check it came through correctly; if a file looks garbled, remove it and paste the text instead.
2. **Skill Map** — Career Agent builds a list of your skills, each linked to where it found the evidence. You review and confirm. When AI mode is selected, the AI can extract a rich, ATS-compatible structured profile from your documents — employment positions with companies, locations, role descriptions, quantified achievements, and technologies used; education entries with institutions and skills gained; a professional summary; core competencies (behavioural and leadership qualities inferred from career patterns and achievements, not only literal keywords — e.g. Leadership, Strategic Planning, Cross-functional Collaboration); spoken languages with proficiency levels; hobbies and interests; causes and volunteering; and any additional categories (publications, patents, awards, etc.). Dates are automatically normalized to ISO format and compound skill entries are expanded into individual items (with an allowlist protecting known compounds like CI/CD, TCP/IP, OS/2, L2/L3, and others from incorrect splitting). A fragment-detection pass also reassembles entries that were accidentally split upstream. After extraction, an **AI-powered consolidation pass** (in AI-only or AI-assisted mode) sends the merged data to the model for context-aware deduplication — catching OCR-garbled company names, vendor-qualified skill variants, and semantic duplicates that pattern-based rules cannot reliably detect. A lightweight deterministic safety net then runs as a final catch-all. In script-only mode, the full deterministic consolidation handles deduplication (vendor-prefix collapsing, fuzzy position matching, and synonym resolution). The pipeline also detects containing-term relationships (e.g. "GitHub" vs "GitHub Enterprise"), slash-compound retention, and capitalization variants. Technologies are extracted as standalone atomic items (never vendor-grouped), resulting in a cleaner skill map. Skill `since` dates are derived from the earliest employment evidence where a skill appears, ensuring accurate experience timelines. This structured extraction is presented for your review before it enters the skill map, giving it richer context about where and when each skill was used.
3. **Role Discovery** — get suggested roles that match your skills, with the gaps called out. The AI now also receives your career trajectory context (previous job titles, core competencies, education, and professional summary) to produce more accurate role recommendations calibrated to your seniority and experience arc.
4. **Interview Coaching** — practise STAR answers. You can **type**, **upload an audio file**, or **record yourself** in the browser. The AI checks whether your answer is complete and asks follow-up questions — using only your own words. Practice questions can now probe multiple behaviours simultaneously (e.g. "Leadership and Stakeholder Management"), giving you richer interview preparation.
5. **Output** — generate a tailored CV in Markdown, PDF, and Word, plus advisory LinkedIn suggestions. When AI tailoring is enabled, the model now produces a **complete ATS-formatted Markdown CV draft** (not just 5 advisory bullet suggestions). The draft includes a targeted professional summary, experience with adjusted emphasis, skills ordered by relevance, education, certifications, awards, nationality, and core competencies — all built exclusively from your confirmed evidence. Your name and contact details are included automatically so the AI never resorts to placeholders. You can **toggle between the AI draft and the deterministic version** to compare them side by side — the AI draft is shown as the primary view by default so you can immediately review the AI's work, with a toggle to switch to the deterministic version for comparison. The draft is advisory: you review and confirm it before it replaces the deterministic version. Skills in the output are grouped by category (Technical, Tools, Domain, Leadership, Communication, Core Competency) and sorted by relevance to your target role. Skill durations reflect actual usage windows (time between first use and latest evidence) rather than time since first use, so legacy skills show accurate years. In AI-only mode, clicking "Generate CV" directly calls the AI to produce a tailored draft — no separate step is needed. The advisory **LinkedIn report** suggests a headline (composed from your target role title and top confirmed core competencies), experience bullets, and recommended skills filtered by recency (10-year cutoff) and capped at 50.
6. **Memory & Maintenance** — export or back up your data.

### A note on privacy while you use it

- Whenever Career Agent is about to send anything to a cloud provider, it shows you a **label** saying so first.
- You can **preview the exact text** about to be sent and edit or delete anything you don't want to share before it goes.
- Anything you mark **private** is never sent to a cloud provider.
- With a local model selected, the app tells you it is **fully offline**.

### Transparency and automated decisions

Career Agent surfaces every automated decision it makes about your data, so nothing happens behind your back:

- **Egress log.** Every request sent to your AI provider (cloud or local) and its response are recorded in a log you can browse from the **Memory & Maintenance** screen. This lets you see exactly what was asked and what came back — full transparency of every AI interaction.
- **Prompt preview.** Before anything is sent to a cloud provider you see the exact text and can edit or cancel it. For a local provider the same preview appears as informational only — with a "this stays on your device" label — so you can still inspect what the model receives without any blocking step.
- **Date normalisation.** When a date like "March 2020" is normalised to "2020-03", the review screen shows the original alongside the result so you can verify.
- **Skill splitting.** When a compound entry like "AWS SAM (Python, Lambda)" is expanded into individual skills, the review screen shows what was split and lets you override.
- **Category assignment.** Each skill's assigned category (e.g. "Technical", "Leadership") is shown in the review and you can change it with a dropdown.
- **Merge decisions.** When two similar skill names are merged (e.g. "k8s" → "Kubernetes"), you see the rationale and can reject the merge with one click.
- **Bullet-to-position matching.** In the Output screen, each CV bullet can be expanded to show why it was placed under a particular position — based on skill overlap between your evidence and the position's technologies.
- **Employment deduplication.** Duplicate employment entries (same company, title, and start date) are automatically removed in CV generation, keeping the richest entry. Redundant company names in job titles are cleaned as well.
- **AI-only mode labels.** When you choose the AI-only mode, each phase clearly labels what is happening — for instance, the Skill Map says "Building your skill map from AI-extracted career data" and the Output screen distinguishes between the CV structure (from your confirmed evidence) and AI tailoring suggestions (advisory).

These transparency features work the same way regardless of whether you use a cloud or local AI provider.

### Where your data is saved

- **Chrome / Edge on desktop:** you can pick a real folder on your computer, and Career Agent saves your profile there as readable Markdown files you fully own.
- **Other browsers:** your data is stored inside the browser. Use the **Export** button to save a `.zip` backup, and **Import** to restore it later or move it to another computer.

### Exporting and importing sessions

Career Agent offers two export formats:

- **JSON export** ("Save & Exit" or "Export Memory Store (JSON)" in the Memory phase) — a single `.json` file containing your full session state.
- **Zip export** ("Download session as zip" in the sidebar or Memory phase) — a timestamped `.zip` archive (e.g. `career-agent-2026-07-04.zip`) containing all your files in their original folder structure (`config/`, `profile/`, `interviews/`, `outputs/`, `log/`) so you can browse them with a regular file explorer, plus the JSON snapshot at the root for easy re-import.

To **import a previous session**:

- **From the Welcome Page:** click "Import a previous session", pick your `.zip` or `.json` file. Career Agent restores your data and takes you to the Resume screen. If the file is invalid, you stay on the Welcome page with an error message — nothing is lost.
- **From the Memory phase:** use the file picker next to the "Import a snapshot" label. Both `.zip` and `.json` files are accepted.

---

## Troubleshooting

**The app won't open at `http://localhost:8080`.**
Make sure Docker Desktop is running and the `docker compose up` command is still going in your terminal (the window should stay open). Give it a minute on first launch.

**"port is already allocated" or "address already in use".**
Something else is using port 8080 (or 11434 / 8081). Close the other program, or stop any old Career Agent containers from the Docker Desktop dashboard, then try again.

**The local model is very slow or runs out of memory.**
Local AI needs a capable machine. Try a smaller model (see the [run-modes guide](./developer/run-modes-and-deployment.md)), close other heavy apps, or use the cloud provider path instead.

**"Could not reach the local server" when testing the local provider.**
Confirm you started the stack with `docker compose up` (not just `web`), that the model finished downloading, and that you used the `http://localhost:...` addresses above — not other names.

**My API key is rejected.**
Double-check you copied the whole key, that it hasn't been revoked, and that billing is set up on the provider's website.

**How do I stop everything?**
Press **Ctrl + C** in the terminal, or use the stop buttons in Docker Desktop. Your saved data is not affected.

---

## Frequently asked questions

**Does this cost money?**
The app itself is free and open source (MIT licensed). If you use a **cloud** provider, that provider charges you for usage. If you use a **local** model, there's no per-use cost.

**Is my data really private?**
Your documents never leave your computer. With a cloud provider, only a small redacted snippet is sent when you ask for an AI feature, and you can preview it first. With a local model, nothing leaves your device.

**Do I need to keep the terminal open?**
Yes, while you're using the app. Closing it stops the app (your saved data stays safe). Reopen it any time with the same `docker compose up` command.

**Can I move my profile to another computer?**
Yes — use **Export** to save a `.zip`, copy it over, and **Import** it on the other machine (or just point Chrome/Edge at the same synced folder).
