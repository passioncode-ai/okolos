import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { EXIT as JOB_EXIT } from '../feed-job.mjs'
import { runBounded } from './bounded.mjs'
import { BOOTSTRAP_FILES, checkoutHealth, EXIT, recoverCheckout, runAgent } from './bootstrap.mjs'
import { acquireLock } from './lock.mjs'
import { feedPaths } from './paths.mjs'
import { readStatus } from './status.mjs'

/**
 * The feed agent's entry point (B-159): what launchd starts, from outside the
 * checkout, so a missing checkout is a recorded failure or a recovery, never a
 * silent `cd` error.
 *
 * Observed 2026-10-09…2026-10-26 (B-149): the plist `cd`'d into
 * ~/.okolos/agent-checkout, the folder was gone, the job never started, and
 * feed-status.json kept `consecutiveFailures: 0` for seventeen days while
 * production served a stale feed. Git and pnpm are doubles in most tests; the
 * last block runs real git against throwaway repositories, because "prune, then
 * add" is a claim about git's behaviour that only git can confirm. Nothing here
 * touches the real ~/.okolos, launchd or the network.
 */

const ok = (stdout = '') => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false })
const failed = (stderr: string, code = 128) => ({ code, signal: null, stdout: '', stderr, timedOut: false })

function world() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'okolos-bootstrap-'))
  const paths = feedPaths(
    {
      OKOLOS_STATE_DIR: path.join(base, 'state'),
      OKOLOS_LOG_DIR: path.join(base, 'logs'),
      OKOLOS_AGENT_CHECKOUT: path.join(base, 'agent-checkout'),
      OKOLOS_AGENT_BIN: path.join(base, 'bin'),
    },
    base,
  )
  const source = path.join(base, 'source')
  mkdirSync(source)
  return { base, paths, source }
}

/** A checkout that passes the health check: the job's entry point is there, and git owns the folder. */
function plantCheckout(checkout: string) {
  mkdirSync(path.join(checkout, 'tools'), { recursive: true })
  writeFileSync(path.join(checkout, 'tools/feed-job.mjs'), '')
}

type Options = { fetchFails?: boolean; addFails?: boolean; sourceIsRepo?: boolean; createsCheckout?: boolean }

/** Git and pnpm as the bootstrap sees them. `worktree add` and `clone` create the folder, as git would. */
function fakeTool(w: ReturnType<typeof world>, { fetchFails = false, addFails = false, sourceIsRepo = true, createsCheckout = true }: Options = {}) {
  const calls: string[][] = []
  const tool = async (command: string, args: string[]) => {
    calls.push([command, ...args])
    if (command === 'pnpm') return ok()
    const dir = args[0] === '-C' ? args[1] : null
    const verb = dir ? args[2] : args[0]
    if (verb === 'rev-parse' && args.includes('--show-toplevel')) return ok(`${dir}\n`)
    if (verb === 'rev-parse' && args.includes('--git-dir')) return sourceIsRepo ? ok('.git\n') : failed('fatal: not a git repository')
    if (verb === 'rev-parse') return ok(`${'d'.repeat(40)}\n`)
    if (verb === 'worktree' && args[3] === 'prune') return ok()
    if (verb === 'fetch') return fetchFails ? failed('fatal: unable to access origin: Could not resolve host') : ok()
    if (verb === 'worktree' && args[3] === 'add') {
      if (addFails) return failed(`fatal: '${args.at(-2)}' is a missing but already registered worktree`)
      if (createsCheckout) plantCheckout(args.at(-2) as string)
      return ok()
    }
    if (verb === 'clone') {
      if (createsCheckout) plantCheckout(args.at(-1) as string)
      return ok()
    }
    if (verb === 'checkout') return ok()
    return failed(`unexpected ${command} ${args.join(' ')}`, 1)
  }
  return { tool, calls }
}

