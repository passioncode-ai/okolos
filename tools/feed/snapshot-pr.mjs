import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { FEED_MAX_AGE_DAYS, FEED_PATH } from '../feed-age.mjs'
import { snapshotText } from '../feed-snapshot.mjs'
import { withoutSecrets } from './bounded.mjs'

/**
 * The feed agent proposes the committed snapshot itself (B-158).
 *
 * The release gate and CI on main refuse a `feeds/phishing.json` older than fourteen
 * days (`tools/feed-age.mjs`). The agent publishes twice a day, but only a person
 * committed the snapshot, so main went red on 2026-10-19 and would again on
 * 2026-11-09. After a publish, when the snapshot on origin/main is SNAPSHOT_PR_AFTER_DAYS
 * old or older, this step:
 *
 *   1. checks that the `update` the worker serves (signed, `{update, signature}`) equals
 *      the feed this machine just published (ADR-0017: the served feed is the truth), and
 *      takes the published file's bytes (the unsigned `{kind, body}`) with the
 *      newline `pnpm feed:snapshot` adds, so the commit is what the manual procedure
 *      would have committed and nothing else;
 *   2. builds a commit that changes only that file, from origin/main's tree, through a
 *      private index (GIT_INDEX_FILE in a private temp folder): the checkout's HEAD,
 *      index and files stay as the pin stage left them, so the next run's pin check is
 *      untouched;
 *   3. pushes it to ONE reused branch, SNAPSHOT_BRANCH, never forced. The new commit
 *      always descends from the branch's tip: a single parent when the tip already
 *      contains main, main alone when the tip was merged, and both (a merge commit)
 *      when main moved past it, so the push is a fast-forward and the pull request is
 *      always up to date with main. A branch that carries any change but the snapshot
 *      is left for a person. The alternative, a new branch per version with the stale
 *      pull request closed, needs a close and a branch deletion per run and leaves
 *      one dead branch per refusal; one branch keeps one pull request open at a time;
 *   4. opens the pull request, or updates the open one (title and body name the
 *      version), and asks GitHub to merge it with a merge commit once main's required
 *      checks pass (`gh pr merge --auto --merge --match-head-commit`). It does not ask
 *      when the repository does not allow auto-merge, or when main requires no status
 *      check (auto-merge would then merge before CI); the pull request stays open for a
 *      person and the record says why. It never merges by hand or as an administrator.
 *
 * The push sets OKOLOS_SKIP_GATES=1: `.githooks/pre-push` would run all eight gates,
 * and the agent's checkout has only the publish tools installed. That variable is the
 * hook's documented escape, and it prints what it skipped; the push's output goes line
 * by line to `log`, which the job points at feed.log, so the skip leaves its trace there.
 * The gate for this commit is the pull request's checks, which auto-merge waits for.
 *
 * Every child is bounded by its own deadline and by `deadline`, the time the run's
 * watchdog leaves, so this step can never turn a publish into a watchdog failure.
 * It never throws: every outcome is a record, `{ outcome, reason?, branch, version,
 * committed?, commit?, pr? }`, with `outcome` one of SNAPSHOT_OUTCOMES and `pr.action`
 * saying whether the pull request was opened or updated. Once `stopped()` names a
 * signal, no further child starts. The job keeps the last step's record, dated by
 * `withSince`, in its own file (`snapshotPrFile`) and in every later run record, so a
 * pull request that waits for a person stays visible until a newer step replaces it. gh runs on its
 * own stored login: GH_TOKEN and GITHUB_TOKEN are removed from its environment, as
 * the Cloudflare credential is from every child here.
 */

export const SNAPSHOT_BRANCH = 'chore/feed-snapshot-auto'
/** Half the release gate's ceiling: a week for the pull request's checks and merge. */
export const SNAPSHOT_PR_AFTER_DAYS = FEED_MAX_AGE_DAYS / 2
/** The whole step, when the run's watchdog leaves more. */
export const SNAPSHOT_BUDGET_MS = 5 * 60_000
export const SNAPSHOT_DEADLINES = { git: 90_000, gh: 60_000 }
/** A child is not started with less than this left. */
const MIN_CALL_MS = 1000

/**
 * Every outcome a step can end with. `opened` is not one: a new pull request always goes
 * on to the auto-merge request, so whether it was opened or updated is `pr.action`.
 * `updated` ends a step only when auto-merge is already on for the open pull request.
 */
export const SNAPSHOT_OUTCOMES = ['skipped-fresh', 'updated', 'auto-merge-requested', 'auto-merge-unavailable', 'failed']

