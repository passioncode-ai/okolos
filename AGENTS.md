# okolos — working in this repository

**Role.** Okolos, the security product of PassionCode.ai: a browser extension that finds
instructions hidden for an AI agent on a page, checks links, downloads, extensions and
leaked passwords, and does it locally.

Shared rules for every `passioncode-ai` repository live in
[org-index RULES.md](https://github.com/passioncode-ai/org-index/blob/main/RULES.md).
Where this file is stricter, this file wins.

## Build and test

| What | Command |
|---|---|
| Install (also sets `core.hooksPath` to `.githooks`) | `pnpm install` |
| Unit tests and the docs/runbook gates | `pnpm test` |
| Everything the pre-push hook runs | `pnpm gates` |
| End-to-end, Chromium / Firefox | `pnpm test:e2e` / `pnpm test:e2e:firefox` |

The full list, and why each command exists, is
[docs/runbooks/development.md](docs/runbooks/development.md); `tools/runbook.test.ts`
fails when a script is missing from it.

## Local rules

- **User-facing text goes through the brand pack** in [docs/brand/](docs/brand/): the
  term from `terminology.md` is mandatory, a number from `facts.md` is taken by command
  at the time of the edit. `tools/docs.test.ts` holds this.
- **User-facing behaviour starts in [docs/ux/scenarios.md](docs/ux/scenarios.md)**, and
  `python3 docs/ux/lint.py` must pass after any UX change.
- **Decisions** are [docs/adr/](docs/adr/); a record naming a missing file fails the build.
- **Licence is the organisation's** — `PolyForm-Noncommercial-1.0.0 OR
  LicenseRef-PolyForm-Internal-Use-1.0.0`, commercial licence from
  contact@passioncode.ai ([LICENSING.md](LICENSING.md), ADR-0015). Never call it
  open source, MIT or Apache. Every new `package.json` carries that expression;
  `tools/licensing.test.ts` refuses anything else. Contributions go under [CLA.md](CLA.md).
- **Firefox add-on id `okolos@ssheleg.dev` stays** after the move to this organisation:
  it is the extension's identity on addons.mozilla.org, not a repository address.
- **Hosted CI runs on push and PR** here, like the public engine: the repository is
  public, so its minutes are not under the organisation's spending cap. The local
  `pnpm gates` is still the gate.
