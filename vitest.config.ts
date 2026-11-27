import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // pdf.js parsing in tests/pdf.test.ts can take a few seconds on slow CI machines.
    testTimeout: 20_000,
  },
});
