# Lifecycle contract handoff — 2026-10-03

## Objective and source

Carry out the organisation's product lifecycle contract
([lifecycle.md](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/lifecycle.md),
LC-01…LC-15) for Okolos, on the audit findings F1–F8 in the
[lifecycle audit](https://github.com/passioncode-ai/fabric-workspace/blob/main/docs/reports/2026-10-03-lifecycle-audit/README.md)
(`raw/okolos.md`). Base: `origin/main` at `11a8e72`. Branch: `claude/lifecycle-contract`.
Decision record: [ADR-0017](../adr/0017-the-feed-agent-publishes-from-a-pinned-checkout-and-counts-from-what-is-served.md).

## Completed

| Finding | Rule | What changed | Test |
|---|---|---|---|
| F1 version from a tracked file | LC-03 | version = max(served, local, snapshot) + 1; publish refuses ≤ served; state in `~/.okolos/state/` | `tools/ingest.test.ts` (F1 block), `tools/publish-feed.test.ts` ("never goes backwards"), `tools/feed/served.test.ts` |
| F2 live checkout, unpinned wrangler, token everywhere | LC-03, LC-04 | agent checkout at origin/main fast-forwarded per run; manual runs refused off origin/main; wrangler 4.146.0 pinned in `apps/proxy`, `pnpm --config.verify-deps-before-run=false exec`; token only on publish | `tools/feed-job.test.ts` (pin, token), `tools/publish-feed.test.ts` (pinned wrangler) |
| F3 silent failures, `/tmp` log | LC-03, LC-12 | `~/Library/Logs/Okolos/feed.log` 5×5 MB 0600; status record per run with `consecutiveFailures`, `lastPublished`; 3 attempts with backoff; telemetry off; wrangler logs moved beside ours | `tools/feed/log.test.ts`, `tools/feed/status.test.ts`, `tools/feed-job.test.ts` |
| F4 hang blocks every later interval | LC-02, LC-03 | every child in its own process group with a deadline; 30-min watchdog; lock shared with manual entry points; AbortSignal on every fetch | `tools/feed/bounded.test.ts`, `tools/feed-job.test.ts` (watchdog, lock), `tools/feed/lock.test.ts` |
| F5 uninstall comes back | LC-14 | bootout + delete plist + `launchctl print` verify; `--purge`; disabled stays disabled; `--status` | `tools/install-feed-agent.test.ts` |
| F6 daily work on every wake | LC-08 | alarms created only when missing; inventory gated by 24 h; rules counted on browser start/install only; navigation listener filtered to http(s), memory write only | `packages/platform/src/adapter.test.ts`, `apps/extension/src/background/wake.test.ts`, `packages/storage/src/retention.test.ts`, `tools/test-quality.test.ts` |
| F8 temp leftovers; RunAtLoad publishes at login | LC-12 | `mkdtemp` + `finally`; old leftovers swept at start; login run skips when served feed < 11 h | `tools/publish-feed.test.ts`, `tools/feed-job.test.ts` |
| LC-09, LC-15 | — | AGENTS.md `## Lifecycle`; `pnpm package` prunes to 2 archives per browser | `tools/release-prune.test.ts` |

## Open (not fixed here)

- **F6, the navigation listener is filtered, not removed.** A filter on the feed's hosts would be
  registered after an async read and miss the event that woke the worker; carrying the URL in the
  redirect would put it in history, which `interstitial/index.ts` refuses by design. The handler
  is now a memory write. Removing the wake needs a product decision.
- **F7** — `reuse` and stale `snapshots` never expire: backlog **B-134**.
- **Host alerting** on `feed-status.json` (two failures, `lastPublished` > 26 h) belongs to Project
  Observatory: backlog **B-135**; B-133 stays open until then.
- **F8 machine items, not repository changes:** the stale token line in
  `~/.okolos/cloudflare.env` (the vault value shadows it) and the unencrypted signing key
  (by design, ADR-0002) are the operator's.
- **Firefox e2e** was not run (Chromium e2e: 190 passed).

## Prerequisites for the coordinator (after landing)

1. `pnpm feed:agent` on the publishing machine: creates `~/.okolos/agent-checkout`, rewrites the
   plist, reloads `app.okolos.feed`. Not done here on purpose.
2. `pnpm feed:snapshot` and commit, when the committed snapshot should catch up (release gate on
   CI reads it; ceiling 14 days from `2026-09-29T11:42:15Z`).
3. Old files the previous agent left: `/tmp/okolos-feed.log` (gone at reboot), and
   `$TMPDIR/okolos-feed-{signed.json,publish.sql}` (the new job sweeps them at its first run).

## Verification (run locally)

| Check | Result |
|---|---|
| `pnpm gates` | exit 0 — 186 files, 2787 passed, 1 skipped |
| `npx playwright test` (Chromium) | exit 0 — 190 passed |
| `node tools/ingest.mjs --dry-run` against the live worker, state dir in a scratch folder | served v51 → would build v52, 277 entries; nothing written |
| `node tools/install-feed-agent.mjs --dry-run` → `plutil -lint` | OK; runner JSON parses; nothing written or loaded |

## Next task

Coordinator: review and land the PR, then run prerequisite 1 and watch the first run in
`~/Library/Logs/Okolos/feed.log` and `node tools/install-feed-agent.mjs --status`.
