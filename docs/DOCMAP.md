# Карта документов okolos: где что живёт и что обязывает изменение

Одна на проект. Отвечает на четыре вопроса: где живёт решённое, где единственный дом каждого
факта, что обязывает изменение какого вида и чем это проверяется. Где другой файл уже говорит то
же, здесь стоит ссылка, а не копия. Заведена 2026-10-27 прогоном Б1 моста
([бриф](superpowers/specs/2026-10-27-bridge-b1-brief.md)).

## Режим

Управляемый с 2026-08: документы сверяются с деревом тестами `tools/*.test.ts`, и красный гейт
не даёт запушить (`.githooks/pre-push`, `pnpm gates`). Эта карта ничего нового не вводит, она
собирает указатели.

## Реестры

| Реестр | Файл | Идентификаторы | Только дописывание | Под арендой |
|---|---|---|---|---|
| Решения | [adr/](adr/) | `ADR-NNNN` | да: заменённый ADR остаётся со ссылкой на замену | да, [AGENT_SYNC.md](AGENT_SYNC.md) |
| Открытые вопросы | [open-questions.md](open-questions.md) | номер вопроса | да | да |
| Задачи | [backlog.md](backlog.md), история в [superpowers/backlog.md](superpowers/backlog.md) | `B-NNN` | да: закрытая строка хранит квитанцию | да |
| Источники задач для общей доски | [backlog-sources.json](backlog-sources.json) | | | да |
| Изменения для людей | [../CHANGELOG.md](../CHANGELOG.md) | версия | да | да |
| Уроки прогонов | [superpowers/retro.md](superpowers/retro.md) | дата записи | да | нет |

## Единственный дом факта

| Факт | Дом | Остальные ссылаются |
|---|---|---|
| Решённая развилка | [adr/](adr/) | номер ADR |
| Поведение, которое видит человек | [ux/scenarios.md](ux/scenarios.md) | `SCN-NNN` |
| Экран и его состояния | [ux/screens.md](ux/screens.md) | `SCR-NN` |
| Термин и его перевод | [brand/terminology.md](brand/terminology.md) | термин как есть |
| Утверждение о продукте, которое можно делать | [brand/facts.md](brand/facts.md) | строка таблицы |
| Что уходит с устройства и куда | [privacy.md](privacy.md), назначения в `packages/net/src/destinations.ts` | |
| Команды сборки и проверки | [runbooks/development.md](runbooks/development.md) | имя скрипта |
| Что работает на машине из-за Okolos | [../AGENTS.md](../AGENTS.md) → Lifecycle | |
| Требование фазы | спека фазы в [superpowers/specs/](superpowers/specs/) | `REQ-NN` |
| Состояние трека RM-18 | fabric-workspace `knowledge/roadmap.md` | номер трека |

## Что обязывает изменение

| Изменение | Обновить | Чем проверяется |
|---|---|---|
| **Новый документ или правило** | карта документов в [README.md](README.md); эта карта, если документ становится домом факта | `tools/docs.test.ts` для чисел и списков; включение в карту README: `review`, потому что значимость документа решает человек |
| Новое или изменённое решение | новый ADR; документы, которые он называет в «Чем держится» | `tools/adr.test.ts`: каждый названный файл существует |
| Поведение, которое видит человек | `ux/scenarios.md`, `ux/flows.md`, `ux/screens.md` в том же изменении | `python3 docs/ux/lint.py` |
| Текст для человека | строка в `packages/i18n`, термин из `brand/terminology.md` | `python3 docs/brand/lint.py`, `tools/copy.test.ts`, `tools/locales.test.ts` |
| Число, которое утверждают доки | `brand/facts.md` и место утверждения, число берётся командой | `tools/docs.test.ts` |
| Новый скрипт `package.json` | [runbooks/development.md](runbooks/development.md) | `tools/runbook.test.ts` |
| Новый процесс на машине (служба, агент launchd) | `AGENTS.md` → Lifecycle; раннбук | `review`: таблица описывает поведение процесса, которое тест читает только частично |
| Новый адресат в сети | `packages/net/src/destinations.ts`, [privacy.md](privacy.md) | `packages/net/src/destinations.test.ts`, гейт бандла |
| Новый пакет | `docs/README.md` → Карта кода; лицензия в `package.json` | `tools/docs.test.ts` (счёт пакетов), `tools/licensing.test.ts` |
| Роль репозитория, его зависимости или тестовая команда | строка в `org-index/repositories.json` | `python3 scripts/check_index.py` в org-index |
| Факт, общий для нескольких репозиториев | страница fabric-workspace `knowledge/`, которая им владеет | `npm test` в fabric-workspace |

## Гейты

| Гейт | Команда | Когда | Блокирует |
|---|---|---|---|
| Всё, что гоняет pre-push | `pnpm gates` | перед пушем | да |
| UX-цепочка | `python3 docs/ux/lint.py` | после изменения поведения | да, входит в `pnpm gates` |
| Бренд-пак | `python3 docs/brand/lint.py` | после изменения текста | да, входит в `pnpm gates` |

Что каждый гейт не ловит, написано в его собственной шапке.
