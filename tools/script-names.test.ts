import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * A script name pnpm owns is a command nobody can run.
 *
 * `pnpm access` never reached `tools/access.mjs`: pnpm answers it with
 * `ERR_PNPM_NOT_IMPLEMENTED` before any script is consulted. The tool worked, the
 * runbook documented the form, and `tools/runbook.test.ts` **required** the runbook
 * to document it — so the project's own gate insisted on documenting a command that
 * cannot run. Nothing was red anywhere.
 *
 * The rule that closes the class rather than the instance: **a colon.** pnpm has no
 * command with one in it, so a namespaced script can never be shadowed. Names that
 * are single words are allowed only where forwarding has been measured, and the
 * measurement is dated below.
 */

const root = path.resolve(import.meta.dirname, '..')
const scripts = Object.keys(
  (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }).scripts,
)

/**
 * Single-word names measured to reach the script, 2026-08-20, pnpm 11.10.0.
 *
 * Measured, not assumed: a throwaway package.json whose every script echoed a
 * sentinel, one `pnpm <name>` per row, and the sentinel either appeared or pnpm's
 * own command answered instead. The same probe found `access`, `publish`, `pack`,
 * `audit`, `licenses`, `outdated`, `why`, `link`, `patch`, `fetch`, `prune`,
 * `import`, `store`, `root`, `bin`, `exec`, `dlx`, `create`, `init`, `config`,
 * `env`, `stage` and `dedupe` intercepted — so this list is the safe side of a
 * boundary that has both.
 *
 * Anything new goes through a colon instead of being added here. Growing this list
 * means re-running the probe against the pnpm of the day; a colon needs no probe.
 */
const FORWARDS = new Set([
  'build',
  'typecheck',
  'test',
  'lint',
  'format',
  'gates',
  'bench',
  'prepare',
  'package',
  'screenshots',
  'wireframes',
])

describe('every script can actually be run by name', () => {
  it('namespaces anything not measured to forward', () => {
    const risky = scripts.filter((name) => !name.includes(':') && !FORWARDS.has(name))
    expect(
      risky,
      'a single-word script name can be a pnpm command; give it a colon or measure it',
    ).toEqual([])
  })

  it('the reserved class is real, not folklore', () => {
    /**
     * The list above is a claim about pnpm, and a claim about a tool is worth what
     * its check is worth (standing instruction 7). So one canary is run for real,
     * in this repository, against the name that started this: `access` is no longer
     * a script here, and pnpm must still answer it with its own refusal rather than
     * "no such script" — which is what proves interception happens before scripts
     * are consulted, and therefore that the rule above has something to prevent.
     */
    let output = ''
    try {
      output = execFileSync('pnpm', ['access'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (cause) {
      const failure = cause as { stdout?: string; stderr?: string }
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
    }
    expect(output).toMatch(/ERR_PNPM_NOT_IMPLEMENTED|not yet implemented/)
    expect(output, 'pnpm answered as if `access` were a missing script').not.toMatch(
      /Missing script|command not found/,
    )
    // A real pnpm start-up, not a pure function: at load average 130 it took 7.8 s
    // (2026-09-29) and the 5 s default failed the push on a clean tree.
  }, 60_000)

  it('keeps the accessible forms of the access registry', () => {
    // Both halves are needed and neither is the other: `--check` refuses, the bare
    // form reports. A single script would have to pick one, and the runbook would
    // then document a flag the reader has to know about rather than a command.
    expect(scripts).toContain('access:list')
    expect(scripts).toContain('access:check')
  })
})
