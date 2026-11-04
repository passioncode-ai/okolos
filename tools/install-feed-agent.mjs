#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BOOTSTRAP_FILES, BOOTSTRAP_SOURCES } from './feed/bootstrap.mjs'
import { runBounded, withoutSecrets } from './feed/bounded.mjs'
import { openLog } from './feed/log.mjs'
import { feedPaths } from './feed/paths.mjs'
import { readSnapshotPr, snapshotPrFile } from './feed/snapshot-pr.mjs'
import { readStatus } from './feed/status.mjs'
import { discover, quote, runnerArgv, xml } from './feed-agent-credential.mjs'
import { directoriesIn, filesIn } from './tree.mjs'
import { isMain } from './is-main.mjs'

/**
 * Installs the feed-refresh agent on this machine, or prints what it would do.
 *
 *   node tools/install-feed-agent.mjs                      # checkout, bootstrap, plist, load
 *   node tools/install-feed-agent.mjs --dry-run            # print the plist, touch nothing
 *   node tools/install-feed-agent.mjs --allow-branch       # install from HEAD other than origin/main, or with
 *                                                          # uncommitted edits to what it installs (recorded:
 *                                                          # feed.log, and installedOffMain in every run's record)
 *   node tools/install-feed-agent.mjs --status             # plist, bootstrap (and drift), launchd's view, last run, snapshot PR
 *   node tools/install-feed-agent.mjs --uninstall          # bootout, delete the plist and bootstrap, verify
 *   node tools/install-feed-agent.mjs --uninstall --purge  # and the checkout, state and logs
 *
 * The schedule cannot live in CI: ADR-0002 keeps the signing key off every
 * server, so the feed is signed and published from the machine that holds it.
 * That makes installing the agent a human step, and this reduces it to one
 * command — which is the difference between a step someone does and a step
 * someone means to do. Measured 2026-08-19, the meaning-to version left the
 * shipped list six days old, blocking one live host out of 248.
 *
 * Symmetric by construction (LC-14): uninstall removes what install added and
 * proves launchd no longer knows the label — the plist used to stay behind and
 * launchd loaded it again at the next login (F5). launchd starts a bootstrap copied
 * to ~/.okolos/bin/feed-agent, outside the checkout, so a missing checkout is
 * recreated and recorded rather than a shell error nobody reads (B-159). And the operator's intent wins:
 * an install over an agent the operator disabled updates the file and loads
 * nothing.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const LABEL = 'app.okolos.feed'
const source = path.join(root, 'tools/launchd', `${LABEL}.plist`)

/**
 * What the installer takes from the working tree rather than from a commit,
 * relative to the repository: every file it copies beside launchd and the plist
 * template it renders. checkBranch holds each to HEAD.
 */
export const INSTALLED_SOURCES = [...BOOTSTRAP_FILES.map((file) => `tools/${sourceOf(file)}`), `tools/launchd/${LABEL}.plist`]

const PLACEHOLDERS = [
  '{{CHECKOUT}}',
  '{{RUNNER}}',
  '{{LOG_DIR}}',
  '{{LOGS}}',
  '{{STATE}}',
  '{{STATE_DIR}}',
  '{{BOOTSTRAP}}',
  '{{NODE}}',
  '{{SOURCE_REPO}}',
  '{{ORIGIN}}',
  '{{OFF_MAIN}}',
]
const LAUNCHCTL_TIMEOUT_MS = 15_000

/**
 * The environment of every child the installer starts: git, pnpm, launchctl and the
 * Observatory probe. Nothing the installer runs publishes, so none of them gets the
 * Cloudflare credential (SECRET_VARIABLES, the list the job and the bootstrap drop),
 * and git never prompts.
 */
export function installerEnv(from = process.env) {
  return { ...withoutSecrets(from), GIT_TERMINAL_PROMPT: '0' }
}

/**
 * `tool` (runBounded's shape) with installerEnv forced on every call. Every bounded
 * child of the installer goes through here, so a new call cannot forget it.
 */
