import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What CI claims about itself.
 *
 * Two of these caught real drift. A step called "scenarios SCN-003 and
 * SCN-019" was running fifty-five specs, and a comment explaining that Firefox
 * was deliberately absent sat two jobs above the Firefox job. Both are the kind
 * of thing nobody re-reads, and both would mislead the next person to open the
 * file at the moment they most needed it to be true.
 */

const root = process.cwd()
const workflow = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')
const scripts = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}).scripts

/** The steps of `pnpm gates`, in order — the one list both wirings are checked against. */
function gateSteps(): string[] {
  const steps = script('gates')
    .split('&&')
    .map((part) => part.trim().replace(/^pnpm\s+/, ''))
    .filter((name) => name !== '')
  if (steps.length < 5) throw new Error(`the gate chain parsed to ${steps.length} step(s)`)
  return steps
}

/** Fails with the script's name rather than on `undefined` three lines later. */
function script(name: string): string {
  const value = scripts[name]
  if (value === undefined) throw new Error(`package.json has no "${name}" script`)
  return value
}

/**
 * Does `body` run `command`, by its own name or by the file it invokes?
 *
 * `body` must be **executable lines only**. Given the whole file this returned true
 * for a gate that had been replaced by `echo skipped`, because a YAML comment three
 * lines up still named `tools/brand-gate.mjs` — a check about a mention rather than
 * a use, which is the same weak discriminator that kept `dueForFeed` green in B-54.
 * The plant that found it was the second one written; the first landed and hid it.
 */
function shares(body: string, command: string): boolean {
  if (body.includes(command)) return true
  // `python3 docs/ux/lint.py` and `node tools/i18n-sweep.mjs` are the same gate
  // whether reached through pnpm or called directly; the file is the identity.
  const file = /([\w./-]+\.(?:py|mjs|js|ts))/.exec(command)
  return file !== null && body.includes(file[1] as string)
}

/** The `run:` values of a workflow — what it executes, without what it says about it. */
function commandsIn(yaml: string): string {
  return [...yaml.matchAll(/^\s*(?:- )?run: (?:\|)?\s*(.*)$/gm)]
    .map((match) => match[1] as string)
    .join('\n')
}

/** The hook's `run <label> '<command>'` lines, without its commentary. */
function commandsInHook(shell: string): string {
  return [...shell.matchAll(/^run\s+\S+\s+'(.+)'$/gm)].map((match) => match[1] as string).join('\n')
}

describe('the workflow runs what the project has', () => {
  it('runs the unit suite, the UX linter and both browser suites', () => {
    expect(workflow).toContain('pnpm test')
    expect(workflow).toContain('docs/ux/lint.py')
    expect(workflow).toContain('pnpm test:e2e')
    expect(workflow).toContain('tools/firefox-e2e.mjs')
  })

  it('runs every gate the local chain runs', () => {
    // The other half of the same rule: a gate added to `pnpm gates` and to the
    // hook, and forgotten in CI, is a gate one `OKOLOS_SKIP_GATES=1` from absent.
    const runs = commandsIn(workflow)
    expect(runs, 'no run: steps parsed out of the workflow').toContain('pnpm test')
    for (const step of gateSteps()) {
      const resolved = scripts[step] ?? ''
      const ran = runs.includes(step) || (resolved !== '' && shares(runs, resolved))
      expect(ran, `CI does not run the "${step}" gate`).toBe(true)
    }
  })

  /**
   * And the direction nobody was checking: a gate CI runs that the local chain does not.
   *
   * The two assertions above walk `pnpm gates` and demand that CI and the hook run each
   * step. Walking only that way makes the local chain the ceiling — and it was not:
   * `package:check` ran in CI and in neither of the other two, so `pnpm gates` returned
   * green on a tree CI could still redden, which is the version of this defect that costs
   * somebody an evening rather than a minute (measured 2026-08-21).
   *
   * The exceptions are named rather than pattern-matched, because "CI does this and you
   * should not have to" is a decision. Both are the browser suites: minutes each, a real
   * browser, and the local chain is meant to be the thing you run before every push.
   */
  const CI_ONLY: Readonly<Record<string, string>> = {
    'test:e2e': 'minutes in a real browser — CI owns it, the local chain stays runnable',
    'test:e2e:firefox': 'the same, and it needs geckodriver to be installed',
    package: 'builds the archive; `package:check` validates its shape and that is in the chain',
  }

  it('runs no gate the local chain has never heard of', () => {
    const runs = commandsIn(workflow)
    const localChain = gateSteps()
    const missing: string[] = []

    for (const [name, body] of Object.entries(scripts)) {
      // Only the project's own checks: a build, a bench and a watcher are not gates.
      if (!/^(?:lint|typecheck|test|.*:(?:lint|check|sweep))$/.test(name)) continue
      if (localChain.includes(name)) continue
      if (CI_ONLY[name] !== undefined) continue
      const ran = runs.includes(`pnpm ${name}`) || (body !== '' && shares(runs, body))
      if (ran) missing.push(name)
    }

    expect(
      missing,
      'CI runs these and `pnpm gates` does not — add them to the chain, or name them CI-only with a reason',
    ).toEqual([])
  })

  it('names nothing CI-only that CI does not actually run', () => {
    // An exemption outliving its case is how a list stops describing the thing.
    const runs = commandsIn(workflow)
    const stale = Object.keys(CI_ONLY).filter((name) => {
      const body = scripts[name] ?? ''
      return !(runs.includes(`pnpm ${name}`) || (body !== '' && shares(runs, body)))
    })
    expect(stale, 'these exemptions no longer describe anything CI does').toEqual([])
  })

  it('does not pin a Playwright build number', () => {
    // A path carrying one turns an unrelated dependency bump into a red Firefox
    // job, which is the pressure that gets a browser dropped from CI.
    expect(workflow).not.toMatch(/firefox-\d{3,}/)
  })

  it('names no individual scenario in a step that runs all of them', () => {
    const stepNames = [...workflow.matchAll(/^\s*- name: (.+)$/gm)].map((m) => m[1] as string)
    for (const name of stepNames) {
      expect(name, `step "${name}" names a scenario`).not.toMatch(/SCN-\d+/)
    }
  })
})

