#!/usr/bin/env node
/**
 * `okolos-mail`: the file `package.json` names as the command.
 *
 * It always calls `main`. B-161 was a command that decided whether to run by
 * looking at `argv[1]`, decided wrongly on Windows, and exited 0, which
 * `scan.ts` defines as "nothing found". A file whose only job is to be the
 * command has nothing to decide.
 *
 * Node runs the TypeScript sources by stripping their types (node ≥ 22.18 with
 * no flag). The sources import each other as `./x.js`, the spelling TypeScript
 * requires, and that file exists only after a build; the resolve hook below
 * tries the `.ts` beside a missing `.js` when the importer is itself `.ts`.
 * Static imports would be resolved before the hook exists, so the command's
 * own modules are imported dynamically, after it.
 *
 * Whatever fails before a verdict — the hook, a module that throws as it
 * loads, `main` itself — ends with exit 2, the code of an unread message, and
 * the error on stderr; never with 0 and never with node's own 1, which this
 * command uses for "signals found".
 */
import { registerHooks } from 'node:module'
import process from 'node:process'

/** `EXIT.unreadable` from `scan.ts`, which cannot be imported before the hook; `bin.test.ts` holds them equal. */
const FAILED = 2

try {
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context)
      } catch (error) {
        if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts') === true) {
          return next(`${specifier.slice(0, -'.js'.length)}.ts`, context)
        }
        throw error
      }
    },
  })
  const { run } = await import('./index.js')
  run(process.argv.slice(2), process.env)
} catch (error) {
  console.error(error)
  process.exitCode = FAILED
}
