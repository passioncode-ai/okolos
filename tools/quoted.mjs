/**
 * Whether a built bundle carries `word` as a string literal, in any quote a bundler may write
 * (B-225).
 *
 * The gates read built JavaScript for literals: `"open"` means the test hook that opens the
 * shadow roots shipped. esbuild writes double quotes, Rollup and rolldown may write single
 * quotes or backticks; Vite 8 wrote every string in backticks, and a check for `"open"` alone
 * passed a bundle that carried the hook. A literal is the word between two of the same quote.
 */
export function carriesLiteral(source, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(["'\`])${escaped}\\1`).test(source)
}