/** The job, as a double: records how it was started, writes its record the way feed-job does, exits. */
function fakeJob(w: ReturnType<typeof world>, behaviour: 'publishes' | 'crashes' | 'lockHeld' | 'hangs' = 'publishes') {
  const starts: Array<{ command: string; args: string[]; env: Record<string, string | undefined>; cwd?: string }> = []
  const run = async (command: string, args: string[], options: { env?: Record<string, string | undefined>; cwd?: string }) => {
    const env = options.env ?? {}
    starts.push({ command, args, env, cwd: options.cwd })
    if (behaviour === 'crashes') return failed('SyntaxError: Unexpected token in tools/feed-job.mjs', 1)
    if (behaviour === 'lockHeld') return { ...ok(), code: 75 }
    if (behaviour === 'hangs') return { code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true }
    mkdirSync(path.dirname(w.paths.status), { recursive: true })
    writeFileSync(
      w.paths.status,
      JSON.stringify({
        startedAt: 'x',
        at: 'y',
        outcome: 'published',
        stage: 'done',
        exit: 0,
        runId: env.OKOLOS_RUN_ID,
        recoveredCheckout: Boolean(env.OKOLOS_RECOVERED_CHECKOUT),
        consecutiveFailures: 0,
      }),
    )
    return ok()
  }
  return { run, starts }
}

function agent(w: ReturnType<typeof world>, overrides: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const lines: string[] = []
  const promise = runAgent({
    paths: w.paths,
    env: { PATH: process.env.PATH ?? '', OKOLOS_SOURCE_REPO: w.source, OKOLOS_ORIGIN_URL: 'https://example.test/okolos.git', ...env },
    tool: fakeTool(w).tool,
    run: fakeJob(w).run,
    node: '/opt/node/bin/node',
    log: (line: string) => lines.push(line),
    ...overrides,
  })
  return { promise, lines }
}

describe('a missing checkout is recreated, and the record says so (B-159)', () => {
  it('recreates it as a worktree of the source clone at origin/main, then runs the job from it', async () => {
    const w = world()
    const git = fakeTool(w)
    const job = fakeJob(w)
    const { promise, lines } = agent(w, { tool: git.tool, run: job.run })
    const result = await promise

    expect(result.exit).toBe(0)
    const ran = git.calls.map((call) => call.join(' '))
    // Prune first: when the folder is deleted but git still lists the worktree,
    // `worktree add` refuses ("missing but already registered").
    expect(ran).toEqual([
      `git -C ${w.source} rev-parse --git-dir`,
      `git -C ${w.source} worktree prune`,
      `git -C ${w.source} fetch --quiet origin main`,
      `git -C ${w.source} worktree add --detach ${w.paths.agentCheckout} origin/main`,
      'pnpm install --frozen-lockfile --filter @okolos/proxy',
      `git -C ${w.paths.agentCheckout} rev-parse HEAD`,
    ])
    expect(job.starts).toHaveLength(1)
    expect(job.starts[0].args).toEqual([path.join(w.paths.agentCheckout, 'tools/feed-job.mjs'), '--agent'])
    expect(job.starts[0].cwd).toBe(w.paths.agentCheckout)
    expect(job.starts[0].env.OKOLOS_RECOVERED_CHECKOUT).toBe('missing')
    expect(readStatus(w.paths.status)).toMatchObject({ outcome: 'published', recoveredCheckout: true })
    expect(lines.join('\n')).toMatch(/is missing; recreating it/)
    expect(lines.join('\n')).toMatch(/recreated .* at ddddddd \(recoveredCheckout: true\)/)
  })

  it('installs the publish tools inside the new checkout, with no Cloudflare token in reach', async () => {
    const w = world()
    const seen: Array<{ command: string; cwd?: string; env?: Record<string, string | undefined> }> = []
    const git = fakeTool(w)
    await agent(
      w,
      {
        tool: async (command: string, args: string[], options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs: number }) => {
          expect(options.timeoutMs).toBeGreaterThan(0)
          seen.push({ command, cwd: options.cwd, env: options.env })
          return git.tool(command, args)
        },
      },
      { CLOUDFLARE_API_TOKEN: 'must-not-leak' },
    ).promise
    expect(seen.find((s) => s.command === 'pnpm')?.cwd).toBe(w.paths.agentCheckout)
    for (const s of seen) {
      expect(s.env?.CLOUDFLARE_API_TOKEN).toBeUndefined()
      if (s.command === 'git') expect(s.env?.GIT_TERMINAL_PROMPT).toBe('0')
    }
  })

  it('clones from origin when the source clone is gone too', async () => {
    const w = world()
    rmSync(w.source, { recursive: true })
    const git = fakeTool(w)
    const result = await agent(w, { tool: git.tool }).promise
    expect(result.exit).toBe(0)
    const ran = git.calls.map((call) => call.join(' '))
    expect(ran).toContain(`git clone --quiet --no-checkout https://example.test/okolos.git ${w.paths.agentCheckout}`)
    expect(ran).toContain(`git -C ${w.paths.agentCheckout} checkout --quiet --detach origin/main`)
    expect(ran.some((line) => line.includes('worktree add'))).toBe(false)
  })

  it('moves a broken checkout aside and recreates it, keeping the broken one as evidence (B-150)', async () => {
    const w = world()
    mkdirSync(w.paths.agentCheckout, { recursive: true })
    writeFileSync(path.join(w.paths.agentCheckout, 'leftover.txt'), 'what the cleaner left')
    const job = fakeJob(w)
    const { promise, lines } = agent(w, { run: job.run })
    const result = await promise
    expect(result.exit).toBe(0)
    expect(readFileSync(path.join(`${w.paths.agentCheckout}.broken`, 'leftover.txt'), 'utf8')).toBe('what the cleaner left')
    expect(existsSync(path.join(w.paths.agentCheckout, 'tools/feed-job.mjs'))).toBe(true)
    expect(job.starts[0].env.OKOLOS_RECOVERED_CHECKOUT).toMatch(/^broken: /)
    expect(lines.join('\n')).toMatch(/is broken \(.*tools\/feed-job\.mjs.*\)/)
  })

  it('leaves a healthy checkout to the job, which fast-forwards it', async () => {
    const w = world()
    plantCheckout(w.paths.agentCheckout)
    const git = fakeTool(w)
    const job = fakeJob(w)
    await agent(w, { tool: git.tool, run: job.run }).promise
    expect(git.calls.map((call) => call.join(' '))).toEqual([`git -C ${w.paths.agentCheckout} rev-parse --show-toplevel`])
    expect(job.starts[0].env.OKOLOS_RECOVERED_CHECKOUT).toBeUndefined()
    expect(readStatus(w.paths.status)).toMatchObject({ recoveredCheckout: false })
  })
})

