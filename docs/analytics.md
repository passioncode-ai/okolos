# Каталог событий

Каждое событие об использовании и ошибках, которое Okolos может отправить, его значения и место в коде,
откуда оно уходит. Источник правды: `apps/extension/src/background/usage/catalogue.ts`; `tools/analytics.test.ts`
держит эту таблицу и его равными: событие или значение, которого нет здесь, не уходит, а здесь не может
быть события, которого нет в коде.

Как события уходят, записано в [ADR-0021](adr/0021-usage-and-error-data-on-by-default.md): только из
фонового скрипта, через единственный сетевой модуль под назначением `usage-data`, на
`analytics.passioncode.ai`, по одному событию на запрос. К каждому событию приёмник добавляет `iid`
(случайный номер установки, пока сбор включён), `environment` (`production` у сборки для магазина,
`sandbox` у любой другой; уходит на деле всегда `production`, потому что ключ есть только у сборки для
магазина, а сборка без ключа не отправляет ничего) и `platform` (`browser_extension`). Рядом с `props` уходят время события
(`timestamp`) и номер сеанса (`sessionId`, один на установку и час: из номера установки и часа, так что
все пробуждения фонового скрипта в этот час дают один и тот же); в `systemProps` уходят язык браузера,
версия расширения, `sdkVersion` (`okolos-usage@1`), признак `isDebug` у сборки не для магазина и пустой
`osName`.
Свободного текста ни в одном событии нет: каждое свойство принимает только значения из списка ниже.

Сколько: события уходят только с будильником фида (`okolos:feeds`, раз в 6 часов; Chrome и Edge, закрытые
в срок, запускают его один раз при старте, Firefox ещё не проверен, B-211), не больше 25 за раз,
то есть не больше 100 в сутки; событие старше суток отбрасывается, очередь держит не больше 500. Повтор
только на 408, 429, 5xx, ошибку сети (в том числе запрос без ответа 15 секунд) и сбой записи в журнал
отправок; другой ответ 4xx и любая другая ошибка отбрасывают событие. Событие старше суток не держится и на
устройстве: запись нового события выбрасывает такие из очереди.

Правило истории (решение оператора 2026-10-25): событие не переименовывается и не меняет смысла;
новое значение получает новое событие, убранное помечается `retired` с датой.

| Событие | Статус | Свойства и значения | Откуда уходит |
|---|---|---|---|
| `extension_installed` | active | `reason`: `install`, `update` | `apps/extension/src/background/index.ts:322` (установка; `update` пока не отправляется) |
| `first_run_completed` | planned | `result`: `clean`, `findings`, `partial` | не подключено: экран первого запуска не говорит с приёмником |
| `warning_shown` | active | `kind`: `hidden-instruction`, `lookalike`, `blocked-page`, `clickfix`, `tech-support`, `browser-lock`, `outside-link`, `credential-guard`, `download`, `leaked-password` | `apps/extension/src/background/index.ts:1008` (ловушки страниц: `clickfix`, `tech-support`, `outside-link`, переведённые из вида ловушки функцией `trapWarning`), `apps/extension/src/background/index.ts:1183` (`download`, только когда страница приняла предупреждение: `downloadWarningShown`); остальные значения, `browser-lock` в том числе, пока не отправляются |
| `check_done` | active | `check`: `password`, `leak-inventory`, `extensions`; `result`: `ok`, `found`, `unavailable` | `apps/extension/src/background/index.ts:652` (`password`: и проверка, которую сама запускает отправленная форма входа), `apps/extension/src/background/index.ts:772` (`leak-inventory`); `extensions` пока не отправляется |
| `error_occurred` | active | `area`: `scan`, `feed`, `download`, `password`, `leak`, `storage`, `ui`, `usage`; `kind`: `timeout`, `network`, `storage-full`, `refused`, `unexpected` | `apps/extension/src/background/index.ts:1374` (`feed`, `unexpected`: только исключение вне самой синхронизации, например не открылось хранилище; сетевую ошибку и отказ подписи синхронизация записывает в журнал сама и сюда не передаёт); остальные пока не отправляются |
