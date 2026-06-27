# Security Policy

Career Agent is built around a strong privacy and trust model. This document explains the security guarantees the project makes, and how to report a problem responsibly.

## Reporting a vulnerability

**Please do not report security issues in public GitHub issues.**

Instead, report privately using GitHub's **[Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)** (the "Report a vulnerability" button under the repository's **Security** tab). If that is unavailable, contact the maintainer through their GitHub profile.

When reporting, please include:
- a description of the issue and its impact,
- steps to reproduce (with **placeholder** data — never real CVs, keys, or personal information),
- the affected version/commit and your browser/OS.

Please give a reasonable window for a fix before any public disclosure.

## What counts as a security issue

Because the product promise *is* the security model, the following are treated as security issues:

- **Egress boundary bypass** — any path that sends data to a provider **without** going through the single Egress Gate, or that transmits more than the minimised, PII-screened payload.
- **PII / secret leakage** — detected high-risk values (SSN, NINO, credit-card numbers, API keys/tokens) reaching a provider or appearing in generated output.
- **API key exposure** — a stored provider key being written to the Memory Store, logged, or sent anywhere other than its owning provider.
- **Memory Store exfiltration** — any code path that transmits the user's career files off the device, or that lets a container/server in any Run Mode receive or persist them.
- **Fabrication** — generated output containing a factual claim that does not resolve to a source citation or explicit user confirmation (a No-Fabrication violation).
- Standard web vulnerabilities (XSS, injection, etc.) in the app or its build/serving configuration.

## The trust guarantees

These are the invariants the codebase is designed to uphold (see the [Architecture doc](./docs/en/developer/architecture.md) for detail):

- **No backend.** All processing runs in your browser; there is no application server that receives your data.
- **Single egress chokepoint.** Every outbound provider request flows through the Egress Gate, which labels the operation, runs local PII/secret pre-screening, and sends only a minimised, redacted payload — to your chosen provider and nowhere else.
- **Bring Your Own Key.** No shared or built-in API key ships with the app. Your key is validated, encrypted at rest (AES-GCM via the Web Crypto API) in browser-local storage, decrypted just-in-time, transmitted only to the provider it belongs to, and **never** written into your Memory Store.
- **Local-first storage.** The Memory Store is human-readable Markdown owned by your browser (File System Access folder, or OPFS/IndexedDB with `.zip` export). No container or server stores it in any Run Mode.
- **Fully offline option.** With only local model providers selected, no payload leaves your device at all.

## Scope and limitations

- **Your own key, in your own browser.** In a local-first BYOK app, your provider key is used by client-side JavaScript on the page you are running. This is acceptable because it is *your* key on *your* device, but it does mean you should run Career Agent only from sources you trust.
- **Third-party providers.** Once a redacted payload reaches the cloud provider you chose, it is governed by *that provider's* policies. Career Agent sets a no-training signal where the provider supports it, but cannot control the provider's own handling.
- **Dependencies.** Vulnerabilities in third-party libraries should be reported here if they affect Career Agent; upstream issues may be forwarded to the relevant project.
