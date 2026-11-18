// The store build carries the App-Key, and dist/<target> is what an unpacked load, e2e and every
// test read (B-199). Once `pnpm package` has started writing it, every way out removes it unless
// the keyless rebuild finished: a die(), an exception, a failed or half-finished first build,
// Ctrl-C, a SIGTERM or a closed terminal (SIGHUP). `pnpm build` puts the targets back.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

import { endTree } from './bin.mjs'
import { filesUnder } from './tree.mjs'

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
  // it finishes there. A signal does not reach `exit` by itself, so it is turned into one, after the
  // build still running is ended: signalled alone (a runner forwarding SIGTERM to its direct child),
  // this process would otherwise exit while the build goes on and writes the keyed target again.
  process.on('exit', drop)
  let child = null
  let stopping = false
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ]) {
    process.on(signal, () => {
      if (stopping) return
      stopping = true
      const running = child
      const finish = () => {
        drop()
        process.exit(code)
      }
      if (running === null || running.exitCode !== null || running.signalCode !== null) return finish()
      // Bounded: a build that will not end is killed, and the target is removed after it either way.
      const hard = setTimeout(() => {
        endTree(running, { signal: 'SIGKILL' })
        finish()
      }, 5_000)
      running.once('exit', () => {
        clearTimeout(hard)
        finish()
      })
      endTree(running)
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
    /** The build now running, ended before the removal when a signal arrives. */
    watch: (running) => {
      child = running
      running.once('exit', () => {
        if (child === running) child = null
      })
    },
    drop,
  }
}

/** The shape of an Aptabase App-Key, any key: a leftover is found without knowing which one. */
const ANY_KEY = /A-SH-\d{10}/i

/** Every `.js` and `.html` file under `dir`, as paths relative to it with `/`. */
function shippedFiles(dir) {
  return [...filesUnder(dir, '.js'), ...filesUnder(dir, '.html')]
    .map((file) => path.relative(dir, file).split(path.sep).join('/'))
    .sort()
}

/**
 * The files of a target build, other than `background.js`, that carry `key` (B-215). Only the
 * worker may: the content script, the MAIN-world page watcher and the pages a page can reach
 * would hand it to any site.
 * @param {string} dir
 * @param {string} key
 * @returns {string[]}
 */
export function carriesKey(dir, key) {
  if (key === '') return []
  return shippedFiles(dir).filter((file) => file !== 'background.js' && readFileSync(path.join(dir, file), 'utf8').includes(key))
}

/**
 * The targets under `dist` that carry any App-Key: what a `pnpm package` killed before its
 * keyless rebuild leaves behind, found in both modes without the key in the environment (B-215).
 * @param {string} dist
 * @param {readonly string[]} targets
 * @returns {string[]}
 */
export function keyedTargets(dist, targets) {
  return targets.filter((target) => {
    const dir = path.join(dist, target)
    return existsSync(dir) && shippedFiles(dir).some((file) => ANY_KEY.test(readFileSync(path.join(dir, file), 'utf8')))
  })
}