describe('no failure path is silent (B-159)', () => {
  it('records stage "checkout" when the checkout cannot be recreated, and counts it', async () => {
    const w = world()
    const job = fakeJob(w)
    const first = await agent(w, { tool: fakeTool(w, { fetchFails: true }).tool, run: job.run }).promise
    const { promise, lines } = agent(w, { tool: fakeTool(w, { fetchFails: true }).tool, run: job.run })
    const second = await promise

    expect(first.exit).toBe(1)
    expect(second.exit).toBe(1)
    expect(job.starts, 'the job must not start without a checkout').toEqual([])
    const status = readStatus(w.paths.status)
    expect(status).toMatchObject({ outcome: 'failed', stage: 'checkout', exit: 1, recoveredCheckout: false, consecutiveFailures: 2 })
    expect(status?.reason).toMatch(/missing.*git fetch.*Could not resolve host/)
    expect(lines.join('\n')).toMatch(/failed in checkout: .*Could not resolve host/)
  })

  it('records the failure when git refuses to add the worktree', async () => {
    const w = world()
    const result = await agent(w, { tool: fakeTool(w, { addFails: true }).tool }).promise
    expect(result.exit).toBe(1)
    expect(readStatus(w.paths.status)).toMatchObject({ outcome: 'failed', stage: 'checkout' })
    expect(readStatus(w.paths.status)?.reason).toMatch(/already registered/)
  })

  it('says what is missing when there is nothing to recreate the checkout from', async () => {
    const w = world()
    rmSync(w.source, { recursive: true })
    const result = await agent(w, {}, { OKOLOS_ORIGIN_URL: '' }).promise
    expect(result.exit).toBe(1)
    expect(readStatus(w.paths.status)?.reason).toMatch(/no source.*pnpm feed:agent/)
  })

  it('records a recovery that reported success but left no job to run', async () => {
    const w = world()
    const result = await agent(w, { tool: fakeTool(w, { createsCheckout: false }).tool }).promise
    expect(result.exit).toBe(1)
    expect(readStatus(w.paths.status)).toMatchObject({ outcome: 'failed', stage: 'checkout' })
  })

  it('records a job that died before writing its own record', async () => {
    const w = world()
    plantCheckout(w.paths.agentCheckout)
    const { promise, lines } = agent(w, { run: fakeJob(w, 'crashes').run })
    const result = await promise
    expect(result.exit).toBe(1)
    expect(readStatus(w.paths.status)).toMatchObject({ outcome: 'failed', stage: 'job', exit: 1, consecutiveFailures: 1 })
    expect(readStatus(w.paths.status)?.reason).toMatch(/SyntaxError/)
    expect(lines.join('\n')).toMatch(/failed in job: /)
  })

  it('keeps the recovery in the record when the job dies after it', async () => {
    const w = world()
    await agent(w, { run: fakeJob(w, 'crashes').run }).promise
    expect(readStatus(w.paths.status)).toMatchObject({ outcome: 'failed', stage: 'job', recoveredCheckout: true, recovery: 'missing' })
  })

  it('records a job the backstop deadline had to kill', async () => {
    const w = world()
    plantCheckout(w.paths.agentCheckout)
    const result = await agent(w, { run: fakeJob(w, 'hangs').run }).promise
    expect(result.exit).toBe(EXIT.watchdog)
    expect(readStatus(w.paths.status)).toMatchObject({ outcome: 'failed', stage: 'job', exit: EXIT.watchdog })
  })

  it('keeps the job’s own record when it wrote one, failure count included', async () => {
    const w = world()
    plantCheckout(w.paths.agentCheckout)
    const result = await agent(w).promise
    expect(result.exit).toBe(0)
    expect(result.record).toMatchObject({ outcome: 'published', stage: 'done' })
    expect(readStatus(w.paths.status)?.runId).toBe(result.record?.runId)
  })

  it('leaves the status alone when another run holds the lock: that record is the other run’s', async () => {
    const w = world()
    const held = acquireLock(w.paths.lock)
    try {
      const git = fakeTool(w)
      const result = await agent(w, { tool: git.tool }).promise
      expect(result.exit).toBe(EXIT.lockHeld)
      expect(git.calls, 'no recovery under another run’s lock').toEqual([])
      expect(existsSync(w.paths.status)).toBe(false)
    } finally {
      held.release()
    }
  })

  it('does not hold the lock while the job runs, so the job can take it', async () => {
    const w = world()
    plantCheckout(w.paths.agentCheckout)
    let lockedDuringJob = true
    await agent(w, {
      run: async () => {
        lockedDuringJob = existsSync(w.paths.lock)
        return { ...ok(), code: 75 }
      },
    }).promise
    expect(lockedDuringJob).toBe(false)
  })

  it('treats a job refused by the lock as a refusal, not a failure', async () => {
    const w = world()
    plantCheckout(w.paths.agentCheckout)
    const result = await agent(w, { run: fakeJob(w, 'lockHeld').run }).promise
    expect(result.exit).toBe(EXIT.lockHeld)
    expect(existsSync(w.paths.status)).toBe(false)
  })

  it('writes its lines to the durable log when no log is injected', async () => {
    const w = world()
    await agent(w, { log: undefined, tool: fakeTool(w, { fetchFails: true }).tool }).promise
    expect(readFileSync(w.paths.log, 'utf8')).toMatch(/failed in checkout: /)
  })

  it('uses the job’s exit codes, so a host reads one table', () => {
    expect(EXIT).toEqual(JOB_EXIT)
  })
})