export function installerTool(tool = runBounded, from = process.env) {
  return (command, args, options = {}) => tool(command, args, { ...options, env: installerEnv(options.env ?? from) })
}

/** execFileSync with installerEnv: the run discover() uses to find the Observatory. */
export function installerRun(command, args, options = {}) {
  return execFileSync(command, args, { ...options, env: installerEnv(options.env ?? process.env) })
}

/** launchctl, bounded. Returns `{ code, stdout, stderr }`. */
async function realLaunchctl(args) {
  const result = await installerTool()('launchctl', args, { timeoutMs: LAUNCHCTL_TIMEOUT_MS })
  return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr || result.error || '' }
}

/**
 * The plist launchd will read: placeholders replaced inside their strings only, so
 * no comment is rewritten, and a template that lost one is refused rather than
 * guessed at — launchd would fail silently every twelve hours.
 */
export function rendered({
  template = readFileSync(source, 'utf8'),
  checkout,
  runner,
  logDir,
  stateDir = feedPaths().state,
  bootstrap,
  node = stableNode(),
  sourceRepo = root,
  origin = '',
  offMain = '',
}) {
  for (const token of PLACEHOLDERS) {
    if (!template.includes(token)) throw new Error(`${source} no longer contains ${token} — refusing to guess`)
  }
  // Words in the shell command are shell-quoted; values of environment variables are not.
  const out = template
    .replaceAll('{{BOOTSTRAP}}', xml(quote(bootstrap)))
    .replaceAll('{{STATE}}', xml(quote(stateDir)))
    .replaceAll('{{LOGS}}', xml(quote(logDir)))
    .replaceAll('{{NODE}}', xml(quote(node)))
    .replaceAll('{{CHECKOUT}}', xml(checkout))
    .replaceAll('{{SOURCE_REPO}}', xml(sourceRepo))
    .replaceAll('{{ORIGIN}}', xml(origin))
    .replaceAll('{{OFF_MAIN}}', xml(offMain))
    .replaceAll('{{RUNNER}}', runner ? xml(JSON.stringify(runner)).replaceAll('"', '&quot;') : '')
    .replaceAll('{{STATE_DIR}}', xml(stateDir))
    .replaceAll('{{LOG_DIR}}', xml(logDir))
  if (out.includes('{{')) throw new Error('a placeholder survived rendering')
  return out
}

/** Whether `launchctl print-disabled` lists `label` as disabled (both spellings macOS uses). */
export function isDisabled(printDisabled, label = LABEL) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`"${escaped}"\\s*=>\\s*(?:disabled|true)\\b`).test(printDisabled)
}

/**
 * The agent's own checkout: a detached worktree of this repository at origin/main,
 * with only the publish tools installed. Left alone when it exists — the job
 * fast-forwards it before every run.
 */
export async function ensureCheckout({ repo = root, checkout, tool = runBounded, env: from = process.env, log = console.log }) {
  if (existsSync(checkout)) {
    log(`agent checkout: ${checkout} (kept; the job fast-forwards it)`)
    return
  }
  // No credential for git or pnpm (installerEnv).
  const run = installerTool(tool, from)
  const steps = [
    // A folder deleted under git leaves its worktree entry, and `add` refuses that
    // path until the entry is pruned (B-150).
    ['git', ['-C', repo, 'worktree', 'prune'], { timeoutMs: 90_000 }],
    ['git', ['-C', repo, 'fetch', '--quiet', 'origin', 'main'], { timeoutMs: 90_000 }],
    ['git', ['-C', repo, 'worktree', 'add', '--detach', checkout, 'origin/main'], { timeoutMs: 120_000 }],
    ['pnpm', ['install', '--frozen-lockfile', '--filter', '@okolos/proxy'], { cwd: checkout, timeoutMs: 600_000 }],
  ]
  for (const [command, args, options] of steps) {
    const result = await run(command, args, options)
    if (result.code !== 0) {
      throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.error || '').trim()}`)
    }
  }
  log(`agent checkout: ${checkout} at origin/main`)
}

/**
 * Copies the bootstrap launchd starts, and every module it imports, to `dir`
 * (B-159). The whole folder is replaced at once — built beside it, then renamed in
 * — so an update leaves no retired module behind and launchd never starts a half
 * copy.
 */
export function installBootstrap({ dir, from = path.join(root, 'tools'), files = BOOTSTRAP_FILES, log = () => {} }) {
  const staging = `${dir}.staging-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  for (const file of files) {
    copyFileSync(path.join(from, sourceOf(file)), path.join(staging, file))
    chmodSync(path.join(staging, file), 0o600)
  }
  chmodSync(staging, 0o700)
  rmSync(dir, { recursive: true, force: true })
  renameSync(staging, dir)
  log(`bootstrap: ${path.join(dir, 'bootstrap.mjs')} (${files.length} files, outside the checkout)`)
}

