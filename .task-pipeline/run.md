# Run: anonymous usage and error data in Okolos (B-198, B-199)

Branch `feat/usage-analytics` from `origin/main` `59f59ff`, worktree `~/DATA/_worktrees/okolos-analytics`.
Model: Opus 5.5 for the whole run. Loop mode: off. Risk: R3 (user-facing behaviour, a public privacy promise
changes, a new network destination). Full flow, not the short path.

## Source of the task

Operator decision 2026-11-04 for all PassionCode products, relayed verbatim by session fabric-32 (Claude Code
5d9bed98) through fabric-workspace-f1, points C and D. The operator's words (D): «Включает первый раз продукт, ему
показывает, чтобы подтвердить, что мы отправляем анонимные логи для юзажа и так далее. А это по дефолту разрешить
собирать анонимные данные об использовании и об ошибках, чтобы мы улучшали наш продукт. Все, только для этого. Это
по дефолту включено, для всех уже текущих тоже по дефолту включено. В настройках можно выключить. Выключается на
уровне каждого продукта.» Replaces the decision of 2026-11-03 (thread b2e5df1f). Backlog rows: B-198, B-199
(`sw/sw-08` `ee7eba4`).

## Stage 0: source ledger

| Source | What it says | State |
|---|---|---|
| `docs/privacy.md:162` (main `59f59ff`) | «Нет аналитики. Ни счётчиков, ни идентификатора установки, ни отчётов об ошибках» | stale after this run: rewritten in the same change |
| `docs/store/listing.md:56,111` | «Не собирает аналитику» / «Collects no analytics» | stale after this run |
| ADR-0003 single network choke point | every request leaves through one module | binds: the transport goes through it |
| ADR-0019 page content never reaches our infrastructure | no page text, no URL | binds: no page-derived prop |
| `docs/brand/facts.md` network destinations, checked by `tools/docs.test.ts` | the list of hosts the product talks to | stale after this run: add analytics.sshlg.me |
| skill usage-events 0.3.0 and its `references/consent.md` | Aptabase at analytics.sshlg.me; `iid`, `environment`, `platform` at the sink; on by default per product since 2026-11-04; off deletes `iid` and drops the queue; on again makes a new `iid`; never send IP, file names, typed text | binds; agrees with the operator decision |
| extensionworkshop.com «Firefox built-in data consent» (read 2026-11-04) | new extensions since 2025-11-03 declare `data_collection_permissions`; `technicalAndInteraction` can only be optional, the person turns it on or off in the install flow | binds for Firefox |
| store state (B-137) | version 0.0.1, never published; no installs exist | so «existing installs on by default» reaches nobody today |

Contradictions: the operator decision (on by default) against `docs/privacy.md:162` and the store card (no
analytics): the operator outranks the documents, out loud; the documents are rewritten in this change. The decision
against Firefox policy: Firefox's install flow decides there, the product cannot be on by default. DOCMAP:
`docs/DOCMAP.md` is missing (project row: `/task-pipeline setup` owed); the doc map used is `docs/README.md`.
Retro floor: no `docs/evidence/retro.md` in this repository, 0 bytes read.

## REQ spine

| REQ | Requirement | Verified by |
|---|---|---|
| A1 | First run shows a notice: anonymous data about usage and errors, only to improve the product; collection on from that run (Chrome, Edge) | e2e on the built extension: notice shown once, switch on |
| A2 | Firefox: `data_collection_permissions` with `technicalAndInteraction` optional; the product sends only when the browser grants it; the in-product switch requests or drops it | manifest test, unit test on the grant check |
| A3 | A switch in the options page turns it off: the `iid` is deleted, the queue dropped, nothing sent; on again makes a new `iid` | unit test, planted defect seen red |
| A4 | Every event carries `iid`, `environment`, `platform`, attached at one sink | unit test that fails when the sink stops attaching |
| A5 | Nothing from the page or the person: no URL, host, page text, file name, hash, password, typed text; props are enumerated strings | unit test over every event in the catalogue; bundle gate |
| A6 | Error reports as anonymous events (area and kind, enumerated), no stack text with paths or URLs | unit test |
| A7 | Transport through the single network module (ADR-0003); App-Key injected at build from `sshlg-analytics/prod/APTABASE_APP_KEY_OKOLOS`, never tracked | bundle-scan gate, `git grep` for the key shape |
| A8 | Event catalogue `docs/analytics.md` (event, status, screens with file:line, props) | docs test |
| A9 | Same change: `docs/privacy.md`, `docs/store/listing.md` in every locale, `docs/brand/facts.md`, a new ADR, `docs/ux/scenarios.md`, flows, screens; texts checked with Copylot | `tools/docs.test.ts`, `python3 docs/ux/lint.py`, Copylot report ids |
| A10 | Growth onboarding: Aptabase app, signed key slot, test event; registering in growth and connecting the source are operator writes asked in this session | growth-onboarding status table |

## Open questions (material)

1. Does Okolos, a security product that promises «no analytics», take the default-on rule or an exception? Asked
   once through fabric-workspace-f1 on 2026-11-04. Until answered, the run proceeds on the operator's decision
   (on by default) and nothing ships: the branch is not merged, the store is not reached (B-137).
2. Which `platform` value an extension sends: growth lists `ios`, `android`, `macos`, `web`, `telegram_bot`,
   `telegram_miniapp`, `server`. To agree with growth's owner before stage 3.

## Events

- 2026-11-04: stage 0 started; brief and REQ spine written; stage 1 next: Aptabase client contract
  (`~/DATA/sshlg-analytics/docs/client-contract.md`), Firefox `permissions` API for data collection, the
  extension's network module and options page.
- 2026-11-04: stage 1, first findings. (1) `packages/net/src/destinations.ts` is a closed map purpose → hosts,
  checked at run time (ADR-0003); analytics needs a new purpose (working name `usage-data`) with exactly
  `analytics.sshlg.me`, plus its wording in the audit panel, in `@okolos/contracts` `Purpose` and in
  `docs/brand/facts.md`. (2) `apps/extension/manifest.firefox.json` has `strict_min_version` 129, while Firefox's
  built-in data consent exists from 140 (extensionworkshop.com): stage 2 decides between raising the floor to 140
  and not sending on 129..139. (3) The Aptabase client contract is `~/DATA/sshlg-analytics/docs/client-contract.md`
  (237 lines): at most 25 events a batch, events older than 24 h refused, `sdkVersion` required, retry only
  transport errors, 429 and 5xx. Next: read the contract in full, the options page and the first-run surface, then
  stage 2 design.
