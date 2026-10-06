import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tools/**/*.test.ts'],
    // e2e belongs to Playwright; vitest must not try to run those specs.
    exclude: ['e2e/**', '**/node_modules/**', '**/dist/**'],
    // Per-file environments are set with a docblock:
    //   /** @vitest-environment happy-dom */
    environment: 'node',
    // Many gates spawn `node` and `git` as child processes. They take 1–2 s on an
    // idle machine and 6–10 s at a load average of 470 (measured 2026-10-06), so the
    // 5 s default failed correct tests and blocked the pre-push gate. A real defect
    // fails an assertion, not the clock; 30 s still catches a test that hangs.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
})
