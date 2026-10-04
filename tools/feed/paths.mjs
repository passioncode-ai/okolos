import os from 'node:os'
import path from 'node:path'

/**
 * Where the feed agent keeps what it writes — never inside the git working tree.
 *
 * The version counter used to live in the tracked `feeds/phishing.json`, so a
 * routine `git checkout -- .`, `stash` or `reset` took it backwards and the next run
 * published a version every extension refuses as a replay (F1). State now lives
 * under `~/.okolos/state`, logs under `~/Library/Logs/Okolos` (LC-12), and the agent
 * runs from its own pinned checkout rather than a developer's clone (F2). Each root
 * can be moved by an environment variable, which is how tests stay out of the real
 * home directory.
 */
export function feedPaths(env = process.env, home = os.homedir()) {
  const state = env.OKOLOS_STATE_DIR || path.join(home, '.okolos', 'state')
  const logs = env.OKOLOS_LOG_DIR || path.join(home, 'Library', 'Logs', 'Okolos')
  return {
    state,
    feed: path.join(state, 'feeds', 'phishing.json'),
    status: path.join(state, 'feed-status.json'),
    lock: path.join(state, 'feed.lock'),
    logs,
    log: path.join(logs, 'feed.log'),
    launchdLog: path.join(logs, 'feed.launchd.log'),
    agentCheckout: env.OKOLOS_AGENT_CHECKOUT || path.join(home, '.okolos', 'agent-checkout'),
  }
}