describe('the local shortcut matches CI', () => {
  it('builds before running the gates that read the build', () => {
    // Without this `pnpm gates` runs the bundle scanners over whatever dist
    // happened to be lying around, which is the definition of a stale green.
    expect(script('gates')).toContain('pnpm build')
    expect(script('gates').indexOf('pnpm build')).toBeLessThan(script('gates').indexOf('pnpm test'))
  })
})

describe('the repository tracks no test-run artefacts', () => {
  /**
   * Three Playwright failure artefacts — including a binary trace.zip of a
   * red run — were committed with an unrelated feature and sat in history for
   * days. They are not project state: they are the debris of one machine's
   * one bad run, and the knowledge-graph build was reading the error context
   * as if it were documentation.
   */
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n')

  it('reads the index, so an empty list cannot pass as a clean tree', () => {
    expect(tracked.length).toBeGreaterThan(50)
  })

  it('has no test-results or playwright-report file under version control', () => {
    const debris = tracked.filter((f) => /^(test-results|playwright-report)\//.test(f))
    expect(debris, `these are run artefacts, not source: ${debris.join(', ')}`).toEqual([])
  })

  it('ignores the directories they land in, so the next red run stays local', () => {
    const ignore = readFileSync(path.join(root, '.gitignore'), 'utf8')
    expect(ignore).toMatch(/^test-results\/$/m)
    expect(ignore).toMatch(/^playwright-report\/$/m)
  })
})

describe('the pre-push hook exists and runs the gates', () => {
  /**
   * The one standing instruction that cannot be followed by reading it. A rule
   * about checking gate output lives in a document; the push that ignores it
   * lives in a shell, and on 2026-08-07 the shell won.
   */
  const hook = path.join(root, '.githooks/pre-push')

  it('is present and executable', () => {
    expect(existsSync(hook), '.githooks/pre-push is missing').toBe(true)
    // A hook without the bit set is a hook git silently never runs — the exact
    // failure mode this is meant to remove.
    expect(statSync(hook).mode & 0o111).toBeGreaterThan(0)
  })

  it('runs every gate the chain runs, derived from the chain', () => {
    /**
     * Derived, not listed. The hand-kept list here was `['lint', 'typecheck',
     * 'test', 'docs/ux/lint.py']`, and three gates lived outside it for weeks —
     * the brand linter with four errors, the i18n sweep that never returned
     * non-zero, and a graph check nobody ran. A list a person maintains is a list
     * that stops matching the thing it describes, silently, which is the whole
     * failure this test exists to prevent.
     *
     * Each step of `pnpm gates` counts as run when the hook names either the
     * script (`pnpm i18n:sweep`) or the command it resolves to
     * (`node tools/i18n-sweep.mjs`) — the hook calls the tools directly to keep
     * one pnpm start-up per gate rather than two.
     */
    const body = commandsInHook(readFileSync(hook, 'utf8'))
    expect(body, 'no run lines parsed out of the hook').toContain('pnpm -s run lint')
    for (const step of gateSteps()) {
      const resolved = scripts[step] ?? ''
      const ran = body.includes(step) || (resolved !== '' && shares(body, resolved))
      expect(ran, `the hook does not run the "${step}" gate`).toBe(true)
    }
  })

  it('names scripts with `run`, which every pnpm major accepts', () => {
    /**
     * pnpm 12 rejects the shorthand `pnpm -s lint` with a usage error before it
     * delegates to the `packageManager` version, so a machine whose PATH resolved
     * pnpm 12 turned lint, typecheck and build red on every push from 2026-09-13
     * without a line of code changing. `pnpm -s run lint` works on 11 and 12.
     */
    const body = commandsInHook(readFileSync(hook, 'utf8'))
    expect(body).not.toMatch(/pnpm -s (?!run )[\w:]+/)
  })

  it('refuses rather than warns', () => {
    expect(readFileSync(hook, 'utf8')).toMatch(/exit 1/)
  })

  it('is wired by installing, not by remembering', () => {
    // core.hooksPath is per-clone. Without `prepare`, the hook is a file nobody
    // on a fresh clone is running.
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.prepare ?? '').toContain('core.hooksPath')
  })
})

describe('the release archive is built by CI, not by hand', () => {
  /**
   * A packaging command nobody runs is a runbook with a shebang. CI runs the
   * checks on every push so a manifest that names a missing file, a locale
   * that cannot answer a `__MSG__`, or a build carrying the test hooks is
   * found here rather than after an upload.
   */
  it('runs the packaging checks', () => {
    expect(workflow).toContain('package:check')
  })
})