/**
 * The node the plist falls back to when the login shell finds none: the PATH entry
 * that leads to the running node (`/opt/homebrew/bin/node`), not the running
 * binary's own path. `process.execPath` is the realpath, a versioned folder such
 * as `Cellar/node/26.10.0_2`, which the next `brew upgrade` deletes.
 */
export function stableNode({ execPath = process.execPath, pathEnv = process.env.PATH ?? '' } = {}) {
  const real = (file) => {
    try {
      return realpathSync(file)
    } catch {
      return null
    }
  }
  const running = real(execPath) ?? execPath
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue
    const candidate = path.join(dir, 'node')
    if (existsSync(candidate) && real(candidate) === running) return candidate
  }
  return execPath
}

/**
 * Whether this clone may install the agent: its HEAD is origin/main, freshly
 * fetched, and every file the installer copies or renders (INSTALLED_SOURCES) is
 * HEAD's, with nothing edited, staged, deleted or untracked. The branch name is not
 * checked, the commit is: a `main` behind or ahead of origin/main, or an edit under
 * tools/feed, installs a bootstrap that is not what production runs. ADR-0017:
 * production publishes run only from origin/main, and the clone the installer runs
 * in is what the bootstrap recreates the checkout from.
 */
export async function checkBranch({ repo = root, tool = runBounded, env = process.env }) {
  const run = installerTool(tool, env)
  const git = (args, timeoutMs = 15_000) => run('git', ['-C', repo, ...args], { timeoutMs })
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch.code !== 0) return { ok: false, branch: null, reason: `git cannot read ${repo}: ${(branch.stderr || '').trim()}` }
  const name = branch.stdout.trim()
  const fetched = await git(['fetch', '--quiet', 'origin', 'main'], 90_000)
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  const target = (await git(['rev-parse', 'origin/main'])).stdout.trim()
  const status = await git(['status', '--porcelain', '--untracked-files=all', '--', ...INSTALLED_SOURCES])
  // Porcelain v1: two status letters, a space, the path from the repository's top. A
  // file removed from the index but kept on disk is listed twice (D and ??): once here.
  const changed =
    status.code === 0 ? [...new Set(status.stdout.split('\n').filter((line) => line.trim() !== '').map((line) => line.slice(3)))] : null
  const facts = { branch: name, head, target, changed: changed ?? [] }
  if (fetched.code !== 0) {
    return {
      ok: false,
      ...facts,
      reason:
        `could not fetch origin/main to compare HEAD with it (${(fetched.stderr || fetched.error || '').trim()}). ` +
        `Connect and run again, or pass --allow-branch to override.`,
    }
  }
  if (changed === null) {
    return {
      ok: false,
      ...facts,
      reason:
        `git cannot tell whether ${repo} has uncommitted changes in what the installer copies ` +
        `(${(status.stderr || status.error || '').trim()}). Run again, or pass --allow-branch to override.`,
    }
  }
  const atMain = /^[0-9a-f]{40}$/.test(head) && head === target
  if (atMain && changed.length === 0) return { ok: true, ...facts }
  const reasons = []
  if (!atMain) {
    reasons.push(
      `${repo} is ${name} at ${head.slice(0, 7) || 'an unreadable HEAD'}, not origin/main ${target.slice(0, 7) || '(unreadable)'}: ` +
        `the agent publishes production only from origin/main (ADR-0017), and recreates its checkout from this clone.`,
    )
  }
  if (changed.length) {
    reasons.push(
      `${repo} has uncommitted changes in what the installer copies and renders (${changed.join(', ')}): ` +
        `the installed bootstrap and plist would not be ${atMain ? 'origin/main' : 'HEAD'}'s. Commit or stash them.`,
    )
  }
  return {
    ok: false,
    ...facts,
    reason: `${reasons.join(' ')} Install from the main clone at origin/main, or pass --allow-branch to override.`,
  }
}

