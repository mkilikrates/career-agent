# Run Modes & Deployment

> Read this in: **English** · [Português](../../pt-BR/developer/run-modes-and-deployment.md) · [← Back to the README](../../../README.md) · Developer docs: [Architecture](./architecture.md) · [Project structure](./project-structure.md) · [Building & testing](./building-and-testing.md) · **Run Modes & deployment**

Career Agent runs the same browser app three ways. In **every** mode it is a static bundle running in the browser — there is **no application backend**, and the Memory Store always stays in the browser. The packaging layer only changes *how the static assets are served*; it never introduces a data or application backend, and the egress boundary (single Egress Gate, same permitted destinations) is identical across all three.

> This is the operator-facing reference. For the friendly, click-by-click version (install Docker Desktop, etc.), point non-technical users at the [User Guide](../user-guide.md).

## 1. Local source build

Run from source with the Node toolchain (see [Building & testing](./building-and-testing.md)):

```bash
npm install
npm run dev        # Vite dev server, e.g. http://localhost:5173

# or build and serve the static bundle:
npm run build      # outputs the self-contained dist/
npm run preview    # serve dist/ to verify
```

The served origin is whatever Vite prints (commonly `http://localhost:5173`). Right for development and for hosting `dist/` on any static host.

## 2. Docker static single container

A single, minimal container that serves the static bundle. The root `Dockerfile` is multi-stage: a Node stage runs `npm ci` + `npm run build`, then the runtime stage is `nginxinc/nginx-unprivileged` serving **only** the built `dist/` on port **8080** as a **non-root** user (UID 101). The runtime image contains no application source, no `node_modules`, and no Node runtime — just the static bundle and the SPA `try_files` config in `docker/nginx.conf`.

```bash
docker build -t career-agent .
docker run -p 8080:8080 career-agent
```

Open `http://localhost:8080`. This container is **static only** — no backend, no data, no model server. To use any LLM/STT feature, point the app at a cloud BYOK provider or your own local provider.

### Using the prebuilt published image

A multi-arch image (`linux/amd64` + `linux/arm64`) is published automatically to the **GitHub Container Registry** by the [`docker-publish.yml`](../../../.github/workflows/docker-publish.yml) workflow, so you can run it without building locally:

```bash
# newest build from the default branch
docker run -p 8080:8080 ghcr.io/<owner>/<repo>:latest

# a pinned release version
docker run -p 8080:8080 ghcr.io/<owner>/<repo>:1.2.3
```

Replace `<owner>/<repo>` with the actual repository path. Available tags:

| Tag | Published when | Use for |
|---|---|---|
| `latest` | every push to `main` | the newest build (rolling) |
| `sha-<commit>` | every push to `main` | pinning an exact commit |
| `X.Y.Z`, `X.Y`, `X` | pushing a git tag `vX.Y.Z` | pinned, immutable releases |

### Release flow (cutting a new version)

The CI publishes a fresh image on **every push to `main`** (as `latest`) and a versioned image on a **semver git tag**. To cut a release:

1. Update the spec, prompts, and docs (all languages) per [`AGENTS.md`](../../../AGENTS.md), and bump `version` in `package.json` (and `CHANGELOG.md` if present).
2. Commit, then create and push a tag: `git tag v1.2.3 && git push origin v1.2.3`.
3. The workflow runs typecheck + tests, then builds and pushes the `1.2.3` / `1.2` / `1` image tags. Tests gate the publish — a failing suite blocks the image.
4. On a version tag, the workflow also **creates a GitHub Release** for `vX.Y.Z` with auto-generated notes (from merged PRs/commits) plus the `docker run` pull command for that version.

> **First publish:** a new ghcr package may default to **private**. After the first successful run, open the package on GitHub → **Package settings** and set visibility to **Public** if you want anyone to pull it. The workflow needs `packages: write` permission, which is granted inline in the workflow.

### Keeping registry storage in check

ghcr storage counts against your account quota, and a `sha-<commit>` tag on every `main` push (plus multi-arch manifests) accumulates over time. The [`cleanup-packages.yml`](../../../.github/workflows/cleanup-packages.yml) workflow runs **weekly** (and on demand via *Run workflow*) to reclaim space:

- **Untagged images** older than a week are deleted automatically using the built-in token. This never removes a `latest`, `sha-*`, or release (`X.Y.Z`) tag, and multi-arch children of retained tags are protected automatically.
- **Optional — cap the `sha-` tags:** add a classic Personal Access Token with the `packages:delete` scope as a repository secret named `GHCR_CLEANUP_TOKEN`. When present, the workflow also prunes old `sha-*` tags (keeping the 10 newest), leaving `latest` and every release tag untouched. Without the secret, this step is skipped.

Run it manually first with **dry run** enabled to preview what would be deleted. Deleted versions have a 30-day restore window on GitHub.

## 3. Docker Compose full local stack

The root `docker-compose.yml` brings up the app alongside keyless, fully local model servers:

```bash
docker compose up                 # starts web + ollama (chat)
docker compose --profile stt up   # additionally starts the LocalAI/whisper STT service
```

| Service | Started | Browser reaches it at | Purpose |
|---|---|---|---|
| `web` | always | `http://localhost:8080` | the static app (built from the `Dockerfile`) |
| `ollama` | always | `http://localhost:11434` | keyless OpenAI-compatible **chat** server |
| `ollama-pull` | always (runs once, then exits) | — | downloads the chat model into Ollama, then stops |
| `localai` | only with `--profile stt` | `http://localhost:8081` | OpenAI-compatible **speech-to-text** (Whisper) server |
| `localai-pull` | only with `--profile stt` (runs once, then exits) | — | downloads the Whisper STT model, then stops |

Configure the **Local provider** in the app with the host-published localhost base URLs — chat `http://localhost:11434`, STT `http://localhost:8081`.

### Pulling / changing models

