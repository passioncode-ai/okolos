/**
 * Every access this project needs, in one place — recorded once, checked often.
 *
 *   node tools/access.mjs              # what is present, what works, what it unblocks
 *   node tools/access.mjs set NAME     # record one, reading the value from stdin
 *   node tools/access.mjs permissions  # the settings.json entries the classifier needs
 *   node tools/access.mjs --check      # exit 1 if anything required is missing or broken
 *
 * **Presence is not the check.** A token that has expired, an account id with a
 * typo, and a signing key that does not match the public half compiled into the
 * extension are all "present". The last one is the expensive kind: every feed
 * signed with the wrong key is rejected by every install, and nothing says so
 * until production. So each access is verified by doing the smallest real thing
 * it is for.
 *
 * **A secret never appears on a command line.** `set` reads from stdin, because
 * argv lands in shell history and in the process table where any local process
 * can read it. Nothing here prints a value, ever — not on success, not in an
 * error, not in `--check`.
 *
 * **This does not, and cannot, stop the harness gating a deploy.** Missing
 * credentials and a gated command are two different reasons an operator gets
 * interrupted; this file fixes the first. The second is a permission decision
 * that belongs to the person, not to a file the agent can write — `permissions`
 * prints exactly what to paste, and stops there.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const STORE = path.join(homedir(), '.okolos')
const CLOUDFLARE_ENV = path.join(STORE, 'cloudflare.env')
const TOOLS_ENV = path.join(STORE, 'tools.env')
const FEED_KEY = path.join(STORE, 'feed-signing-key.pem')

// ---------------------------------------------------------------------------
// Reading what is already there.
// ---------------------------------------------------------------------------

/**
 * Parse an env file without sourcing it, so a stray command in a secrets file
 * cannot run. Same shape `tools/deploy-worker.mjs` uses, and deliberately so:
 * two parsers for one format is how a file starts meaning different things to
 * different tools.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z0-9_]+)=(?:'([^']*)'|"([^"]*)"|(.*?))\s*$/.exec(line)
    if (m) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return out
}

/**
 * Normalise a pasted value.
 *
 * People paste `export FOO=bar`, or the value wrapped in quotes, or with a
 * trailing newline the terminal added. Storing any of those verbatim produces a
 * credential that is present and wrong — the failure this file exists to end.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normaliseValue(raw) {
  let value = raw.trim()
  const assignment = /^\s*(?:export\s+)?[A-Za-z0-9_]+=(.*)$/s.exec(value)
  if (assignment) value = assignment[1].trim()
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))
  ) {
    value = value.slice(1, -1)
  }
  return value.trim()
}

/** @returns {Record<string, string>} */
function stored() {
  /** @type {Record<string, string>} */
  const out = {}
  for (const file of [CLOUDFLARE_ENV, TOOLS_ENV]) {
    if (existsSync(file)) Object.assign(out, parseEnv(readFileSync(file, 'utf8')))
  }
  // The environment wins, so a one-off `FOO=… node tools/…` still works and is
  // still reported honestly as coming from the environment.
  return out
}

/**
 * Whether POSIX mode bits mean anything on `platform`.
 *
 * Windows has none: `stat().mode & 0o777` reads 0o666 for every writable file there,
 * so a check reading it reported every secrets file BAD and told the reader to run
 * `chmod`, which Windows does not have (B-163). Access there is the user profile's ACL.
 *
 * @param {string} [platform]
 */
export function modesApply(platform = process.platform) {
  return platform !== 'win32'
}

/**
 * A file holding a secret must not be readable by anyone else.
 *
 * @param {string} file
 * @param {string} [platform]
 * @returns {string | null} the problem, or null; null too where modes do not apply
 */
export function permissionProblem(file, platform = process.platform) {
  if (!modesApply(platform) || !existsSync(file)) return null
  const mode = statSync(file).mode & 0o777
  return mode & 0o077 ? `mode ${mode.toString(8)} — readable by others, should be 600` : null
}

// ---------------------------------------------------------------------------
// What each access is, and how to prove it works.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Access
 * @property {string} name
 * @property {string} file
 * @property {boolean} required
 * @property {string} unblocks
 * @property {string} readBy
 * @property {string} [howToGet]
 */

