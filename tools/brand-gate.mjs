#!/usr/bin/env node
/**
 * The brand linter, with its exit codes mapped to a gate's two answers.
 *
 * `docs/brand/lint.py` answers in three codes — 0 clean, **1 warnings only**, 2
 * any error — and a gate wired straight to it would refuse a push for a warning.
 * That matters here: the ux linter has carried two known warnings for weeks
 * (SCR-17 and SCR-18 orphans, B-22), and a project whose gates refuse over
 * warnings is a project that learns `OKOLOS_SKIP_GATES=1`, which is how the one
 * load-bearing gate stopped being load-bearing in August.
 *
 * So: errors refuse, warnings are printed and pass. The mapping lives here, in a
 * file with a reason, rather than as `|| [ $? -eq 1 ]` in a package.json string —
 * a shell trick nobody reads is a shell trick nobody notices inverting.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { findPython, noPythonMessage } from './python.mjs'

const root = path.resolve(import.meta.dirname, '..')
const pack = process.argv[2] ?? 'docs/brand'

// Found, not spelled: `python3` is not a name a stock Windows answers to (B-162).
const python = findPython()
if (python === null) {
  console.error(`\n  could not run the brand linter: ${noPythonMessage()}\n`)
  process.exit(1)
}

const run = spawnSync(python.command, [...python.args, path.join(root, 'docs/brand/lint.py'), path.join(root, pack)], {
  stdio: 'inherit',
  windowsHide: true,
})

if (run.error) {
  console.error(`\n  could not run the brand linter: ${run.error.message}\n`)
  process.exit(1)
}

// A signal is not an exit code, and `status` is null when one arrived. Treating
// null as 0 would turn a killed linter into a clean pack — the absence-reads-as-
// pass shape this project has already been bitten by.
if (run.status === null) {
  console.error(`\n  the brand linter did not finish (signal ${String(run.signal)})\n`)
  process.exit(1)
}

if (run.status >= 2) {
  console.error('\n  brand pack: errors above. The pack is the source for every string a user reads.\n')
  process.exit(1)
}
if (run.status === 1) {
  console.log('\n  brand pack: warnings only — not blocking, and not nothing either.\n')
}
process.exit(0)
