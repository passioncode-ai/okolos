# ADR-0017. The feed agent publishes from a pinned checkout and counts from what is served

**Дата:** 2026-10-03
**Статус:** accepted — carries out the organisation's product lifecycle contract
([lifecycle.md](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/lifecycle.md),
LC-02, LC-03, LC-12, LC-14, adopted 2026-10-03) for the feed agent, on the findings F1–F5 and F8 of
the [lifecycle audit](https://github.com/passioncode-ai/fabric-workspace/blob/main/docs/reports/2026-10-03-lifecycle-audit/README.md)
(its `raw/okolos.md`).
**Уточняет:** [ADR-0010](0010-the-blocklist-is-about-hosts-so-the-sources-must-be.md) — the
schedule and the source are unchanged; where the agent runs from and where its state lives
change.

## Контекст

The launchd agent ran `cd <developer clone> && pnpm feed:refresh` twice a day and at every login.
That one line carried four defects the audit measured:

- **The version counter lived in a tracked, uncommitted file.** `tools/ingest.mjs` read
  `version = previous + 1` from `feeds/phishing.json` in the working tree: v51 there, v42 at HEAD.
  Any routine `git checkout -- .`, `stash` or `reset` took it back to 42, the next run published
  v43, and every extension holding v51 refuses v43…v51 as replays
  (`packages/core-feeds/src/apply.ts`) — about four days of no updates, with the smoke test green.
- **Production ran whatever the clone had checked out**, from whatever branch an agent left
  there, and `npx wrangler` resolved an unpinned version from the npx cache — or, on a miss, from
  the registry, with the D1 write token in its environment.
- **Nothing was bounded or recorded.** No deadline on wrangler or the smoke fetches, no job
  timeout, so a hung run would make launchd skip every later interval; the log was `/tmp`, wiped
  at every boot; the token reached every process in the tree.
- **Uninstall came back at the next login**, because the plist stayed in `~/Library/LaunchAgents`.

## Решение

1. **The served feed is the source of truth for the version.** A run reads `/feeds/phishing` and
   builds `max(served, local, committed snapshot) + 1`; a publish refuses any version not above
   the served one, and treats the served version with identical bytes as an already-landed retry.
2. **The agent's state lives outside the tree**: `~/.okolos/state/feeds/phishing.json`, the run's
   status record beside it, logs in `~/Library/Logs/Okolos/` (5 × 5 MB, mode 0600). The tracked
   `feeds/phishing.json` becomes a committed snapshot, refreshed deliberately with
   `pnpm feed:snapshot`; the release gate reads whichever of the two is newer.
3. **Production publishes run only from a clean checkout at origin/main.** The agent owns a
   detached worktree at `~/.okolos/agent-checkout` and fast-forwards it before each run; a manual
   run from a clone that is not at origin/main is refused unless `--unpinned` is given, which is
   recorded. The installer itself refuses to install unless the clone's HEAD equals a freshly
   fetched origin/main (the commit is checked, not the branch name) and every file it installs
   from the working tree (the bootstrap's sources and the plist template, `INSTALLED_SOURCES`)
   is HEAD's: nothing edited, staged, deleted or untracked. `--allow-branch` overrides, and is
   recorded in `feed.log` and as `installedOffMain` in every record of a run: the launch line's,
   the bootstrap's and the job's, a stop by signal and a record adopted from an older job
   included. wrangler is a pinned devDependency of `apps/proxy`, run through `pnpm exec` with the
   install-before-run check off and telemetry off.
4. **Every run is bounded, exclusive and observable**: each stage a child in its own process
   group with a deadline, a thirty-minute watchdog over the run, a lock shared with every manual
   entry point, retries with backoff, and a status record per run that counts failures in a row.
   The Cloudflare token reaches only the publish step: one list of credential variables
   (`tools/feed/bounded.mjs`) is dropped from every other child of the job, the bootstrap and the
   installer; the job itself gets the bootstrap's whole environment, because publish inherits it
   through the job. Since B-159 one deadline covers the whole
   run, the checkout repair included (45 minutes; the job's watchdog is what is left minus two
   minutes, at most thirty).
5. **A login is not a publish**: the agent's run skips when the served feed is younger than its
   interval (eleven hours, one under the twelve-hour schedule).
6. **Uninstall is symmetric**: bootout, delete the plist and `~/.okolos/bin/feed-agent/` (and
   `~/.okolos/bin` when that was all it held, and any staging folder an interrupted install left),
   verify with `launchctl print`; `--purge` also removes the checkout,
   `~/.okolos/agent-checkout.broken`, the state and the logs, and prunes the clone's worktree entry.
   An install never re-enables an agent the operator disabled.
7. **launchd starts a bootstrap outside the checkout, never a `cd` into it (B-159, 2026-10-27).**
   From 2026-10-09 to 2026-10-26 the checkout was gone; every run died in `cd`, nothing wrote the
   status record, and the failure count read 0 for seventeen days (B-149). The installer now copies
   `tools/feed/bootstrap.mjs` and the modules it imports to `~/.okolos/bin/feed-agent/`, and the
   plist runs it through a `/bin/sh` launch line. The bootstrap checks the checkout; it moves a
   broken one to `~/.okolos/agent-checkout.broken` (one kept, as evidence for B-150) and recreates
   a missing one at origin/main: a detached worktree of the clone the installer ran from (after
   `git worktree prune`, since a deleted folder stays registered), or, when that clone is gone too,
   a clone of its origin. The run's record carries `recoveredCheckout`. Every failure that reaches
   the bootstrap is recorded (`stage: checkout`, `stage: job`, the job's stages); one that fails
   before it (no `node`, the copy gone, `node` exiting without a record for this launch) is
   recorded by the launch line itself with `/bin/sh` only (`stage: launch`). A record is a run's
   when it carries that launch's `runId`; the bootstrap stamps it into a record adopted from a job
   that writes none, so one failure is counted once. launchd not starting the agent at all is
   recorded nowhere. No alarm reads the record yet: that alarm is OBS-32 in
   `passioncode-ai/project-observatory-dashboard` (B-135, done, filed it), and it does not read
   `feed-status.json` yet.
8. **The agent commits the snapshot, through a pull request (B-158, 2026-10-29).** Point 2 left the
   commit to a person, and nobody made it: CI on main went red on 2026-10-19 (`package:check`, the
   snapshot 15.6 days old against the 14-day ceiling of `tools/feed-age.mjs`) and would again on
   2026-11-09. Now a run that published (`--snapshot-pr`, part of `--agent`) reads
   `feeds/phishing.json` on origin/main; when it is 7 days old or older and an older version, the
   run checks that the `update` the worker serves (signed, `{update, signature}`) equals the
   feed it published (point 1: what is served is the truth), and commits the published file, the
   unsigned `{kind, body}`, with the newline `pnpm feed:snapshot` adds, and nothing else. The commit is built from origin/main's tree through a private index, so the checkout's
   HEAD, index and files stay at origin/main for the next run's pin check. It goes to one reused
   branch, `chore/feed-snapshot-auto`, never forced: the new commit descends from the branch's tip
   (its only parent when the tip contains main, main alone when the tip was merged, both when main
   moved past it), so every push is a fast-forward and the pull request stays up to date with main.
   A branch carrying any other change is left for a person. A branch per version, with the stale
   pull request closed, was the alternative: it needs a close and a branch deletion each time and
   leaves a dead branch behind every refusal, where one branch keeps one pull request. The run then
   opens the pull request or updates the open one, and asks GitHub to merge it with a merge commit
   once main's required checks pass (`gh pr merge --auto --merge --match-head-commit`). It does not
   ask when the repository does not allow auto-merge, or when main requires no status check
   (auto-merge would merge before CI ran), and it never merges by hand or as an administrator; the
   pull request then waits for a person, its text says so (and always names "Create a merge
   commit"), and the record says why. Only the agent's own pull request counts: the repository is
   public, a fork may open one from a branch of the same name, and `gh pr list --head` matches the
   name only. A pull request is the agent's when its head is in this repository
   (`isCrossRepository` false, the head's owner this repository's), and it is edited or asked to
   auto-merge only once its `headRefOid` is the commit just pushed; any other is never edited or
   recorded as the agent's, only named in the reason. The push sets
   `OKOLOS_SKIP_GATES=1`, the pre-push hook's documented escape, which prints what it skipped;
   the push's output goes line by line into `feed.log`, so that notice is the trace the escape
   promises: the agent's checkout has only the publish tools installed, and the gate for this
   commit is the pull request's checks. gh runs on its own stored login; `GH_TOKEN`, `GITHUB_TOKEN`
   and the Cloudflare credential are removed from its environment and git's. The step's outcome is
   `snapshotPr` in the record (`skipped-fresh`, `updated`, `auto-merge-requested`,
   `auto-merge-unavailable`, `failed`; opened or updated is `pr.action`) and one `snapshot PR:`
   line in `feed.log`; a failure there (gh missing or not logged in is `failed: gh unavailable`),
   or a stop by signal during it, leaves the run `published` with `lastPublished` moved and the
   failure count not raised. The last step stays in `~/.okolos/state/snapshot-pr.json` and in
   every record the job writes after it until a newer step replaces it, and
   `install-feed-agent --status` names its pull request, since when it waits and when it was last
   seen. A step that fails before it reaches the pull request carries the earlier one forward
   (`pr`, `since`, `prAt`, `prOutcome`); the pull request leaves the record only when a step sees
   it merged, closed or no longer open (`previousPr`), or sees main already carry the version. Each child has
   its deadline (git 90 s, gh 60 s), the step five minutes in all, never past what the run's
   watchdog leaves; once a stop is known no further child starts. None of this changes the
   installed bootstrap: `tools/feed/status.mjs` and the other installed files are untouched, so no
   reinstall is needed.

   **Until the operator decides B-186 (the row B-186 on branch sw/sw-08 until the branches
   merge), the merge is a person's.** The repository does not allow auto-merge and
   `protect-default-branch` requires no status check (2026-10-29), so every pull request ends
   `auto-merge-unavailable` and waits. With v65 on main (`body.updatedAt` 2026-10-26T21:08Z), the
   first comes at the first publish after 2026-11-02T21:08Z, and no earlier than one run after this
   change lands on origin/main: the job that fast-forwards the agent's checkout is the previous
   commit's code, already loaded, so the step first runs on the next run, up to 12 hours later.
   main turns red at 2026-11-09T21:08Z without a merge. The merge is
   a merge commit, not squash or rebase (both allowed here): the branch is reused, and only a merge
   commit puts its commits into main's history, so the next pull request starts from main alone;
   after a squash or rebase the old branch commits are not ancestors of main and every later pull
   request carries them again under a merge of main.

## Цена

- The agent needs network access to the worker before it builds anything: a run that cannot read
  the served version refuses rather than guesses. That is the point, and the retries cover a
  transient failure.
- A second checkout of the repository lives on the publishing machine, with only the publish
  tools installed (`pnpm install --filter @okolos/proxy`).
- The committed snapshot no longer follows the agent on its own; CI's release gate reads it, so it
  has to be committed within the fourteen-day freshness ceiling. Since point 8 the agent proposes
  it after seven days; the merge is automatic only once the repository allows auto-merge and main's
  ruleset requires a status check. On 2026-10-29 neither holds (`allow_auto_merge: false`; ruleset
  `protect-default-branch` has only `deletion` and `non_fast_forward`), so the pull request waits
  for a person, who has a week before the gate turns red (B-186 is that decision; its row is on
  branch sw/sw-08 until the branches merge).
- A required status check in `protect-default-branch`, which has no bypass actors, would also
  refuse every direct push to main whose commit has not passed the checks: changes, the snapshot
  committed by hand included, would then reach main only through pull requests, unless a bypass
  actor is added.
- The machine that publishes now also pushes a branch and opens pull requests: its git remote
  credential needs write access to the repository, and gh a stored login. Without them the step
  records why and the publish is unaffected. Neither has been observed under launchd yet; the first
  evidence is `snapshotPr` in `install-feed-agent --status` after the first publish past
  2026-11-02T21:08Z by a run that already has this change.
- Uninstalling the agent, `--purge` included, leaves GitHub and the clone alone: the branch
  `chore/feed-snapshot-auto`, an open snapshot pull request and the remote-tracking ref
  `refs/remotes/origin/chore/feed-snapshot-auto` stay; `--purge` removes `snapshot-pr.json`, so a
  reinstalled agent does not know that pull request until a step finds it.
- A change to the feed tools reaches production only once it lands on main — including an urgent
  fix, unless someone runs `--unpinned` and accepts the record it leaves.
- The bootstrap copy changes only when a person reinstalls: a change to `tools/feed/bootstrap.mjs`
  or its modules on main needs `pnpm feed:agent` again; `--status` reports the drift. The launch
  line's own record is minimal (no version, no commit).

## Чем держится

| Part | Mechanism |
|---|---|
| Version from the served feed; a stale local file cannot take it back | `tools/ingest.test.ts` — "the version comes from what is served, not from the worktree (F1)" |
| A publish never goes backwards; a retry of a landed publish is safe | `tools/publish-feed.test.ts` — "a publish never goes backwards (F1)" |
| Pinned wrangler, no install, no telemetry, every step bounded, no temp leftovers | `tools/publish-feed.test.ts` — "the pinned wrangler, bounded and quiet" |
| Children killed as a group at their deadline; no orphan survives | `tools/feed/bounded.test.ts` |
| Watchdog, lock, retries, status, token only on publish, origin/main only, login skip | `tools/feed-job.test.ts` |
| Logs rotated and owner-only; status record shape | `tools/feed/log.test.ts`, `tools/feed/status.test.ts` |
| Uninstall verified; disabled stays disabled; plist placeholders | `tools/install-feed-agent.test.ts` |
| Bootstrap outside the checkout: recreate (worktree or clone), `.broken`, a record on every failure that reaches it, one run deadline, the job's stderr relayed (B-159) | `tools/feed/bootstrap.test.ts` |
| The launch line records `stage: launch` with `/bin/sh` alone; bootstrap copy installed and removed; drift in `--status`; install from main only | `tools/install-feed-agent.test.ts` |
| The run id and `recoveredCheckout` in the job's record; the watchdog handed down | `tools/feed-job.test.ts` |
| A tool or job started through a linked path still runs (one check, `tools/is-main.mjs`) | `tools/is-main.test.ts` |
| One failed job run counts once: the launch line and the bootstrap agree on `runId`; a launch record holds one `runId`, its own, after a stamped one | `tools/install-feed-agent.test.ts`, `tools/feed/status.test.ts` |
| The installer refuses uncommitted edits to what it installs, named in one line (a git double and real git) | `tools/install-feed-agent.test.ts` |
| `installedOffMain` in every writer: launch line, bootstrap failure, crash and signal records, the job's records and signal record, an adopted record | `tools/install-feed-agent.test.ts`, `tools/feed/bootstrap.test.ts`, `tools/feed-job.test.ts` |
| A stop by signal is recorded as the stop (exit 143), not as the job's crash it caused | `tools/feed/bootstrap.test.ts` |
| State paths outside the working tree | `tools/feed/paths.test.ts` |
| Release gate reads the newer of snapshot and state | `tools/feed-age.test.ts` |
| The snapshot pull request: only after a publish and only with `--snapshot-pr`; skipped while main's snapshot is under 7 days (unrounded); gh missing or logged out recorded as `gh unavailable`; the served `update` checked; one branch, never forced, fast-forward over main; open or update; auto-merge only where allowed and gated by checks; bounded, no token in any child; the outcome list is what some path produces; a failure or a stop leaves the run `published`; the hook's skip notice in `feed.log`; the last step kept across later runs | `tools/feed/snapshot-pr.test.ts` (doubles, and real git against a bare origin with the repository's own `.githooks/pre-push`), `tools/feed-job.test.ts` "after a publish the agent proposes the committed snapshot (B-158)" |
| `--status` names the snapshot pull request, its link, since when it waits and when last seen; not after a step saw it merged | `tools/install-feed-agent.test.ts` |
| A fork's pull request with the same branch name is never edited or recorded; the agent's own is touched only at the pushed head; a step that never reached the pull request carries it; the text says whether a person merges it | `tools/feed/snapshot-pr.test.ts` "only the agent's own pull request is touched", "a waiting pull request is not forgotten by a step that never reached it (B-158)", "the pull request's text says what will happen to it" |
