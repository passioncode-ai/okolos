import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { BoundedOptions, BoundedResult } from './bounded.mjs'
import { runBounded } from './bounded.mjs'
import { proposeSnapshot, SNAPSHOT_BRANCH, SNAPSHOT_PR_AFTER_DAYS } from './snapshot-pr.mjs'

/**
 * The feed agent proposes the committed snapshot itself (B-158).
 *
 * `pnpm package:check` and CI on main fail once `feeds/phishing.json` is over
 * fourteen days old, and only a person used to commit it. After a publish the
 * agent now opens or updates one pull request carrying exactly the feed it
 * published, verified against what the worker serves (ADR-0017), and asks GitHub to
 * merge it once main's required checks pass. Git and gh are doubles here; the last
 * block runs real git against a bare origin in a temporary folder. Nothing reaches
 * the network, the operator's GitHub login or a real push.
 */

const DAY = 86_400_000
const NOW = Date.parse('2026-11-05T12:00:00.000Z')
const MAIN = 'a'.repeat(40)
const TIP = 'e'.repeat(40)
const BLOB = 'b'.repeat(40)
const TREE = 'c'.repeat(40)
const COMMIT = 'd'.repeat(40)
const PR_URL = 'https://github.com/passioncode-ai/okolos/pull/42'

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

function feedText(version: number, updatedAt: string, entries = ['a.test', 'b.test']): string {
  return JSON.stringify({ kind: 'snapshot', body: { name: 'phishing', version, updatedAt, entries } }, null, 2)
}

/** The published feed in the agent's state, and what the worker serves for it. */
function published(version = 66, updatedAt = new Date(NOW - 60_000).toISOString()) {
  const dir = tempDir('okolos-snappr-')
  const feedFile = path.join(dir, 'state', 'feeds', 'phishing.json')
  mkdirSync(path.dirname(feedFile), { recursive: true })
  const text = feedText(version, updatedAt)
  writeFileSync(feedFile, text)
  const signed = JSON.stringify({ update: JSON.parse(text), signature: 'c2ln' })
  const readServedFeed = async () => ({ state: 'served', version, updatedAt, count: 2, text: signed })
  return { dir, feedFile, text, version, readServedFeed }
}

type Call = { command: string; args: string[]; options: BoundedOptions }

interface FakeOptions {
  committed?: { version: number; ageDays: number } | 'missing'
  tip?: string
  threeDot?: string[]
  mainInTip?: boolean
  tipInMain?: boolean
  tipBlob?: string
  push?: 'ok' | 'rejected'
  gh?: 'ok' | 'missing' | 'logged-out'
  open?: Array<{ number: number; url: string; autoMergeRequest: unknown }>
  allowAutoMerge?: string
  requiredChecks?: string
  merge?: 'ok' | 'not-allowed' | 'fail'
}

