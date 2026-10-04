import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { acquireLock } from './feed/lock.mjs'
import { feedPaths } from './feed/paths.mjs'
import { readStatus } from './feed/status.mjs'
import { runJob, STALE_AFTER_MS, sweepLeftovers } from './feed-job.mjs'

/**
 * The feed agent's run: bounded, exclusive, observable (LC-03), pinned (F2), with
 * the token only where it is used and failures recorded where a host can read them
 * (F3). The stages are real child processes — fakes of ingest and publish in a
 * fixture repository — so the watchdog, the process groups and the environment are
 * the real ones. Git, pnpm and the worker are doubles; nothing here touches the
 * network, the operator's launchd domain or production.
 */

const node = process.execPath

/** Stand-ins for tools/ingest.mjs and tools/publish-feed.mjs, steered by FAKE_* variables. */
const FAKE_STAGE = (stage: 'ingest' | 'publish') => `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const dir = process.env.FAKE_DIR
const mode = process.env.FAKE_${stage.toUpperCase()} ?? 'ok'
appendFileSync(path.join(dir, '${stage}.calls'), JSON.stringify({
  argv: process.argv.slice(2),
  token: process.env.CLOUDFLARE_API_TOKEN ?? null,
  lock: process.env.OKOLOS_FEED_LOCK ? 'inherited' : null,
  metrics: process.env.WRANGLER_SEND_METRICS ?? null,
  wranglerLogs: process.env.WRANGLER_LOG_PATH ?? null,
}) + '\\n')
if (mode === 'hang') {
  process.on('SIGTERM', () => {})
  writeFileSync(path.join(dir, '${stage}.pid'), String(process.pid))
  setInterval(() => {}, 1000)
} else if (mode.startsWith('flaky:')) {
  const counter = path.join(dir, '${stage}.count')
  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 1
  writeFileSync(counter, String(n))
  if (n < Number(mode.slice(6))) { console.error('source answered 502'); process.exit(1) }
} else if (mode === 'fail') {
  console.error('\\u001b[31mUnauthorized 401\\u001b[0m'); process.exit(1)
}
if (mode !== 'hang' && '${stage}' === 'ingest') {
  const out = process.argv[process.argv.indexOf('--out') + 1]
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify({ kind: 'snapshot', body: { name: 'phishing', version: 52, updatedAt: 'x', entries: ['a.test', 'b.test', 'c.test'] } }))
}
`

/** Sets the token in the child's environment the way use_secret does, then runs the rest. */
const FAKE_RUNNER = `
import { spawnSync } from 'node:child_process'
const rest = process.argv.slice(process.argv.indexOf('--') + 1)
const result = spawnSync(rest[0], rest.slice(1), { stdio: 'inherit', env: { ...process.env, CLOUDFLARE_API_TOKEN: 'from-the-vault' } })
process.exit(result.status ?? 1)
`

function world() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'okolos-job-'))
  const root = path.join(base, 'repo')
  mkdirSync(path.join(root, 'tools'), { recursive: true })
  mkdirSync(path.join(root, 'apps/proxy/node_modules/.bin'), { recursive: true })
  writeFileSync(path.join(root, 'apps/proxy/node_modules/.bin/wrangler'), '')
  writeFileSync(path.join(root, 'tools/ingest.mjs'), FAKE_STAGE('ingest'))
  writeFileSync(path.join(root, 'tools/publish-feed.mjs'), FAKE_STAGE('publish'))
  writeFileSync(path.join(base, 'runner.mjs'), FAKE_RUNNER)
  const fake = path.join(base, 'fake')
  mkdirSync(fake)
  const paths = feedPaths({ OKOLOS_STATE_DIR: path.join(base, 'state'), OKOLOS_LOG_DIR: path.join(base, 'logs') }, base)
  return { base, root, fake, paths, runner: path.join(base, 'runner.mjs') }
}

