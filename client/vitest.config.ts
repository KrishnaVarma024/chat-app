import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // Integration tests hit a real running API + Postgres (see
    // src/e2e/*.integration.test.ts) — excluded from the default `test`
    // run (which should work with no backend at all) and run explicitly
    // via `npm run test:integration`, same convention as the .mjs scripts
    // in server/scripts/.
    exclude: ['**/node_modules/**', 'src/e2e/**'],
  },
});