/** Git and gh as the agent's checkout sees them. Every call is recorded with its options. */
function fake(o: FakeOptions = {}) {
  const calls: Call[] = []
  const ok = (stdout = ''): BoundedResult => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false })
  const no = (stderr: string, code = 1): BoundedResult => ({ code, signal: null, stdout: '', stderr, timedOut: false })
  const tool = async (command: string, args: string[], options: BoundedOptions): Promise<BoundedResult> => {
    calls.push({ command, args, options })
    if (command === 'gh') {
      const [sub, verb] = args
      if (o.gh === 'missing') return { code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: 'Error: spawn gh ENOENT' }
      if (sub === 'auth') return o.gh === 'logged-out' ? no('You are not logged into any GitHub hosts. To log in, run: gh auth login') : ok('Logged in')
      if (sub === 'pr' && verb === 'list') return ok(JSON.stringify(o.open ?? []))
      if (sub === 'pr' && verb === 'create') return ok(`${PR_URL}\n`)
      if (sub === 'pr' && verb === 'edit') return ok(`${PR_URL}\n`)
      if (sub === 'api' && args[1] === 'repos/{owner}/{repo}') return ok(`${o.allowAutoMerge ?? 'true'}\n`)
      if (sub === 'api' && args[1] === 'repos/{owner}/{repo}/rules/branches/main') return ok(`${o.requiredChecks ?? '1'}\n`)
      if (sub === 'pr' && verb === 'merge') {
        if (o.merge === 'not-allowed') return no('GraphQL: Pull request Auto merge is not allowed for this repository (enablePullRequestAutoMerge)')
        if (o.merge === 'fail') return no('GraphQL: Something went wrong')
        return ok()
      }
      return no(`unexpected gh ${args.join(' ')}`)
    }
    const verb = args[args.indexOf('-C') + 2]
    const rest = args.slice(args.indexOf('-C') + 3)
    if (verb === 'show') {
      if (o.committed === 'missing') return no("fatal: path 'feeds/phishing.json' does not exist in 'origin/main'", 128)
      const c = o.committed ?? { version: 65, ageDays: 9 }
      return ok(feedText(c.version, new Date(NOW - c.ageDays * DAY).toISOString()))
    }
    if (verb === 'rev-parse' && rest.at(-1) === 'origin/main') return ok(`${MAIN}\n`)
    if (verb === 'rev-parse' && rest.at(-1) === `${TIP}:feeds/phishing.json`) return ok(`${o.tipBlob ?? 'f'.repeat(40)}\n`)
    if (verb === 'ls-remote') return ok(o.tip ? `${o.tip}\trefs/heads/${SNAPSHOT_BRANCH}\n` : '')
    if (verb === 'fetch') return ok()
    if (verb === 'diff') return ok((o.threeDot ?? ['feeds/phishing.json']).map((name) => `${name}\n`).join(''))
    if (verb === 'merge-base') {
      const [, a, b] = rest
      if (a === 'origin/main' && b === TIP) return { ...ok(), code: o.mainInTip ? 0 : 1 }
      if (a === TIP && b === 'origin/main') return { ...ok(), code: o.tipInMain ? 0 : 1 }
      return no(`unexpected merge-base ${rest.join(' ')}`)
    }
    if (verb === 'hash-object') return ok(`${BLOB}\n`)
    if (verb === 'read-tree' || verb === 'update-index') return ok()
    if (verb === 'write-tree') return ok(`${TREE}\n`)
    if (verb === 'commit-tree') return ok(`${COMMIT}\n`)
    if (verb === 'push') {
      return o.push === 'rejected' ? no(` ! [rejected]        ${COMMIT} -> ${SNAPSHOT_BRANCH} (non-fast-forward)`) : ok()
    }
    return no(`unexpected git ${args.join(' ')}`)
  }
  const ran = () => calls.map((call) => [call.command, ...call.args.filter((_, i) => !(call.args[0] === '-C' && i < 2))].join(' '))
  return { tool, calls, ran }
}

async function propose(o: FakeOptions = {}, extra: Record<string, unknown> = {}, feed = published()) {
  const f = fake(o)
  const record = await proposeSnapshot({
    root: '/agent-checkout',
    feedFile: feed.feedFile,
    readServedFeed: feed.readServedFeed,
    tool: f.tool,
    env: { PATH: '/usr/bin', CLOUDFLARE_API_TOKEN: 'cf-secret', GH_TOKEN: 'gh-secret', GITHUB_TOKEN: 'gh-secret-2' },
    now: () => NOW,
    tmp: feed.dir,
    ...extra,
  })
  return { record, ...f, feed }
}

describe('when the committed snapshot is young enough, nothing is proposed', () => {
  it(`skips while the snapshot on origin/main is under ${SNAPSHOT_PR_AFTER_DAYS} days old`, async () => {
    const { record, ran } = await propose({ committed: { version: 65, ageDays: 3 } })
    expect(record).toMatchObject({ outcome: 'skipped-fresh', version: 66, committed: { version: 65, ageDays: 3 } })
    expect(ran().filter((line) => line.startsWith('gh') || line.includes('push'))).toEqual([])
  })

  it('skips when origin/main already carries this version', async () => {
    const { record, ran } = await propose({ committed: { version: 66, ageDays: 10 } })
    expect(record.outcome).toBe('skipped-fresh')
    expect(record.reason).toMatch(/already carries v66/)
    expect(ran().filter((line) => line.startsWith('gh') || line.includes('push'))).toEqual([])
  })

  it('waits seven days, half the fourteen-day ceiling of the release gate', () => {
    expect(SNAPSHOT_PR_AFTER_DAYS).toBe(7)
  })
})

describe('gh is optional on the machine; its absence is recorded, never a crash', () => {
  it('records "gh unavailable" when gh is not installed, and pushes nothing', async () => {
    const { record, ran } = await propose({ gh: 'missing' })
    expect(record.outcome).toBe('failed')
    expect(record.reason).toMatch(/^gh unavailable/)
    expect(ran().filter((line) => line.includes('push'))).toEqual([])
  })

  it('records "gh unavailable" when gh is not logged in, and pushes nothing', async () => {
    const { record, ran } = await propose({ gh: 'logged-out' })
    expect(record.outcome).toBe('failed')
    expect(record.reason).toMatch(/^gh unavailable: .*not logged in/)
    expect(ran().filter((line) => line.includes('push'))).toEqual([])
  })
})