The `ollama` image ships **no models**, so the short-lived `ollama-pull` service waits for the server to be healthy, pulls the chat model, and exits. The download lands in the `ollama_models` volume, so it happens only once. The default is **`llama3`** (matching the app's default Local-provider chat model). Override it:

```bash
OLLAMA_MODEL=llama3.2:3b docker compose up
```

…or edit the `${OLLAMA_MODEL:-llama3}` line in `docker-compose.yml`. Whatever you pull **must match** the chat-model name you enter in the app's Local-provider setup. Watch progress with `docker compose logs -f ollama-pull`.

Speech-to-text models work the same way under `--profile stt`: `localai-pull` installs the Whisper model into `localai_models` before the STT server starts. Default **`whisper-1`**; override with `LOCALAI_STT_MODEL` or by editing `docker-compose.yml`.

### Local model sizing

Approximate memory footprints for common Ollama chat models at **Q4_K_M** (Ollama's default quantization). "Min memory to run" is the model file size plus ~1–1.5 GB overhead (KV cache at a short ~2K context); longer contexts add more (roughly +0.5 GB per 2K tokens for a 7–8B model, more for larger). Models run fastest **fully in GPU VRAM or Apple-Silicon unified memory**; if they spill to system RAM (CPU inference) expect them to still work but generate several times slower.

| Model (`ollama` tag) | Params | Q4_K_M size | Min memory to run | Fits comfortably on | Notes for Career Agent |
|---|---|---|---|---|---|
| `llama3.2:1b` | 1.2B | ~0.8 GB | ~2 GB | almost anything | Fastest/lightest; lowest quality. Good for smoke-testing the local path. |
| `llama3.2:3b` | 3.2B | ~1.9 GB | ~3 GB | 8 GB RAM, no GPU | Usable on modest CPU-only machines. |
| `gemma3:4b` | 3.9B | ~2.5 GB | ~3.5 GB | 8 GB RAM / 4 GB GPU | Strong for its size. |
| `phi4-mini` | 3.8B | ~2.3 GB | ~3.5 GB | 8 GB RAM / 4 GB GPU | Best tiny reasoner; good at structured tasks. |
| `qwen2.5:7b` | 7.6B | ~4.4 GB | ~5.5 GB | 8 GB GPU / 16 GB RAM | Strong instruction following. |
| `llama3` (8B) | 8.0B | ~4.9 GB | ~6 GB | 8 GB GPU / 16 GB RAM | **App default.** Best all-round starting point. |
| `qwen3:8b` | 8.2B | ~5.0 GB | ~6.5 GB | 8 GB GPU / 16 GB RAM | Newer; hybrid think/no-think, native tool-calling. |
| `gemma3:12b` | 12.2B | ~7.3 GB | ~8.5 GB | 12 GB GPU | Excellent instruction following for its size. |
| `qwen2.5:14b` | 14.8B | ~8.7 GB | ~10 GB | 12–16 GB GPU | Big quality jump over 7–8B. |
| `phi4` | 14.0B | ~8.2 GB | ~9.5 GB | 12 GB GPU | Strong reasoning/analysis. |
| `gemma3:27b` | 27.2B | ~15.9 GB | ~17 GB | 24 GB GPU (16 GB tight) / 32 GB Apple Silicon | Near-70B quality. |
| `qwen2.5:32b` | 32.5B | ~18.8 GB | ~20 GB | 24 GB GPU | Sweet spot for a single high-end consumer GPU. |
| `llama3.3:70b` | 70.6B | ~40 GB | ~42 GB | 48 GB+ unified / dual 24 GB GPUs | Top-tier local quality; ~12 tok/s on an M4 Max. Does not fit a single 24 GB GPU. |

#### DeepSeek-R1 (reasoning models)

DeepSeek's locally-runnable models in Ollama are the **R1 distills**, which are distilled into Qwen/Llama architectures — so each one's memory footprint **equals its base model** in the table above:

| Model (`ollama` tag) | Distilled from | Q4_K_M size | Min memory to run |
|---|---|---|---|
| `deepseek-r1:1.5b` | Qwen 2.5 1.5B | ~1.0 GB | ~2 GB |
| `deepseek-r1:7b` | Qwen 2.5 7B | ~4.4 GB | ~5.5 GB |
| `deepseek-r1:8b` | Llama 3.1 8B | ~4.9 GB | ~6 GB |
| `deepseek-r1:14b` | Qwen 2.5 14B | ~8.7 GB | ~10 GB |
| `deepseek-r1:32b` | Qwen 2.5 32B | ~18.8 GB | ~20 GB |
| `deepseek-r1:70b` | Llama 3.3 70B | ~40 GB | ~42 GB |

**Two things to know before choosing R1 for Career Agent:**

- **It runs fully locally.** Pulled through Ollama, the weights execute on your machine; nothing is sent to DeepSeek's servers. (Career Agent does not wire up DeepSeek's *cloud* API — keyed cloud providers are OpenAI and Anthropic only.)
- **It is a reasoning model, and that fights our strict-output steps.** R1 emits a chain-of-thought (often wrapped in `<think>…</think>`) plus extra "thinking" tokens before its answer. Several Career Agent flows parse **exact, structured replies** — the adaptive STAR coaching loop (`SITUATION/TASK/ACTION/RESULT: covered|missing`, `ENOUGH: yes|no`, `FOLLOWUP: …`), competency-tagged questions (`<competency> :: <question>`), and skill-name parsing. A verbose reasoning preamble can be mis-parsed (e.g. reasoning text picked up as "skills," or a follow-up line missed). Mitigations: use a recent Ollama build that strips or separates thinking tokens, and budget more output tokens. For the structured coaching/discovery steps, a plain **instruct** model (`llama3`, `qwen2.5`) is the safer default; R1 is best treated as experimental here.

Speech-to-text (LocalAI / Whisper, only under `--profile stt`):

| Model (`LOCALAI_STT_MODEL`) | Approx. size | Notes |
|---|---|---|
| `whisper-base` | ~150 MB | Fast, low memory; fine for clear English. |
| `whisper-small` | ~500 MB | Better accuracy, still light. |
| `whisper-medium` | ~1.5 GB | Strong multilingual accuracy. |
| `whisper-large` | ~3 GB | Best accuracy; more memory/time. |

Sizing tips:
- **Estimate any model:** `FP16 ≈ params(B) × 2 GB`; `Q4_K_M ≈ FP16 × ~0.3`; min memory ≈ Q4_K_M size + ~1 GB.
- **Long contexts cost memory.** Career Agent's AI-assist sends chunked corpora; if you hit out-of-memory on a model that "should fit," lower the context (`num_ctx`) or set `OLLAMA_KV_CACHE_TYPE=q8_0` to roughly halve the KV cache.
- **When in doubt, size down.** A smaller model at a comfortable context beats a larger one that constantly spills to CPU.
- Always verify the exact tag and current size against the [official Ollama library](https://ollama.com/library) before pulling — the lineup and quant sizes change frequently.

> Footprint figures above are approximate Q4_K_M values compiled from the [Ollama library](https://ollama.com/library) and public hardware references (e.g. Local AI Master's [Ollama RAM/VRAM table](https://localaimaster.com/blog/ollama-model-ram-vram-table), 2026); they were rephrased and reformatted for this guide and will drift as models are updated.

## Networking & CORS

These matter whenever the browser talks to a model server or a cloud provider.

### Use host-published ports, not Compose service names

In the Compose stack the **browser runs on the host**, outside the Compose network. It can only reach a model server via that server's **host-published port** (a `localhost` address). A Compose internal service name resolves only container-to-container and is unreachable from the browser — so the app **rejects** such a base URL with guidance to use a host-published address.

```
✅  http://localhost:11434   (chat)        ✅  http://localhost:8081   (STT)
❌  http://ollama:11434       (rejected)    ❌  http://localai:8080      (rejected)
```

### Allowed origins (the served origin must be allowed)

When the app calls a local model server cross-origin, the server must allow the app's **exact** origin (scheme + host + port). The Compose file wires this up:

- **Ollama** — `OLLAMA_ORIGINS=http://localhost:8080`
- **LocalAI** — `CORS=true`, `CORS_ALLOW_ORIGINS=http://localhost:8080`

The origin must match wherever the app is served: `http://localhost:5173` in local source dev, `http://localhost:8080` in the container/Compose modes. If a request is rejected for origin reasons, the app surfaces an allowed-origins hint and preserves your provider configuration.

For a **user-run** local provider outside Compose (e.g. Ollama installed natively), set the same env yourself before starting the server, e.g. `OLLAMA_ORIGINS="http://localhost:5173" ollama serve`.

### Cloud provider CORS

Provider calls are cross-origin from the browser. OpenAI permits direct browser CORS. **Anthropic requires the `anthropic-dangerous-direct-browser-access: true` header**, which the provider HTTP client sets. Calling a provider from the browser exposes *your own* key to that page's JS — acceptable in a local-first BYOK app, but run Career Agent only from sources you trust.

### Hosting headers

No special headers are required for the current dependency set. The bundled Typst PDF typesetter runs single-threaded, so **no** `SharedArrayBuffer` / cross-origin isolation is needed. The ~20 MB Typst compiler `.wasm` is bundled as a local asset and loaded lazily on first use — never from a CDN — preserving the local-first guarantee.

## The Memory Store is browser-owned in every mode

Whether you run from source, the static container, or the full Compose stack, the user's career data lives in their browser — written by the File System Access tier (Chromium desktop) or the Fallback tier (OPFS/IndexedDB + `.zip`). **No** container or server stores it. There is deliberately **no Memory Store volume or host bind mount** anywhere in the stack; the Compose named volumes (`ollama_models`, `localai_models`) hold **only** downloaded model files so they survive restarts.

## Recommended browsers

For the full experience — including the File System Access tier that writes to a real local folder with no manual export/import — use a **Chromium-based desktop browser (Chrome, Edge)**. Other desktop browsers and all mobile browsers use the **Fallback tier** (OPFS/IndexedDB) with one-click `.zip` export/import so data stays portable.

## Verification (deployment)

These are packaging/config concerns, verified by smoke/integration tests rather than property tests: the runtime image contains `dist/` only (no source/toolchain), nginx runs as non-root on a port ≥ 1024, the root path returns `index.html` with no app processing, `docker compose up` starts `web` + `ollama` by default and `localai` only with `--profile stt`, and the declared volumes are model-only with no Memory Store mount. The cross-mode egress boundary reuses the existing egress-boundary correctness property.
