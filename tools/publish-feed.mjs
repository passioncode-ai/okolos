#!/usr/bin/env node
/**
 * Signs a feed and publishes it, in one step that cannot be half-done.
 *
 *   node tools/publish-feed.mjs feed.json          # sign, upload, verify live
 *   node tools/publish-feed.mjs feed.json --dry-run
 *
 * The signing key never leaves this machine and the worker never signs, so
 * these are the only two places the private half is used: here, and in
 * `tools/sign-feed.mjs`, which this calls rather than reimplements.
 *
 * Why one command: the feed table stayed empty because publishing was a
 * sentence in a runbook. A step performed by hand is a step skipped when late.
 *
 * What it refuses, and why each refusal exists:
 *
 *   - a version that is not above the served one (F1). Extensions refuse it as a
 *     replay, so publishing it would freeze every user's blocklist while the smoke
 *     test below passed. The same version with identical bytes is a retry of a
 *     publish that already landed, and is accepted without a second upload.
 *   - an unbounded step (F4, LC-02). Every child runs in its own process group
 *     with a deadline; every request carries an AbortSignal. A hung run used to
 *     keep the launchd job "running", and launchd skips every later interval
 *     while it does.
 *   - an unpinned wrangler (F2). `npx wrangler` resolved whatever the npx cache or
 *     the registry held, with the production token in its environment. It is now
 *     the version pinned in apps/proxy, run through `pnpm exec` with pnpm's
 *     install-before-run check off — measured 2026-10-03: with it on, `pnpm exec`
 *     installs a dependency missing from node_modules before running, which here
 *     would mean a registry install holding the D1 token. Telemetry is off
 *     (`WRANGLER_SEND_METRICS=false`): the step that holds the token reports to
 *     nobody (F3).
 *   - leftovers (F8). The signed body and its SQL go to a private `mkdtemp`
 *     directory removed in `finally`; fixed names in $TMPDIR collided between runs.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { renderConfig } from './deploy-config.mjs'
import { runBounded } from './feed/bounded.mjs'
import { acquireLock } from './feed/lock.mjs'
import { feedPaths } from './feed/paths.mjs'
import { DEFAULT_WORKER, readServed, refuseBackwards } from './feed/served.mjs'
import { hostOf, listingSql } from './listings.mjs'

const REPO = path.resolve(import.meta.dirname, '..')

/** Deadlines, each well under the job's watchdog. */
export const SIGN_TIMEOUT_MS = 60_000
export const WRANGLER_TIMEOUT_MS = 180_000
export const SMOKE_TIMEOUT_MS = 20_000

/** The wrangler invocation, before the per-run file argument. */
export const WRANGLER_ARGS = [
  '--config.verify-deps-before-run=false',
  'exec',
  'wrangler',
  'd1',
  'execute',
  'okolos',
  // --config: without it wrangler reads the committed template and sends its
  // `set-at-deploy` placeholder as the database id.
  '--config',
  'wrangler.generated.toml',
  '--remote',
  '--yes',
]

/** Reads ~/.okolos/cloudflare.env without sourcing it; the environment wins. */
export function loadEnv(env, file = path.join(homedir(), '.okolos/cloudflare.env')) {
  const merged = { ...env }
  if (!existsSync(file)) return merged
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(?:'([^']*)'|"([^"]*)"|(.*))\s*$/.exec(line)
    if (m) merged[m[1]] ??= m[2] ?? m[3] ?? m[4]
  }
  return merged
}

function failed(step, result) {
  if (result.timedOut) return `${step} timed out and its process group was killed`
  if (result.error) return `${step} could not start: ${result.error}`
  const said = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' / ')
  return `${step} exited ${result.code ?? result.signal}${said ? `: ${said}` : ''}`
}

/** The generated deploy config, rendered from the template when a checkout has none. */
function ensureDeployConfig(proxy, env, log) {
  const generated = path.join(proxy, 'wrangler.generated.toml')
  if (existsSync(generated)) return
  if (!env.OKOLOS_D1_ID) {
    throw new Error(
      `${generated} is missing and OKOLOS_D1_ID is not set, so the database cannot be named. ` +
        `Put OKOLOS_D1_ID in ~/.okolos/cloudflare.env (not a secret) or run tools/deploy-worker.mjs once.`,
    )
  }
  const template = readFileSync(path.join(proxy, 'wrangler.toml'), 'utf8')
  writeFileSync(generated, renderConfig(template, env.OKOLOS_D1_ID))
  log(`   wrote ${path.basename(generated)} from the template (gitignored)`)
}

/**
 * Signs `input`, refuses to go backwards, uploads, and verifies what is served.
 * Returns `{ name, version, uploaded }`; throws an Error whose message says what
 * was refused. Every external effect is a parameter.
 */
