import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@next_term/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@next_term/web': path.resolve(__dirname, 'packages/web/src/index.ts'),
    },
  },
});