/** Where the job keeps the last snapshot step: beside the run record, not in it alone. */
export function snapshotPrFile(paths) {
  return path.join(paths.state, 'snapshot-pr.json')
}

/** The last snapshot step, or null when there is none or it cannot be read. */
export function readSnapshotPr(file) {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'))
    return record && typeof record === 'object' && typeof record.outcome === 'string' ? record : null
  } catch {
    return null
  }
}

/** Writes the last snapshot step whole, owner-only, through a temp file. */
export function writeSnapshotPr(file, record) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
  return record
}

/**
 * `next` stamped with `at`, and, when it names a pull request, `since`: when that pull
 * request was first recorded (kept from `previous` while the number is the same).
 */
export function withSince(previous, next, at) {
  const fields = { ...next }
  delete fields.since
  delete fields.at
  if (!fields.pr) return { ...fields, at }
  const same = previous?.pr?.number === fields.pr.number
  return { ...fields, at, since: same ? (previous.since ?? previous.at ?? at) : at }
}

const GITHUB_TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']

/** Thrown inside the step to end it with an outcome and a reason. */
class Stop extends Error {
  constructor(outcome, reason) {
    super(reason)
    this.outcome = outcome
  }
}

function lastLine(result) {
  return (result.stderr || result.stdout || '').trim().split('\n').at(-1)?.trim() ?? ''
}

function describe(name, result) {
  if (result.timedOut) return `${name} timed out; its process group was killed`
  if (result.error) return `${name} could not start: ${result.error}`
  const said = lastLine(result)
  return `${name} exited ${result.code ?? result.signal}${said ? `: ${said}` : ''}`
}

function parseFeed(text, what) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Stop('failed', `${what} is not JSON`)
  }
  const body = parsed?.body
  if (!Number.isSafeInteger(body?.version)) throw new Stop('failed', `${what} carries no version`)
  return parsed
}

function title(version) {
  return `chore(feed): снимок фида v${version} из опубликованного агентом (B-158)`
}

/** The committed snapshot's age in words, for a commit message and a pull request. */
function ageWords(ageDays) {
  return ageDays === null ? 'возраст неизвестен (нет читаемого body.updatedAt)' : `ему ${ageDays} дн.`
}

function body({ version, entries, updatedAt, committed }) {
  return [
    `Агент фида опубликовал v${version} (${entries} записей, собран ${updatedAt}).`,
    `Снимок \`${FEED_PATH}\` на main: v${committed.version}, ${ageWords(committed.ageDays)}; гейт выпуска отказывает после ${FEED_MAX_AGE_DAYS} дн.`,
    '',
    `Меняется только \`${FEED_PATH}\`: опубликованный с этой машины фид без подписи (\`{kind, body}\`), как его записал бы \`pnpm feed:snapshot\`; перед коммитом сверено, что его \`body\` равен тому, что отдаёт воркер в \`update\` (ADR-0017).`,
    'Слияние коммитом слияния, автоматически, когда обязательные проверки main зелёные. Если автослияние в репозитории выключено, PR ждёт человека.',
    '',
    `Открыт и обновляется агентом фида (\`tools/feed/snapshot-pr.mjs\`), ветка \`${SNAPSHOT_BRANCH}\`.`,
    '',
  ].join('\n')
}

/**
 * Proposes the snapshot of the feed in `feedFile`. Every external effect is a
 * parameter: `tool` runs git and gh (runBounded's shape), `readServedFeed` reads the
 * worker (feed/served.mjs `readServed`'s answer).
 */
