# Деплой прокси-воркера — раннбук

Один скрипт делает всё, что раньше было списком «сделай руками»:

```bash
node tools/deploy-worker.mjs              # рендер конфига → схема → деплой → смоук
node tools/deploy-worker.mjs --dry-run    # всё, кроме изменяющих шагов
node tools/deploy-worker.mjs --smoke-only # проверить выкаченное, ничего не меняя
```

Живой воркер: <https://okolos-proxy.sergeysheleg4.workers.dev>, cron `17 3 * * *`.

Идемпотентен, и это измерено, а не заявлено: второй независимый прогон
2026-08-07 накатил схему с `Rows written: 0` при тех же двух таблицах, выкатил
новую версию и прошёл все четыре смоук-проверки. Схема —
`CREATE TABLE IF NOT EXISTS`, деплой перезаписывает скрипт, смоук ничего не
пишет.

## Что нужно в окружении

Скрипт читает `~/.okolos/cloudflare.env` (режим `0600`, вне репозиториев) или
переменные окружения — что найдёт первым:

| Переменная | Что это |
|---|---|
| `CLOUDFLARE_API_TOKEN` | account-scoped токен с Workers Scripts:Edit и D1:Edit |
| `CLOUDFLARE_ACCOUNT_ID` | id аккаунта, 32 hex-символа |
| `OKOLOS_D1_ID` | uuid базы D1 `okolos` |
| `OKOLOS_WORKER_URL` | необязательно; если не задана, URL берётся из `wrangler deployments list` |
| `CLOUDFLARE_WORKERS_TOKEN` | необязательно: токен для шага деплоя, если `CLOUDFLARE_API_TOKEN` пишет только D1 |

**Токены из Observatory (2026-11-19).** Observatory выпускает токены Cloudflare по пресетам, и
один пресет не пишет и D1, и Worker: `okolos/prod/CLOUDFLARE_API_TOKEN` (пресет `d1-edit`) накатывает
схему, `okolos-extension/prod/CLOUDFLARE_WORKERS_TOKEN` (пресет `workers-edit`, выпущен
`tools/cloudflare.py issue --preset workers-edit`) выкатывает воркер. Переменная окружения сильнее
файла, поэтому деплой целиком идёт так, без значений в выводе:

```bash
T="$(project-observatory full-path)/tools"
python3 "$T/use_secret.py" run --vault-only --env prod okolos CLOUDFLARE_API_TOKEN -- \
  python3 "$T/use_secret.py" run --vault-only --env prod okolos-extension CLOUDFLARE_WORKERS_TOKEN -- \
  node tools/deploy-worker.mjs
```

Токен в `~/.okolos/cloudflare.env` 2026-11-19 отвечал `Invalid access token [code: 9109]`; файл
нужен теперь только ради `CLOUDFLARE_ACCOUNT_ID` и `OKOLOS_D1_ID`.

Env-файл **читается парсером, а не `source`** — команда, случайно попавшая в
файл с кредами, не выполнится.

### `APPEALS_TOKEN` — секрет воркера, не переменная деплоя

Читать поданные апелляции можно только с ним, и ставится он отдельно, потому что
это секрет воркера, а не вход скрипта:

```bash
wrangler secret put APPEALS_TOKEN   # спросит значение и не запишет его в файл
```

Пока секрет не поставлен, `/appeals` отвечает **404**, а не 401: адрес, который
признался, что существует, начинают угадывать. То есть отсутствие токена — это
рабочее состояние, а не поломка; путь чтения просто закрыт.

Прочитать:

```bash
curl -sS -H "Authorization: Bearer $APPEALS_TOKEN" \
  "$OKOLOS_WORKER_URL/appeals?limit=50" | jq '.appeals[] | {domain, created_at}'
```

Токен в `wrangler.toml` не кладётся намеренно: токен в закоммиченном файле — не
токен.

**Про account-scoped токены:** `cfat_…` не проходит `GET /user/tokens/verify`
— это user-level эндпоинт, и токену аккаунта туда нельзя. Проверять токен надо
через `GET /accounts/{id}`. Первая проверка этого проекта дала «Invalid API
Token» на рабочем токене именно по этой причине.

## Почему конфиг генерируется

`apps/proxy/wrangler.toml` в репозитории намеренно держит
`database_id = "set-at-deploy"`. Id принадлежит одному аккаунту; репозиторий,
который его зашивает, деплоит в этот аккаунт из любого клона.
`tools/deploy-config.mjs` подставляет id в сгенерированный
`wrangler.generated.toml` — он в `.gitignore`, и `tools/deploy-config.test.ts`
следит, что в шаблоне не появился настоящий uuid.

## Что проверяет смоук

Четыре проверки, и каждая отличает **этот** воркер от любого другого хоста —
проверено натравливанием `--smoke-only` на `example.com`, где падают все четыре:

- `/healthz` отвечает 200;
- неперечисленный домен получает `status: "not-listed"` и **не** `"unknown"`:
  `unknown` — это ровно то, что воркер отвечает, когда не может достучаться до
  D1, поэтому деплой с ненакатанной схемой падает здесь, а не проходит на 200;
- запрос без домена получает 400, а не ответ;
- неизвестный путь отдаёт `{"error":"not found"}` — тело проверяется, потому
  что голый 404 вернул бы любой чужой хост. Версия этой проверки, смотревшая
  только на код, прошла против `example.com`.

## Создать D1 с нуля (один раз на аккаунт)

```bash
cd apps/proxy && npx wrangler d1 create okolos
```

Напечатанный `database_id` — в `~/.okolos/cloudflare.env` как `OKOLOS_D1_ID`.

## Грабли, на которые уже наступили

- `d1 execute` **тоже** нужен `--config wrangler.generated.toml`. Без него
  wrangler читает закоммиченный шаблон и отправляет `set-at-deploy` как id
  базы, а API отвечает «Invalid uuid» и ни словом не поминает конфиг.
- URL воркера печатает `deploy`, а не `deployments list`. Первый настоящий
  прогон дошёл до смоука без URL — после успешного деплоя.
- Контракт `/status/domain` — это `status: listed | not-listed | unknown`,
  а не `listed: boolean`. Смоук, написанный по памяти, проверял второе.

## Гейт песочницы

Harness Claude Code блокирует изменяющие прод команды (`wrangler deploy`,
`d1 execute --remote`, POST в API Cloudflare) — и это правильно. Чтобы агент
доводил деплой автономно, нужно точечное Bash-permission-правило на
`node tools/deploy-worker.mjs`; иначе команду запускает человек.
