# Backlog consolidation handoff — 2026-10-04

## Objective

The operator asked (2026-10-04) for every unfinished item, ticket and unmerged pull request to be
in its project's backlog, under the workspace's
[common backlog contract](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/backlog.md).

## Completed

- `docs/backlog-sources.json` already declared [docs/backlog.md](../backlog.md). An earlier sweep
  that day (#12) added B-136 (PR #11) and B-137 (store publication).
- This change adds the lifecycle items that PR #11 names and leaves open:
  - **B-134** (F7, `reuse` and snapshots never expire), worded as PR #11 words it.
  - **B-135** (alerting on `feed-status.json`). Its single owner is Project Observatory, so the
    row is blocked until PR #11 lands and Observatory's own row exists. Then it closes with a
    link to that row.
  - **B-138** (`pnpm feed:agent` on the publishing machine after PR #11 lands).
  - **B-139** (a fresh feed snapshot before 2026-10-13T11:42Z). `pnpm package:check` in CI
    refuses a feed older than 14 days.
  - **B-140** (whether the navigation listener may wake the extension; an operator decision).
  - **B-141** (the stale revoked token line in the operator's local Okolos environment file).
    This is a step on the operator's machine. The file was not opened.
- Open issues: none. Open PRs: #11 only (`gh pr list`/`gh issue list -R passioncode-ai/okolos`,
  2026-10-04).

## Checks run

`pnpm gates` exit 0 (174 test files, 2653 passed, 1 skipped; `package:check` passed). The
workspace collector (`lib/backlog.mjs`, fabric-workspace `origin/main`) reads 19 tasks with no
source error.

## Exact next task

The coordinator lands PR #11. On the board conflict, keep `main`'s rows: B-134 and B-135 are
already here. Then do B-138 and B-139 before 2026-10-13. Ask the Project Observatory owner to add
the alerting row and link it from B-135.
