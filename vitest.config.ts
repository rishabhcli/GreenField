import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Integration tests that need a real service are opt-in via env flags and
    // skip themselves loudly rather than silently passing.
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/dist/**', '**/*.d.ts'],
    },
  },
  resolve: {
    // Run tests against source, not build output, so a stale dist cannot make
    // a broken change look green.
    alias: {
      '@foundry/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@foundry/obs': new URL('./packages/obs/src/index.ts', import.meta.url).pathname,
      '@foundry/providers': new URL('./packages/providers/src/index.ts', import.meta.url).pathname,
      '@foundry/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      '@foundry/queue': new URL('./packages/queue/src/index.ts', import.meta.url).pathname,
      '@foundry/agents': new URL('./packages/agents/src/index.ts', import.meta.url).pathname,
    },
  },
});
