import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { feedPaths } from './feed/paths.mjs'
import { readStatus, writeStatus } from './feed/status.mjs'
import { filesIn } from './tree.mjs'
import { BOOTSTRAP_FILES } from './feed/bootstrap.mjs'
import {
  LABEL,
  agentStatus,
  bootstrapDrift,
  checkBranch,
  ensureCheckout,
  installAgent,
  installBootstrap,
  isDisabled,
  originUrl,
  rendered,
  stableNode,
  uninstallAgent,
} from './install-feed-agent.mjs'

/**
 * Installing and removing the feed agent (LC-14: uninstall is symmetric; the
 * operator's intent wins). launchctl is a double throughout — these tests never
 * load, unload or print the operator's real `app.okolos.feed`, and use their own
 * label so a mistake could not reach it either.
 */

const repo = path.resolve(import.meta.dirname, '..')
const template = () => readFileSync(path.join(repo, 'tools/launchd/app.okolos.feed.plist'), 'utf8')
const TEST_LABEL = 'app.okolos.feed.test-throwaway'

/** A launchd double: which services are loaded and disabled, and every call made. */
function fakeLaunchd({ loaded = true, disabled = false, staysLoaded = false } = {}) {
  const state = { loaded, disabled }
  const calls: string[][] = []
  const launchctl = async (args: string[]) => {
    calls.push(args)
    const [verb] = args
    if (verb === 'bootout') {
      if (!state.loaded) return { code: 3, stdout: '', stderr: 'No such process' }
      if (!staysLoaded) state.loaded = false
      return { code: 0, stdout: '', stderr: '' }
    }
    if (verb === 'bootstrap') {
      if (state.disabled) return { code: 5, stdout: '', stderr: 'Service is disabled' }
      state.loaded = true
      return { code: 0, stdout: '', stderr: '' }
    }
    if (verb === 'print') {
      return state.loaded
        ? { code: 0, stdout: `${TEST_LABEL} = {\n\tstate = not running\n\truns = 3\n\tlast exit code = 0\n}`, stderr: '' }
        : { code: 113, stdout: '', stderr: `Could not find service "${TEST_LABEL}"` }
    }
    if (verb === 'print-disabled') {
      return { code: 0, stdout: `disabled services = {\n\t"${TEST_LABEL}" => ${state.disabled ? 'disabled' : 'enabled'}\n}`, stderr: '' }
    }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` }
  }
  return { launchctl, calls, state }
}

/** A throwaway HOME: every path the installer writes resolves under it, never the real one. */
function home() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-agent-home-'))
  const target = path.join(dir, 'Library/LaunchAgents', `${TEST_LABEL}.plist`)
  mkdirSync(path.dirname(target), { recursive: true })
  return { dir, target, paths: feedPaths({}, dir) }
}

const ok = (stdout = '') => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false })

const quiet = () => undefined
const base = { label: TEST_LABEL, domain: 'gui/501', log: quiet }

describe('uninstall is symmetric (F5, LC-14)', () => {
  it('boots the agent out, deletes the plist, and proves launchd no longer knows it', async () => {
    const h = home()
    writeFileSync(h.target, '<plist/>')
    const launchd = fakeLaunchd({ loaded: true })
    const result = await uninstallAgent({ ...base, target: h.target, launchctl: launchd.launchctl })
    expect(result.ok).toBe(true)
    expect(existsSync(h.target), 'the plist stays, and launchd loads it again at the next login').toBe(false)
    expect(launchd.calls.map((c) => c[0])).toEqual(['bootout', 'print'])
    expect(launchd.calls[0]).toEqual(['bootout', `gui/501/${TEST_LABEL}`])
  })

  it('removes the bootstrap it installed beside launchd, and nothing else without --purge (B-159)', async () => {
    const h = home()
    writeFileSync(h.target, '<plist/>')
    installBootstrap({ dir: h.paths.agentBin })
    for (const dir of [h.paths.agentCheckout, h.paths.state, h.paths.logs]) mkdirSync(dir, { recursive: true })
    const launchd = fakeLaunchd({ loaded: true })
    const result = await uninstallAgent({ ...base, target: h.target, bin: h.paths.agentBin, launchctl: launchd.launchctl })
    expect(result.ok).toBe(true)
    expect(existsSync(h.paths.agentBin), 'a bootstrap left behind is a half-installed agent').toBe(false)
    for (const dir of [h.paths.agentCheckout, h.paths.state, h.paths.logs]) expect(existsSync(dir), dir).toBe(true)
  })

  it('removes an emptied ~/.okolos/bin and a staging folder an interrupted install left', async () => {
    const h = home()
    installBootstrap({ dir: h.paths.agentBin })
    mkdirSync(`${h.paths.agentBin}.staging-4242`)
    const launchd = fakeLaunchd({ loaded: false })
    const result = await uninstallAgent({ ...base, target: h.target, bin: h.paths.agentBin, launchctl: launchd.launchctl })
    expect(result.ok).toBe(true)
    expect(existsSync(`${h.paths.agentBin}.staging-4242`)).toBe(false)
    expect(existsSync(path.dirname(h.paths.agentBin)), '~/.okolos/bin held only the agent').toBe(false)
    expect(existsSync(path.join(h.dir, '.okolos')), 'the rest of ~/.okolos is not the agent’s to remove').toBe(true)
  })

  it('keeps ~/.okolos/bin when something else lives there', async () => {
    const h = home()
    installBootstrap({ dir: h.paths.agentBin })
    writeFileSync(path.join(path.dirname(h.paths.agentBin), 'someone-elses-tool'), '')
    const launchd = fakeLaunchd({ loaded: false })
    await uninstallAgent({ ...base, target: h.target, bin: h.paths.agentBin, launchctl: launchd.launchctl })
    expect(existsSync(path.join(path.dirname(h.paths.agentBin), 'someone-elses-tool'))).toBe(true)
  })

  it('succeeds when the agent was never loaded — absence is the outcome asked for', async () => {
    const h = home()
    const launchd = fakeLaunchd({ loaded: false })
    const result = await uninstallAgent({ ...base, target: h.target, launchctl: launchd.launchctl })
    expect(result.ok).toBe(true)
  })

  it('fails loudly when launchd still lists the service afterwards', async () => {
    const h = home()
    writeFileSync(h.target, '<plist/>')
    const launchd = fakeLaunchd({ loaded: true, staysLoaded: true })
    const result = await uninstallAgent({ ...base, target: h.target, launchctl: launchd.launchctl })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/still/)
  })

  it('with --purge also removes its checkout, state and logs', async () => {
    const h = home()
    for (const dir of [h.paths.agentCheckout, h.paths.state, h.paths.logs]) mkdirSync(dir, { recursive: true })
    writeFileSync(h.paths.status, '{}')
    const launchd = fakeLaunchd({ loaded: false })
    const tools: string[][] = []
    const tool = async (command: string, args: string[]) => {
      tools.push([command, ...args])
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    }
    mkdirSync(`${h.paths.agentCheckout}.broken`)
    const result = await uninstallAgent({
      ...base,
      target: h.target,
      bin: h.paths.agentBin,
      launchctl: launchd.launchctl,
      purge: { repo: '/repo', paths: h.paths, tool },
    })
    expect(result.ok).toBe(true)
    expect(tools).toContainEqual(['git', '-C', '/repo', 'worktree', 'remove', '--force', h.paths.agentCheckout])
    expect(tools).toContainEqual(['git', '-C', '/repo', 'worktree', 'prune'])
    for (const dir of [h.paths.agentCheckout, `${h.paths.agentCheckout}.broken`, h.paths.state, h.paths.logs]) {
      expect(existsSync(dir), dir).toBe(false)
    }
  })
})

describe('install respects what the operator decided (LC-14)', () => {
  it('writes and loads the agent when it is enabled', async () => {
    const h = home()
    const launchd = fakeLaunchd({ loaded: false })
    const result = await installAgent({ ...base, target: h.target, plist: '<plist/>', launchctl: launchd.launchctl })
    expect(result.state).toBe('loaded')
    expect(readFileSync(h.target, 'utf8')).toBe('<plist/>')
    expect(launchd.calls.map((c) => c[0])).toEqual(['print-disabled', 'bootout', 'bootstrap'])
  })

  it('never re-enables an agent the operator disabled: it updates the file and loads nothing', async () => {
    const h = home()
    const launchd = fakeLaunchd({ loaded: false, disabled: true })
    const result = await installAgent({ ...base, target: h.target, plist: '<plist/>', launchctl: launchd.launchctl })
    expect(result.state).toBe('disabled')
    expect(launchd.calls.map((c) => c[0])).not.toContain('bootstrap')
    expect(launchd.calls.map((c) => c[0])).not.toContain('enable')
    expect(launchd.state.disabled).toBe(true)
  })

  it('reads both spellings of a disabled service', () => {
    expect(isDisabled(`\t"${LABEL}" => disabled`, LABEL)).toBe(true)
    expect(isDisabled(`\t"${LABEL}" => true`, LABEL)).toBe(true)
    expect(isDisabled(`\t"${LABEL}" => enabled`, LABEL)).toBe(false)
    expect(isDisabled(`\t"${LABEL}.other" => disabled`, LABEL)).toBe(false)
  })
})

describe('the agent runs from its own checkout at origin/main (F2)', () => {
  it('creates a detached worktree at origin/main and installs only the publish tools', async () => {
    const h = home()
    const tools: string[][] = []
    const tool = async (command: string, args: string[]) => {
      tools.push([command, ...args])
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    }
    await ensureCheckout({ repo: '/repo', checkout: h.paths.agentCheckout, tool, log: quiet })
    expect(tools).toEqual([
      // A folder deleted under git leaves its worktree entry; `add` refuses that path until it is pruned (B-150).
      ['git', '-C', '/repo', 'worktree', 'prune'],
      ['git', '-C', '/repo', 'fetch', '--quiet', 'origin', 'main'],
      ['git', '-C', '/repo', 'worktree', 'add', '--detach', h.paths.agentCheckout, 'origin/main'],
      ['pnpm', 'install', '--frozen-lockfile', '--filter', '@okolos/proxy'],
    ])
  })

  it('leaves an existing checkout to the job, which fast-forwards it', async () => {
    const h = home()
    mkdirSync(h.paths.agentCheckout, { recursive: true })
    const tools: string[][] = []
    const tool = async (command: string, args: string[]) => {
      tools.push([command, ...args])
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    }
    await ensureCheckout({ repo: '/repo', checkout: h.paths.agentCheckout, tool, log: quiet })
    expect(tools).toEqual([])
  })
})

describe('the plist launchd reads', () => {
  const where = {
    checkout: '/Users/example/.okolos/agent-checkout',
    logDir: '/Users/example/Library/Logs/Okolos',
    bootstrap: '/Users/example/.okolos/bin/feed-agent/bootstrap.mjs',
    node: '/Users/example/.fnm/node-versions/v24/bin/node',
    sourceRepo: '/Users/example/DATA/okolos',
    origin: 'git@github.com:passioncode-ai/okolos.git',
  }
  const plist = (runner: string[] | null = ['/opt/py/bin/python3', '/opt/obs/tools/use_secret.py', 'run', '--env', 'prod', 'okolos', 'CLOUDFLARE_API_TOKEN', '--']) =>
    rendered({ template: template(), runner, ...where })
  const program = (text: string) => /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? ''
  const variable = (text: string, name: string) => new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`).exec(text)?.[1]

  it('starts the bootstrap outside the checkout, never a cd into it (B-159)', () => {
    const text = program(plist())
    expect(text).toContain("b='/Users/example/.okolos/bin/feed-agent/bootstrap.mjs'")
    expect(text).toContain('then n=node')
    expect(text).toContain('&quot;$n&quot; &quot;$b&quot;'.replaceAll('&quot;', '"'))
    expect(text).not.toContain('cd ')
    expect(text).not.toContain('agent-checkout')
  })

  it('falls back to the node that installed it when the login shell has none', () => {
    expect(program(plist())).toContain("else n='/Users/example/.fnm/node-versions/v24/bin/node'; fi")
  })

  it('tells the bootstrap where the checkout is and what to recreate it from', () => {
    const text = plist()
    expect(variable(text, 'OKOLOS_AGENT_CHECKOUT')).toBe('/Users/example/.okolos/agent-checkout')
    expect(variable(text, 'OKOLOS_SOURCE_REPO')).toBe('/Users/example/DATA/okolos')
    expect(variable(text, 'OKOLOS_ORIGIN_URL')).toBe('git@github.com:passioncode-ai/okolos.git')
  })

  it('renders an empty origin when the clone has none, which the bootstrap reads as none', () => {
    expect(variable(rendered({ template: template(), runner: null, ...where, origin: '' }), 'OKOLOS_ORIGIN_URL')).toBe('')
  })

  // plutil and launchd exist only on macOS; elsewhere there is nothing to load the plist.
  it.skipIf(process.platform !== 'darwin')('is a plist plutil accepts', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'okolos-plist-')), 'agent.plist')
    writeFileSync(file, plist())
    const lint = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' })
    expect(lint.status, lint.stdout + lint.stderr).toBe(0)
  })

  it('keeps the secret runner out of the command line: it wraps only the publish step', () => {
    const text = plist()
    expect(program(text)).not.toContain('use_secret')
    expect(text).toMatch(/<key>OKOLOS_SECRET_RUNNER<\/key>\s*<string>\[&quot;\/opt\/py\/bin\/python3&quot;/)
  })

  it('turns wrangler telemetry off for the whole job', () => {
    expect(plist()).toMatch(/<key>WRANGLER_SEND_METRICS<\/key>\s*<string>false<\/string>/)
  })

  it('logs to ~/Library/Logs/Okolos, never /tmp', () => {
    expect(plist()).toContain('<string>/Users/example/Library/Logs/Okolos/feed.launchd.log</string>')
    expect(plist()).not.toContain('/tmp/')
  })

  it('holds no "--" inside a comment, which XML forbids', () => {
    const bad = (template().match(/<!--([\s\S]*?)-->/g) ?? []).filter((comment) => comment.slice(4, -3).includes('--'))
    expect(bad.map((comment) => comment.slice(0, 60))).toEqual([])
  })

  it('leaves no placeholder behind, and rewrites no comment', () => {
    expect(plist()).not.toContain('{{')
    const comments = (text: string) => (text.match(/<!--[\s\S]*?-->/g) ?? []).join('\n')
    expect(comments(plist())).toBe(comments(template()))
  })

  it('still renders without a secret runner, as an empty variable the job reads as none', () => {
    expect(plist(null)).toMatch(/<key>OKOLOS_SECRET_RUNNER<\/key>\s*<string><\/string>/)
  })

  it('refuses a template that lost a placeholder rather than guessing', () => {
    expect(() => rendered({ template: template().replace('{{CHECKOUT}}', '/x'), runner: null, ...where })).toThrow(/CHECKOUT/)
    expect(() => rendered({ template: template().replaceAll('{{BOOTSTRAP}}', '/x'), runner: null, ...where })).toThrow(/BOOTSTRAP/)
  })
})

