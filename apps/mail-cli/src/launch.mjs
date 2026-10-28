/**
 * How `okolos-mail` starts, in plain JavaScript.
 *
 * B-161 was a command that could end with 0, "nothing found", without having
 * scanned anything. The first fix made the command a TypeScript file; on node
 * 22.0 to 22.17, which the root `engines` allowed until it became
 * `^22.18.0 || >=23.6.0` (the FLOORS below, kept equal by a test), node rejects a `.ts`
 * entry before a line of it runs (ERR_UNKNOWN_FILE_EXTENSION) and exits 1, which
 * this command uses for "signals found". So the file node is handed is
 * JavaScript, does no TypeScript itself, and every way it can fail before a
 * verdict ends with 2, the code of an unread message, and one line on stderr
 * that starts with `okolos-mail:`.
 *
 * The command runs from its TypeScript sources: node strips the types (node
 * 22.18 and later, 23.6 and later, with no flag) and a resolve hook tries the
 * `.ts` beside a missing `.js`, the spelling TypeScript requires in imports.
 * `module.registerHooks` arrived in 22.15, so the 22.18 floor covers both.
 *
 * The stderr lines are diagnostics of the runtime, not product copy: they are
 * written before the catalogue can be read, on a node that may not be able to
 * read the code that reads it. The verdict and every refusal of a message stay
 * in the catalogue (`index.ts`, `scan.ts`).
 */
// The namespace, not `{ registerHooks }`: a named import of an export an old
// node lacks fails as the file links, before the version check can refuse.
import * as nodeModule from 'node:module'
import process from 'node:process'

/** `EXIT.unreadable` in `scan.ts`; `launch.test.ts` holds them equal. */
export const FAILED = 2

/** The first node of each line that strips types with no flag. */
const FLOORS = [
  { major: 22, minor: 18 },
  { major: 23, minor: 6 },
]

/**
 * Whether this node can run the TypeScript sources.
 *
 * @param {string} node `process.versions.node`
 * @param {string | false | undefined} typescript `process.features.typescript`:
 *   `false` when stripping is switched off, `undefined` on a node too old to say
 * @returns {boolean}
 */
export function runsFromSources(node, typescript) {
  if (typescript === false) return false
  const [major = 0, minor = 0] = node.split('.').map(Number)
  if (major > 23) return true
  const floor = FLOORS.find((entry) => entry.major === major)
  return floor !== undefined && minor >= floor.minor
}

/** @param {string} text */
const line = (text) => `okolos-mail: ${text}\n`

/**
 * Register the hook, then import the command. Dynamic, because a static import
 * would be resolved before the hook exists.
 *
 * @returns {Promise<{ run: (argv: readonly string[], env: NodeJS.ProcessEnv) => void }>}
 */
export async function loadSources() {
  nodeModule.registerHooks({
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
  return import('./index.ts')
}

/**
 * Start the command. Returns `FAILED` when it could not start, and `undefined`
 * when `run` did, because then `run` has set the exit code itself.
 *
 * @param {{
 *   argv: readonly string[]
 *   env: NodeJS.ProcessEnv
 *   node?: string
 *   typescript?: string | false | undefined
 *   load?: typeof loadSources
 *   write?: (text: string) => void
 * }} options
 * @returns {Promise<number | undefined>}
 */
export async function launch({
  argv,
  env,
  node = process.versions.node,
  typescript = process.features.typescript,
  load = loadSources,
  write = (text) => void process.stderr.write(text),
}) {
  if (!runsFromSources(node, typescript)) {
    write(
      typescript === false && runsFromSources(node, 'strip')
        ? line(`this Node.js ${node} has type stripping switched off, and the command runs from its TypeScript sources; start it without --no-experimental-strip-types`)
        : line(`Node.js 22.18 or later in the 22 line, or 23.6 or later, is needed to run the command from its TypeScript sources; this is Node.js ${node}`),
    )
    return FAILED
  }
  try {
    const { run } = await load()
    run(argv, env)
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    write(line(`the command could not start: ${message}`))
    if (error instanceof Error && error.stack !== undefined) write(`${error.stack}\n`)
    return FAILED
  }
}
