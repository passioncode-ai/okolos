#!/usr/bin/env node
/**
 * The Python 3 this machine has, found rather than assumed.
 *
 *   node tools/python.mjs docs/ux/lint.py [args…]   # runs the script, exits with its code
 *
 * Every gate that runs a Python linter used to spell `python3`. That name exists on
 * macOS and Linux and, on a stock Windows, either does not exist or is the Store
 * alias that prints an advert and exits 9009, so `pnpm gates` and the pre-push hook
 * stopped at the UX linter on a Windows checkout (B-162). Windows installs answer
 * to `py -3` (the launcher) or `python`.
 *
 * Each candidate is asked to prove it is Python 3 by running one line, rather than
 * trusted by name: `python` is still Python 2 on some machines, and the Store alias
 * answers to every name and runs nothing. On macOS and Linux `python3` is asked
 * first, so the interpreter the gates used before this file is still the one they use.
 */
import { spawnSync } from 'node:child_process'
import { isMain } from './is-main.mjs'

/** Exits 0 only under Python 3.7 or later (the linters' syntax); what each candidate is asked to run. */
export const PYTHON3_CHECK = 'import sys; sys.exit(0 if sys.version_info[0] == 3 and sys.version_info[:2] >= (3, 7) else 1)'

/**
 * The names to try, in order, as `[command, ...args]`.
 *
 * @param {string} [platform]
 * @returns {string[][]}
 */
export function pythonCandidates(platform = process.platform) {
  return platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']]
}

/**
 * Does `command args… -c PYTHON3_CHECK` exit 0. Spawned without a shell: these are
 * executables (`py.exe`, `python.exe`), and no argument here comes from a person.
 *
 * @param {string} command
 * @param {string[]} args
 */
function answersAsPython3(command, args) {
  const run = spawnSync(command, [...args, '-c', PYTHON3_CHECK], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 15_000,
  })
  return run.error === undefined && run.status === 0
}

/**
 * The first candidate that proves it is Python 3, or null when none does.
 *
 * @param {{ platform?: string, probe?: (command: string, args: string[]) => boolean }} [options]
 * @returns {{ command: string, args: string[] } | null}
 */
export function findPython({ platform = process.platform, probe = answersAsPython3 } = {}) {
  for (const [command, ...args] of pythonCandidates(platform)) {
    if (command !== undefined && probe(command, args)) return { command, args }
  }
  return null
}

/**
 * The environment a linter runs in: on Windows, with Python's UTF-8 mode on.
 *
 * Python there reads files and writes a piped stdout in the ANSI code page (cp1252)
 * unless told otherwise, and the linters read Russian documents and print Russian
 * findings; the pre-push hook captures their output through a pipe, which is where
 * a cp1252 stdout fails. macOS and Linux already run them in UTF-8, and their
 * environment is passed through unchanged.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 */
export function pythonEnv(env = process.env, platform = process.platform) {
  return platform === 'win32' ? { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } : env
}

/** What to print when nothing answered: the names tried, and what to install. */
export function noPythonMessage(platform = process.platform) {
  const tried = pythonCandidates(platform)
    .map((candidate) => candidate.join(' '))
    .join(', ')
  return `no Python 3.7 or later found (tried ${tried}). Install Python 3 so one of those names runs it.`
}

// Real paths, so a run through a symlink or a junction still runs (tools/is-main.mjs).
if (isMain(import.meta.filename)) {
  const [script, ...rest] = process.argv.slice(2)
  if (script === undefined) {
    console.error('usage: node tools/python.mjs <script.py> [args…]')
    process.exit(2)
  }
  const python = findPython()
  if (python === null) {
    console.error(`\n  ${noPythonMessage()}\n`)
    process.exit(1)
  }
  const run = spawnSync(python.command, [...python.args, script, ...rest], {
    stdio: 'inherit',
    env: pythonEnv(),
    windowsHide: true,
  })
  if (run.error) {
    console.error(`\n  could not run ${python.command}: ${run.error.message}\n`)
    process.exit(1)
  }
  // A signal is not an exit code: null would read as success to `process.exit`.
  process.exit(run.status ?? 1)
}
