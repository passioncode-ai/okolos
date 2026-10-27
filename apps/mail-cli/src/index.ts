/**
 * `index.ts` started directly: `node src/index.ts`, or `node dist/index.js`
 * after `tsc -b`. The command is `bin/okolos-mail.mjs`; this is the file a
 * person tries before reading `bin`, and it ends the same way.
 *
 * B-161, round 2. The built `index.js` exited 1 without scanning: its static
 * imports reach the TypeScript sources of the workspace packages, and plain
 * node cannot link them, so the process died before a line of it ran. Here the
 * only static imports are node's and the launcher, which is plain JavaScript;
 * the command is imported after the launcher has checked the node and
 * installed its hook, and every failure ends with 2 and an `okolos-mail:` line.
 *
 * Nothing compares `argv[1]` with this file's path. That comparison was B-161
 * itself (Windows separators), and every other spelling it could miss (`\\?\`
 * long paths, 8.3 short names, links) would have run nothing and exited 0. The
 * launcher marks the import it makes; anything else that evaluates this module
 * is a start, and a start runs the command. So no test imports this module:
 * `index.test.ts` spawns it.
 */
import process from 'node:process'

// `../src/` rather than `./`: from `dist/index.js` the launcher is still the
// one in `src/`, because `tsc` emits no `.mjs`.
import { LAUNCHED, installHook, launch } from '../src/launch.mjs'

/** What the launcher calls: the command, imported once the hook exists. */
export async function run(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const command = await import('./command.js')
  command.run(argv, env)
}

if (Reflect.get(globalThis, LAUNCHED) !== true) {
  const code = await launch({
    argv: process.argv.slice(2),
    env: process.env,
    load: async () => {
      installHook()
      return { run }
    },
  })
  if (code !== undefined) process.exitCode = code
}
