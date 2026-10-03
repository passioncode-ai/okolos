# Local backlog

Canonical status for these tasks; keep stable IDs and closure receipts. Older handoffs
and narrative boards retain evidence, not a second editable status. The workspace
derives its common backlog from [backlog-sources.json](backlog-sources.json).

| ID | Item | Status | Source |
|---|---|---|---|
| B-25 | Установка локального агента обновления фида; выполнена по записи B-133 от 2026-09-29 | done | [История B-25](superpowers/backlog.md) |
| B-78 | Баннер один раз из двенадцати прогонов CI не появляется за 35 секунд | open | [История B-78](superpowers/backlog.md) |
| B-72 | Граф кода отстал на 209 файлов, и собрать его может только скил | open | [История B-72](superpowers/backlog.md) |
| B-125 | Ключ HIBP читается, но ввести его негде — половина утечек недостижима | open | [История B-125](superpowers/backlog.md) |
| B-127 | Проверка чисел сценариев и экранов не покрывает первый файл, который открывают | open | [История B-127](superpowers/backlog.md) |
| B-128 | Матрица покрытия занижает по строке 3.13 | open | [История B-128](superpowers/backlog.md) |
| B-129 | `pnpm graph:check` не гоняется ни одной цепочкой | open | [История B-129](superpowers/backlog.md) |
| B-130 | SCN-001 описывает экран, которого нет | open | [История B-130](superpowers/backlog.md) |
| B-131 | `@okolos/model` уезжает в продакшн-бандл, которому он недостижим | open | [История B-131](superpowers/backlog.md) |
| B-132 | mail-guard: проверки Ф0 не построены — ожидаемо, но названо | open | [История B-132](superpowers/backlog.md) |
| B-133 | Проверка свежести опубликованного фида отдельно от локального артефакта; доступ к публикации восстановлен 2026-09-29 | open | [История B-133](superpowers/backlog.md) |
| B-134 | Индекс `reuse` в IndexedDB не истекает: строки сменённых паролей копятся и дают устаревшее «уже использован на …»; снимки удалённых расширений тоже не выметаются (аудит жизненного цикла 2026-10-03, F7) | open | [Аудит, F7](https://github.com/passioncode-ai/fabric-workspace/blob/main/docs/reports/2026-10-03-lifecycle-audit/README.md) |
| B-135 | Хост должен читать `~/.okolos/state/feed-status.json` и поднимать тревогу при двух неудачах подряд или `lastPublished` старше 26 ч — запись агент уже пишет (ADR-0017); владелец показа — Project Observatory | open | [ADR-0017](adr/0017-the-feed-agent-publishes-from-a-pinned-checkout-and-counts-from-what-is-served.md) |