/** @type {readonly Access[]} */
export const ACCESSES = [
  {
    name: 'CLOUDFLARE_API_TOKEN',
    file: CLOUDFLARE_ENV,
    required: true,
    unblocks: 'deploying the worker',
    readBy: 'tools/deploy-worker.mjs',
    howToGet: 'dash.cloudflare.com → My Profile → API Tokens → Workers Scripts:Edit + D1:Edit',
  },
  {
    name: 'CLOUDFLARE_ACCOUNT_ID',
    file: CLOUDFLARE_ENV,
    required: true,
    unblocks: 'deploying the worker',
    readBy: 'tools/deploy-worker.mjs',
    howToGet: 'the 32 hex characters in any dash.cloudflare.com URL',
  },
  {
    name: 'OKOLOS_D1_ID',
    file: CLOUDFLARE_ENV,
    required: true,
    unblocks: 'applying the D1 schema',
    readBy: 'tools/deploy-worker.mjs',
    howToGet: 'npx wrangler d1 list',
  },
  {
    name: 'OKOLOS_WORKER_URL',
    file: CLOUDFLARE_ENV,
    required: false,
    unblocks: 'pointing the smoke checks at a specific deployment',
    readBy: 'tools/deploy-worker.mjs',
    howToGet: 'optional — taken from `wrangler deployments list` when absent',
  },
  {
    name: 'GEMINI_API_KEY',
    file: TOOLS_ENV,
    required: false,
    unblocks: 'the knowledge graph re-extracting changed documents (backlog B-17)',
    readBy: 'graphify',
    howToGet: 'aistudio.google.com → API keys',
  },
]

/** The signing key is a file, not a variable, so it is described separately. */
export const FEED_KEY_ACCESS = {
  name: 'feed signing key',
  file: FEED_KEY,
  required: false,
  unblocks: 'signing and publishing a feed',
  readBy: 'tools/sign-feed.mjs, tools/publish-feed.mjs',
  howToGet: 'node tools/generate-feed-key.mjs — and it never enters the repository',
}

/**
 * The public half the extension verifies against, read from the source rather
 * than restated here. A copy would be a second place the trust anchor lives.
 *
 * @returns {string | null}
 */
export function compiledPublicKey() {
  const source = path.join(root, 'apps/extension/src/background/feeds.ts')
  if (!existsSync(source)) return null
  const m = /FEED_PUBLIC_KEY = '([A-Za-z0-9+/=]+)'/.exec(readFileSync(source, 'utf8'))
  return m ? m[1] : null
}

/**
 * Does this private key produce the public half the extension trusts?
 *
 * The check that matters. A mismatched key signs feeds nobody accepts, and the
 * only symptom is installs quietly staying on their last good snapshot.
 *
 * @param {string} pem
 * @param {string | null} expectedBase64
 * @returns {{ ok: boolean; why: string }}
 */
export function feedKeyMatches(pem, expectedBase64) {
  let derived
  try {
    const spki = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' })
    // Ed25519 SPKI is a 12-byte header followed by the 32-byte key.
    derived = Buffer.from(spki.subarray(spki.length - 32)).toString('base64')
  } catch (cause) {
    return { ok: false, why: `not a usable private key (${cause.message})` }
  }
  if (expectedBase64 === null) return { ok: false, why: 'the extension names no public key' }
  return derived === expectedBase64
    ? { ok: true, why: 'matches the key compiled into the extension' }
    : { ok: false, why: 'does NOT match the key compiled into the extension — feeds would be rejected' }
}

/**
 * Turn a probe's outcome into a verdict, without doing the probe.
 *
 * Separated so the rules are testable without a network: a check that can only
 * be exercised online is a check nobody runs.
 *
 * @param {{ present: boolean; required: boolean; probe?: { ok: boolean; why: string } | null }} input
 * @returns {{ state: 'ok' | 'missing' | 'broken' | 'unverified'; why: string }}
 */
export function verdictOf({ present, required, probe }) {
  if (!present) {
    return required
      ? { state: 'missing', why: 'required, and not set' }
      : { state: 'missing', why: 'not set — the thing it unblocks stays unavailable' }
  }
  if (probe === undefined || probe === null) return { state: 'unverified', why: 'present; not probed' }
  return probe.ok ? { state: 'ok', why: probe.why } : { state: 'broken', why: probe.why }
}

// ---------------------------------------------------------------------------
// Probes. Each does the smallest real thing the access is for.
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, string>} env
 * @param {typeof fetch} doFetch
 */
