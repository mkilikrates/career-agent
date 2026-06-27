# ---------------------------------------------------------------------------
# Career Agent — Docker Static Single-Container Run Mode (Requirement 52)
#
# Multi-stage build:
#   * Stage 1 (build): compiles the static bundle with the full Node toolchain.
#   * Stage 2 (runtime): an unprivileged nginx that serves ONLY the built
#     `dist/` output. The runtime image carries no application source code and
#     no build toolchain (no node_modules, no src, no Node runtime).
# ---------------------------------------------------------------------------

# ---- Stage 1: build the static bundle -------------------------------------
# Pinned Node image (current LTS line). Installs deps reproducibly with `npm ci`
# and runs the existing Vite static build (`npm run build`, which uses `base: './'`).
FROM node:24-alpine AS build

WORKDIR /app

# Install dependencies first to leverage Docker layer caching. Only the
# manifest + lockfile are needed, so changes to source don't bust this layer.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the build context (source, config, locales, index.html).
COPY . .

# Produce the static bundle in /app/dist (relative asset paths via base: './').
RUN npm run build

# ---- Stage 2: unprivileged static runtime ---------------------------------
# nginxinc/nginx-unprivileged already runs as a non-root user (UID 101) and
# listens on 8080 by default, reading config from /etc/nginx/conf.d/.
FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime

# SPA static-file serving config (listens on 8080, try_files -> /index.html).
# Replaces the image's default server block; serves static files only.
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# Copy ONLY the built static bundle from the build stage. No source, no
# node_modules, no build toolchain ever lands in the runtime image.
COPY --from=build /app/dist /usr/share/nginx/html

# Non-privileged published port (>= 1024).
EXPOSE 8080