describe('the snapshot is exactly what was served (ADR-0017)', () => {
  it('refuses when the worker serves something other than the feed published here', async () => {
    const feed = published()
    const other = JSON.stringify({ update: JSON.parse(feedText(66, 'x', ['other.test'])), signature: 'c2ln' })
    const { record, ran } = await propose({}, { readServedFeed: async () => ({ state: 'served', version: 66, updatedAt: 'x', count: 1, text: other }) }, feed)
    expect(record).toMatchObject({ outcome: 'failed' })
    expect(record.reason).toMatch(/not the feed published here/)
    expect(ran().filter((line) => line.includes('push') || line.includes('hash-object'))).toEqual([])
  })

  it('commits the published file’s bytes with the newline pnpm feed:snapshot adds', async () => {
    const { calls, feed } = await propose()
    const hashed = calls.find((call) => call.args.includes('hash-object'))
    expect(hashed?.args).toEqual(['-C', '/agent-checkout', 'hash-object', '-w', '--stdin'])
    expect(hashed?.options.input).toBe(`${feed.text}\n`)
  })
})

describe('a new pull request on one reused branch, never forced (B-158)', () => {
  it('builds a commit on origin/main that changes only the snapshot, without touching the checkout', async () => {
    const { calls, ran } = await propose()
    const index = calls.filter((call) => ['read-tree', 'update-index', 'write-tree'].includes(call.args[2] ?? ''))
    expect(index).toHaveLength(3)
    // A private index: the checkout's own index, HEAD and files stay as the pin stage left them.
    for (const call of index) expect(call.options.env?.GIT_INDEX_FILE).toMatch(/okolos-feed-.*index$/)
    expect(ran()).toContainEqual('git read-tree origin/main')
    expect(ran()).toContainEqual(`git update-index --add --cacheinfo 100644,${BLOB},feeds/phishing.json`)
    expect(ran()).toContainEqual(`git commit-tree ${TREE} -p ${MAIN} -F -`)
    const touching = ['checkout', 'reset', 'add', 'commit', 'stash', 'switch', 'merge', 'rebase']
    expect(ran().filter((line) => touching.includes(line.split(' ')[1] ?? ''))).toEqual([])
  })

  it('pushes the commit to the branch without force, with the gates’ recorded skip', async () => {
    const { calls } = await propose()
    const push = calls.find((call) => call.args.includes('push'))
    expect(push?.args.slice(2)).toEqual(['push', '--quiet', 'origin', `${COMMIT}:refs/heads/${SNAPSHOT_BRANCH}`])
    expect(push?.args.join(' ')).not.toMatch(/--force|\s-f\b|\+/)
    // The agent's checkout has only the publish tools installed, so the pre-push gates
    // cannot run there; the hook's documented escape prints that it skipped them, and
    // the pull request's checks are the gate.
    expect(push?.options.env?.OKOLOS_SKIP_GATES).toBe('1')
    expect(push?.options.env?.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('opens a pull request into main and asks GitHub to merge it, with a merge commit, once checks pass', async () => {
    const { record, ran, calls } = await propose()
    expect(record).toMatchObject({
      outcome: 'auto-merge-requested',
      branch: SNAPSHOT_BRANCH,
      version: 66,
      commit: COMMIT,
      pr: { number: 42, url: PR_URL, action: 'opened' },
    })
    expect(ran()).toContainEqual(expect.stringMatching(new RegExp(`^gh pr create --base main --head ${SNAPSHOT_BRANCH} --title .*v66.* --body-file -$`)))
    const body = calls.find((call) => call.args[1] === 'create')?.options.input ?? ''
    expect(body).toContain('feeds/phishing.json')
    expect(ran()).toContainEqual(`gh pr merge 42 --auto --merge --match-head-commit ${COMMIT}`)
  })

  it('updates the open pull request instead of opening a second one', async () => {
    const { record, ran } = await propose({
      tip: TIP,
      mainInTip: true,
      open: [{ number: 42, url: PR_URL, autoMergeRequest: null }],
    })
    expect(record).toMatchObject({ outcome: 'auto-merge-requested', pr: { number: 42, action: 'updated' } })
    expect(ran()).toContainEqual(`git commit-tree ${TREE} -p ${TIP} -F -`)
    expect(ran()).toContainEqual(expect.stringMatching(/^gh pr edit 42 --title .*v66.* --body-file -$/))
    expect(ran().filter((line) => line.startsWith('gh pr create'))).toEqual([])
  })

  it('keeps the branch up to date with main by a merge commit when main moved past it', async () => {
    const { ran } = await propose({ tip: TIP, mainInTip: false, tipInMain: false })
    expect(ran()).toContainEqual(`git commit-tree ${TREE} -p ${TIP} -p ${MAIN} -F -`)
  })

  it('starts again from main when the branch was already merged', async () => {
    const { ran } = await propose({ tip: TIP, mainInTip: false, tipInMain: true, threeDot: [] })
    expect(ran()).toContainEqual(`git commit-tree ${TREE} -p ${MAIN} -F -`)
  })

  it('does not commit or push again when the branch already carries this snapshot', async () => {
    const { record, ran } = await propose({ tip: TIP, mainInTip: true, tipBlob: BLOB, open: [{ number: 42, url: PR_URL, autoMergeRequest: null }] })
    expect(record).toMatchObject({ outcome: 'auto-merge-requested', commit: TIP })
    expect(ran().filter((line) => line.includes('commit-tree') || line.includes('push'))).toEqual([])
  })

  it('records "updated" and asks nothing more when auto-merge is already on for the pull request', async () => {
    const { record, ran } = await propose({
      tip: TIP,
      mainInTip: true,
      open: [{ number: 42, url: PR_URL, autoMergeRequest: { mergeMethod: 'MERGE' } }],
    })
    expect(record).toMatchObject({ outcome: 'updated', pr: { action: 'updated' } })
    expect(ran().filter((line) => line.startsWith('gh pr merge'))).toEqual([])
  })

  it('leaves a branch that carries anything but the snapshot to a person', async () => {
    const { record, ran } = await propose({ tip: TIP, mainInTip: true, threeDot: ['feeds/phishing.json', 'tools/ingest.mjs'] })
    expect(record.outcome).toBe('failed')
    expect(record.reason).toMatch(/tools\/ingest\.mjs/)
    expect(ran().filter((line) => line.includes('push') || line.startsWith('gh pr'))).toEqual([])
  })

  it('records a rejected push and opens no pull request', async () => {
    const { record, ran } = await propose({ push: 'rejected' })
    expect(record.outcome).toBe('failed')
    expect(record.reason).toMatch(/git push.*non-fast-forward/)
    expect(ran().filter((line) => line.startsWith('gh pr'))).toEqual([])
  })
})

describe('auto-merge only where the repository allows it and checks gate it', () => {
  it('leaves the pull request open when the repository does not allow auto-merge', async () => {
    const { record, ran } = await propose({ allowAutoMerge: 'false' })
    expect(record).toMatchObject({ outcome: 'auto-merge-unavailable', pr: { number: 42, action: 'opened' } })
    expect(record.reason).toMatch(/allow_auto_merge/)
    expect(ran().filter((line) => line.startsWith('gh pr merge'))).toEqual([])
  })

  it('leaves it open when main requires no status checks, so a merge would not wait for CI', async () => {
    const { record, ran } = await propose({ requiredChecks: '0' })
    expect(record.outcome).toBe('auto-merge-unavailable')
    expect(record.reason).toMatch(/no status checks/)
    expect(ran().filter((line) => line.startsWith('gh pr merge'))).toEqual([])
  })

  it('records GitHub’s refusal to enable auto-merge as unavailable, not as a failure', async () => {
    const { record } = await propose({ merge: 'not-allowed' })
    expect(record.outcome).toBe('auto-merge-unavailable')
    expect(record.reason).toMatch(/not allowed/)
  })

  it('records any other merge error as a failure with its reason', async () => {
    const { record } = await propose({ merge: 'fail' })
    expect(record.outcome).toBe('failed')
    expect(record.reason).toMatch(/gh pr merge.*Something went wrong/)
  })

  it('never merges by hand or with administrator rights', async () => {
    const { ran } = await propose()
    const merges = ran().filter((line) => line.startsWith('gh pr merge'))
    expect(merges).toHaveLength(1)
    expect(merges[0]).toMatch(/--auto/)
    expect(merges[0]).not.toMatch(/--admin|--squash|--rebase/)
  })
})

describe('bounded, and holding no secret', () => {
  it('gives every child a deadline inside the time the run has left', async () => {
    const { calls } = await propose({}, { deadline: NOW + 20_000 })
    expect(calls.length).toBeGreaterThan(10)
    for (const call of calls) {
      expect(call.options.timeoutMs).toBeGreaterThan(0)
      expect(call.options.timeoutMs).toBeLessThanOrEqual(20_000)
    }
  })

  it('stops with a recorded failure, starting nothing, when no time is left', async () => {
    const { record, calls } = await propose({}, { deadline: NOW + 500 })
    expect(record.outcome).toBe('failed')
    expect(record.reason).toMatch(/out of time/)
    expect(calls).toEqual([])
  })

  it('passes no Cloudflare token and no GitHub token to git or gh; gh uses its own login', async () => {
    const { calls } = await propose()
    for (const call of calls) {
      expect(call.options.env?.CLOUDFLARE_API_TOKEN).toBeUndefined()
      expect(call.options.env?.GH_TOKEN).toBeUndefined()
      expect(call.options.env?.GITHUB_TOKEN).toBeUndefined()
      expect(call.args.join(' ')).not.toMatch(/secret/)
    }
    const gh = calls.filter((call) => call.command === 'gh')
    for (const call of gh) expect(call.options.env?.GH_PROMPT_DISABLED).toBe('1')
  })

  it('never throws: an unexpected error becomes a failed record', async () => {
    const { record } = await propose({}, { readServedFeed: async () => { throw new Error('worker answered HTTP 503') } })
    expect(record).toMatchObject({ outcome: 'failed' })
    expect(record.reason).toMatch(/503/)
  })

  it('removes its private index folder', async () => {
    const { feed, calls } = await propose()
    const index = calls.find((call) => call.args.includes('read-tree'))?.options.env?.GIT_INDEX_FILE ?? ''
    expect(index.startsWith(feed.dir)).toBe(true)
    expect(existsSync(path.dirname(index))).toBe(false)
  })
})

describe('with real git: a bare origin, the agent’s checkout, gh as a double', () => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  }
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { env, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }

  /** origin with main carrying a snapshot `ageDays` old, and a detached checkout of it. */
  function repos(ageDays = 9) {
    const base = tempDir('okolos-snappr-git-')
    const origin = path.join(base, 'origin.git')
    const seed = path.join(base, 'seed')
    const checkout = path.join(base, 'agent-checkout')
    git('init', '--quiet', '--bare', '--initial-branch=main', origin)
    git('init', '--quiet', '--initial-branch=main', seed)
    mkdirSync(path.join(seed, 'feeds'))
    mkdirSync(path.join(seed, 'tools'))
    writeFileSync(path.join(seed, 'feeds/phishing.json'), `${feedText(65, new Date(NOW - ageDays * DAY).toISOString())}\n`)
    writeFileSync(path.join(seed, 'tools/feed-job.mjs'), '// job\n')
    git('-C', seed, 'add', '.')
    git('-C', seed, 'commit', '--quiet', '-m', 'seed')
    git('-C', seed, 'push', '--quiet', origin, 'main')
    git('clone', '--quiet', origin, checkout)
    git('-C', checkout, 'checkout', '--quiet', '--detach', 'origin/main')
    // The repository's hook path, as the clone the agent's worktree belongs to has it:
    // a pre-push that refuses unless the gates' skip is set, as `.githooks/pre-push` would
    // fail there (no full install in the agent's checkout).
    const hooks = path.join(base, 'hooks')
    mkdirSync(hooks)
    writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\n[ -n "$OKOLOS_SKIP_GATES" ] || { echo "gates would run" >&2; exit 1; }\necho "$OKOLOS_SKIP_GATES" > "$(dirname "$0")/skipped"\n')
    chmodSync(path.join(hooks, 'pre-push'), 0o755)
    git('-C', checkout, 'config', 'core.hooksPath', hooks)
    return { base, origin, seed, checkout, hooks }
  }

  /** Real git, bounded; gh answers as a logged-in client on a repository with auto-merge. */
  function tools(open: () => Array<{ number: number; url: string; autoMergeRequest: unknown }>) {
    const gh: string[][] = []
    const tool = async (command: string, args: string[], options: BoundedOptions): Promise<BoundedResult> => {
      if (command === 'gh') {
        gh.push(args)
        const out = (stdout: string): BoundedResult => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false })
        if (args[0] === 'pr' && args[1] === 'list') return out(JSON.stringify(open()))
        if (args[0] === 'pr' && args[1] === 'create') return out(`${PR_URL}\n`)
        if (args[0] === 'api' && args[1] === 'repos/{owner}/{repo}') return out('true\n')
        if (args[0] === 'api') return out('1\n')
        return out('')
      }
      return runBounded(command, args, { ...options, env: { ...env, ...options.env } })
    }
    return { tool, gh }
  }

  async function run(r: ReturnType<typeof repos>, version: number, open: () => Array<{ number: number; url: string; autoMergeRequest: unknown }> = () => []) {
    const feed = published(version)
    const t = tools(open)
    const record = await proposeSnapshot({
      root: r.checkout,
      feedFile: feed.feedFile,
      readServedFeed: feed.readServedFeed,
      tool: t.tool,
      env,
      now: () => NOW,
      tmp: feed.dir,
    })
    return { record, feed, gh: t.gh }
  }

  const branchTip = (r: ReturnType<typeof repos>) => git('-C', r.origin, 'rev-parse', `refs/heads/${SNAPSHOT_BRANCH}`)

  it('pushes a branch whose only change against main is the snapshot, byte for byte, and leaves the checkout alone', async () => {
    const r = repos()
    const head = git('-C', r.checkout, 'rev-parse', 'HEAD')
    const { record, feed } = await run(r, 66)
    expect(record).toMatchObject({ outcome: 'auto-merge-requested', pr: { action: 'opened' } })
    const tip = branchTip(r)
    expect(record.commit).toBe(tip)
    const main = git('-C', r.origin, 'rev-parse', 'main')
    expect(git('-C', r.origin, 'rev-parse', `${tip}^`)).toBe(main)
    expect(git('-C', r.origin, 'diff', '--name-only', main, tip)).toBe('feeds/phishing.json')
    expect(git('-C', r.origin, 'show', `${tip}:feeds/phishing.json`)).toBe(feed.text)
    expect(readFileSync(path.join(r.hooks, 'skipped'), 'utf8').trim()).toBe('1')
    // The checkout the next run pins: same HEAD, clean, no branch of its own.
    expect(git('-C', r.checkout, 'rev-parse', 'HEAD')).toBe(head)
    expect(git('-C', r.checkout, 'status', '--porcelain')).toBe('')
  }, 30_000)

  it('moves the branch forward on the next publish, and merges main in when main moved', async () => {
    const r = repos()
    await run(r, 66)
    const first = branchTip(r)
    // Someone lands an unrelated change on main meanwhile.
    git('-C', r.seed, 'pull', '--quiet', r.origin, 'main')
    writeFileSync(path.join(r.seed, 'tools/feed-job.mjs'), '// job, changed\n')
    git('-C', r.seed, 'commit', '--quiet', '-am', 'unrelated')
    git('-C', r.seed, 'push', '--quiet', r.origin, 'main')
    // The run's pin stage fetches origin/main before anything is published.
    git('-C', r.checkout, 'fetch', '--quiet', 'origin', 'main')

    const { record, feed, gh } = await run(r, 67, () => [{ number: 42, url: PR_URL, autoMergeRequest: null }])
    expect(record).toMatchObject({ outcome: 'auto-merge-requested', pr: { action: 'updated' } })
    const second = branchTip(r)
    // Fast-forward: the old tip is an ancestor, so the push needed no force.
    expect(spawnSync('git', ['-C', r.origin, 'merge-base', '--is-ancestor', first, second], { env }).status).toBe(0)
    const main = git('-C', r.origin, 'rev-parse', 'main')
    expect(spawnSync('git', ['-C', r.origin, 'merge-base', '--is-ancestor', main, second], { env }).status).toBe(0)
    expect(git('-C', r.origin, 'diff', '--name-only', main, second)).toBe('feeds/phishing.json')
    expect(git('-C', r.origin, 'show', `${second}:feeds/phishing.json`)).toBe(feed.text)
    expect(gh.filter((args) => args[1] === 'create')).toEqual([])
  }, 30_000)

  it('touches nothing on origin while main’s snapshot is fresh', async () => {
    const r = repos(2)
    const { record, gh } = await run(r, 66)
    expect(record.outcome).toBe('skipped-fresh')
    expect(git('-C', r.origin, 'branch', '--list', SNAPSHOT_BRANCH)).toBe('')
    expect(gh).toEqual([])
  }, 30_000)
})