describe('what is the agent doing', () => {
  it('reports the plist, launchd’s view and the last run in one answer', async () => {
    const h = home()
    writeFileSync(h.target, '<plist/>')
    mkdirSync(h.paths.state, { recursive: true })
    writeFileSync(h.paths.status, JSON.stringify({ outcome: 'published', version: 52, consecutiveFailures: 0 }))
    const launchd = fakeLaunchd({ loaded: true })
    const status = await agentStatus({ ...base, target: h.target, launchctl: launchd.launchctl, paths: h.paths })
    expect(status).toMatchObject({ plist: true, loaded: true, launchd: { state: 'not running', runs: 3, lastExit: 0 }, lastRun: { outcome: 'published', version: 52 } })
    expect(status.bootstrap).toBe(false)
  })
})

describe('the bootstrap launchd starts lives outside the checkout (B-159)', () => {
  it('copies the bootstrap and every module it imports', () => {
    const h = home()
    installBootstrap({ dir: h.paths.agentBin })
    for (const file of BOOTSTRAP_FILES) {
      const copy = path.join(h.paths.agentBin, file)
      expect(readFileSync(copy, 'utf8'), file).toBe(readFileSync(path.join(repo, 'tools/feed', file), 'utf8'))
    }
    expect(existsSync(h.paths.bootstrap)).toBe(true)
  })

  // POSIX modes: Windows reports 0o666/0o444 whatever was asked. The agent is a
  // launchd agent, macOS only (ADR-0017).
  it.skipIf(process.platform === 'win32')('keeps the copy owner-only', () => {
    const h = home()
    installBootstrap({ dir: h.paths.agentBin })
    expect(statSync(h.paths.agentBin).mode & 0o777).toBe(0o700)
  })

  it('replaces an older copy whole, so no stale module survives an update', () => {
    const h = home()
    mkdirSync(h.paths.agentBin, { recursive: true })
    writeFileSync(path.join(h.paths.agentBin, 'retired.mjs'), '')
    installBootstrap({ dir: h.paths.agentBin })
    expect(existsSync(path.join(h.paths.agentBin, 'retired.mjs'))).toBe(false)
    expect(filesIn(h.paths.agentBin, '')).toEqual([...BOOTSTRAP_FILES].sort())
  })

  it('runs from the installed copy alone: a missing checkout ends in a written status, not a shell error', () => {
    const h = home()
    installBootstrap({ dir: h.paths.agentBin })
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: h.dir,
      OKOLOS_STATE_DIR: h.paths.state,
      OKOLOS_LOG_DIR: h.paths.logs,
      OKOLOS_AGENT_CHECKOUT: h.paths.agentCheckout,
      OKOLOS_AGENT_BIN: h.paths.agentBin,
      OKOLOS_SOURCE_REPO: path.join(h.dir, 'no-such-clone'),
      OKOLOS_ORIGIN_URL: '',
    }
    const result = spawnSync(process.execPath, [h.paths.bootstrap], { env, encoding: 'utf8', timeout: 20_000 })
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toMatch(/feed-agent: failed in checkout: .*missing/)
    expect(readStatus(h.paths.status)).toMatchObject({ outcome: 'failed', stage: 'checkout', consecutiveFailures: 1, recoveredCheckout: false })
    expect(readFileSync(h.paths.log, 'utf8')).toMatch(/is missing; recreating it/)
  })
})

