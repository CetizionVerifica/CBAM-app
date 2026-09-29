/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The API port comes from the repo-root .env (PORT), so both dev servers agree.
const rootEnv = loadEnv('development', fileURLToPath(new URL('../..', import.meta.url)), '');
const api = `http://localhost:${rootEnv.PORT || 4000}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    // Same-origin API in dev: session cookies work without CORS.
    proxy: { '/api': api, '/health': api },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
