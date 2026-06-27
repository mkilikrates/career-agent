/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Local-first static bundle: relative asset paths (`base: './'`) so the build
// opens from `file://` or any static host with NO backend server (Requirement 1.1).
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      // Framework-agnostic domain logic. MUST NOT import any provider/storage/
      // network client directly (the adapters are the swappable boundary).
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      // Thin, swappable boundaries (storage / provider / pii / crypto vault).
      '@adapters': fileURLToPath(new URL('./src/adapters', import.meta.url)),
      // React shell.
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
