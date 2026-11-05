// The store build carries the App-Key, and dist/<target> is what an unpacked load, e2e and every
// test read (B-199). Once `pnpm package` has started writing it, every way out removes it unless
// the keyless rebuild finished: a die(), an exception, a failed or half-finished first build,
// Ctrl-C or a SIGTERM. `pnpm build` puts the targets back.
import { rmSync } from 'node:fs'

/**
 * @param {readonly string[]} dirs the target builds that may carry the key
 * @param {{ log?: (line: string) => void }} [options]
 */
export function guardKeyedBuilds(dirs, { log = (line) => console.error(line) } = {}) {
  let armed = false
  const drop = () => {
    if (!armed) return
    armed = false
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    log('package: removed the store builds in dist/, which carried the App-Key; `pnpm build` restores them')
  }
  // `exit` runs for process.exit and for an uncaught exception alike; rmSync is synchronous, so
  // it finishes there. A signal does not reach `exit` by itself, so it is turned into one.
  process.on('exit', drop)
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    process.on(signal, () => {
      drop()
      process.exit(code)
    })
  }
  return {
    /** Before the first keyed byte is written. */
    arm: () => {
      armed = true
    },
    /** After dist/<target> is keyless again. */
    disarm: () => {
      armed = false
    },
    drop,
  }
}