/** One line for an install made past checkBranch's refusal; it rides in the plist into every run's record. */
export function offMainNote(branch, at = new Date().toISOString()) {
  const short = (sha) => (sha ? String(sha).slice(0, 7) : 'unreadable')
  const uncommitted = branch.changed?.length ? `, uncommitted: ${branch.changed.join(', ')}` : ''
  return `${branch.branch ?? 'HEAD'} at ${short(branch.head)}, origin/main ${short(branch.target)}${uncommitted} (--allow-branch, ${at})`
}

function digest(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/** An installed file's source under tools/: BOOTSTRAP_SOURCES, else tools/feed. */
function sourceOf(file) {
  return BOOTSTRAP_SOURCES[file] ?? `feed/${file}`
}

/**
 * Whether the bootstrap copy in `bin` is the one in `from` (the agent checkout's
 * tools/): `{ matches, differs }`, `matches` null when there is no checkout to
 * compare with. The copy changes only at install, the checkout at every run.
 */
export function bootstrapDrift({ bin, from, files = BOOTSTRAP_FILES }) {
  if (!existsSync(path.join(from, 'feed', 'bootstrap.mjs'))) return { matches: null, differs: [] }
  const names = new Set([...files, ...(existsSync(bin) ? filesIn(bin, '.mjs') : [])])
  const differs = [...names].filter((name) => digest(path.join(bin, name)) !== digest(path.join(from, sourceOf(name)))).sort()
  return { matches: differs.length === 0, differs }
}

/** The clone's origin URL, which the bootstrap clones from when the clone itself is gone; '' when none. */
export async function originUrl({ repo = root, tool = runBounded, env = process.env }) {
  const result = await installerTool(tool, env)('git', ['-C', repo, 'remote', 'get-url', 'origin'], { timeoutMs: 15_000 })
  return result.code === 0 ? result.stdout.trim() : ''
}

/** Writes the plist and loads it — unless the operator disabled the service. */
export async function installAgent({ label = LABEL, domain, target, plist, launchctl = realLaunchctl, log = console.log }) {
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, plist)
  log(`wrote ${target}`)

  const disabled = await launchctl(['print-disabled', domain])
  if (isDisabled(disabled.stdout, label)) {
    log(
      `${label} is disabled in ${domain} — the operator's choice, kept. The plist is updated; ` +
        `nothing was loaded. To turn it back on: launchctl enable ${domain}/${label}, then run this again.`,
    )
    return { state: 'disabled' }
  }

  // Bootout first so re-running is an update rather than an error about an agent
  // that is already loaded. Not loaded yet is the ordinary case on a first install.
  await launchctl(['bootout', `${domain}/${label}`])
  const loaded = await launchctl(['bootstrap', domain, target])
  if (loaded.code !== 0) throw new Error(`launchctl bootstrap failed: ${loaded.stderr.trim()}`)
  return { state: 'loaded' }
}

/**
 * Boots the agent out, deletes its plist and its bootstrap, and verifies with
 * `launchctl print` that launchd no longer knows the label. With `purge`, also
 * removes the agent's checkout (and a broken one the bootstrap moved aside),
 * state and logs.
 */
