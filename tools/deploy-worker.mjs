#!/usr/bin/env node
/**
 * Deploying the proxy worker, end to end and idempotently.
 *
 *   node tools/deploy-worker.mjs              # render config, apply schema, deploy, smoke
 *   node tools/deploy-worker.mjs --dry-run    # everything except the mutating steps
 *   node tools/deploy-worker.mjs --smoke-only # check what is deployed, change nothing
 *
 * Every step here was once a line in a runbook. A runbook step that is
 * performed by hand is performed differently each time and skipped when it is
 * late; this exists so the post-deploy list is empty rather than short.
 *
 * Credentials come from the environment, or from ~/.okolos/cloudflare.env,
 * which is mode 0600 and outside every repository. Nothing here prints a
 * token, and the rendered config is gitignored because it carries a database
 * id the checked-in template deliberately leaves as `set-at-deploy`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { binInvocation } from './bin.mjs'
import { renderConfig } from './deploy-config.mjs'

const root = path.resolve(import.meta.dirname, '..')
const proxy = path.join(root, 'apps/proxy')
const dryRun = process.argv.includes('--dry-run')
/** Check production without touching it — also how the checks themselves get tested. */
const smokeOnly = process.argv.includes('--smoke-only')

function die(message) {
  console.error(`deploy-worker: ${message}`)
  process.exit(1)
}

function step(label) {
  console.log(`\n── ${label}`)
}

/** Reads the env file without sourcing it, so a stray command in it cannot run. */
function loadEnv() {
  const file = path.join(homedir(), '.okolos/cloudflare.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(?:'([^']*)'|"([^"]*)"|(.*))\s*$/.exec(line)
    if (m) process.env[m[1]] ??= m[2] ?? m[3] ?? m[4]
  }
}

function wrangler(args, { capture = false } = {}) {
  // npx is npx.cmd on Windows, which Node will not spawn without a shell (B-163).
  const npx = binInvocation('npx', ['wrangler', ...args])
  const out = execFileSync(npx.command, npx.args, {
    cwd: proxy,
    shell: npx.shell,
    encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    env: process.env,
  })
  // Captured output still belongs on screen: a deploy the operator cannot see
  // is a deploy they cannot judge.
  if (capture && out) process.stdout.write(out)
  return out
}

loadEnv()

for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'OKOLOS_D1_ID']) {
  if (!process.env[name]) {
    die(`${name} is not set. Put it in ~/.okolos/cloudflare.env (mode 0600) or the environment.`)
  }
}

step('render the deploy config')
const template = readFileSync(path.join(proxy, 'wrangler.toml'), 'utf8')
let rendered
try {
  rendered = renderConfig(template, process.env.OKOLOS_D1_ID)
} catch (cause) {
  die(cause.message)
}
const configPath = path.join(proxy, 'wrangler.generated.toml')
writeFileSync(configPath, rendered)
console.log(`   wrote ${path.relative(root, configPath)} (gitignored)`)

step('apply the schema (CREATE TABLE IF NOT EXISTS — safe to repeat)')
if (dryRun || smokeOnly) console.log(`   skipped: ${dryRun ? '--dry-run' : '--smoke-only'}`)
else {
  // --config on this one too. Without it wrangler reads the committed template
  // and sends its `set-at-deploy` placeholder as the database id, which fails
  // with "Invalid uuid" from an endpoint that never mentions the config file.
  wrangler([
    'd1', 'execute', 'okolos',
    '--config', 'wrangler.generated.toml',
    '--remote', '--yes', '--file=schema.sql',
  ])
}

step('deploy')
let deployOut = ''
if (dryRun || smokeOnly) console.log(`   skipped: ${dryRun ? '--dry-run' : '--smoke-only'}`)
else deployOut = wrangler(['deploy', '--config', 'wrangler.generated.toml'], { capture: true })

step('smoke: the deployed worker answers as itself')
if (dryRun) {
  console.log('   skipped: --dry-run')
  process.exit(0)
}

// The URL comes from the deploy that just ran. `deployments list` does not
// print one, which is how the first real run reached this line with nothing to
// smoke-test after a deploy that had in fact succeeded.
const host = /https:\/\/([a-z0-9-]+\.[a-z0-9-]+\.workers\.dev)/i.exec(deployOut)?.[1]
const base = process.env.OKOLOS_WORKER_URL ?? (host ? `https://${host}` : null)
if (!base) {
  die(
    smokeOnly
      ? 'with --smoke-only there is no deploy output to read the URL from. Set OKOLOS_WORKER_URL.'
      : 'could not determine the worker URL. Set OKOLOS_WORKER_URL and re-run to smoke-test it.',
  )
}

const checks = []
async function check(name, fn) {
  try {
    await fn()
    checks.push([name, true, ''])
  } catch (cause) {
    checks.push([name, false, String(cause.message ?? cause)])
  }
}

await check('/healthz answers 200', async () => {
  const res = await fetch(`${base}/healthz`)
  if (res.status !== 200) throw new Error(`status ${res.status}`)
})

await check('an unlisted domain gets "not-listed", not "unknown"', async () => {
  const res = await fetch(`${base}/status/domain?domain=example.test`)
  if (!res.ok) throw new Error(`status ${res.status}`)
  const body = await res.json()
  // This is the schema check as well as the routing one. `unknown` is exactly
  // what the worker answers when it cannot reach D1, so a deploy whose schema
  // never landed fails here rather than passing on a 200.
  if (body.status === 'unknown') throw new Error('answered "unknown" — the D1 binding or the schema is not there')
  if (body.status !== 'not-listed') throw new Error(`expected not-listed, got ${JSON.stringify(body)}`)
})

await check('a request with no domain is refused, not answered', async () => {
  const res = await fetch(`${base}/status/domain`)
  if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`)
})

await check('an unknown path is this worker\'s own 404', async () => {
  // Routing regressions have a way of making every path answer the last
  // handler that matched. The body is asserted too, because a bare 404 is what
  // any wrong host in the world would also return — pointed at example.com,
  // the status-code-only version of this check passed.
  const res = await fetch(`${base}/nope`)
  if (res.status !== 404) throw new Error(`expected 404, got ${res.status}`)
  const body = await res.json().catch(() => null)
  if (body?.error !== 'not found') {
    throw new Error(`404 came from something other than this worker: ${JSON.stringify(body)}`)
  }
})

/**
 * The three public pages, by their own words rather than by a status code.
 *
 * The ledger's V-10 said "the public pages are alive" and this smoke checked
 * `/healthz`, `/status/domain` twice and `/nope` — none of them a page a person opens
 * (B-60). A 200 is not enough either, for the reason the `/nope` check already gives:
 * pointed at the wrong host, a status-code-only assertion passes against somebody
 * else's site. So each page is identified by a string only it serves.
 */
const PAGES = [
  ['/', 'Okolos — защита от скрытых инструкций'],
  ['/privacy', 'Приватность — Okolos'],
  ['/status', 'Статус домена'],
]

for (const [route, marker] of PAGES) {
  await check(`${route} is served by this worker`, async () => {
    const res = await fetch(`${base}${route}`)
    if (res.status !== 200) throw new Error(`status ${res.status}`)
    const body = await res.text()
    if (!body.includes(marker)) {
      throw new Error(`200, but the body does not carry "${marker}" — this is not our page`)
    }
  })
}

for (const [name, ok, detail] of checks) {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const failed = checks.filter(([, ok]) => !ok)
if (failed.length) {
  console.error(`\n${failed.length} smoke check(s) failed against ${base}`)
  process.exit(1)
}
console.log(`\nall smoke checks passed against ${base}`)