export async function publish({
  input,
  dryRun = false,
  root = REPO,
  base,
  fetchImpl = fetch,
  run = runBounded,
  env = process.env,
  log = console.log,
  tmpRoot = tmpdir(),
  node = process.execPath,
}) {
  if (!input) throw new Error('name a JSON file holding the feed update: { kind, body }')
  if (!existsSync(input)) throw new Error(`${input} does not exist`)
  const worker = base ?? env.OKOLOS_WORKER_URL ?? DEFAULT_WORKER
  const proxy = path.join(root, 'apps/proxy')
  const signer = path.join(root, 'tools/sign-feed.mjs')

  log('\n── sign')
  const signedRun = await run(node, [signer, input], { cwd: root, env, timeoutMs: SIGN_TIMEOUT_MS })
  if (signedRun.code !== 0) throw new Error(failed('signing', signedRun))
  const signed = signedRun.stdout
  const parsed = JSON.parse(signed)
  const name = parsed.update?.body?.name
  const version = parsed.update?.body?.version
  if (!name) throw new Error('the update has no body.name, so there is nothing to publish it under')
  log(`   ${name} v${version}, ${parsed.update.body.entries?.length ?? 0} entries`)

  const work = mkdtempSync(path.join(tmpRoot, 'okolos-feed-'))
  try {
    log('\n── verify the signature against the key that ships')
    const check = path.join(work, 'signed.json')
    writeFileSync(check, signed, { mode: 0o600 })
    const checked = await run(node, [signer, '--check', check], { cwd: root, env, timeoutMs: SIGN_TIMEOUT_MS })
    if (checked.code !== 0) throw new Error(failed('the signature check', checked))
    log(`   ${checked.stdout.trim()}`)

    log('\n── against what is served')
    const served = await readServed({ base: worker, name, fetchImpl, timeoutMs: SMOKE_TIMEOUT_MS })
    let upload = true
    if (served.state === 'served') {
      if (version === served.version && served.text === signed) {
        // A retry of a publish that already landed: same version, same bytes.
        // Ed25519 signatures are deterministic, so re-signing reproduces them.
        log(`   v${version} is already served byte for byte — nothing to upload`)
        upload = false
      } else {
        const backwards = refuseBackwards(version, served.version)
        if (backwards) throw new Error(backwards)
        log(`   ok    v${version} is newer than the served v${served.version}`)
      }
    } else {
      log('   nothing is served under this name yet — this is the first publish')
    }

    log('\n── publish')
    if (dryRun) {
      log('   skipped: --dry-run')
      return { name, version, uploaded: false }
    }

    if (upload) {
      ensureDeployConfig(proxy, env, log)
      // Written through a file rather than inlined: a signed body on a command line
      // is a body mangled by quoting.
      //
      // Both tables in one file, because they are one fact. `feeds` is what the
      // extension downloads and blocks on; `listings` is what the public status page
      // answers from. Published separately, they drifted: the worker served a feed
      // listing four domains and told each of their owners nothing was recorded.
      const sql = path.join(work, 'publish.sql')
      const escaped = signed.replace(/'/g, "''")
      const publishedAt = new Date().toISOString()
      writeFileSync(
        sql,
        `INSERT INTO feeds (name, body, updated_at) VALUES ('${name}', '${escaped}', '${publishedAt}')\n` +
          `ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at;\n` +
          listingSql(parsed.update, publishedAt),
        { mode: 0o600 },
      )
      const uploaded = await run('pnpm', [...WRANGLER_ARGS, `--file=${sql}`], {
        cwd: proxy,
        env: { ...env, WRANGLER_SEND_METRICS: 'false' },
        timeoutMs: WRANGLER_TIMEOUT_MS,
        onLine: (_stream, line) => log(`   ${line}`),
      })
      if (uploaded.code !== 0) throw new Error(failed('wrangler d1 execute', uploaded))
    }

    log('\n── smoke: what the extension will actually fetch')
    const response = await fetchImpl(`${worker}/feeds/${name}?cb=${version}`, {
      signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`the worker answered ${response.status} for /feeds/${name}`)
    if ((await response.text()) !== signed) {
      throw new Error('what the worker serves is not byte-for-byte what was signed')
    }
    log(`   ok    /feeds/${name} serves exactly what was signed`)

    // The check that was missing. Serving a feed and answering for it are two
    // paths, and for one release they disagreed: every domain in the feed was
    // answered "nothing is recorded for this domain" by the page the interstitial
    // sends its owner to. A publish that cannot answer for what it published has
    // not finished.
    const listed =
      parsed.update.kind === 'snapshot'
        ? (parsed.update.body.entries ?? [])[0]
        : (parsed.update.body.added ?? [])[0]

    if (listed === undefined) {
      log('   --    no entry to ask about: this update lists nothing')
    } else {
      const host = hostOf(listed)
      const answer = await fetchImpl(
        `${worker}/status/domain?domain=${encodeURIComponent(host)}&cb=${version}`,
        { signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS) },
      ).then((r) => r.json())
      if (answer.status !== 'listed') {
        throw new Error(`the status page answers "${answer.status}" for ${host}, which this feed lists`)
      }
      log(`   ok    /status answers "listed" for ${host}, by ${answer.feed}`)
    }

    log(`\npublished ${name} v${version}`)
    return { name, version, uploaded: upload }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function main() {
  const lock = acquireLock(feedPaths().lock, { inherited: process.env.OKOLOS_FEED_LOCK })
  try {
    await publish({
      input: process.argv.slice(2).find((arg) => arg.endsWith('.json')),
      dryRun: process.argv.includes('--dry-run'),
      env: loadEnv(process.env),
    })
  } finally {
    lock.release()
  }
}

if (import.meta.filename === process.argv[1]) {
  main().catch((cause) => {
    console.error(`publish-feed: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exit(1)
  })
}