export async function uninstallAgent({ label = LABEL, domain, target, bin, launchctl = realLaunchctl, log = console.log, purge }) {
  // Not loaded is the outcome asked for, not a failure.
  await launchctl(['bootout', `${domain}/${label}`])
  rmSync(target, { force: true })
  if (bin) {
    rmSync(bin, { recursive: true, force: true })
    // A staging folder an interrupted install left, and ~/.okolos/bin when the
    // agent was all it held. rmdir removes only an empty folder.
    const parent = path.dirname(bin)
    const staging = `${path.basename(bin)}.staging-`
    if (existsSync(parent)) {
      for (const name of directoriesIn(parent)) {
        if (name.startsWith(staging)) rmSync(path.join(parent, name), { recursive: true, force: true })
      }
      try {
        rmdirSync(parent)
      } catch {
        // Not empty: something else lives there.
      }
    }
  }

  if (purge) {
    const { repo, paths, tool: purgeTool = runBounded } = purge
    const tool = installerTool(purgeTool)
    if (existsSync(paths.agentCheckout)) {
      const removed = await tool('git', ['-C', repo, 'worktree', 'remove', '--force', paths.agentCheckout], { timeoutMs: 60_000 })
      if (removed.code !== 0) log(`git worktree remove failed (${(removed.stderr || '').trim()}); removing the directory`)
      rmSync(paths.agentCheckout, { recursive: true, force: true })
    }
    rmSync(`${paths.agentCheckout}.broken`, { recursive: true, force: true })
    await tool('git', ['-C', repo, 'worktree', 'prune'], { timeoutMs: 60_000 })
    rmSync(paths.state, { recursive: true, force: true })
    rmSync(paths.logs, { recursive: true, force: true })
    log(`purged ${paths.agentCheckout}, ${paths.state} and ${paths.logs}`)
  }

  const still = await launchctl(['print', `${domain}/${label}`])
  if (still.code === 0) {
    return { ok: false, reason: `${domain}/${label} is still loaded after bootout — check launchctl print ${domain}/${label}` }
  }
  log(`removed ${label}: no plist at ${target}${bin ? `, no bootstrap at ${bin}` : ''}, and launchd no longer lists it`)
  return { ok: true }
}

function field(printed, name) {
  return new RegExp(`^\\s*${name} = (.+)$`, 'm').exec(printed)?.[1]?.trim()
}