/**
 * The launch line: what launchd runs before any of our JavaScript (B-159, fix
 * round 2). When node cannot start, the bootstrap copy is gone, or node exits
 * non-zero before the bootstrap wrote a record, the line itself writes a minimal
 * status (stage "launch") and a feed.log line, with /bin/sh and coreutils only.
 * These tests run the rendered line, so they test the plist launchd reads.
 */
// /bin/sh and launchd: the feed agent is a launchd agent, macOS only (ADR-0017).
describe.skipIf(process.platform === 'win32')('the launch line records what fails before the bootstrap', () => {
  const unxml = (text: string) =>
    text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&')

  function launch(h: ReturnType<typeof home>, { node = process.execPath, bootstrap, pathEnv }: { node?: string; bootstrap?: string; pathEnv?: string } = {}) {
    const text = rendered({
      template: template(),
      runner: null,
      checkout: h.paths.agentCheckout,
      logDir: h.paths.logs,
      stateDir: h.paths.state,
      bootstrap: h.paths.bootstrap,
      node,
      sourceRepo: '/nowhere',
      origin: '',
    })
    const line = unxml(/<key>ProgramArguments<\/key>\s*<array>[\s\S]*?<string>[\s\S]*?<\/string>\s*<string>[\s\S]*?<\/string>\s*<string>([\s\S]*?)<\/string>/.exec(text)?.[1] ?? '')
    if (bootstrap !== undefined) {
      mkdirSync(h.paths.agentBin, { recursive: true })
      writeFileSync(h.paths.bootstrap, bootstrap)
    }
    const env = {
      HOME: h.dir,
      PATH: pathEnv ?? [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      OKOLOS_STATE_DIR: h.paths.state,
    }
    return spawnSync('/bin/sh', ['-c', line], { env, encoding: 'utf8', timeout: 20_000 })
  }

  /** A stand-in bootstrap that writes the record the real one would, under the launch id. */
  const writesItsRecord = (exit: number) => `
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const file = path.join(process.env.OKOLOS_STATE_DIR, 'feed-status.json')
mkdirSync(path.dirname(file), { recursive: true })
writeFileSync(file, JSON.stringify({ outcome: 'failed', stage: 'checkout', exit: ${exit}, runId: process.env.OKOLOS_LAUNCH_ID, consecutiveFailures: 1, lastPublished: null }, null, 2) + '\\n')
process.exit(${exit})
`

  it('records a missing bootstrap copy, counts it, and says so in feed.log and launchd’s log', () => {
    const h = home()
    const result = launch(h)
    expect(result.status).toBe(1)
    const status = readStatus(h.paths.status)
    expect(status).toMatchObject({ outcome: 'failed', stage: 'launch', exit: 1, consecutiveFailures: 1, lastPublished: null })
    expect(status?.reason).toMatch(/bootstrap .* is missing.*pnpm feed:agent/)
    expect(status?.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    expect(readFileSync(h.paths.log, 'utf8')).toMatch(/failed in launch: the installed bootstrap/)
    expect(result.stderr).toMatch(/feed-agent: failed in launch/)
    expect(statSync(h.paths.status).mode & 0o777).toBe(0o600)
  })

  // On a host whose system folders carry a node, "no node on PATH" cannot be arranged.
  it.skipIf(existsSync('/usr/bin/node') || existsSync('/bin/node'))('records a node that cannot be found', () => {
    const h = home()
    const result = launch(h, { node: path.join(h.dir, 'gone', 'node'), bootstrap: 'process.exit(0)\n', pathEnv: '/usr/bin:/bin' })
    expect(result.status).toBe(127)
    expect(readStatus(h.paths.status)).toMatchObject({ outcome: 'failed', stage: 'launch', exit: 127 })
    expect(readStatus(h.paths.status)?.reason).toMatch(/no node/)
  })

  it('records node exiting non-zero before the bootstrap wrote anything', () => {
    const h = home()
    const result = launch(h, { bootstrap: 'process.exit(3)\n' })
    expect(result.status).toBe(3)
    expect(readStatus(h.paths.status)).toMatchObject({ outcome: 'failed', stage: 'launch', exit: 3 })
  })

  it('leaves a record the bootstrap wrote for this launch alone', () => {
    const h = home()
    const result = launch(h, { bootstrap: writesItsRecord(1) })
    expect(result.status).toBe(1)
    expect(readStatus(h.paths.status)).toMatchObject({ stage: 'checkout', consecutiveFailures: 1 })
    expect(existsSync(h.paths.log)).toBe(false)
  })

  it('writes nothing for a success or for a run refused by the lock', () => {
    for (const exit of [0, 75]) {
      const h = home()
      const result = launch(h, { bootstrap: `process.exit(${exit})\n` })
      expect(result.status).toBe(exit)
      expect(existsSync(h.paths.status), `exit ${exit}`).toBe(false)
    }
  })

  it('counts on from the previous record and keeps the last publish, as JSON the host can read', () => {
    const h = home()
    writeStatus(h.paths.status, { startedAt: 'a', at: 'a', outcome: 'published', stage: 'done', exit: 0, version: 65, entries: 220 })
    writeStatus(h.paths.status, { startedAt: 'b', at: 'b', outcome: 'failed', stage: 'publish', exit: 1 })
    launch(h)
    launch(h)
    const status = readStatus(h.paths.status)
    expect(status).toMatchObject({ stage: 'launch', consecutiveFailures: 3, lastPublished: { version: 65, entries: 220, at: 'a' } })
  })
})

describe('the node the plist falls back to', () => {
  /** A Homebrew-like layout: a versioned binary and a stable link to it on PATH. */
  function brew() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-node-'))
    const versioned = path.join(dir, 'Cellar/node/26.10.0_2/bin/node')
    mkdirSync(path.dirname(versioned), { recursive: true })
    writeFileSync(versioned, '#!/bin/sh\n')
    chmodSync(versioned, 0o755)
    mkdirSync(path.join(dir, 'bin'))
    symlinkSync(versioned, path.join(dir, 'bin/node'))
    const other = path.join(dir, 'other/node')
    mkdirSync(path.dirname(other))
    writeFileSync(other, '#!/bin/sh\n')
    chmodSync(other, 0o755)
    return { dir, versioned, link: path.join(dir, 'bin/node'), other }
  }

  // Symbolic links need a privilege on Windows; the plist that uses this is a launchd agent, macOS only.
  it.skipIf(process.platform === 'win32')('is the PATH entry that leads to the running node, not its versioned realpath (a brew upgrade removes that)', () => {
    const b = brew()
    const pathEnv = [path.dirname(b.other), path.join(b.dir, 'bin')].join(path.delimiter)
    expect(stableNode({ execPath: b.versioned, pathEnv })).toBe(b.link)
  })

  it.skipIf(process.platform === 'win32')('skips a different node earlier on PATH', () => {
    const b = brew()
    expect(stableNode({ execPath: b.versioned, pathEnv: path.dirname(b.other) })).toBe(b.versioned)
  })

  it('is the running node itself when PATH has no way to it', () => {
    expect(stableNode({ execPath: '/opt/node/bin/node', pathEnv: '' })).toBe('/opt/node/bin/node')
  })
})

describe('whether the installed bootstrap is the checkout’s', () => {
  function installed() {
    const h = home()
    installBootstrap({ dir: h.paths.agentBin })
    const from = path.join(h.paths.agentCheckout, 'tools/feed')
    mkdirSync(from, { recursive: true })
    for (const file of BOOTSTRAP_FILES) writeFileSync(path.join(from, file), readFileSync(path.join(repo, 'tools/feed', file)))
    return { h, from }
  }

  it('matches when every module hashes the same', () => {
    const { h, from } = installed()
    expect(bootstrapDrift({ bin: h.paths.agentBin, from })).toEqual({ matches: true, differs: [] })
  })

  it('names the modules that changed on main since the install', () => {
    const { h, from } = installed()
    writeFileSync(path.join(from, 'status.mjs'), '// changed on main\n')
    writeFileSync(path.join(from, 'newer.mjs'), '')
    writeFileSync(path.join(h.paths.agentBin, 'newer.mjs'), 'older')
    expect(bootstrapDrift({ bin: h.paths.agentBin, from })).toEqual({ matches: false, differs: ['newer.mjs', 'status.mjs'] })
  })

  it('cannot say when there is no checkout to compare with', () => {
    const h = home()
    installBootstrap({ dir: h.paths.agentBin })
    expect(bootstrapDrift({ bin: h.paths.agentBin, from: path.join(h.paths.agentCheckout, 'tools/feed') })).toEqual({ matches: null, differs: [] })
  })

  it('reports drift, and whether the plist starts the bootstrap, in --status', async () => {
    const { h, from } = installed()
    writeFileSync(path.join(from, 'log.mjs'), '// changed\n')
    writeFileSync(h.target, rendered({ template: template(), runner: null, checkout: h.paths.agentCheckout, logDir: h.paths.logs, bootstrap: h.paths.bootstrap }))
    const status = await agentStatus({ ...base, target: h.target, launchctl: fakeLaunchd({ loaded: true }).launchctl, paths: h.paths })
    expect(status).toMatchObject({ bootstrap: true, plistStartsBootstrap: true, bootstrapMatchesCheckout: false, bootstrapDiffers: ['log.mjs'] })
    expect(status.note).toMatch(/differs .* pnpm feed:agent/)
  })

  it('says when the plist is the old one that cd’d into the checkout', async () => {
    const h = home()
    writeFileSync(h.target, '<plist><key>ProgramArguments</key><array><string>/bin/sh</string><string>-lc</string><string>cd x &amp;&amp; exec node tools/feed-job.mjs --agent</string></array></plist>')
    const status = await agentStatus({ ...base, target: h.target, launchctl: fakeLaunchd({ loaded: true }).launchctl, paths: h.paths })
    expect(status.plistStartsBootstrap).toBe(false)
    expect(status.note).toMatch(/old plist/)
  })
})

describe('the installer installs from main only (ADR-0017)', () => {
  const git = (answers: Record<string, string>) => async (_command: string, args: string[]) => {
    const key = args.slice(2).join(' ')
    return key in answers ? ok(`${answers[key]}\n`) : { ...ok(), code: 128, stderr: `unexpected ${key}` }
  }
  const sha = (c: string) => c.repeat(40)

  it('accepts the main branch', async () => {
    expect(await checkBranch({ repo: '/r', tool: git({ 'rev-parse --abbrev-ref HEAD': 'main' }) })).toMatchObject({ ok: true, branch: 'main' })
  })

  it('accepts a detached HEAD at origin/main', async () => {
    const tool = git({ 'rev-parse --abbrev-ref HEAD': 'HEAD', 'rev-parse HEAD': sha('a'), 'rev-parse origin/main': sha('a') })
    expect(await checkBranch({ repo: '/r', tool })).toMatchObject({ ok: true })
  })

  it('refuses a feature branch, naming it and the override', async () => {
    const result = await checkBranch({ repo: '/r', tool: git({ 'rev-parse --abbrev-ref HEAD': 'sw/sw-03' }) })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/sw\/sw-03.*origin\/main.*--allow-branch/)
  })

  it('refuses a detached HEAD elsewhere, and a clone git cannot read', async () => {
    const tool = git({ 'rev-parse --abbrev-ref HEAD': 'HEAD', 'rev-parse HEAD': sha('b'), 'rev-parse origin/main': sha('a') })
    expect((await checkBranch({ repo: '/r', tool })).ok).toBe(false)
    expect((await checkBranch({ repo: '/r', tool: git({}) })).ok).toBe(false)
  })
})

describe('where the agent recreates its checkout from', () => {
  it('reads the origin URL of the clone the installer runs in', async () => {
    const seen: string[][] = []
    const url = await originUrl({ repo: '/repo', tool: async (command: string, args: string[]) => (seen.push([command, ...args]), ok('git@github.com:passioncode-ai/okolos.git\n')) })
    expect(url).toBe('git@github.com:passioncode-ai/okolos.git')
    expect(seen).toEqual([['git', '-C', '/repo', 'remote', 'get-url', 'origin']])
  })

  it('answers empty when there is no origin, and the bootstrap then uses the clone alone', async () => {
    expect(await originUrl({ repo: '/repo', tool: async () => ({ ...ok(), code: 2, stderr: 'No such remote' }) })).toBe('')
  })
})
