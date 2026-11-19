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
то есть обычно не больше 100 в сутки (после пропущенного будильника возможна пятая отправка, B-205);
событие старше суток отбрасывается, очередь держит не больше 500. Повтор
только на 408, 429, 5xx, ошибку сети (в том числе запрос без ответа 15 секунд; журнал отправок открывается не дольше 5 секунд, иначе это сбой записи в журнал, и новый запрос не начинается позже 8 секунд от начала отправки, так что одна отправка укладывается в 30 секунд RPC страницы, B-214) и сбой записи в журнал
отправок; другой ответ 4xx и любая другая ошибка отбрасывают событие. Событие старше суток не отправляется: запись
нового события выбрасывает такие из очереди, а отправка проверяет возраст перед каждым запросом. До этого
оно может лежать на устройстве. Событие со временем больше чем на 5 минут впереди часов (часы устройства спешили и были
исправлены) не уходит и выбрасывается.

Правило истории (решение оператора 2026-10-25): событие не переименовывается и не меняет смысла;
новое значение получает новое событие, убранное помечается `retired` с датой.

| Событие | Статус | Свойства и значения | Откуда уходит |
|---|---|---|---|
| `extension_installed` | active | `reason`: `install`, `update` | `apps/extension/src/background/index.ts#platform.runtime.onInstalled` (установка), `apps/extension/src/background/index.ts#platform.runtime.onUpdated` (обновление расширения, B-206) |
| `first_run_completed` | active | `result`: `clean`, `findings`, `partial` | экран первого запуска (`apps/extension/src/first-run/index.ts`) присылает итог проверок (`firstRunResult`: `findings`, если есть открытые находки, `partial`, если какая-то проверка не прошла или недоступна, иначе `clean`), `apps/extension/src/background/index.ts#countFirstRun` считает его один раз на установку (ключ `usage:firstRunCounted`; страница сама событий не шлёт, ADR-0021; B-206) |
| `warning_shown` | active | `kind`: `hidden-instruction`, `lookalike`, `blocked-page`, `clickfix`, `tech-support`, `outside-link`, `credential-guard`, `download`, `leaked-password` | `apps/extension/src/background/index.ts#journalTrap` (ловушки страниц: `clickfix`, `tech-support`, `outside-link`, переведённые из вида ловушки функцией `trapWarning`; `outside-link` считается, только когда показано само это предупреждение, а не клик под уже открытым предупреждением ClickFix, B-210), `apps/extension/src/background/index.ts#platform.downloads.onCreated` (`download`, только когда страница приняла предупреждение: `downloadWarningShown`); ловушка «браузер заблокирован» (SCN-009) считается как `tech-support`, отдельного значения у неё нет, `apps/extension/src/background/index.ts#countShownWarning` (`hidden-instruction`, `lookalike`, `credential-guard`: когда предупреждение заняло панель на странице, а не строкой на чужой панели; `blocked-page`: один раз на показанную страницу блокировки; `leaked-password`: панель пароля, которая рисуется только для скомпрометированного пароля; B-206)
| `check_done` | active | `check`: `password`, `leak-inventory`, `extensions`; `result`: `ok`, `found`, `unavailable` | `apps/extension/src/background/index.ts#handlePasswordCheck` (`password`: и проверка, которую сама запускает отправленная форма входа), `apps/extension/src/background/index.ts#handleLeakCheck` (`leak-inventory`: `found`, если утечку нашёл хоть один источник, `ok`, только если ответили все и ничего не нашли, `unavailable`, если источник молчал и утечек нет, `leakCheckResult`), `apps/extension/src/background/index.ts#reviewExtensions` (`extensions`, ежедневная проверка расширений: `found`, если она записала изменение, `ok`, если нет, `unavailable`, если браузер не даёт списка расширений или проверка упала, `extensionsCheckResult`; B-206) |
| `error_occurred` | active | `area`: `scan`, `feed`, `download`, `password`, `leak`, `storage`, `ui`, `usage`; `kind`: `timeout`, `network`, `storage-full`, `refused`, `unexpected` | `apps/extension/src/background/index.ts#pullFeed` (`feed`, `unexpected`: только исключение вне самой синхронизации и только у синхронизации, срок которой пришёл, так что не чаще раза в 6 часов; хранилище, которое не открылось, события не даёт: очередь отправки лежит в нём же (B-206); сетевую ошибку и отказ подписи синхронизация записывает в журнал сама и сюда не передаёт); остальные области пока не отправляются |
