/**
 * `chrome` inside `page.evaluate` runs in the extension page, not in Node.
 *
 * Declared here rather than imported: pulling the full WebExtension types into
 * the e2e project would drag DOM lib conflicts in with them, and the specs use
 * exactly the calls declared below.
 */
declare const chrome: {
  runtime: { sendMessage(message: unknown): Promise<unknown> }
  /** Asked for readiness: a message resolving is not a rule being installed. */
  declarativeNetRequest: {
    // `condition` is declared because a test that only counts rules cannot
    // tell the rule it seeded from the four the published feed installs —
    // which is exactly how the SCN-007 flake stayed hidden.
    getDynamicRules(): Promise<
      Array<{ id: number; condition: { urlFilter?: string } }>
    >
    updateDynamicRules(update: {
      removeRuleIds?: number[]
      addRules?: unknown[]
    }): Promise<void>
  }
  /**
   * The catalogue, asked the way the product asks it.
   *
   * A spec that asserts a surface is "in Russian" is asserting the **browser's** UI
   * language: Playwright launches Chromium with the machine's locale, so `chrome.i18n`
   * resolves `en` here and `ru` on a Russian desktop. Comparing against
   * `getMessage` instead tests the rule — these words came from `_locales` — whatever
   * locale the run happens to have.
   */
  i18n: { getMessage(key: string, substitutions?: readonly string[]): string }
  /** Which tab a fixture page ended up in, so a per-tab badge can be read back. */
  tabs: { query(info: { url: string }): Promise<Array<{ id?: number }>> }
  /**
   * The extension's own icon — the one surface a page cannot reach (ADR-0001).
   *
   * Read, never set, from a spec: the point of the escalation is that the product
   * marks the icon, and a test that set it would be asserting about itself.
   */
  action: {
    getBadgeText(details: { tabId: number }): Promise<string>
    getTitle(details: { tabId: number }): Promise<string>
  }
  /**
   * What the browser lists, read only when the extensions screen reports a change on a
   * fresh profile, so the failure names the extension (B-168).
   */
  management: {
    getAll(): Promise<Array<{ id: string; name: string; version: string; installType?: string }>>
  }
}
