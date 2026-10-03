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
   recorded. wrangler is a pinned devDependency of `apps/proxy`, run through `pnpm exec` with the
   install-before-run check off and telemetry off.
4. **Every run is bounded, exclusive and observable**: each stage a child in its own process
   group with a deadline, a thirty-minute watchdog over the run, a lock shared with every manual
   entry point, retries with backoff, and a status record per run that counts failures in a row.
   The Cloudflare token reaches only the publish step.
5. **A login is not a publish**: the agent's run skips when the served feed is younger than its
   interval (eleven hours, one under the twelve-hour schedule).
6. **Uninstall is symmetric**: bootout, delete the plist, verify with `launchctl print`; `--purge`
   also removes the checkout, the state and the logs. An install never re-enables an agent the
   operator disabled.

## Цена

- The agent needs network access to the worker before it builds anything: a run that cannot read
  the served version refuses rather than guesses. That is the point, and the retries cover a
  transient failure.
- A second checkout of the repository lives on the publishing machine, with only the publish
  tools installed (`pnpm install --filter @okolos/proxy`).
- The committed snapshot no longer follows the agent on its own; CI's release gate reads it, so it
  has to be committed from `pnpm feed:snapshot` within the fourteen-day freshness ceiling.
- A change to the feed tools reaches production only once it lands on main — including an urgent
  fix, unless someone runs `--unpinned` and accepts the record it leaves.

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
| State paths outside the working tree | `tools/feed/paths.test.ts` |
| Release gate reads the newer of snapshot and state | `tools/feed-age.test.ts` |