async function probeCloudflare(env, doFetch) {
  /** @type {Record<string, { ok: boolean; why: string } | null>} */
  const out = { CLOUDFLARE_API_TOKEN: null, CLOUDFLARE_ACCOUNT_ID: null, OKOLOS_D1_ID: null }
  const token = env.CLOUDFLARE_API_TOKEN
  if (!token) return out
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  /**
   * Ask what the token is FOR, not whether it exists.
   *
   * The first version called `/user/tokens/verify`, which answers only for
   * user-owned tokens. Ours is account-scoped, so a token that had deployed the
   * worker ten minutes earlier came back 401 "Invalid API Token" — a check that
   * would have sent someone to rotate a working credential. Measured
   * 2026-08-08: verify 401, `/accounts/<id>` 200, the D1 database 200.
   *
   * Reaching the account and the database is also the stronger claim: it proves
   * the token can do the two things this project needs it for.
   */
  const account = env.CLOUDFLARE_ACCOUNT_ID
  if (!account) {
    return { ...out, CLOUDFLARE_API_TOKEN: { ok: false, why: 'no account id to check the token against' } }
  }

  try {
    const res = await doFetch(`https://api.cloudflare.com/client/v4/accounts/${account}`, { headers })
    const body = await res.json().catch(() => null)
    if (res.ok && body?.success) {
      const name = body?.result?.name ?? 'unnamed'
      out.CLOUDFLARE_API_TOKEN = { ok: true, why: 'reaches the account it is for' }
      out.CLOUDFLARE_ACCOUNT_ID = { ok: true, why: `account "${name}"` }
    } else {
      const why = body?.errors?.[0]?.message ?? `HTTP ${res.status}`
      // Which of the two is wrong is not knowable from one call, and guessing
      // would point at the wrong thing to fix.
      out.CLOUDFLARE_API_TOKEN = { ok: false, why: `token or account rejected: ${why}` }
      out.CLOUDFLARE_ACCOUNT_ID = { ok: false, why: `not reachable with this token: ${why}` }
      return out
    }
  } catch (cause) {
    return { ...out, CLOUDFLARE_API_TOKEN: { ok: false, why: `could not reach Cloudflare (${cause.message})` } }
  }

  const d1 = env.OKOLOS_D1_ID
  if (d1) {
    const res = await doFetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${d1}`,
      { headers },
    )
    const body = await res.json().catch(() => null)
    out.OKOLOS_D1_ID =
      res.ok && body?.success
        ? { ok: true, why: `database "${body?.result?.name ?? 'unnamed'}"` }
        : { ok: false, why: `no such database on this account (HTTP ${res.status})` }
  }
  return out
}

/**
 * @param {string} key
 * @param {typeof fetch} doFetch
 */
async function probeGemini(key, doFetch) {
  try {
    const res = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`)
    return res.ok
      ? { ok: true, why: 'the key answers' }
      : { ok: false, why: `rejected (HTTP ${res.status})` }
  } catch (cause) {
    return { ok: false, why: `could not reach the API (${cause.message})` }
  }
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

const GREEN = '[32m'
const RED = '[31m'
const DIM = '[2m'
const OFF = '[0m'
const MARK = { ok: `${GREEN}ok${OFF}`, missing: `${RED}--${OFF}`, broken: `${RED}BAD${OFF}`, unverified: '??' }

async function status({ probe = true } = {}) {
  const env = { ...stored(), ...process.env }
  const cf = probe ? await probeCloudflare(env, fetch) : {}

  console.log(`\nAccess for okolos, stored under ${STORE}`)
  console.log(`${DIM}Values are never printed. Probes do the smallest real thing each access is for.${OFF}\n`)

  let bad = 0
  for (const access of ACCESSES) {
    const present = Boolean(env[access.name])
    let probed = cf[access.name]
    if (probe && access.name === 'GEMINI_API_KEY' && present) {
      probed = await probeGemini(env[access.name], fetch)
    }
    const { state, why } = verdictOf({ present, required: access.required, probe: probe ? probed : null })
    if (state === 'broken' || (state === 'missing' && access.required)) bad += 1
    console.log(`  ${MARK[state].padEnd(14)} ${access.name.padEnd(22)} ${why}`)
    console.log(`  ${' '.repeat(14)} ${DIM}${access.unblocks} · read by ${access.readBy}${OFF}`)
    if (state === 'missing' && access.howToGet) {
      console.log(`  ${' '.repeat(14)} ${DIM}get it: ${access.howToGet}${OFF}`)
      console.log(`  ${' '.repeat(14)} ${DIM}then:   node tools/access.mjs set ${access.name}${OFF}`)
    }
  }

  const key = FEED_KEY_ACCESS
  const present = existsSync(key.file)
  const probed = present ? feedKeyMatches(readFileSync(key.file, 'utf8'), compiledPublicKey()) : null
  const { state, why } = verdictOf({ present, required: key.required, probe: probed })
  if (state === 'broken') bad += 1
  console.log(`  ${MARK[state].padEnd(14)} ${key.name.padEnd(22)} ${why}`)
  console.log(`  ${' '.repeat(14)} ${DIM}${key.unblocks} · read by ${key.readBy}${OFF}`)
  if (state === 'missing') console.log(`  ${' '.repeat(14)} ${DIM}get it: ${key.howToGet}${OFF}`)

  if (!modesApply()) {
    console.log(
      `\n  n/a  file modes: not checked on Windows, which has no POSIX mode bits; ` +
        `the files under ${STORE} are guarded by your user profile's permissions`,
    )
  }
  const problems = [CLOUDFLARE_ENV, TOOLS_ENV, FEED_KEY].map((f) => [f, permissionProblem(f)])
  for (const [file, problem] of problems) {
    if (problem) {
      bad += 1
      console.log(`\n  ${RED}BAD${OFF} ${file}: ${problem}`)
      console.log(`      fix: chmod 600 ${file}`)
    }
  }

  console.log(
    `\n${DIM}A gated command is a different problem: node tools/access.mjs permissions${OFF}\n`,
  )
  return bad
}

