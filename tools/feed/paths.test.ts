import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { toPosix } from '../tree.mjs'
import { feedPaths } from './paths.mjs'

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
