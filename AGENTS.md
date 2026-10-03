# Working in okolos

## Read first

1. The PassionCode.ai knowledge base — `fabric-workspace/knowledge/` in your clone (org-index
   `scripts/clone_all.sh` makes it) or https://wiki.passioncode.ai/knowledge — at least its
   [README](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/README.md),
   vision, principles and how-to-work.
2. This file, then the organization's
   [CONTRIBUTING.md](https://github.com/passioncode-ai/.github/blob/main/CONTRIBUTING.md).

That guide holds the names, how a change lands, the code region markers and the security contact;
this file adds the rules of this repository and wins where the two differ.

## What this repository is

Okolos: the security product of PassionCode.ai, a browser extension (Chrome, Edge, Firefox) that
finds instructions hidden for an AI agent on a page, checks links, downloads, extensions and
leaked passwords, and does it locally.

## Commands

| What | Command |
|---|---|
| Install (also sets `core.hooksPath` to `.githooks`) | `pnpm install` |
| Unit tests and the docs/runbook gates; two of them read `dist/`, so on a fresh clone run `pnpm build` first | `pnpm build && pnpm test` |
| Everything the pre-push hook runs | `pnpm gates` |
| End-to-end, Chromium / Firefox | `pnpm test:e2e` / `pnpm test:e2e:firefox` |
| MCP (register + proving call) | none: Okolos neither exposes nor uses an MCP server, and none is planned yet (fabric-workspace `knowledge/products.md` → MCP gaps) |

The full list, and why each command exists, is
[docs/runbooks/development.md](docs/runbooks/development.md); `tools/runbook.test.ts`
fails when a script is missing from it.

## Local rules

- **Shared registers are edited under a lease.** [docs/AGENT_SYNC.md](docs/AGENT_SYNC.md)
  (generated from `.claude/agent-sync.json` by `agent_sync.py setup`; never edited by hand) lists
  the guarded files and the gate. Run `agent_sync.py acquire <file>` before editing one and
  `agent_sync.py release <file>` after, on every path including failure. The lease is a ref under
  `refs/agent-sync/leases/` on `origin`, so another contributor's agent sees it
  (`git ls-remote origin 'refs/agent-sync/leases/*'`); the record plane is local (`fs`), and
  `.agent-sync/` is git-ignored. No register here carries a "Next free ID" line, so nothing is
  reserved yet; a register that gains one is declared under `idRegisters` and taken with
  `agent_sync.py reserve <REG>`.
- **User-facing text goes through the brand pack** in [docs/brand/](docs/brand/): the
  term from `terminology.md` is mandatory, a number from `facts.md` is taken by command
  at the time of the edit. `tools/docs.test.ts` holds this.
- **User-facing behaviour starts in [docs/ux/scenarios.md](docs/ux/scenarios.md)**, and
  `python3 docs/ux/lint.py` must pass after any UX change.
- **Decisions** are [docs/adr/](docs/adr/); a record naming a missing file fails the build.
- **Licence is the organisation's** — `AGPL-3.0-only OR LicenseRef-PassionCode-Commercial`:
  open source under the GNU AGPL-3.0, commercial licence from contact@passioncode.ai
  ([LICENSING.md](LICENSING.md), [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md), ADR-0016).
  Earlier terms are named only in the history sentence of `LICENSING.md` and `README.md`;
  `tools/licensing.test.ts` fails any other surface that presents them as current. Every new
  `package.json` carries the expression (`packages/core-lookalike` adds `AND MPL-2.0` for the
  Public Suffix List file); `tools/licensing.test.ts` refuses anything else. Contributions go
  under [CLA.md](CLA.md).
- **Firefox add-on id `okolos@ssheleg.dev` stays** after the move to this organisation:
  it is the extension's identity on addons.mozilla.org, not a repository address.
- **Hosted CI runs on push and PR** here, like the public engine: the repository is
  public, so its minutes are not under the organisation's spending cap. The local
  `pnpm gates` is still the gate.

## Lifecycle

What runs on a machine because of Okolos, under the organisation's
[lifecycle contract](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/lifecycle.md)
(LC-09). There is no port, no native-messaging host, no login item and no per-session (MCP)
server; `apps/mail-cli` is an on-demand CLI and `apps/proxy` is a remote Cloudflare Worker.

| What | Who starts it | Cadence | With no window | Who stops it | Idle budget |
|---|---|---|---|---|---|
| launchd agent **`app.okolos.feed`** (`gui/<uid>`, plist from `tools/launchd/app.okolos.feed.plist`) | a person, once: `pnpm feed:agent` (machine holding the signing key, ADR-0002) | `StartInterval` 43200 s + `RunAtLoad`; a login run ends as "skipped" when the served feed is under 11 h old | the whole job is background: `Nice 5`, `ProcessType Background`, no `KeepAlive` | its own exit; watchdog 30 min kills the run's process groups; removed by `node tools/install-feed-agent.mjs --uninstall [--purge]` (deletes the plist, verifies with `launchctl print`) | 0 processes and 0 RSS between runs; a run is about a minute, twice a day |
| a run's children: `git fetch`/`checkout`, `pnpm install --filter @okolos/proxy` (only when the lockfile moved), `node tools/ingest.mjs`, the secret runner → `node tools/publish-feed.mjs` → `pnpm exec wrangler` | `tools/feed-job.mjs`, each in its own process group | per run | — | deadline per child (git 90 s, install 10 min, ingest 3 min, publish 6 min), then SIGTERM → SIGKILL to the group | none left after the run (`tools/feed/bounded.test.ts`) |
| MV3 service worker (Chrome) / event page (Firefox) | the browser, on a listened event | alarms `okolos:feeds` 6 h, `okolos:retention` 24 h, `okolos:inventory` 24 h — created only when missing | wakes on messages, alarms, downloads and top-level http(s) navigations (memory write only) | the browser, after ~30 s idle; no timer outlives a wake | per wake: three alarm checks and timestamp reads; per day: ≤ 4 feed pulls, 2 sweeps, 1 extension review, 0 rule rebuilds without a change (`apps/extension/src/background/wake.test.ts`) |
| content script and MAIN-world page watcher | the browser, per http(s) page and frame | event-driven, paced rescans | — | the page's lifetime | no work while the page is unchanged |

Files the feed agent writes — all outside the working tree, all bounded (LC-12): state in
`~/.okolos/state/` (`feeds/phishing.json`, `feed-status.json`, `feed.lock`); logs in
`~/Library/Logs/Okolos/` (`feed.log`, 5 × 5 MB, mode 0600; `feed.launchd.log`, capped at start;
`wrangler/`, pruned by wrangler after 30 days); its own checkout `~/.okolos/agent-checkout`
(a worktree at origin/main); private `$TMPDIR/okolos-feed-*` directories removed in `finally`,
older ones swept at the next start. The run's record — `outcome`, `stage`, `exit`, `version`,
`entries`, `consecutiveFailures`, `lastPublished` — is what a host reads: alert at two failures in
a row or when `lastPublished.at` is older than 26 h. Decision: [ADR-0017](docs/adr/0017-the-feed-agent-publishes-from-a-pinned-checkout-and-counts-from-what-is-served.md).

**Build retention (LC-15).** Release archives go to `apps/extension/dist/release/`, and
`pnpm package` keeps the current and the previous one per browser itself
(`tools/release-prune.mjs`, `tools/release-prune.test.ts`). Build output that is not a release —
`apps/extension/dist/{chrome,firefox}` and the `*-e2e` builds beside them, `apps/extension/.tsc`,
`packages/*/dist`, `test-results/`, `playwright-report/`, `node_modules/.vite` — is capped at
**500 MB** in total (`du -sch` over those paths); an agent that built and passed the cap runs
`rm -rf apps/extension/dist/chrome* apps/extension/dist/firefox* apps/extension/.tsc packages/*/dist test-results playwright-report node_modules/.vite`
before ending its run. It leaves `dist/release/` and every `node_modules` alone, and
`pnpm build` restores what a gate needs. (Not `git clean -X` with pathspecs: measured
2026-10-03, its dry run would remove the whole `node_modules` tree.)

## Organisation

This repository is one of the `passioncode-ai` repositories. **The org map and onboarding live in
[passioncode-ai/org-index](https://github.com/passioncode-ai/org-index)** (private; readable by
every org member); the shared rules live in the knowledge base
([rules](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/rules.md)).
Where this file is stricter, this file wins. A change to this repository's role, dependencies or
test command updates its row in `org-index/repositories.json` in the same change.

## Shared backlog

[docs/backlog-sources.json](docs/backlog-sources.json) declares this repository's canonical
local task sources and their vision goals. The [common backlog contract](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/backlog.md)
owns aggregation; [the workspace backlog](https://wiki.passioncode.ai/backlog) is a derived view.
Edit a task only in its canonical source under an agent-sync lease, retain stable IDs and
closure receipts, and declare any new source in the manifest. Do not edit generated task
status in the workspace or copy another repository's task into a second editable row.
Land the source change, then run `node scripts/workspace.mjs sync` from a Fabric checkout
(or use the scheduled sync); check the published source commit before calling it current.

## After work

In the same run: update this repository's docs with the change; if a cross-repository fact changed
(a product, a version, a plan row, a principle), update the page in `fabric-workspace/knowledge/`
that owns it; land both; publish (`node scripts/workspace.mjs sync` from a Fabric checkout) or
leave it to the scheduled sync. Leave a handoff with the exact next task.
