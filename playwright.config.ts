import { defineConfig } from '@playwright/test'

/**
 * Chromium only. Extensions load in a persistent context with a head, so these
 * run headed under xvfb in CI.
 *
 * Firefox is not absent — it simply cannot be driven from here: Playwright has
 * no way to install an extension into it. That side runs through geckodriver
 * in `tools/firefox-e2e.mjs` (`pnpm test:e2e:firefox`), which is how Mozilla
 * supports unpacked builds.
 */
export default defineConfig({
  testDir: 'e2e',
  // Firefox through geckodriver, with its own config: playwright.gecko.config.ts (B-231).
  testIgnore: ['gecko/**'],
  /**
   * Longer than the two waits a single test can stack.
   *
   * It was 30 s — the same number as the extension's own `RPC_TIMEOUT_MS`, so
   * Playwright killed the test at the instant the product's deadline expired and
   * neither side got to report anything. A test can spend `WORKER_REGISTER_MS`
   * waiting for the worker and then `SURFACE_MOUNT_MS` waiting for the surface;
   * this is above their sum, so whichever of them runs out fails with its own
   * sentence instead of as a timeout with none.
   */
  timeout: 75_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
})