/** The plist, launchd's view of the service, and the last run's record. */
export async function agentStatus({ label = LABEL, domain, target, launchctl = realLaunchctl, paths = feedPaths() }) {
  const printed = await launchctl(['print', `${domain}/${label}`])
  const loaded = printed.code === 0
  const runs = Number(field(printed.stdout, 'runs'))
  const lastExit = Number(field(printed.stdout, 'last exit code'))
  const plistText = existsSync(target) ? readFileSync(target, 'utf8') : ''
  const program = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plistText)?.[1] ?? ''
  const plistStartsBootstrap = program.includes('bootstrap.mjs')
  const drift = bootstrapDrift({ bin: paths.agentBin, from: path.join(paths.agentCheckout, 'tools') })
  const notes = []
  if (plistText && !plistStartsBootstrap) notes.push('the old plist (cd into the checkout) is installed; run pnpm feed:agent from the main clone')
  if (drift.matches === false) {
    notes.push(`the installed bootstrap differs from the checkout's (${drift.differs.join(', ')}); run pnpm feed:agent from the main clone`)
  }
  // The last snapshot step (B-158). Nothing else tells anyone that its pull request waits:
  // GitHub does not notify the author of their own pull request, and no alarm reads the record.
  const snapshotPr = readSnapshotPr(snapshotPrFile(paths))
  // A pull request is named until a step saw it merged or closed, or saw main carry the
  // version; a step that failed before reaching it carries it (`prAt`: when last seen).
  if (snapshotPr?.pr) {
    const { number, url } = snapshotPr.pr
    const since = snapshotPr.since ?? snapshotPr.at
    const asOf = snapshotPr.prAt ?? snapshotPr.at
    const prOutcome = snapshotPr.prOutcome ?? snapshotPr.outcome
    const last = `last step ${snapshotPr.at}: ${snapshotPr.outcome}${snapshotPr.reason ? `: ${snapshotPr.reason}` : ''}`
    notes.push(
      prOutcome === 'auto-merge-requested' || prOutcome === 'updated'
        ? `snapshot pull request #${number} (${url}): ${prOutcome} since ${since}, as of ${asOf} (${last})`
        : `snapshot pull request #${number} (${url}) waits for a person since ${since}, as of ${asOf} (${last}); merge it with "Create a merge commit" once CI is green`,
    )
  }
  return {
    plist: existsSync(target),
    plistStartsBootstrap,
    bootstrap: existsSync(paths.bootstrap),
    bootstrapMatchesCheckout: drift.matches,
    bootstrapDiffers: drift.differs,
    ...(notes.length ? { note: notes.join('; ') } : {}),
    loaded,
    launchd: loaded
      ? {
          state: field(printed.stdout, 'state') ?? null,
          runs: Number.isFinite(runs) ? runs : null,
          lastExit: Number.isFinite(lastExit) ? lastExit : null,
        }
      : null,
    lastRun: readStatus(paths.status),
    snapshotPr,
    log: paths.log,
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const target = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`)
  const domain = `gui/${process.getuid?.() ?? 501}`
  const paths = feedPaths()

  if (process.platform !== 'darwin') {
    console.error(
      'The feed agent installs on macOS only: launchd starts its bootstrap, which keeps\n' +
        'the checkout and the status record. On Linux, publish by hand from a clean clone at\n' +
        'origin/main on a machine that holds the signing key: pnpm feed:refresh. The feed\n' +
        'tools do not run on Windows.',
    )
    process.exit(argv.includes('--uninstall') ? 0 : 1)
  }

  if (argv.includes('--status')) {
    console.log(JSON.stringify(await agentStatus({ domain, target, paths }), null, 2))
    return
  }

  if (argv.includes('--uninstall')) {
    const result = await uninstallAgent({
      domain,
      target,
      bin: paths.agentBin,
      purge: argv.includes('--purge') ? { repo: root, paths } : undefined,
    })
    if (!result.ok) {
      console.error(`install-feed-agent: ${result.reason}`)
      process.exit(1)
    }
    return
  }

  const branch = await checkBranch({ repo: root })
  let offMain = ''
  if (!branch.ok) {
    if (argv.includes('--dry-run')) console.log(`— would refuse: ${branch.reason}`)
    else if (!argv.includes('--allow-branch')) throw new Error(branch.reason)
    else {
      offMain = offMainNote(branch)
      console.log(`installing past the origin/main check because --allow-branch was given: ${offMain}`)
      // Recorded where a person looks: feed.log now, and every run's status
      // (installedOffMain) for as long as this plist is installed.
      openLog(paths.log).write(`install: ${offMain}`)
    }
  }

  const plist = rendered({
    checkout: paths.agentCheckout,
    runner: runnerArgv(discover({ run: installerRun })),
    logDir: paths.logs,
    stateDir: paths.state,
    bootstrap: paths.bootstrap,
    sourceRepo: root,
    origin: await originUrl({ repo: root }),
    offMain,
  })
  if (argv.includes('--dry-run')) {
    console.log(plist)
    console.log(`\n— would create ${paths.agentCheckout} (a worktree at origin/main) if missing`)
    console.log(`— would copy ${BOOTSTRAP_FILES.join(', ')} to ${paths.agentBin}`)
    console.log(`— would write ${target}`)
    console.log(`— would run: launchctl bootstrap ${domain} ${target} (unless the operator disabled it)`)
    return
  }

  await ensureCheckout({ checkout: paths.agentCheckout })
  installBootstrap({ dir: paths.agentBin, log: console.log })
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 })
  const { state } = await installAgent({ domain, target, plist })
  if (state === 'loaded') {
    console.log(
      `loaded ${LABEL} — refreshes every 12 hours, and now if the served feed is stale.\n` +
        `  node tools/install-feed-agent.mjs --status\n` +
        `  tail -f ${paths.log}`,
    )
  }
}

if (isMain(import.meta.filename)) {
  main().catch((cause) => {
    console.error(`install-feed-agent: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exit(1)
  })
}