export async function proposeSnapshot({
  root,
  feedFile,
  readServedFeed,
  tool,
  env = process.env,
  now = Date.now,
  deadline = now() + SNAPSHOT_BUDGET_MS,
  tmp = tmpdir(),
  log = () => {},
  stopped = () => null,
} = {}) {
  const facts = { branch: SNAPSHOT_BRANCH }
  let work
  try {
    const clean = withoutSecrets(env)
    for (const name of GITHUB_TOKENS) delete clean[name]
    const gitEnv = {
      ...clean,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15',
    }
    const ghEnv = { ...clean, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' }

    const call = (command, args, { limit, ...options }) => {
      const signal = stopped()
      if (signal) throw new Stop('failed', `stopped by ${signal}`)
      const left = deadline - now()
      if (left < MIN_CALL_MS) {
        throw new Stop('failed', `out of time: the run's watchdog leaves ${Math.max(0, Math.round(left / 1000))} s for ${command}`)
      }
      return tool(command, args, { cwd: root, ...options, timeoutMs: Math.min(limit, left) })
    }
    const git = (args, options = {}) =>
      call('git', ['-C', root, ...args], {
        env: { ...gitEnv, ...options.env },
        limit: SNAPSHOT_DEADLINES.git,
        input: options.input,
        ...(options.onLine ? { onLine: options.onLine } : {}),
      })
    const gh = (args, options = {}) => call('gh', args, { env: ghEnv, limit: SNAPSHOT_DEADLINES.gh, input: options.input })
    const must = async (name, promise) => {
      const result = await promise
      if (result.code !== 0) throw new Stop('failed', describe(name, result))
      return result.stdout.trim()
    }

    // 1. What was published here, and what main carries.
    let localText
    try {
      localText = readFileSync(feedFile, 'utf8')
    } catch (cause) {
      throw new Stop('failed', `no published feed at ${feedFile}: ${cause.message}`)
    }
    const local = parseFeed(localText, 'the published feed')
    facts.version = local.body.version

    const shown = await git(['show', `origin/main:${FEED_PATH}`])
    if (shown.code !== 0) throw new Stop('failed', describe(`git show origin/main:${FEED_PATH}`, shown))
    const onMain = parseFeed(shown.stdout, `${FEED_PATH} on origin/main`).body
    const at = Date.parse(onMain.updatedAt)
    // Compared unrounded; rounded only for the record and the text.
    const exactDays = Number.isFinite(at) ? (now() - at) / 86_400_000 : null
    const ageDays = exactDays === null ? null : Math.round(exactDays * 10) / 10
    facts.committed = { version: onMain.version, ageDays }
    if (onMain.version >= local.body.version) {
      throw new Stop('skipped-fresh', `origin/main already carries v${onMain.version}`)
    }
    if (exactDays !== null && exactDays < SNAPSHOT_PR_AFTER_DAYS) {
      throw new Stop('skipped-fresh', `the snapshot on origin/main is ${ageDays} days old, under ${SNAPSHOT_PR_AFTER_DAYS}`)
    }

    // 2. gh present and logged in, before anything leaves this machine.
    const auth = await gh(['auth', 'status', '--hostname', 'github.com'])
    if (auth.error) throw new Stop('failed', `gh unavailable: gh is not installed or not on PATH (${auth.error})`)
    if (auth.code !== 0) throw new Stop('failed', `gh unavailable: not logged in to github.com (${describe('gh auth status', auth)})`)

    // 3. The feed published here is the one the worker serves.
    const served = await readServedFeed()
    if (served?.state !== 'served') throw new Stop('failed', 'the worker serves no feed, so there is nothing to commit')
    const signed = JSON.parse(served.text)
    const update = signed?.update ?? signed
    if (!isDeepStrictEqual({ kind: update?.kind, body: update?.body }, { kind: local.kind, body: local.body })) {
      throw new Stop('failed', `the served feed (v${served.version}) is not the feed published here (v${local.body.version})`)
    }
    const text = snapshotText(localText)

    // 4. The branch as it is on origin.
    const listed = await must('git ls-remote', git(['ls-remote', '--heads', 'origin', `refs/heads/${SNAPSHOT_BRANCH}`]))
    const tip = listed.split(/\s+/)[0] || ''
    const main = await must('git rev-parse origin/main', git(['rev-parse', '--verify', 'origin/main']))
    let parents = [main]
    if (tip) {
      await must('git fetch', git(['fetch', '--quiet', 'origin', `+refs/heads/${SNAPSHOT_BRANCH}:refs/remotes/origin/${SNAPSHOT_BRANCH}`]))
      const changed = (await must('git diff', git(['diff', '--name-only', `origin/main...${tip}`])))
        .split('\n')
        .filter((name) => name !== '')
      const foreign = changed.filter((name) => name !== FEED_PATH)
      if (foreign.length > 0) {
        throw new Stop('failed', `${SNAPSHOT_BRANCH} carries changes besides the snapshot (${foreign.join(', ')}); left for a person`)
      }
      const ancestor = async (a, b) => {
        const result = await git(['merge-base', '--is-ancestor', a, b])
        if (result.code === 0) return true
        if (result.code === 1) return false
        throw new Stop('failed', describe('git merge-base', result))
      }
      if (await ancestor('origin/main', tip)) parents = [tip]
      else if (await ancestor(tip, 'origin/main')) parents = [main]
      else parents = [tip, main]
    }

    // 5. The commit, through a private index; pushed only when it is new.
    const blob = await must('git hash-object', git(['hash-object', '-w', '--stdin'], { input: text }))
    let commit
    const carried = parents.length === 1 && parents[0] === tip ? await git(['rev-parse', `${tip}:${FEED_PATH}`]) : null
    if (carried?.code === 0 && carried.stdout.trim() === blob) {
      commit = tip
    } else {
      mkdirSync(tmp, { recursive: true })
      work = mkdtempSync(path.join(tmp, 'okolos-feed-'))
      const index = { env: { GIT_INDEX_FILE: path.join(work, 'index') } }
      await must('git read-tree', git(['read-tree', 'origin/main'], index))
      await must('git update-index', git(['update-index', '--add', '--cacheinfo', `100644,${blob},${FEED_PATH}`], index))
      const tree = await must('git write-tree', git(['write-tree'], index))
      const message =
        `${title(local.body.version)}\n\n` +
        `Агент фида опубликовал v${local.body.version}; снимок на main был v${onMain.version}, ${ageWords(ageDays)}.\n` +
        `Меняется только ${FEED_PATH}: опубликованный фид без подписи, сверенный с тем, что отдаёт воркер (ADR-0017).\n`
      commit = await must(
        'git commit-tree',
        git(['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-F', '-'], { input: message }),
      )
      // The hook's output (its skip notice) and git's go to the run's log, line by line.
      const pushed = await git(['push', '--quiet', 'origin', `${commit}:refs/heads/${SNAPSHOT_BRANCH}`], {
        env: { OKOLOS_SKIP_GATES: '1' },
        onLine: (_stream, line) => log(`   ${line}`),
      })
      if (pushed.code !== 0) throw new Stop('failed', describe('git push', pushed))
    }
    facts.commit = commit

    // 6. The pull request.
    const open = JSON.parse(
      await must(
        'gh pr list',
        gh(['pr', 'list', '--head', SNAPSHOT_BRANCH, '--base', 'main', '--state', 'open', '--json', 'number,url,autoMergeRequest', '--limit', '1']),
      ) || '[]',
    )
    const text2 = body({ version: local.body.version, entries: local.body.entries?.length ?? 0, updatedAt: local.body.updatedAt, committed: facts.committed })
    if (open.length > 0) {
      const { number, url, autoMergeRequest } = open[0]
      facts.pr = { number, url, action: 'updated' }
      await must('gh pr edit', gh(['pr', 'edit', String(number), '--title', title(local.body.version), '--body-file', '-'], { input: text2 }))
      if (autoMergeRequest) throw new Stop('updated', 'auto-merge is already on for this pull request')
    } else {
      const url = await must(
        'gh pr create',
        gh(['pr', 'create', '--base', 'main', '--head', SNAPSHOT_BRANCH, '--title', title(local.body.version), '--body-file', '-'], { input: text2 }),
      )
      const number = Number(/\/pull\/(\d+)/.exec(url)?.[1])
      if (!Number.isSafeInteger(number)) throw new Stop('failed', `gh pr create printed no pull request URL: ${url}`)
      facts.pr = { number, url, action: 'opened' }
    }

    // 7. Auto-merge, only where the repository allows it and checks gate it.
    const allowed = await must('gh api repos/{owner}/{repo}', gh(['api', 'repos/{owner}/{repo}', '--jq', '.allow_auto_merge']))
    if (allowed === 'false') {
      throw new Stop('auto-merge-unavailable', 'the repository does not allow auto-merge (allow_auto_merge is false); the pull request stays open for a person')
    }
    const required = await must(
      'gh api rules/branches/main',
      gh(['api', 'repos/{owner}/{repo}/rules/branches/main', '--jq', '[.[] | select(.type == "required_status_checks")] | length']),
    )
    if (!(Number(required) > 0)) {
      throw new Stop(
        'auto-merge-unavailable',
        'main requires no status checks, so auto-merge would merge before CI; the pull request stays open for a person',
      )
    }
    const merged = await gh(['pr', 'merge', String(facts.pr.number), '--auto', '--merge', '--match-head-commit', commit])
    if (merged.code !== 0) {
      const said = lastLine(merged)
      if (/auto.?merge/i.test(said) && /not allowed|not enabled|disabled/i.test(said)) {
        throw new Stop('auto-merge-unavailable', `GitHub refused auto-merge: ${said}; the pull request stays open for a person`)
      }
      throw new Stop('failed', describe('gh pr merge', merged))
    }
    return { outcome: 'auto-merge-requested', ...facts }
  } catch (cause) {
    if (cause instanceof Stop) return { outcome: cause.outcome, reason: cause.message, ...facts }
    return { outcome: 'failed', reason: cause instanceof Error ? cause.message : String(cause), ...facts }
  } finally {
    if (work) rmSync(work, { recursive: true, force: true })
  }
}
