import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tools/**/*.test.ts'],
    // e2e belongs to Playwright; vitest must not try to run those specs.
    exclude: [
      'e2e/**',
      '**/node_modules/**',
      '**/dist/**',
      // Okolos Agent Б1 runs on macOS only (ADR-0020): its store and journal rely on POSIX
      // modes and fsync, CDP on a POSIX process group, the installer on launchd. Windows is
      // its own phase (B-171); until then these suites do not run there.
      ...(process.platform === 'win32'
        ? ['apps/agent/**', 'packages/cdp-pipe/**', 'tools/install-agent.test.ts', 'tools/build-agent.test.ts']
        : []),
    ],
    // Per-file environments are set with a docblock:
    //   /** @vitest-environment happy-dom */
    environment: 'node',
    // Many gates spawn `node` and `git` as child processes. They take 1–2 s on an
    // idle machine and 6–10 s at a load average of 470 (measured 2026-10-06), so the
    // 5 s default failed correct tests and blocked the pre-push gate. A real defect
    // fails an assertion, not the clock; 30 s still catches a test that hangs.
    testTimeout: 30_000,
    // The pre-push hook's GIT_DIR must not reach a test's git child (B-160): see the file.
    setupFiles: ['tools/vitest-git-env.ts'],
    // One temporary folder per run, removed at its end, so tests cannot fill the disk (B-179).
    globalSetup: ['tools/vitest-tmp.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
})
