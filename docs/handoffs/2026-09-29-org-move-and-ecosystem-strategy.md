# Handoff 2026-09-29 — переезд в passioncode-ai и стратегия экосистемы

**Цель.** Перенести Okolos в организацию `passioncode-ai` и проработать, как
переупаковать его в экосистемное решение безопасности: движок, самостоятельный
агент, интеграция с Fabric Inbox и Fabric, защита от инъекций в почте и при
браузинге агентами.

## Сделано

| Что | Квитанция |
|---|---|
| Репозиторий перенесён в `passioncode-ai/okolos`, публичный; старый адрес редиректит | `gh api repos/passioncode-ai/okolos` → `public` |
| Команда `contributors` получила `push` | `gh api orgs/passioncode-ai/teams/contributors/repos` → `okolos write` |
| Адреса в `SECURITY.md`, `package.json`, `tools/ingest.mjs` и `docs/README.md`; `AGENTS.md` и `@AGENTS.md` в `CLAUDE.md` (org-index RULES §8) | `25308af` |
| Фид в дереве догнал агента — v41 | `dddc9e9` |
| Хук `pre-push` падал на lint, typecheck и build с 2026-09-13: pnpm 12.4.1 из Homebrew отвергает `pnpm -s <script>` (код 2). Заменено на `pnpm -s run`, тест не даёт сокращению вернуться | `13126b8`, `tools/ci.test.ts` |
| Канарейка `pnpm access` получила таймаут 60 с: при load 130 она шла 7.8 с | `4bca516`, `tools/script-names.test.ts` |
| `main` переведён fast-forward на `4bca516` после зелёных восьми гейтов pre-push | `git ls-remote origin refs/heads/main` |
| Строка `okolos` в `org-index/repositories.json`, README перегенерирован | `passioncode-ai/org-index@4a0b9e0`; `check_index.py` → 0 находок |
| Стратегия-предложение | [docs/strategy/2026-09-29-ecosystem.md](../strategy/2026-09-29-ecosystem.md) |

## Открыто

- **Токен Cloudflare агента фида недействителен.** В `/tmp/okolos-feed.log`
  записано `Invalid access token [code: 9109]` на `wrangler d1 execute`. Прод
  отдаёт старый фид, агент собирает свежий только локально (B-133). Нужен
  человек: новый токен с правами на D1.
- **Агент фида пишет только в рабочую копию.** `feeds/phishing.json` в основном
  checkout снова изменён после коммита v41. Это выход агента, а не чужая работа.
  В дерево его кладут коммитом, как `5241cb6`.
- **Firefox id `okolos@ssheleg.dev`** оставлен сознательно — это личность
  дополнения в AMO (`AGENTS.md`).
- **CI остался на push и PR**, а не на ночном батче организации. Репозиторий
  публичный, минуты не под лимитом (`AGENTS.md`). Если оператор решит иначе —
  перевести на расписание по `org-index/docs/CI-BATCHING.md`.
- **Лицензия.** AGPL-3.0 не описана в RULES §9. Решение — §8.1 стратегии.
- Четыре решения из §8 стратегии не приняты.

## Проверки, которые реально прогнаны

- `pre-push`: lint, typecheck, build, unit (2631 тест), ux, brand, i18n, package — все `ok` на `4bca516`.
- `python3 docs/ux/lint.py` — ok.
- `org-index`: `python3 scripts/check_index.py` → `15 repositories, 0 finding(s)`,
  `python3 -m unittest discover -s tests` → `OK`.

## Следующая задача

Получить от оператора ответы на §8 стратегии и записать их как ADR-0014 и дальше.
Параллельно — Ф0 из §6: новый Cloudflare-токен для агента фида, затем проверка,
что `GET /feeds/phishing` на воркере отдаёт версию из дерева.

## Продолжение 2026-09-29 — токен, фид, лицензии

| Что | Квитанция |
|---|---|
| В движок Observatory добавлен пресет `d1-edit`: D1 Write на один аккаунт, в слот хранилища | passioncode-ai/project-observatory-dashboard#81 |
| Выпущен токен в `okolos/prod/CLOUDFLARE_API_TOKEN`, проверен листингом D1 новым значением | вывод `cloudflare.py issue`, журнал хранилища |
| Мёртвый токен шёл из окружения launchd и перекрывал `~/.okolos/cloudflare.env`; агент фида теперь запускается через `use_secret.py` | `tools/feed-agent-credential.mjs`, `c8a5df0` |
| Прод отдаёт свежий фид: v42 опубликован вручную, v43 — самим агентом, `last exit code = 0` | `/tmp/okolos-feed.log`: `published phishing v43` |
| Лицензии: сначала Apache-2.0/AGPL (ADR-0014), затем в тот же день — схема организации | см. ниже |
| Правило «креденшлы — сначала через Observatory» записано в глобальные инструкции оператора | `~/.claude/CLAUDE.md` (не в репозитории) |

**Открыто:**

- PR #81 в движке Observatory слит (`4472b8f`); до релиза 0.8.3 установленная
  копия (0.8.2) пресета `d1-edit` не знает.
- ~~Строка об Okolos в `org-index/RULES.md` §9~~ — слита: Okolos в списке публичных инструментов (org-index#6).
- B-133, вторая половина: гейт, который отличает свежий прод от свежего дерева.
- Глобальная переменная launchd `CLOUDFLARE_API_TOKEN` мертва, но всё ещё
  выставлена. Ей пользуется любой процесс, запущенный из GUI.
- Решения §8.2 (анти-цель) и §8.4 (порядок фаз) стратегии.

**Следующая задача:** бриф Ф1 — `@okolos/engine` и корпуса почты и ответов
инструментов — в `docs/superpowers/briefs/`.

## Лицензия — схема организации (ADR-0015)

Оператор уточнил цель: людям и организациям бесплатно без согласия,
коммерческое использование — по согласованию через contact@passioncode.ai.
Okolos переведён на выражение `PolyForm-Noncommercial-1.0.0 OR
LicenseRef-PolyForm-Internal-Use-1.0.0` — тот же `LICENSE` и `CLA.md`, что у
Observatory. [ADR-0015](../adr/0015-okolos-takes-the-organisations-licence.md)
заменяет ADR-0014; коммиты до `5a8e490` остаются под AGPL/Apache, это записано в
`LICENSE`. Держит `tools/licensing.test.ts`: оба текста, выражение во всех 24
манифестах, запрет «open source» в поверхностях, разрешительные зависимости.

**Замечено у соседей, не менялось:**
- `fabric-inbox` — Apache-2.0 (наследие шаблона Cloudflare);
- у `fabric` нет `LICENSE` вовсе;
- у `project-observatory-contract` MIT — по правилу §9, это нормально.
