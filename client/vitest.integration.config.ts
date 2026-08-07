import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Separate config on purpose: these tests need a real API + Postgres
// running (see src/e2e/*.integration.test.ts's header comment) and are
// never part of the default `npm test`, which should pass with nothing
// else running at all.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/e2e/**/*.integration.test.ts'],
    testTimeout: 20000,
  },
});
