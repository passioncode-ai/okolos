# Lifecycle contract landing handoff (2026-10-04)

## Objective

Land PR #11 ([lifecycle contract](2026-10-03-lifecycle-contract.md), ADR-0017), then do its
post-landing steps on the publishing machine. Each step is a row in [the board](../backlog.md):
B-136, B-138 and B-139.

## Completed

- **B-136.** `origin/main` was merged into `claude/lifecycle-contract`. The only conflict was
  `docs/backlog.md`. `main`'s rows were kept, because B-134 and B-135 were already there in
  `main`'s wording. `be5ab20` gives the watchdog test in `tools/feed-job.test.ts` 30 s and an
  elapsed bound of watchdog + 13.5 s. At load ~34 it overran vitest's 5 s default inside
  `pnpm gates`, and alone it passed three runs out of three. Two planted defects were watched
  being caught:
  - a watchdog that ignores its option fails on the timeout;
  - a watchdog that does not kill the group fails with "survived the watchdog".

  `pnpm gates` → exit 0. Hosted CI passed: gates, e2e chromium and e2e firefox. The PR was
  squash-merged as `abf77b5`.
- **B-138.** `pnpm feed:agent` → exit 0.
  - The agent checkout `~/.okolos/agent-checkout` is at `abf77b5`. The plist passes
    `plutil -lint`, and its secret runner is the Observatory vault slot.
  - The first run happened at load. It was `skipped` / `fresh` because the served v53 was 5.8 h
    old. It also swept the old `$TMPDIR` leftovers.
  - A manual pinned run, `node tools/feed-job.mjs --follow` from the agent checkout with the
    plist's runner, published v54 (264 entries), and both smoke checks passed.
- **B-139.** `pnpm feed:snapshot` → v54, committed as `88f6541`. `package:check` reports the
  feed as 0.0 days old.

## Open

- B-140 is a product decision about the navigation listener. It belongs to the operator.
- B-141 is the stale token line in the operator's local Okolos environment file. It is a step
  on the operator's machine, and the file was not opened.
- B-133 and B-134 are unchanged.
- The installed plist still says `ProcessType Background`. On 2026-10-04, Fabric moved its own
  scheduled job to `Standard` + `Nice` + `LowPriorityIO`, because `Background` throttled it
  under load (Fabric ADR-0106, third amendment). The feed run took about 10 s today. Watch
  `feed-status.json` for `failed` runs that hit a stage deadline before changing this.
- `~/DATA/okolos-extension` (the main clone) still has the old agent's last write in
  `feeds/phishing.json` (v53, uncommitted). The new agent no longer writes there. Whoever owns
  that clone can discard the change, because v54 is now committed.

## Checks run

| Command | Outcome |
|---|---|
| `pnpm gates` on the merged branch | exit 0, 186 files, 2787 passed, 1 skipped |
| `pnpm feed:agent` | exit 0, loaded `app.okolos.feed` |
| `node tools/install-feed-agent.mjs --status` | loaded, runs 1, lastExit 0, lastRun `skipped` |
| `node tools/feed-job.mjs --follow` (agent checkout) | exit 0, `published` v54 |
| `pnpm feed:snapshot` | v54 |
| `pnpm gates` with the snapshot and these rows | exit 0, 186 files, 2787 passed, 1 skipped; feed 0.0 days old |

## Next task

At the next 12-hour slot, read `~/.okolos/state/feed-status.json`. It should show
`outcome: published` from the scheduled run, with `consecutiveFailures: 0`.