describe('the health check', () => {
  it('calls a folder that git does not own broken, even when the job file is there', async () => {
    const w = world()
    plantCheckout(w.paths.agentCheckout)
    const tool = async () => ok(`${w.base}\n`)
    expect(await checkoutHealth({ checkout: w.paths.agentCheckout, tool })).toMatchObject({ state: 'broken' })
  })

  it('names what it found missing', async () => {
    const w = world()
    expect(await checkoutHealth({ checkout: w.paths.agentCheckout, tool: async () => ok() })).toMatchObject({ state: 'missing' })
  })
})

describe('the files installed beside launchd', () => {
  it('are every module the bootstrap imports, and nothing from outside tools/feed', () => {
    const dir = path.join(import.meta.dirname)
    const imported = new Set<string>(['bootstrap.mjs'])
    for (const file of BOOTSTRAP_FILES) {
      const text = readFileSync(path.join(dir, file), 'utf8')
      for (const match of text.matchAll(/^import [^'"]*['"]([^'"]+)['"]/gm)) {
        const specifier = match[1]
        if (specifier.startsWith('node:')) continue
        expect(specifier, `${file} imports ${specifier}, which the installed copy would not find`).toMatch(/^\.\/[\w-]+\.mjs$/)
        imported.add(specifier.slice(2))
      }
    }
    expect([...imported].sort()).toEqual([...BOOTSTRAP_FILES].sort())
  })
})

describe('with real git (B-150: the folder deleted, git still listing it)', () => {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name]
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { env, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }

  /** origin (bare) with one commit on main, and a source clone of it. */
  function repos() {
    const w = world()
    const origin = path.join(w.base, 'origin.git')
    const seed = path.join(w.base, 'seed')
    git('init', '--quiet', '--bare', '--initial-branch=main', origin)
    git('init', '--quiet', '--initial-branch=main', seed)
    mkdirSync(path.join(seed, 'tools'))
    writeFileSync(path.join(seed, 'tools/feed-job.mjs'), '// job\n')
    git('-C', seed, 'add', '.')
    git('-C', seed, 'commit', '--quiet', '-m', 'seed')
    git('-C', seed, 'push', '--quiet', origin, 'main')
    rmSync(w.source, { recursive: true })
    git('clone', '--quiet', origin, w.source)
    return { ...w, origin, head: git('-C', seed, 'rev-parse', 'HEAD') }
  }

  /** Real git, bounded; pnpm skipped (it would reach the registry). */
  const tool = async (command: string, args: string[], options: Parameters<typeof runBounded>[2]) =>
    command === 'pnpm' ? ok() : runBounded(command, args, { ...options, env: { ...env, ...options.env } })

  it('recreates a worktree whose folder was deleted while git still lists it', async () => {
    const r = repos()
    git('-C', r.source, 'worktree', 'add', '--quiet', '--detach', r.paths.agentCheckout, 'origin/main')
    rmSync(r.paths.agentCheckout, { recursive: true })
    expect(git('-C', r.source, 'worktree', 'list')).toContain(r.paths.agentCheckout)

    const health = await checkoutHealth({ checkout: r.paths.agentCheckout, tool, env })
    expect(health.state).toBe('missing')
    const done = await recoverCheckout({ checkout: r.paths.agentCheckout, sourceRepo: r.source, origin: r.origin, tool, env })
    expect(done.commit).toBe(r.head)
    expect(await checkoutHealth({ checkout: r.paths.agentCheckout, tool, env })).toEqual({ state: 'ok' })
  }, 30_000)

  it('calls a worktree whose git metadata was wiped broken', async () => {
    const r = repos()
    git('-C', r.source, 'worktree', 'add', '--quiet', '--detach', r.paths.agentCheckout, 'origin/main')
    rmSync(path.join(r.source, '.git/worktrees'), { recursive: true })
    const health = await checkoutHealth({ checkout: r.paths.agentCheckout, tool, env })
    expect(health.state).toBe('broken')
  }, 30_000)

  it('clones from origin at origin/main when there is no source clone', async () => {
    const r = repos()
    const done = await recoverCheckout({ checkout: r.paths.agentCheckout, sourceRepo: path.join(r.base, 'gone'), origin: r.origin, tool, env })
    expect(done.commit).toBe(r.head)
    expect(git('-C', r.paths.agentCheckout, 'status', '--porcelain')).toBe('')
    expect(await checkoutHealth({ checkout: r.paths.agentCheckout, tool, env })).toEqual({ state: 'ok' })
  }, 30_000)
})
