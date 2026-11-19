/**
 * What the first run found, for `first_run_completed` (B-206): findings first, then any check
 * that could not run (`failed`, `unavailable`), else clean.
 */
export function firstRunResult(rows: readonly { readonly state: string }[], findings: number): 'clean' | 'findings' | 'partial' {
  if (findings > 0) return 'findings'
  return rows.every((row) => row.state === 'ok') ? 'clean' : 'partial'
}
