import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { publish, WRANGLER_ARGS } from './publish-feed.mjs'
import { directoriesIn } from './tree.mjs'

/**
 * Publishing a feed: refuses to go backwards (F1), bounds every step (F4), runs the
 * pinned wrangler with no install and no telemetry (F2, F3), and leaves nothing in
 * the temp directory (F8). Every external effect is passed in, so none of this
 * touches the network, the signing key or production.
 */

const repo = path.resolve(import.meta.dirname, '..')
const D1 = '01234567-89ab-cdef-0123-456789abcdef'

function fixture({ generated = true }: { generated?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'okolos-publish-root-'))
  mkdirSync(path.join(root, 'apps/proxy'), { recursive: true })
  copyFileSync(path.join(repo, 'apps/proxy/wrangler.toml'), path.join(root, 'apps/proxy/wrangler.toml'))
  if (generated) writeFileSync(path.join(root, 'apps/proxy/wrangler.generated.toml'), 'name = "x"\n')
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'okolos-publish-tmp-'))
  const input = path.join(root, 'feed.json')
  writeFileSync(input, JSON.stringify(update(52)))
  return { root, tmpRoot, input }
}

function update(version: number) {
  return { kind: 'snapshot', body: { name: 'phishing', version, updatedAt: '2026-10-03T12:00:00.000Z', entries: ['evil-login.campaign.test'] } }
}

function signedText(version: number): string {
  return `${JSON.stringify({ update: update(version), signature: 'c2ln' }, null, 2)}\n`
}

interface Call {
  command: string
  args: string[]
  options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number }
}

/** A child-process double: signs as version `signs`, checks clean, and lets wrangler answer `wrangler`. */
function fakeRun({ signs = 52, wrangler = { code: 0, timedOut: false } } = {}) {
  const calls: Call[] = []
  const run = async (command: string, args: string[], options: Call['options']) => {
    calls.push({ command, args, options })
    if (args.some((arg) => arg.endsWith('sign-feed.mjs')) && !args.includes('--check')) {
      return { code: 0, signal: null, stdout: signedText(signs), stderr: '', timedOut: false }
    }
    if (args.includes('--check')) return { code: 0, signal: null, stdout: 'valid', stderr: '', timedOut: false }
    return { code: wrangler.code, signal: null, stdout: '', stderr: '', timedOut: wrangler.timedOut }
  }
  return { run, calls }
}

/** The worker double: `served` before the upload, the signed text after it. */
function fakeWorker(served: { status: number; text?: string }, after: () => string) {
  const signals: Array<AbortSignal | undefined> = []
  let uploaded = false
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    signals.push(init?.signal ?? undefined)
    if (url.includes('/status/domain')) {
      return new Response(JSON.stringify({ status: 'listed', feed: 'Okolos phishing list' }))
    }
    if (!uploaded && served.status !== 200) return new Response('{}', { status: served.status })
    return new Response(uploaded ? after() : (served.text ?? ''), { status: 200 })
  }) as typeof fetch
  return { fetchImpl, signals, markUploaded: () => (uploaded = true) }
}

const quiet = () => undefined
const wranglerCalls = (calls: Call[]) => calls.filter((call) => call.args.includes('wrangler'))

describe('a publish never goes backwards (F1)', () => {
  it('refuses a version below the served one, before anything is uploaded', async () => {
    const { root, tmpRoot, input } = fixture()
    const { run, calls } = fakeRun({ signs: 43 })
    const worker = fakeWorker({ status: 200, text: signedText(51) }, () => signedText(43))
    await expect(
      publish({ input, root, tmpRoot, run, fetchImpl: worker.fetchImpl, env: {}, log: quiet }),
    ).rejects.toThrow(/43 is not newer than the served 51/)
    expect(wranglerCalls(calls)).toEqual([])
  })

  it('refuses the served version with different contents — two runs signed the same number', async () => {
    const { root, tmpRoot, input } = fixture()
    const { run, calls } = fakeRun({ signs: 51 })
    const other = signedText(51).replace('evil-login', 'other-login')
    const worker = fakeWorker({ status: 200, text: other }, () => other)
    await expect(
      publish({ input, root, tmpRoot, run, fetchImpl: worker.fetchImpl, env: {}, log: quiet }),
    ).rejects.toThrow(/replay/)
    expect(wranglerCalls(calls)).toEqual([])
  })

  it('treats the served version with identical bytes as already published, so a retry is safe', async () => {
    const { root, tmpRoot, input } = fixture()
    const { run, calls } = fakeRun({ signs: 52 })
    const worker = fakeWorker({ status: 200, text: signedText(52) }, () => signedText(52))
    const result = await publish({ input, root, tmpRoot, run, fetchImpl: worker.fetchImpl, env: {}, log: quiet })
    expect(result).toMatchObject({ name: 'phishing', version: 52, uploaded: false })
    expect(wranglerCalls(calls)).toEqual([])
  })

  it('publishes a newer version and verifies what the worker serves', async () => {
    const { root, tmpRoot, input } = fixture()
    const { run, calls } = fakeRun({ signs: 52 })
    const worker = fakeWorker({ status: 200, text: signedText(51) }, () => signedText(52))
    const wrapped = async (...args: Parameters<typeof run>) => {
      const result = await run(...args)
      if (args[1].includes('wrangler')) worker.markUploaded()
      return result
    }
    const result = await publish({ input, root, tmpRoot, run: wrapped, fetchImpl: worker.fetchImpl, env: {}, log: quiet })
    expect(result).toMatchObject({ version: 52, uploaded: true })
    expect(wranglerCalls(calls)).toHaveLength(1)
  })
})

