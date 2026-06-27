/**
 * Static build-artefact / smoke tests for the container image and Compose stack.
 *
 * These tests do NOT invoke `docker build` or `docker compose up` (no docker
 * daemon is required). Instead they statically parse the repo-root `Dockerfile`,
 * `docker-compose.yml`, `docker/nginx.conf`, and `.dockerignore` source text and
 * assert the required structural properties of the deployment artefacts.
 *
 * Requirements covered: 52.1, 52.2, 52.3, 53.1, 53.2, 53.3, 53.4, 55.4
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// Repo root is two levels up from src/deploy/.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

const dockerfile = read('Dockerfile');
const nginxConf = read('docker/nginx.conf');
const compose = read('docker-compose.yml');
const dockerignore = read('.dockerignore');

// Strip blank lines and comment-only lines so structural assertions ignore the
// (extensive, requirement-referencing) comments in these artefacts.
function nonComment(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

describe('Dockerfile — multi-stage static runtime image', () => {
  const lines = nonComment(dockerfile);

  // R52.1: multi-stage build — a Node build stage AND an nginx runtime stage.
  it('declares a Node build stage and an unprivileged-nginx runtime stage', () => {
    const buildStage = lines.find((l) => /^FROM\s+node:.*\s+AS\s+build$/i.test(l));
    const runtimeStage = lines.find((l) =>
      /^FROM\s+nginxinc\/nginx-unprivileged:.*\s+AS\s+runtime$/i.test(l),
    );
    expect(buildStage).toBeDefined();
    expect(runtimeStage).toBeDefined();
  });

  // R52.2: the runtime image carries ONLY the built dist/ — no source, no
  // node_modules, no build toolchain. We inspect the runtime stage (everything
  // after the runtime FROM) in isolation.
  it('runtime stage copies ONLY dist/ and no source/toolchain', () => {
    const runtimeStart = lines.findIndex((l) =>
      /^FROM\s+nginxinc\/nginx-unprivileged:.*\s+AS\s+runtime$/i.test(l),
    );
    expect(runtimeStart).toBeGreaterThanOrEqual(0);
    const runtimeLines = lines.slice(runtimeStart);

    // The only build-stage artefact copied in is the compiled dist bundle.
    const distCopy = runtimeLines.find((l) =>
      /^COPY\s+--from=build\s+\/app\/dist\s+\/usr\/share\/nginx\/html$/i.test(l),
    );
    expect(distCopy).toBeDefined();

    // No bulk source copy and no node_modules / src copied into the runtime.
    for (const l of runtimeLines) {
      expect(l).not.toMatch(/^COPY\s+\.\s+\./i); // no `COPY . .`
      expect(l).not.toMatch(/node_modules/i);
      expect(l).not.toMatch(/--from=build\s+\/app\/src/i);
    }

    // The runtime base is the unprivileged nginx image, never a node image.
    const runtimeFrom = runtimeLines[0];
    expect(runtimeFrom).toMatch(/nginxinc\/nginx-unprivileged/i);
    expect(runtimeFrom).not.toMatch(/FROM\s+node/i);
  });

  // R52.3: unprivileged runtime (non-root UID 101) on a port >= 1024.
  it('uses the unprivileged nginx base and EXPOSEs a non-privileged port (>= 1024)', () => {
    expect(dockerfile).toMatch(/nginxinc\/nginx-unprivileged/i);

    const exposeLine = lines.find((l) => /^EXPOSE\s+\d+/i.test(l));
    expect(exposeLine).toBeDefined();
    const port = Number(exposeLine!.match(/^EXPOSE\s+(\d+)/i)![1]);
    expect(port).toBe(8080);
    expect(port).toBeGreaterThanOrEqual(1024);
  });
});

describe('nginx.conf — static-only SPA serving', () => {
  const lines = nonComment(nginxConf);
  const joined = lines.join('\n');

  // R52.3: listens on non-privileged 8080, serves index.html via try_files.
  it('listens on 8080 and serves index.html via try_files SPA fallback', () => {
    expect(lines.some((l) => /^listen\s+8080;/.test(l))).toBe(true);
    expect(lines.some((l) => /^index\s+index\.html;/.test(l))).toBe(true);
    expect(joined).toMatch(/try_files\s+[^;]*\/index\.html;/);
  });

  // R52.3: static files ONLY — no server-side application processing.
  it('has no server-side application processing (no proxy/fastcgi/upstream)', () => {
    expect(joined).not.toMatch(/proxy_pass/i);
    expect(joined).not.toMatch(/fastcgi_pass/i);
    expect(joined).not.toMatch(/\bupstream\b/i);
  });
});

describe('.dockerignore — keeps source/toolchain out of the build context', () => {
  const entries = nonComment(dockerignore);

  // Defensive (R52.2): confirms no source/deps/output leak into image layers.
  it('excludes node_modules, build output, and test files', () => {
    expect(entries).toContain('node_modules');
    expect(entries).toContain('dist');
    expect(entries.some((e) => /\*\*\/\*\.test\.ts$/.test(e))).toBe(true);
  });
});

describe('docker-compose.yml — default services, profiles, and model-only volumes', () => {
  const lines = nonComment(compose);

  /**
   * Tiny structural reader for the well-formed, 2-space-indented Compose file.
   * Returns the block of lines (with relative indentation preserved) belonging
   * to a given `services:` child, i.e. everything indented under `  <name>:`.
   */
  function serviceBlock(name: string): string[] {
    const header = `${name}:`;
    const startIdx = lines.findIndex((l) => l === header);
    if (startIdx < 0) return [];
    const block: string[] = [];
    // Re-scan the raw source to respect indentation (nonComment trims it away).
    const rawLines = compose.split('\n');
    const rawStart = rawLines.findIndex((l) => l.trim() === header && /^\s{2}\S/.test(l));
    if (rawStart < 0) return [];
    for (let i = rawStart + 1; i < rawLines.length; i++) {
      const raw = rawLines[i];
      if (raw.trim() === '') continue;
      if (raw.trim().startsWith('#')) continue;
      // A new top-level service starts at exactly 2-space indent and ends block.
      if (/^\s{2}\S/.test(raw) && !/^\s{4,}/.test(raw)) break;
      // A new top-level key (e.g. `volumes:`) at column 0 ends the block.
      if (/^\S/.test(raw)) break;
      block.push(raw);
    }
    return block;
  }

  const web = serviceBlock('web');
  const ollama = serviceBlock('ollama');
  const localai = serviceBlock('localai');

  // R53.1: web service builds from the Dockerfile and has no profile gate, so
  // it starts by default on a plain `docker compose up`.
  it('web builds from the Dockerfile and starts by default (no profile)', () => {
    expect(web.length).toBeGreaterThan(0);
    expect(web.some((l) => /^\s+build:\s*\.?\s*$/.test(l))).toBe(true);
    expect(web.some((l) => /profiles\s*:/.test(l))).toBe(false);
  });

  // R53.1: ollama (chat Local Model Server) has no profile, starts by default.
  it('ollama (chat server) starts by default (no profile)', () => {
    expect(ollama.length).toBeGreaterThan(0);
    expect(ollama.some((l) => /^\s+image:\s+ollama\/ollama/.test(l))).toBe(true);
    expect(ollama.some((l) => /profiles\s*:/.test(l))).toBe(false);
  });

  // R53.2 / R53.3: localai (STT Local Model Server) is gated behind the "stt"
  // profile, so it starts ONLY with `--profile stt`, not on a plain up.
  it('localai (STT server) is gated behind the "stt" profile', () => {
    expect(localai.length).toBeGreaterThan(0);
    expect(localai.some((l) => /^\s+image:\s+localai\/localai/.test(l))).toBe(true);
    const profileLine = localai.find((l) => /profiles\s*:/.test(l));
    expect(profileLine).toBeDefined();
    expect(profileLine).toMatch(/\[\s*["']?stt["']?\s*\]/);
  });

  // R53.4 / R55.4: top-level volumes are model-only named volumes; each model
  // server mounts a named volume to a model path; NO host bind mount and NO
  // Memory Store volume exist anywhere in the file.
  it('declares only model-only named volumes (no host bind, no Memory Store)', () => {
    // Top-level named volumes are exactly the two model caches.
    const volumesIdx = compose
      .split('\n')
      .findIndex((l) => /^volumes:\s*$/.test(l));
    expect(volumesIdx).toBeGreaterThanOrEqual(0);
    const topVolumes = compose
      .split('\n')
      .slice(volumesIdx + 1)
      .filter((l) => /^\s{2}\S/.test(l))
      .map((l) => l.trim().replace(/:$/, ''));
    expect(topVolumes).toContain('ollama_models');
    expect(topVolumes).toContain('localai_models');

    // Each model server mounts its named volume to a model directory.
    expect(ollama.some((l) => /^\s*-\s*ollama_models:\/root\/\.ollama\s*$/.test(l))).toBe(true);
    expect(localai.some((l) => /^\s*-\s*localai_models:\/models\s*$/.test(l))).toBe(true);

    // web declares no volumes at all (browser-owned Memory Store, R55.4).
    expect(web.some((l) => /^\s+volumes:\s*$/.test(l))).toBe(false);

    // No host bind mount anywhere: a bind mount has a "/host/path:" or
    // "./relative:" source on the left of the colon in a `- src:dest` entry.
    const mountLines = lines.filter((l) => /^-\s+\S+:\S+/.test(l));
    for (const m of mountLines) {
      const source = m.replace(/^-\s+/, '').split(':')[0];
      expect(source.startsWith('./')).toBe(false);
      expect(source.startsWith('/')).toBe(false);
      expect(source.startsWith('~')).toBe(false);
    }

    // No Memory Store volume by name anywhere in the file.
    expect(compose).not.toMatch(/memory[_-]?store/i);
  });
});