/** Git as the job sees it: a clean checkout at `head`, origin/main at `target`. */
function fakeTool({ head = 'a'.repeat(40), target = 'a'.repeat(40), dirty = '', depsChanged = false } = {}) {
  const calls: string[][] = []
  const tool = async (command: string, args: string[]) => {
    calls.push([command, ...args])
    const ok = (stdout = '') => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false })
    if (command === 'pnpm') return ok()
    const verb = args[args.indexOf('-C') + 2]
    if (verb === 'fetch') return ok()
    if (verb === 'status') return ok(dirty)
    if (verb === 'rev-parse') return ok(`${args.at(-1) === 'HEAD' ? head : target}\n`)
    if (verb === 'diff') return { ...ok(), code: depsChanged ? 1 : 0 }
    if (verb === 'checkout') return ok()
    return { ...ok(), code: 1, stderr: `unexpected git ${args.join(' ')}` }
  }
  return { tool, calls }
}

function servedAt(updatedAt: string | null): typeof fetch {
  return (async () =>
    updatedAt === null
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify({ update: { body: { version: 51, updatedAt, entries: [] } } }))) as typeof fetch
}

const calls = (fake: string, stage: string) =>
  existsSync(path.join(fake, `${stage}.calls`))
    ? readFileSync(path.join(fake, `${stage}.calls`), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    : []

function job(w: ReturnType<typeof world>, overrides: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const sleeps: number[] = []
  const lines: string[] = []
  const promise = runJob({
    root: w.root,
    paths: w.paths,
    env: { PATH: process.env.PATH ?? '', FAKE_DIR: w.fake, ...env },
    tool: fakeTool().tool,
    fetchImpl: servedAt(null),
    sleep: async (ms: number) => void sleeps.push(ms),
    retries: { attempts: 3, backoffMs: [30_000, 120_000] },
    log: (line: string) => lines.push(line),
    node,
    tmp: path.join(w.base, 'tmp'),
    ...overrides,
  })
  return { promise, sleeps, lines }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('a run that hangs ends inside its watchdog (LC-03, F4)', () => {
  // The fake ingest never ends, so a run whose watchdog does not fire never ends
  // either, and fails on this test's timeout; a watchdog that fires late fails the
  // bound below. What the test does not measure is how fast a loaded machine starts
  // and reaps node processes: about 2.5 s alone, but at load ~34 (2026-10-04,
  // `pnpm gates`) it overran vitest's default 5 s while passing alone three times
  // out of three. So it gets room for scheduling, and the bound stays under it.
  const WATCHDOG_MS = 1500
  const ENDS_WITHIN_MS = WATCHDOG_MS + 13_500

  it('ends non-zero, kills the hung stage’s group, and writes its status', async () => {
    const w = world()
    const started = Date.now()
    const { promise } = job(w, { watchdogMs: WATCHDOG_MS, graceMs: 200 }, { FAKE_INGEST: 'hang' })
    const record = await promise

    expect(record.exit).toBe(124)
    expect(Date.now() - started).toBeLessThan(ENDS_WITHIN_MS)
    expect(readStatus(w.paths.status)).toMatchObject({ outcome: 'failed', stage: 'ingest', exit: 124 })
    expect(readStatus(w.paths.status)?.reason).toMatch(/watchdog/)
    const pid = Number(readFileSync(path.join(w.fake, 'ingest.pid'), 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(alive(pid), `the hung ingest (${pid}) survived the watchdog`).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(calls(w.fake, 'ingest'), 'no retry starts after the watchdog fired').toHaveLength(1)
    expect(calls(w.fake, 'publish'), 'nothing starts after the watchdog fired').toEqual([])
  }, 30_000)
})

describe('one run at a time (LC-03)', () => {
  it('refuses while another run holds the lock, and leaves that run’s status alone', async () => {
    const w = world()
    const held = acquireLock(w.paths.lock)
    try {
      const record = await job(w).promise
      expect(record.exit).toBe(75)
      expect(existsSync(w.paths.status)).toBe(false)
      expect(calls(w.fake, 'ingest')).toEqual([])
    } finally {
      held.release()
    }
  })

  it('passes its lock to the stages it starts, so they do not refuse their own parent', async () => {
    const w = world()
    await job(w).promise
    expect(calls(w.fake, 'ingest')[0].lock).toBe('inherited')
    expect(calls(w.fake, 'publish')[0].lock).toBe('inherited')
  })
})

describe('a login is not a publish (RunAtLoad)', () => {
  it('skips when the served feed is younger than its interval', async () => {
    const w = world()
    const fresh = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const record = await job(w, { flags: { ifStale: true }, fetchImpl: servedAt(fresh) }).promise
    expect(record).toMatchObject({ outcome: 'skipped', stage: 'fresh', exit: 0 })
    expect(calls(w.fake, 'ingest')).toEqual([])
  })

  it('publishes when the served feed is older than its interval', async () => {
    const w = world()
    const stale = new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString()
    const record = await job(w, { flags: { ifStale: true }, fetchImpl: servedAt(stale) }).promise
    expect(record).toMatchObject({ outcome: 'published', exit: 0 })
  })

  it('stays just under the twelve-hour interval, so a scheduled run is never skipped as fresh', () => {
    expect(STALE_AFTER_MS).toBeLessThan(12 * 60 * 60 * 1000)
    expect(STALE_AFTER_MS).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000)
  })
})

describe('the token reaches only the publish step (F2)', () => {
  it('strips an inherited token from ingest and passes it to publish', async () => {
    const w = world()
    await job(w, {}, { CLOUDFLARE_API_TOKEN: 'inherited-token' }).promise
    expect(calls(w.fake, 'ingest')[0].token).toBeNull()
    expect(calls(w.fake, 'publish')[0].token).toBe('inherited-token')
  })

  it('wraps only the publish step in the secret runner', async () => {
    const w = world()
    await job(w, {}, { OKOLOS_SECRET_RUNNER: JSON.stringify([node, w.runner, '--']) }).promise
    expect(calls(w.fake, 'ingest')[0].token).toBeNull()
    expect(calls(w.fake, 'publish')[0].token).toBe('from-the-vault')
  })

  it('turns wrangler telemetry off for the publish step, and keeps its logs with ours', async () => {
    const w = world()
    await job(w).promise
    expect(calls(w.fake, 'publish')[0].metrics).toBe('false')
    // Wrangler prunes its own logs after thirty days; in the product's log directory
    // they sit beside the run they belong to instead of in a shared global folder.
    expect(calls(w.fake, 'publish')[0].wranglerLogs).toBe(path.join(w.paths.logs, 'wrangler'))
  })

  it('refuses a runner it cannot parse rather than publishing without one', async () => {
    const w = world()
    const record = await job(w, {}, { OKOLOS_SECRET_RUNNER: 'python use_secret.py' }).promise
    expect(record).toMatchObject({ outcome: 'failed', stage: 'config' })
    expect(calls(w.fake, 'publish')).toEqual([])
  })
})

describe('a failure is retried inside the run, then recorded (F3)', () => {
  it('retries with backoff and publishes when the source recovers', async () => {
    const w = world()
    const { promise, sleeps } = job(w, {}, { FAKE_INGEST: 'flaky:3' })
    const record = await promise
    expect(record).toMatchObject({ outcome: 'published', exit: 0, version: 52, entries: 3 })
    expect(sleeps).toEqual([30_000, 120_000])
  })

  it('records the stage, the exit and the count of failures in a row', async () => {
    const w = world()
    await job(w, {}, { FAKE_PUBLISH: 'fail' }).promise
    const second = await job(w, {}, { FAKE_PUBLISH: 'fail' }).promise
    expect(second).toMatchObject({ outcome: 'failed', stage: 'publish', exit: 1 })
    expect(readStatus(w.paths.status)).toMatchObject({ consecutiveFailures: 2, version: 52 })
  })

  it('writes every stage’s output to the durable log, without colour codes', async () => {
    const w = world()
    await job(w, { log: undefined }, { FAKE_PUBLISH: 'fail' }).promise
    const log = readFileSync(w.paths.log, 'utf8')
    expect(log).toContain('Unauthorized 401')
    expect(log).not.toContain('\u001b[')
  })

  it('records a successful run with what a host shows', async () => {
    const w = world()
    await job(w).promise
    expect(readStatus(w.paths.status)).toMatchObject({
      outcome: 'published',
      stage: 'done',
      exit: 0,
      version: 52,
      entries: 3,
      commit: 'a'.repeat(40),
      consecutiveFailures: 0,
    })
  })
})

describe('production publishes run from origin/main (F2)', () => {
  it('refuses a checkout that is not at origin/main, before anything runs', async () => {
    const w = world()
    const record = await job(w, { tool: fakeTool({ head: 'b'.repeat(40) }).tool }).promise
    expect(record).toMatchObject({ outcome: 'failed', stage: 'pin', exit: 1 })
    expect(record.reason).toMatch(/origin\/main/)
    expect(calls(w.fake, 'ingest')).toEqual([])
  })

  it('refuses a checkout with local changes even at origin/main', async () => {
    const w = world()
    const record = await job(w, { tool: fakeTool({ dirty: ' M tools/publish-feed.mjs\n' }).tool }).promise
    expect(record).toMatchObject({ outcome: 'failed', stage: 'pin' })
    expect(record.reason).toMatch(/local changes/)
  })

  it('fast-forwards its own checkout, reinstalling the pinned tools when the lockfile moved', async () => {
    const w = world()
    const git = fakeTool({ head: 'b'.repeat(40), target: 'c'.repeat(40), depsChanged: true })
    const record = await job(w, { tool: git.tool, flags: { follow: true } }).promise
    expect(record).toMatchObject({ outcome: 'published', commit: 'c'.repeat(40) })
    const ran = git.calls.map((call) => call.join(' '))
    expect(ran).toContainEqual(expect.stringMatching(/checkout --quiet --detach c{40}$/))
    expect(ran).toContainEqual('pnpm install --frozen-lockfile --filter @okolos/proxy')
  })

  it('never lets git prompt, and bounds every git call', async () => {
    const w = world()
    const seen: Array<{ env?: Record<string, string>; timeoutMs?: number }> = []
    const base = fakeTool().tool
    await job(w, {
      tool: async (command: string, args: string[], options: { env?: Record<string, string>; timeoutMs?: number }) => {
        seen.push(options)
        return base(command, args)
      },
    }).promise
    for (const options of seen) {
      expect(options.timeoutMs).toBeGreaterThan(0)
      expect(options.env?.GIT_TERMINAL_PROMPT).toBe('0')
      expect(options.env?.CLOUDFLARE_API_TOKEN).toBeUndefined()
    }
  })

  it('runs an unpinned checkout only when told to, and records that it did', async () => {
    const w = world()
    const record = await job(w, { tool: fakeTool({ head: 'b'.repeat(40) }).tool, flags: { unpinned: true } }).promise
    expect(record).toMatchObject({ outcome: 'published', pinned: false })
  })
})

describe('leftovers from older runs are swept at start (LC-12, F8)', () => {
  it('removes the fixed-name temp files and dead runs’ directories, and keeps a live one', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'okolos-sweep-'))
    writeFileSync(path.join(tmp, 'okolos-feed-signed.json'), '{}')
    writeFileSync(path.join(tmp, 'okolos-feed-publish.sql'), '')
    mkdirSync(path.join(tmp, 'okolos-feed-old'))
    mkdirSync(path.join(tmp, 'okolos-feed-live'))
    const dayAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(path.join(tmp, 'okolos-feed-old'), dayAgo, dayAgo)
    writeFileSync(path.join(tmp, 'unrelated.txt'), '')

    const removed = sweepLeftovers(tmp, Date.now())
    expect(removed.sort()).toEqual(['okolos-feed-old', 'okolos-feed-publish.sql', 'okolos-feed-signed.json'])
    expect(existsSync(path.join(tmp, 'okolos-feed-live'))).toBe(true)
    expect(existsSync(path.join(tmp, 'unrelated.txt'))).toBe(true)
  })
})
