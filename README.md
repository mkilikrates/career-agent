# Career Agent

> Read this in: **English** · [Português (Brasil)](./README.pt-BR.md)

A **local-first browser web app** that builds an evidence-backed professional profile, coaches STAR interview answers, and generates ATS-safe job application materials (Markdown, PDF, DOCX).

The defining promise is **trust**: your files never leave your device, and every claim in every generated output is traceable to a source citation or an explicit confirmation you made (the **No-Fabrication Rule**). The only network traffic is user-initiated, **Bring-Your-Own-Key (BYOK)** calls to the LLM / speech-to-text provider you choose — and only a minimal, PII-redacted payload is ever sent. With a local model provider selected, the app is **fully offline**.

There is **no backend server**. All parsing, skill mapping, typesetting, and persistence run on your device in TypeScript + WebAssembly.

---

## Documentation

The docs are split by who you are. Start here:

### 📘 I just want to use it — [User Guide](./docs/en/user-guide.md)
A non-technical, step-by-step walkthrough: install Docker Desktop (Windows or macOS), run Career Agent on your own machine, and connect it to either a cloud AI provider (with your own key) or a fully local model — no terminal expertise required.

### 🛠️ I want to understand or contribute to the code — Developer Docs
- [Architecture & trust model](./docs/en/developer/architecture.md) — how it works, the Egress Gate, the six-phase pipeline, the No-Fabrication Rule.
- [Project structure](./docs/en/developer/project-structure.md) — the `@core` / `@adapters` / `@ui` layout and the key modules and files.
- [Building & testing](./docs/en/developer/building-and-testing.md) — build from source, the npm scripts, and the unit / property / No-Fabrication test suites.
- [Run Modes & deployment](./docs/en/developer/run-modes-and-deployment.md) — the three ways to run it (source, single container, full local stack) plus networking and CORS.
- [How to contribute](./CONTRIBUTING.md) · [Security policy](./SECURITY.md)

---

## At a glance

- **Local-first, no backend** — a static bundle that runs entirely in your browser.
- **Bring Your Own Key** — works with OpenAI or Anthropic using *your* key, or a keyless local model server (Ollama, LocalAI, LM Studio, llama.cpp, vLLM).
- **Trust by construction** — a single Egress Gate is the only path to any provider; it labels the call, screens for PII/secrets, and sends only a minimised, redacted payload. Nothing is ever fabricated into your outputs without a traceable source.
- **You own your data** — the Memory Store is human-readable Markdown, written to a local folder (Chromium desktop) or exportable as a `.zip` (other browsers).
- **ATS-safe outputs** — Markdown, single-column selectable-text PDF (typeset locally via Typst/WebAssembly), and structured DOCX.

## License

Licensed under the **MIT License** — see [`LICENSE`](./LICENSE). You may use, modify, and distribute this software (including commercially); the one condition is that the copyright and permission notice are retained. Copyright (c) 2026 mkilikrates (https://kilikrates.io/).
