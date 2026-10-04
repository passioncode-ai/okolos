#!/usr/bin/env node
/**
 * Copies the feed this machine last published into the committed snapshot.
 *
 *   pnpm feed:snapshot      # ~/.okolos/state/feeds/phishing.json → feeds/phishing.json
 *
 * The agent writes its state outside the git working tree (F1): it used to rewrite
 * the tracked file on every run, the worktree was always dirty, and any routine
 * `git checkout -- .` took the version counter backwards. The committed snapshot
 * is still worth keeping — a seed for a new machine, a reference the licence
 * table and `suffix-gap` read, and the fallback the release gate measures on CI —
 * so bringing it up to date is a deliberate act, followed by a commit.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { FEED_PATH } from './feed-age.mjs'
import { feedPaths } from './feed/paths.mjs'

const root = path.resolve(import.meta.dirname, '..')

function versionOf(file) {
  try {
    const body = JSON.parse(readFileSync(file, 'utf8'))?.body
    return Number.isSafeInteger(body?.version) ? body.version : null
  } catch {
    return null
  }
}

/** Copies `from` over `to` when it is newer. Returns `{ copied, version }`. */
export function snapshot({ from = feedPaths().feed, to = path.join(root, FEED_PATH) } = {}) {
  const fresh = versionOf(from)
  if (fresh === null) {
    throw new Error(`no published feed at ${from}; run pnpm feed:refresh on the machine that holds the signing key`)
  }
  const committed = versionOf(to)
  if (committed !== null && fresh <= committed) return { copied: false, version: committed }
  const text = readFileSync(from, 'utf8')
  const temporary = `${to}.${process.pid}.tmp`
  writeFileSync(temporary, text.endsWith('\n') ? text : `${text}\n`)
  renameSync(temporary, to)
  return { copied: true, version: fresh }
}

if (import.meta.filename === process.argv[1]) {
  try {
    const { copied, version } = snapshot()
    console.log(copied ? `${FEED_PATH} is now v${version} — commit it` : `${FEED_PATH} is already v${version}; nothing to do`)
  } catch (cause) {
    console.error(`feed-snapshot: ${cause.message}`)
    process.exit(1)
  }
}
