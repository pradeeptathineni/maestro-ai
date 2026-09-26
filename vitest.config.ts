import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx'],
    exclude: ['**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
  },
});
