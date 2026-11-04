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
- 2026-11-04: paused on the public side. fabric-workspace-f1 took both new points (the «no analytics» promise in
  `docs/privacy.md:162` and the store card; Firefox collecting only by choice at install, from 140) to the operator
  as his decision, and asked: until he answers, do not change public texts and do not turn collection on in Okolos.
  Allowed meanwhile: stage 1 reading and stage 2 design notes in this ledger, nothing user-facing, nothing that
  sends. Rows B-197..B-199 are in fabric-workspace `knowledge/plans.md` (PR #620). Resume trigger: the operator's
  answer relayed with his words.
- 2026-11-04 ~17:25 UTC: the operator answered both points (relayed verbatim by fabric-workspace-f1 from session
  74a9440a): «На все остальное там апрув, типа давай делать, и все, что там не закончили, давай дорабатывать.»
  No exception for Okolos: point D applies. Rewrite `docs/privacy.md:162` and the store card in the same change as
  the collection, texts through Copylot. Firefox: as the platform allows, `technicalAndInteraction` optional in the
  install flow. Chrome: on from the first run, with the notice. Pause lifted; open question 1 closed.

## Stage 2: design (draft, 2026-11-04)

| # | Decision | Why |
|---|---|---|
| D1 | Transport: our own small client over `packages/net` with a new purpose `usage-data` whose only host is `analytics.sshlg.me`; batch route `/api/v0/events`, at most 25 a request; retry only transport errors, 429 and 5xx with backoff | ADR-0003 (one choke point, closed purposes, audit entry before the request); client contract |
| D2 | Consent state in `storage.local`: `on` or `off`, the random `iid` while on. Chrome and Edge: on from the first run, the notice is on the first-run screen (SCR-01). Firefox 140+: on only while `browser.permissions.getAll()` lists `technicalAndInteraction` under `data_collection`; the manifest declares it under `browser_specific_settings.gecko.data_collection_permissions.optional`; the options switch calls `permissions.request` / `permissions.remove`. Firefox 129..139 (no `data_collection` key): nothing is sent, the switch says why | operator 2026-11-04; Firefox platform rule; keeps the 129 floor |
| D3 | Off: delete `iid`, drop the queue, send nothing; on again: a new `iid`. No erasure promise (Okolos is not on growth's C4 path) | consent.md |
| D4 | `environment`/`isDebug` from the build: the store build made by `pnpm package` is `production`/`false`; dev, e2e and CI builds are `sandbox`/`true`; a build with no App-Key sends nothing | client contract «Build modes» |
| D5 | `platform`: asked of sshlg-growth (thread `881757d0`), proposal `browser_extension`; `osName`, `engineName`, `engineVersion` filled from `navigator.userAgent` by the server's map | usage-events; client contract «Web sinks» |
| D6 | Events: a closed catalogue in `docs/analytics.md`; each event's props an enumerated schema checked at the sink; errors as `error_occurred` {`area`, `kind`} events, not the unused `/api/v0/error` route | usage-events; client contract «Error reporting (exists, not yet used)» |
| D7 | Nothing from the page or the person: no URL, host, page text, file name, hash, password, address, typed text, stack text; a unit test runs every catalogue event through the sink with planted page data and fails if any leaves | ADR-0019; consent.md «Never send» |
| D8 | App-Key `sshlg-analytics/prod/APTABASE_APP_KEY_OKOLOS` injected by `pnpm package` through `use_secret.py run`; never in a tracked file | usage-events «The transport» |
| D9 | Same change: `docs/privacy.md` (the «Чего нет» list and a new section), `docs/store/listing.md` ru and en, `docs/brand/facts.md` destinations, ADR-0021, `docs/ux/scenarios.md` (first-run notice, the switch, Firefox both ways), `flows.md`, `screens.md` SCR-01 and the options screen; texts through Copylot | operator 2026-11-04 ~17:25; CLAUDE.md routes |

Next: stage 3, scenarios through super-ux, then the plan and TDD build.
- 2026-11-04: stage 3, UX chain written (inline fallback in the super-ux format; Figma is off by the 2026-08-04
  decision): ST-032 (`docs/ux/foundation.md`), FLW-24 (`docs/ux/flows.md`), SCN-049..SCN-052 under privacy
  (`docs/ux/scenarios.md`, status draft), SCR-01 and SCR-12 planned notes (`docs/ux/screens.md`);
  `python3 docs/ux/lint.py` OK. Next: product texts through Copylot (notice, switch block, privacy text, store card),
  then the plan.

## Stage 3: product texts (Copylot, voice Okolos 266030ff v1)

The brand pack forbids «анонимно» as a promise in the interface (`docs/brand/terminology.md:121`: name what leaves
instead), so the texts say what is sent and what is not, and never call it anonymous.

| Where | ru-RU | en-US | Copylot report |
|---|---|---|---|
| SCR-01 notice | «Okolos отправляет нам данные о том, как работает продукт и где он ломается, чтобы его исправлять. В них нет адресов страниц, их текста, имён файлов, почты и паролей.» Link «Выключить в настройках» | «Okolos sends us data on how the product runs and where it breaks, so we can fix it. It contains no page addresses, page text, file names, email or passwords.» Link «Turn off in settings» | ru `63697267`, en `f0382019` (ui, score 100 each, no blocking) |
| SCR-12 block | heading «Данные об использовании и ошибках»; switch «Отправлять данные об использовании и ошибках»; what is sent: «Отправляются названия действий и ошибок из закрытого списка, версия расширения, браузер и система. Адреса страниц, их текст, имена файлов, почта и пароли не отправляются.»; off: «Выключено: ничего не отправляется, номер установки удалён.»; save failed: «Изменение не сохранилось. Сейчас сохранено: {state}.»; Firefox 129..139: «В этой версии Firefox нет встроенного согласия на сбор данных, поэтому Okolos ничего не отправляет. Обновите Firefox до версии 140, чтобы выбрать.»; Firefox 140+: «В Firefox выбор хранит браузер. Переключатель просит Firefox разрешить или запретить отправку.» | the same set in English, as checked | same reports |
| store card, replaces «Не собирает аналитику» | «• Отправляет данные об использовании и ошибках, чтобы мы исправляли продукт. Адреса страниц, их текст, почта и пароли туда не попадают. Выключается в настройках.» and «• Не просит аккаунт, не показывает рекламу.» | «• Sends usage and error data so we can fix what breaks for you, and none of it is a page address, page text, an email or a password. Settings turn it off.» and «• Asks for no account, shows no advertising.» | ru `b184e587` (store, 87), en `8887fb7b` (store, 100; the first draft `c55852db` scored 71.3 on rhythm and was rewritten) |

`docs/privacy.md` (the «Чего нет» bullet and a new section) is written with the code, against the final event
catalogue, and checked then. Next: stage 4 plan.
- 2026-11-04 17:30 UTC, sshlg-growth answered (thread `881757d0`): `platform` is `browser_extension` (not `web`:
  `web` means a site's page), browser and OS through `systemProps`; growth adds the value in manifest revision 34
  (RB-111); until then `POST /v1/config` refuses it, which Okolos does not call. And the server: PassionCode
  products send to `analytics.passioncode.ai` (passioncode-platform `infra/analytics`), not `analytics.sshlg.me`;
  growth reads both. The operator's decision names no server, `analytics.sshlg.me` was this run's choice from the
  usage-events skill, so the design changes: D1 host `analytics.passioncode.ai`; D5 `platform: browser_extension`;
  D8 App-Key slot `passioncode-platform/prod/APTABASE_APP_KEY_OKOLOS`, made by growth with
  passioncode-platform `scripts/app.sh create` (asked, answer pending). `docs/brand/facts.md` and
  `packages/net/src/destinations.ts` will name `analytics.passioncode.ai`.
