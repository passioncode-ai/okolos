import { defineConfig } from '@playwright/test'

/**
 * Firefox scenarios that need the extension's own pages (B-231): Firefox is driven through
 * geckodriver from `e2e/gecko/firefox.ts`, not by Playwright, so no browser is configured here.
 * Playwright runs these files for its TypeScript loader, `expect.poll` and its reporting.
 * `playwright.config.ts` leaves this folder to this file.
 */
export default defineConfig({
  testDir: 'e2e/gecko',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
})
