import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** The API and the simulator's approval page live on the server; in development Vite forwards to it. */
const SERVER = process.env['VITE_SERVER_ORIGIN'] ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': SERVER, '/sim': SERVER },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 4000 },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/pages/console/Studio.tsx'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 70, statements: 70, functions: 65, branches: 60 },
    },
  },
});