describe('the pinned wrangler, bounded and quiet (F2, F3, F4)', () => {
  async function published(env: Record<string, string> = {}) {
    const { root, tmpRoot, input } = fixture()
    const { run, calls } = fakeRun({ signs: 52 })
    const worker = fakeWorker({ status: 404 }, () => signedText(52))
    const wrapped = async (...args: Parameters<typeof run>) => {
      const result = await run(...args)
      if (args[1].includes('wrangler')) worker.markUploaded()
      return result
    }
    await publish({ input, root, tmpRoot, run: wrapped, fetchImpl: worker.fetchImpl, env, log: quiet })
    return { calls, root, tmpRoot, worker }
  }

  it('runs the repository’s wrangler through pnpm exec, never npx, and never lets pnpm install', async () => {
    const { calls, root } = await published()
    const [call] = wranglerCalls(calls)
    expect(call?.command).toBe('pnpm')
    expect(call?.args.slice(0, 3)).toEqual(['--config.verify-deps-before-run=false', 'exec', 'wrangler'])
    expect(call?.args).toEqual([...WRANGLER_ARGS.slice(0, 3), 'd1', 'execute', 'okolos', '--config', 'wrangler.generated.toml', '--remote', '--yes', expect.stringMatching(/^--file=/)])
    expect(call?.options.cwd).toBe(path.join(root, 'apps/proxy'))
    expect(calls.some((c) => c.command === 'npx')).toBe(false)
  })

  it('turns wrangler’s telemetry off for the step that holds the token', async () => {
    const { calls } = await published({ CLOUDFLARE_API_TOKEN: 'not-a-real-token' })
    expect(wranglerCalls(calls)[0]?.options.env?.WRANGLER_SEND_METRICS).toBe('false')
  })

  it('gives every child a deadline and every request an AbortSignal', async () => {
    const { calls, worker } = await published()
    for (const call of calls) expect(call.options.timeoutMs, call.args.join(' ')).toBeGreaterThan(0)
    expect(worker.signals.length).toBeGreaterThanOrEqual(3)
    for (const signal of worker.signals) expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('leaves nothing in the temp directory after a publish', async () => {
    const { tmpRoot } = await published()
    expect(directoriesIn(tmpRoot)).toEqual([])
  })

  it('leaves nothing in the temp directory after a failed upload either, and says it timed out', async () => {
    const { root, tmpRoot, input } = fixture()
    const { run } = fakeRun({ signs: 52, wrangler: { code: null as unknown as number, timedOut: true } })
    const worker = fakeWorker({ status: 404 }, () => signedText(52))
    await expect(
      publish({ input, root, tmpRoot, run, fetchImpl: worker.fetchImpl, env: {}, log: quiet }),
    ).rejects.toThrow(/timed out/)
    expect(directoriesIn(tmpRoot)).toEqual([])
  })

  it('renders the deploy config when a fresh checkout has none, from OKOLOS_D1_ID', async () => {
    const { root, tmpRoot, input } = fixture({ generated: false })
    const { run } = fakeRun({ signs: 52 })
    const worker = fakeWorker({ status: 404 }, () => signedText(52))
    const wrapped = async (...args: Parameters<typeof run>) => {
      const result = await run(...args)
      if (args[1].includes('wrangler')) worker.markUploaded()
      return result
    }
    await publish({ input, root, tmpRoot, run: wrapped, fetchImpl: worker.fetchImpl, env: { OKOLOS_D1_ID: D1 }, log: quiet })
    const generated = path.join(root, 'apps/proxy/wrangler.generated.toml')
    expect(existsSync(generated)).toBe(true)
    expect(readFileSync(generated, 'utf8')).toContain(D1)
  })

  it('refuses to guess a database when there is neither a config nor an id', async () => {
    const { root, tmpRoot, input } = fixture({ generated: false })
    const { run, calls } = fakeRun({ signs: 52 })
    const worker = fakeWorker({ status: 404 }, () => signedText(52))
    await expect(
      publish({ input, root, tmpRoot, run, fetchImpl: worker.fetchImpl, env: {}, log: quiet }),
    ).rejects.toThrow(/OKOLOS_D1_ID/)
    expect(wranglerCalls(calls)).toEqual([])
  })
})
