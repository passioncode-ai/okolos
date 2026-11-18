import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { toPosix } from '../tree.mjs'
import { feedPaths, windowsRefusal } from './paths.mjs'

/**
 * The paths in the platform's spelling turned into `/`, so the same literals hold on
 * Windows, where `path.join('/home/example', …)` answers with backslashes (B-164).
 */
function posixPaths(...args: Parameters<typeof feedPaths>): { [K in keyof ReturnType<typeof feedPaths>]: string } {
  const paths = feedPaths(...args)
  return Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, toPosix(String(value))])) as {
    [K in keyof typeof paths]: string
  }
}

/**
 * Where the feed agent keeps what it writes: outside the git working tree.
 *
 * The version counter lived in the tracked `feeds/phishing.json`, so any routine
 * `git checkout -- .` or `stash` took it back and the next run published a version
 * every extension refuses as a replay (F1).
 */
describe('where the feed agent writes', () => {
  it('keeps state under ~/.okolos/state and logs under ~/Library/Logs/Okolos', () => {
    const paths = posixPaths({}, '/home/example')
    expect(paths.feed).toBe('/home/example/.okolos/state/feeds/phishing.json')
    expect(paths.status).toBe('/home/example/.okolos/state/feed-status.json')
    expect(paths.lock).toBe('/home/example/.okolos/state/feed.lock')
    expect(paths.log).toBe('/home/example/Library/Logs/Okolos/feed.log')
    expect(paths.agentCheckout).toBe('/home/example/.okolos/agent-checkout')
  })

  it('keeps what launchd starts outside the checkout, so a missing checkout cannot stop it (B-159)', () => {
    const paths = posixPaths({}, '/home/example')
    expect(paths.bootstrap).toBe('/home/example/.okolos/bin/feed-agent/bootstrap.mjs')
    expect(paths.bootstrap.startsWith(`${paths.agentCheckout}/`)).toBe(false)
    expect(posixPaths({ OKOLOS_AGENT_BIN: '/b' }, '/h').bootstrap).toBe('/b/bootstrap.mjs')
  })

  it('never resolves into the repository', () => {
    const repo = path.resolve(import.meta.dirname, '../..')
    for (const value of Object.values(feedPaths())) {
      expect(String(value).startsWith(repo), `${value} is inside the working tree`).toBe(false)
    }
  })

  it('takes overrides from the environment, which is how tests stay out of the real home', () => {
    const paths = posixPaths({ OKOLOS_STATE_DIR: '/s', OKOLOS_LOG_DIR: '/l', OKOLOS_AGENT_CHECKOUT: '/c' }, '/h')
    expect(paths.feed).toBe('/s/feeds/phishing.json')
    expect(paths.log).toBe('/l/feed.log')
    expect(paths.agentCheckout).toBe('/c')
  })
})

describe('the feed tools on Windows (B-175)', () => {
  it('refuse there with a sentence naming where to publish instead', () => {
    const refusal = windowsRefusal('feed-job', 'win32')
    expect(refusal).toContain('feed-job: the feed tools do not run on Windows')
    expect(refusal).toContain('ADR-0002')
  })

  it('say nothing on macOS and Linux', () => {
    expect(windowsRefusal('feed-job', 'darwin')).toBeNull()
    expect(windowsRefusal('feed-job', 'linux')).toBeNull()
  })

  it('are refused before main runs, in every entry point that spawns pnpm or git', () => {
    for (const file of ['tools/feed-job.mjs', 'tools/feed/bootstrap.mjs', 'tools/publish-feed.mjs']) {
      const source = readFileSync(path.resolve(import.meta.dirname, '../..', file), 'utf8')
      const entry = source.slice(source.lastIndexOf('if (isMain('))
      expect(entry.indexOf('windowsRefusal('), file).toBeGreaterThan(-1)
      expect(entry.indexOf('windowsRefusal('), file).toBeLessThan(entry.indexOf('main()'))
    }
  })
})
