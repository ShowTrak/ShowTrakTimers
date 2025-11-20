import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{js,cjs,mjs,ts,cts,mts}'],
    coverage: {
      reporter: ['text', 'lcov'],
    },
  },
});
