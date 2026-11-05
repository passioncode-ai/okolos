# Каталог событий

Каждое событие об использовании и ошибках, которое Okolos может отправить, его значения и место в коде,
откуда оно уходит. Источник правды: `apps/extension/src/background/usage/catalogue.ts`; `tools/analytics.test.ts`
держит эту таблицу и его равными: событие или значение, которого нет здесь, не уходит, а здесь не может
быть события, которого нет в коде.

Как события уходят, записано в [ADR-0021](adr/0021-usage-and-error-data-on-by-default.md): только из
фонового скрипта, через единственный сетевой модуль под назначением `usage-data`, на
`analytics.passioncode.ai`, по одному событию на запрос. К каждому событию приёмник добавляет `iid`
(случайный номер установки, пока сбор включён), `environment` (`production` у сборки для магазина,
`sandbox` у любой другой) и `platform` (`browser_extension`). Свободного текста ни в одном событии нет:
каждое свойство принимает только значения из списка ниже.

Правило истории (решение оператора 2026-10-25): событие не переименовывается и не меняет смысла;
новое значение получает новое событие, убранное помечается `retired` с датой.

| Событие | Статус | Свойства и значения | Откуда уходит |
|---|---|---|---|
| `extension_installed` | active | `reason`: `install`, `update` | `apps/extension/src/background/index.ts:322` (установка; `update` пока не отправляется) |
| `first_run_completed` | planned | `result`: `clean`, `findings`, `partial` | не подключено: экран первого запуска не говорит с приёмником |
| `warning_shown` | active | `kind`: `hidden-instruction`, `lookalike`, `blocked-page`, `clickfix`, `tech-support`, `browser-lock`, `outside-link`, `credential-guard`, `download`, `leaked-password` | `apps/extension/src/background/index.ts:1006` (ловушки страниц: `clickfix`, `tech-support`, `browser-lock`, `outside-link`), `apps/extension/src/background/index.ts:1149` (`download`); остальные значения пока не отправляются |
| `check_done` | active | `check`: `password`, `leak-inventory`, `extensions`; `result`: `ok`, `found`, `unavailable` | `apps/extension/src/background/index.ts:652` (`password`), `apps/extension/src/background/index.ts:772` (`leak-inventory`); `extensions` пока не отправляется |
| `error_occurred` | active | `area`: `scan`, `feed`, `download`, `password`, `leak`, `storage`, `ui`, `usage`; `kind`: `timeout`, `network`, `storage-full`, `refused`, `unexpected` | `apps/extension/src/background/index.ts:1370` (сбой обновления фида: `feed`, `unexpected`); остальные пока не отправляются |
