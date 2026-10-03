import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { feedPaths } from './paths.mjs'

/**
 * Where the feed agent keeps what it writes: outside the git working tree.
 *
 * The version counter lived in the tracked `feeds/phishing.json`, so any routine
 * `git checkout -- .` or `stash` took it back and the next run published a version
 * every extension refuses as a replay (F1).
 */
describe('where the feed agent writes', () => {
  it('keeps state under ~/.okolos/state and logs under ~/Library/Logs/Okolos', () => {
    const paths = feedPaths({}, '/home/example')
    expect(paths.feed).toBe('/home/example/.okolos/state/feeds/phishing.json')
    expect(paths.status).toBe('/home/example/.okolos/state/feed-status.json')
    expect(paths.lock).toBe('/home/example/.okolos/state/feed.lock')
    expect(paths.log).toBe('/home/example/Library/Logs/Okolos/feed.log')
    expect(paths.agentCheckout).toBe('/home/example/.okolos/agent-checkout')
  })

  it('never resolves into the repository', () => {
    const repo = path.resolve(import.meta.dirname, '../..')
    for (const value of Object.values(feedPaths())) {
      expect(String(value).startsWith(repo), `${value} is inside the working tree`).toBe(false)
    }
  })

  it('takes overrides from the environment, which is how tests stay out of the real home', () => {
    const paths = feedPaths({ OKOLOS_STATE_DIR: '/s', OKOLOS_LOG_DIR: '/l', OKOLOS_AGENT_CHECKOUT: '/c' }, '/h')
    expect(paths.feed).toBe('/s/feeds/phishing.json')
    expect(paths.log).toBe('/l/feed.log')
    expect(paths.agentCheckout).toBe('/c')
  })
})
