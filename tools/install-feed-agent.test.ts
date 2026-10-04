import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { feedPaths } from './feed/paths.mjs'
import {
  LABEL,
  agentStatus,
  ensureCheckout,
  installAgent,
  isDisabled,
  rendered,
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

function home() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-agent-home-'))
  const target = path.join(dir, 'Library/LaunchAgents', `${TEST_LABEL}.plist`)
  mkdirSync(path.dirname(target), { recursive: true })
  return { dir, target, paths: feedPaths({}, dir) }
}

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
    const result = await uninstallAgent({
      ...base,
      target: h.target,
      launchctl: launchd.launchctl,
      purge: { repo: '/repo', paths: h.paths, tool },
    })
    expect(result.ok).toBe(true)
    expect(tools).toContainEqual(['git', '-C', '/repo', 'worktree', 'remove', '--force', h.paths.agentCheckout])
    for (const dir of [h.paths.agentCheckout, h.paths.state, h.paths.logs]) expect(existsSync(dir), dir).toBe(false)
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
  const plist = (runner: string[] | null = ['/opt/py/bin/python3', '/opt/obs/tools/use_secret.py', 'run', '--env', 'prod', 'okolos', 'CLOUDFLARE_API_TOKEN', '--']) =>
    rendered({ template: template(), checkout: '/Users/example/.okolos/agent-checkout', runner, logDir: '/Users/example/Library/Logs/Okolos' })

  it('runs the job from the agent checkout, in agent mode', () => {
    expect(plist()).toContain("cd '/Users/example/.okolos/agent-checkout' &amp;&amp; exec node tools/feed-job.mjs --agent")
  })

  it('keeps the secret runner out of the command line: it wraps only the publish step', () => {
    const text = plist()
    const program = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? ''
    expect(program).not.toContain('use_secret')
    expect(text).toMatch(/<key>OKOLOS_SECRET_RUNNER<\/key>\s*<string>\[&quot;\/opt\/py\/bin\/python3&quot;/)
  })

  it('turns wrangler telemetry off for the whole job', () => {
    expect(plist()).toMatch(/<key>WRANGLER_SEND_METRICS<\/key>\s*<string>false<\/string>/)
  })

  it('logs to ~/Library/Logs/Okolos, never /tmp', () => {
    expect(plist()).toContain('<string>/Users/example/Library/Logs/Okolos/feed.launchd.log</string>')
    expect(plist()).not.toContain('/tmp/')
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
    expect(() => rendered({ template: template().replace('{{CHECKOUT}}', '/x'), checkout: '/c', runner: null, logDir: '/l' })).toThrow(/CHECKOUT/)
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
  })
})