/** @param {string} name */
function setAccess(name) {
  const access = ACCESSES.find((a) => a.name === name)
  if (!access) {
    const known = [...ACCESSES.map((a) => a.name), 'FEED_KEY'].join(', ')
    die(`unknown access "${name}". Known: ${known}`)
  }
  // stdin, never argv: a command line lands in shell history and in the process
  // table, where any local process can read it.
  const raw = readFileSync(0, 'utf8')
  const value = normaliseValue(raw)
  if (!value) die('nothing on stdin. Usage: printf %s "$VALUE" | node tools/access.mjs set NAME')

  mkdirSync(STORE, { recursive: true, mode: 0o700 })
  chmodSync(STORE, 0o700)

  const current = existsSync(access.file) ? parseEnv(readFileSync(access.file, 'utf8')) : {}
  current[name] = value
  const body = Object.entries(current)
    .map(([k, v]) => `export ${k}=${v}`)
    .join('\n')
  writeFileSync(access.file, `${body}\n`, { mode: 0o600 })
  chmodSync(access.file, 0o600)
  console.log(`recorded ${name} in ${access.file} (mode 600). Value not shown.`)
  console.log(`verify it: node tools/access.mjs`)
}

/**
 * The permission entries, printed rather than written.
 *
 * Writing them would be the agent granting itself the thing the gate exists to
 * ask a person about. Printing them is the whole of what this command does.
 */
function permissions() {
  const rules = [
    'Bash(node tools/deploy-worker.mjs:*)',
    'Bash(node tools/publish-feed.mjs:*)',
    'Bash(node tools/access.mjs:*)',
    'Bash(npx wrangler deployments list:*)',
  ]
  console.log(`
The harness gates prod-mutating commands, and no credentials file changes that.
It is a permission decision, so it is yours: paste these into the "allow" array
of ~/.claude/settings.json → permissions, then restart Claude Code.

  ${JSON.stringify(rules, null, 2).split('\n').join('\n  ')}

What each one lets happen without asking again:

  deploy-worker.mjs     render config → D1 schema → deploy → smoke. Idempotent:
                        a second run writes 0 rows and redeploys the same code.
  publish-feed.mjs      publishes an already-signed feed. It never signs, and
                        the private key is not on the server.
  access.mjs            this tool. Reads and verifies; prints no values.
  wrangler deployments  read-only.

Deliberately NOT listed: \`wrangler d1 execute --remote\` and \`wrangler delete\`.
Those are the ones worth being asked about.
`)
}

/** @param {string} message */
function die(message) {
  console.error(`access: ${message}`)
  process.exit(1)
}

/**
 * Only when run, never when imported.
 *
 * `tools/access.test.ts` imports the rules above. Without this guard the import
 * ran the whole tool — network probes and all — which is a test that reaches
 * the internet because it mentioned a module.
 */
if (import.meta.filename === process.argv[1]) {
  const [command, argument] = process.argv.slice(2)
  if (command === 'set') setAccess(argument ?? die('name an access to set'))
  else if (command === 'permissions') permissions()
  else if (command === '--check') process.exit((await status({ probe: true })) > 0 ? 1 : 0)
  else if (command === undefined || command === 'status') await status()
  else die(`unknown command "${command}". Try: status, set NAME, permissions, --check`)
}
