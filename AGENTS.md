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
