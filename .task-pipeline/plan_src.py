# Single source for the plan (docs/superpowers/plans/2026-10-27-bridge-b1.md) and the execution packets.
import json, os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEC=["docs/superpowers/specs/2026-10-27-bridge-b1-brief.md#решения","docs/superpowers/specs/2026-10-06-bridge-b1-design.md","docs/superpowers/specs/2026-10-27-bridge-b1-modules.md"]
GUARDS_ALL=["TDD: тест пишется первым и наблюдается красным","никакого секрета в argv, логах, журнале и URL","ничего не уходит в сеть, кроме уже разрешённого @okolos/net","core-* не трогают браузерные API, сеть, часы, случайность (гейт ESLint и скан бандла)","лицензия нового package.json: AGPL-3.0-only OR LicenseRef-PassionCode-Commercial","без длинного тире в текстах для людей"]
T=[
dict(n="N-001",title="K0: контракты моста",deps=[],req=["REQ-53"],
 files=["Modify: packages/contracts/src/bridge.ts","Test: packages/contracts/src/bridge.test.ts"],
 consumes="—",
 produces="`BRIDGE_SESSION_VERBS = ['session.open','hygiene.census'] as const`; типы ответов `SessionOpenResult {sessionId, windowId}`, `OpenResult {url}`, `SnapshotResult {text, refs: string[], verdict: SnapshotVerdict, cursor?: string, partial: boolean}`, `ReadResult {text, boundary: {nonce, origin}}`, `CensusEntry`; `refusalKey(code: BridgeRefusal): string` — исчерпывающий `switch`, ключ строки `refusal_<code>`",
 tests=["refusalKey даёт ключ для каждого из BRIDGE_REFUSALS, и каждый ключ есть в apps/agent/_locales/{ru,en}/messages.json","добавление кода в BRIDGE_REFUSALS без ветки в refusalKey — ошибка компиляции (посадка наблюдается: tsc TS2322/TS2366)","validateScope отвергает write ⊄ read, ttlSeconds > 3600, stepBudget > 500 (уже есть, сохраняется)"],
 dod="vitest packages/contracts зелёный; pnpm typecheck 0; посадка удалённой ветки switch наблюдена красной"),
dict(n="N-002",title="K1: packages/cdp-pipe",deps=[],req=["REQ-54"],
 files=["Create: packages/cdp-pipe/package.json, packages/cdp-pipe/tsconfig.json, packages/cdp-pipe/src/index.ts, packages/cdp-pipe/src/frames.ts, packages/cdp-pipe/src/pipe.ts","Modify: tsconfig.json (ссылка на проект)","Test: packages/cdp-pipe/src/frames.test.ts, packages/cdp-pipe/src/pipe.test.ts","Modify: tools/agent-window-spike.mjs (splitFrames импортируется из пакета), tools/agent-window-spike.test.ts"],
 consumes="—",
 produces="`splitFrames(pending, chunk): {messages, pending}`; `class CdpPipe { static launch(o: {binary, args, userDataDir, requestTimeoutMs?}): Promise<CdpPipe>; send<T>(method, params?, sessionId?): Promise<T>; on(event, (params, sessionId?) => void): () => void; readonly pid: number; close(graceMs = 2000): Promise<void> }` — дочерний процесс `detached` в своей группе, fd 3 в браузер, fd 4 из браузера; `close` шлёт `Browser.close`, затем SIGTERM группе, затем SIGKILL",
 tests=["кадры: сообщение, разрезанное между чтениями, собирается; пустые куски пропускаются (переезжают из спайка)","send без ответа за requestTimeoutMs отклоняется с ошибкой, называющей метод","ответ с error превращается в отклонение с текстом CDP","close завершает всю группу: после close процесса с pid нет (фальшивый браузер — node-скрипт, читающий fd 3 и пишущий в fd 4)","события с sessionId доставляются подписчику с этим sessionId"],
 dod="vitest packages/cdp-pipe и tools/agent-window-spike.test.ts зелёные; спайк собирается"),
dict(n="N-003",title="K2: вердикт к снимку, корпус, fuzz секретов",deps=["N-001"],req=["REQ-55"],
 files=["Create: packages/core-snapshot/src/verdict.ts","Test: packages/core-snapshot/src/verdict.test.ts, src/corpus.test.ts, src/secrets.test.ts"],
 consumes="`buildSnapshot`, `AxNode` (packages/core-snapshot/src/snapshot.ts); `Verdict` (@okolos/contracts)",
 produces="`snapshotVerdict(probe: {verdicts: readonly Verdict[], truncated: boolean, unresolved: number}): SnapshotVerdict` — `{level: 'clean'|'finding'|'incomplete', findings: {kind, confidence, evidence}[]}`; `incomplete`, когда пробник упёрся в бюджет или не нашёл элемент: агенту говорится, что очистка неполная",
 tests=["корпус corpora/injections/positives.json: каждый позитив, помещённый в AX-дерево скрытым узлом, отсутствует в renderLine-выдаче","negatives.json: ни один негатив не вырезан","fuzz: 200 случайных значений, введённых в textbox/searchbox/combobox и потомки, не встречаются в выдаче (фиксированное зерно)","truncated или unresolved > 0 дают level 'incomplete', а не 'clean' (правило retro №3)"],
 dod="vitest packages/core-snapshot зелёный; плант «поле отдаёт значение» наблюдён красным"),
dict(n="N-004",title="K2: выдача частями",deps=["N-003"],req=["REQ-56"],
 files=["Create: packages/core-snapshot/src/pages.ts","Test: packages/core-snapshot/src/pages.test.ts"],
 consumes="`pageOf`, `utf8Bytes`, `SnapshotLine` (snapshot.ts)",
 produces="`DEFAULT_MAX_BYTES = 32 * 1024`; `encodeCursor({from, digest}) / decodeCursor(c): {from, digest} | null`; `paginate(lines, {cursor?, maxBytes?}): {text, cursor?, partial}` — курсор несёт дайджест снимка, курсор от другого снимка отвергается",
 tests=["дерево формы Википедии (29 714 узлов, детерминированное): каждая страница ≤ 32 КБ UTF-8, страниц ≥ 8, конкатенация страниц равна полному тексту","курсор чужого снимка → null (и демон отвечает invalid_scope)","maxBytes больше потолка обрезается до потолка; меньше 1 КБ поднимается до 1 КБ","страница всегда двигается вперёд, даже если одна строка длиннее maxBytes"],
 dod="vitest packages/core-snapshot зелёный"),
dict(n="N-005",title="K3: оболочка службы fabric-service/0.1",deps=["N-002"],req=["REQ-63"],
 files=["Create: apps/agent/package.json, apps/agent/tsconfig.json, apps/agent/src/fabric/ (набор Fabric для Node: fabric_kit.py install apps/agent/src/fabric --lang node --module fabric-service), apps/agent/src/service/dirs.ts, apps/agent/src/service/http.ts, apps/agent/src/service/wellknown.ts","Modify: tsconfig.json (ссылка на проект, после N-002)","Test: apps/agent/src/service/*.test.ts"],
 consumes="набор Fabric: holdSingleInstance, ensureToken, checkRequest, buildWellKnown, LoginCodes, JsonlEventLog, Drain, RotatingLog",
 produces="`SERVICE_ID='okolos-agent'`, `PORT=47871`; `serviceDirs(home?)`; `startService({port, dirs, routes}): Promise<{close()}>` — замок до побочных эффектов, токен 0600, guard на каждом пути, маршруты /.well-known/fabric-service, /fabric/v1/events, /fabric/v1/login-code, /fabric/v1/login; `Route = (req, res, ctx) => Promise<boolean>`",
 tests=["вторая копия на тех же данных выходит с 75, первая отвечает","Host evil.example → 403 на каждом маршруте, включая well-known","Origin https://evil.example → 403; Sec-Fetch-Site: cross-site → 403","well-known: id okolos-agent, instance default, build.commit, process.pid, degraded присутствует, surfaces.mcp.auth = own","события без токена → 401; код входа одноразовый"],
 dod="vitest apps/agent/src/service зелёный; сервер слушает только 127.0.0.1 (тест читает address())"),
dict(n="N-006",title="K3: журнал до ответа",deps=["N-005"],req=["REQ-60"],
 files=["Create: apps/agent/src/journal/journal.ts","Test: apps/agent/src/journal/journal.test.ts"],
 consumes="serviceDirs().data",
 produces="`class Journal { static open(dir, {retentionDays}): Journal; record(e: JournalEntry): Promise<void> /* append + fsync, бросает при сбое */; recent(limit): JournalEntry[]; sweep(now) }`; `JournalEntry {at, agent, task?, verb, origin?, outcome: 'answered'|'refused', code?, bytes?, verdict?}` — без текста страницы и значений полей",
 tests=["record дописывает строку и делает fsync до возврата (шпион на fd.sync)","каталог только для чтения → record бросает, и обёртка answerAfterRecord отдаёт internal, а не ответ","запись с полем text или value отвергается типом и рантайм-проверкой","sweep удаляет записи старше срока; срок берётся из RETENTION_DAYS журнала расширения"],
 dod="vitest apps/agent/src/journal зелёный; плант «ответ до записи» наблюдён красным"),
dict(n="N-007",title="K3: привязка",deps=["N-005"],req=["REQ-58"],
 files=["Create: apps/agent/src/pairing/pairing.ts, src/pairing/keychain.ts","Test: apps/agent/src/pairing/pairing.test.ts, src/pairing/keychain.test.ts"],
 consumes="serviceDirs().data",
 produces="`class Pairing { request(agentName): {requestId, code, expiresAt}; confirm(requestId): void; decline(requestId); claim(requestId): {key} | null /* один раз, ≤ 5 мин, только после confirm */; verify(key): AgentRecord | null; revoke(agentId); list(): {requests, agents} }`; `interface KeyStore { put(agentId, sha256hex); get(agentId); remove(agentId) }`; `MacKeychain implements KeyStore` через `security -i` по stdin",
 tests=["claim до confirm → null; claim после confirm → ключ; второй claim → null","код из 6 цифр; запрос живёт 5 минут; больше 5 открытых запросов → старейший отклоняется; 3 claim подряд с неверным requestId от одного имени → запросы этого имени отклоняются","verify сравнивает в постоянном времени; отозванный ключ → null","MacKeychain: команда уходит в stdin, argv не содержит отпечатка (шпион spawn); интеграционный тест на одноразовом имени службы удаляет за собой"],
 dod="vitest apps/agent/src/pairing зелёный"),
dict(n="N-008",title="K3: дверь /mcp и stdio-шим",deps=["N-001","N-006","N-007"],req=["REQ-57"],
 files=["Create: apps/agent/src/door/door.ts, src/door/stdio-shim.ts","Test: apps/agent/src/door/door.test.ts, src/door/stdio-shim.test.ts","Modify: apps/agent/package.json (зависимости @modelcontextprotocol/server, @modelcontextprotocol/node, zod)"],
 consumes="Pairing.verify/request/claim; Journal.record; Route из N-005",
 produces="`doorRoute({pairing, journal, tools}): Route` — POST /mcp: ключ в `X-Okolos-Agent-Key`; токен хоста отвергается; без ключа → результат not_paired с {requestId, code}; `claim` через заголовок `X-Okolos-Pairing-Request`; `type ToolSet = (agent: AgentRecord) => McpServer`; `okolos-agent mcp-stdio` проксирует stdio ↔ /mcp с ключом из файла 0600",
 tests=["без ключа: not_paired с кодом, запрос виден в pairing.list()","токен хоста в Authorization: not_paired, не 200","Host rebinding (Host: attacker.example:47871) → 403 до разбора","Origin http://evil.example → 403; без Origin, но без ключа → not_paired","ключ отозван → not_paired, задачи агента закрыты","тестовый MCP-клиент (@modelcontextprotocol/client) получает tools/list после привязки"],
 dod="vitest apps/agent/src/door зелёный"),
dict(n="N-009",title="K3: задачи",deps=["N-001"],req=["REQ-59"],
 files=["Create: apps/agent/src/tasks/tasks.ts","Test: apps/agent/src/tasks/tasks.test.ts"],
 consumes="validateScope, inScope, refuse (bridge.ts)",
 produces="`class Tasks { open(agentId, scopeInput, now): BridgeResult<Task>; get(agentId, taskId, now): BridgeResult<Task>; charge(task, verb, url?): BridgeResult<void>; closeAllOf(agentId); list(now) }`; `Task {id, agentId, scope, openedAt, stepsUsed, windowId?}`",
 tests=["каждый отказ BRIDGE_REFUSALS, который выдают задачи (invalid_scope, no_such_task, origin_not_in_task, verb_not_in_task, budget_exhausted, task_expired), — свой тест","чужая задача (другой agentId) → no_such_task","отказ тоже списывает шаг (спека §2.3)","фрагмент URL не влияет на проверку origin"],
 dod="vitest apps/agent/src/tasks зелёный"),
dict(n="N-010",title="K4: окно агента",deps=["N-002"],req=["REQ-61"],
 files=["Create: apps/agent/src/window/chrome.ts, src/window/window.ts","Test: apps/agent/src/window/window.test.ts, src/window/window.chrome.test.ts (настоящий Chrome, пропуск с причиной, если его нет)"],
 consumes="CdpPipe",
 produces="`findChrome(): string | null`; `class AgentWindows { constructor({binary, profileDir, launch = CdpPipe.launch}); openWindow(): Promise<{targetId, sessionId}>; closeWindow(targetId); shutdown() }` — аргументы `--remote-debugging-pipe --no-startup-window --no-first-run --no-default-browser-check --user-data-dir=<profile>` и никогда `--enable-automation`",
 tests=["аргументы запуска: нет --enable-automation, есть --no-startup-window (фальшивый launch)","openWindow зовёт Target.createTarget {newWindow: true, background: true}","shutdown закрывает группу (фальшивый браузер)","Chrome: окно открывается, document.visibilityState = visible, фронтальное приложение не меняется (osascript), outerHeight − innerHeight < 120","Chrome: kill -9 демона-обёртки → процессов с профилем не остаётся после перезапуска (зачистка сирот своего профиля по SingletonLock)"],
 dod="vitest apps/agent/src/window зелёный на этой машине с Chrome stable"),
dict(n="N-011",title="K3: глаголы и walking skeleton",deps=["N-004","N-008","N-009","N-010"],req=["REQ-55"],
 files=["Create: apps/agent/src/verbs/verbs.ts, src/verbs/probe.ts, src/main.ts, tools/build-agent.mjs (бандл демона и пробника)","Test: apps/agent/src/verbs/verbs.test.ts, src/verbs/skeleton.chrome.test.ts"],
 consumes="Tasks, AgentWindows, Journal, buildSnapshot, snapshotVerdict, paginate, runProbe (бандл apps/extension/src/agent-probe.ts)",
 produces="инструменты MCP: session.open, open, snapshot, read, get, waitFor, screenshot, close, hygiene.census; каждый ответ проходит journal.record до отправки; `main.ts` собирает службу",
 tests=["skeleton на Chrome: session.open → open локальной фикстуры со скрытой инструкцией из корпуса → snapshot не содержит текста инструкции, verdict.level = finding → close: окна нет","open вне origins.read → origin_not_in_task, запись в журнале есть","snapshot большой фикстуры приходит частями ≤ 32 КБ с курсором","read возвращает boundary с nonce и origin; get title/url без фрагмента","поле password с введённым значением: значения нет ни в snapshot, ни в read, ни в get text"],
 dod="vitest apps/agent/src/verbs зелёный на Chrome stable"),
dict(n="N-012",title="K5: перепись процессов",deps=["N-001"],req=["REQ-62"],
 files=["Create: apps/agent/src/hygiene/census.ts","Test: apps/agent/src/hygiene/census.test.ts, fixtures ps/launchctl"],
 consumes="CensusEntry (bridge.ts)",
 produces="`census(ps: string, launchctl: string, opts: {selfPid, home}): CensusEntry[]` — `{pid, ppid, kind, owner, keep: boolean, reason}`; `readCensus()` вызывает `ps -axo pid=,ppid=,lstart=,command=` и `launchctl list` с таймаутом",
 tests=["процесс --remote-debugging-port с живым родителем-сессией: keep, owner = сессия","потомок задачи launchd с ppid 1: keep, причина «служба ОС»","Chrome человека без флагов автоматизации: keep, «браузер человека»","chrome-headless-shell с мёртвым родителем на $TMPDIR-профиле: keep=false, причина «сирота», но ничего не завершается"],
 dod="vitest apps/agent/src/hygiene зелёный"),
dict(n="N-013",title="UX: экраны SCR-23/24, потоки, сценарии",deps=[],req=["REQ-64"],
 files=["Modify: docs/ux/screens.md, docs/ux/flows.md, docs/ux/scenarios.md"],
 consumes="—",produces="SCR-23, SCR-24 со состояниями; FLW-21/22 ведут к ним",
 tests=["python3 docs/ux/lint.py → 0"],dod="сделано на стадии 3 (коммит de4cf56); узел закрывается проверкой линтера"),
dict(n="N-014",title="Термины и строки",deps=["N-013"],req=["REQ-66"],
 files=["Modify: docs/brand/terminology.md","Create: apps/agent/_locales/ru/messages.json, apps/agent/_locales/en/messages.json","Modify: tools/locales.test.ts (каталог демона: одинаковые ключи в двух языках, плейсхолдеры объявлены)"],
 consumes="—",produces="47 ключей строк; термины раздела «Мост для агентов»",
 tests=["оба каталога с одинаковыми ключами; каждый $X$ объявлен в placeholders","python3 docs/brand/lint.py → 0"],dod="строки и термины сделаны на стадии 3; узел добавляет проверку каталога демона в tools/locales.test.ts"),
dict(n="N-015",title="Страница демона: SCR-23, SCR-24",deps=["N-007","N-009","N-013","N-014"],req=["REQ-64","REQ-65"],
 files=["Create: apps/agent/src/dashboard/page.ts, src/dashboard/api.ts, apps/agent/static/ (набор дашборда Fabric)","Test: apps/agent/src/dashboard/*.test.ts"],
 consumes="Pairing.list/confirm/decline/revoke, Tasks.list, Journal.recent, каталоги строк",
 produces="GET /dashboard (сессия-кука от кода входа), GET /api/state, POST /api/pairing/:id/confirm|decline, POST /api/agents/:id/revoke — запись требует куку и заголовок X-Okolos-Request: 1; CSP без inline-скрипта; действия fabric-actions: pairing.confirm (human, consent), pairing.decline (human, consent), agent.revoke (relayed)",
 tests=["без куки → 401; запись без X-Okolos-Request → 403","состояния SCR-23: loading, empty, error, success, expired; SCR-24: loading, empty, error, success — каждое по data-role","инструмент pairing.confirm через MCP отвечает human-step-required со ссылкой /dashboard","строки берутся из каталога; ключ без строки виден как [key]"],
 dod="vitest apps/agent/src/dashboard зелёный; SCN-044, SCN-045 переведены в built в том же изменении, python3 docs/ux/lint.py 0"),
dict(n="N-016",title="K6: установка",deps=["N-011","N-012","N-015"],req=["REQ-63"],
 files=["Create: tools/install-agent.mjs, tools/install-agent.test.ts, tools/launchd/app.okolos.agent.plist (через launchdPlist набора)","Modify: package.json (agent:build, agent:install, agent:doctor, test:e2e:bridge), docs/runbooks/development.md, docs/runbooks/agent.md"],
 consumes="бандл из tools/build-agent.mjs; набор Fabric: writeDescriptor, launchdPlist, launchdInstall, launchdUninstall, pruneReleases",
 produces="`pnpm agent:install` → релиз в ~/.local/share/okolos-agent/releases/<версия>-<sha12>/, дескриптор, plist, загрузка, ожидание well-known; `--uninstall`, `--status`, `--dry-run`; `okolos-agent doctor --json`",
 tests=["dry-run печатает plist: RunAtLoad, KeepAlive, ThrottleInterval 10, ProcessType Standard, FABRIC_SERVICE_SUPERVISOR=launchd, абсолютный node, путь в релизе, ни одного секрета","tools/runbook.test.ts видит новые скрипты в раннбуке","фальшивый launchctl первым в PATH: install зовёт bootout, ждёт, bootstrap"],
 dod="vitest tools/install-agent.test.ts tools/runbook.test.ts зелёные"),
dict(n="N-017",title="e2e моста",deps=["N-011","N-015"],req=["REQ-58","REQ-61"],
 files=["Create: e2e/bridge/skeleton.spec.ts, e2e/bridge/scn-044.spec.ts, e2e/bridge/scn-045.spec.ts, playwright.bridge.config.ts"],
 consumes="собранный демон на временном каталоге данных и временном порту; Chrome stable",
 produces="`pnpm test:e2e:bridge`",
 tests=["skeleton: MCP-клиент → привязка через страницу → session.open → open → snapshot без скрытой инструкции → close","SCN-044: неверный код → отклонить; отзыв → следующий вызов not_paired, задача закрыта","SCN-045: страница показывает задачу агента и отказ origin_not_in_task"],
 dod="pnpm test:e2e:bridge зелёный; все процессы Chrome и демона закрыты после прогона"),
dict(n="N-018",title="ADR моста и снимка частями",deps=["N-011"],req=["REQ-67"],
 files=["Create: docs/adr/0020-bridge-is-part-of-okolos-agent.md, docs/adr/0021-agent-snapshot-in-pages-of-32-kb.md","Modify: docs/adr/0019-page-content-never-reaches-our-infrastructure.md (таблица «Чем держится»), docs/adr/0018-…md (строка о демоне)"],
 consumes="имена тестов N-006, N-008, N-011",produces="два ADR",
 tests=["tools/adr.test.ts: каждый названный файл существует"],dod="vitest tools/adr.test.ts зелёный"),
dict(n="N-019",title="Снять исключения reachable",deps=["N-011"],req=["REQ-68"],
 files=["Modify: tools/reachable.test.ts"],consumes="apps/agent как вызывающий core-snapshot и agent-probe",produces="—",
 tests=["tools/reachable.test.ts без строк «Okolos Bridge Б1»"],dod="vitest tools/reachable.test.ts зелёный"),
dict(n="N-020",title="Документы",deps=["N-016","N-017"],req=["REQ-69"],
 files=["Modify: AGENTS.md (Commands: MCP; Lifecycle: app.okolos.agent), docs/README.md (Статус, карта кода), docs/privacy.md (демон не выходит в сеть), docs/brand/facts.md, docs/backlog.md, docs/superpowers/backlog.md"],
 consumes="команды N-016, N-017",produces="доки в синхроне",
 tests=["tools/docs.test.ts, tools/runbook.test.ts зелёные"],dod="vitest зелёный; README «Статус» не утверждает ложного"),
dict(n="N-021",title="Регресс",deps=["N-019","N-020"],req=["REQ-70"],
 files=[],consumes="всё",produces="—",
 tests=["pnpm gates → 0","pnpm test:e2e → 0","tools/manifest.test.ts «the line between Okolos and Okolos Bridge» зелёный"],dod="три команды зелёные"),
]

import re
EDGEPAY={}
g=json.load(open(os.path.join(ROOT,'.task-pipeline/graph.json')))
for e in g['edges']: EDGEPAY[(e['from'],e['to'])]=e['payload']
def paths(files):
    out=[]
    for f in files:
        body=f.split(':',1)[1] if ':' in f else f
        for part in body.split(','):
            p=part.strip().split(' ')[0]
            if '/' in p or '.' in p:
                out.append(p)
    return out
def render():
    L=["# Okolos Bridge Б1: план реализации","",
"> **Исполнителю:** задачи идут по стадии 5 task-pipeline: изолированный worktree, тест первым, после каждой задачи ревью с тремя вердиктами (соответствие спеке, REQ выполнен, качество кода). Шаги отмечаются `- [ ]`.","",
"**Цель:** агент, привязанный человеком, через локальную дверь Okolos Agent читает страницу в своём фоновом окне очищенной и частями, и каждый ответ есть в журнале.","",
"**Архитектура:** демон на Node/TypeScript в `apps/agent`: служба `fabric-service/0.1` (Node-набор Fabric), дверь MCP на официальном SDK v2, окно агента через CDP по pipe (`packages/cdp-pipe`), снимок через `packages/core-snapshot` и пробник расширения. Страница демона в Fabric Dashboards: привязка и активность.","",
"**Стек:** TypeScript, Node ≥ 22, pnpm, vitest, Playwright; `@modelcontextprotocol/server` 2.4.0, `@modelcontextprotocol/node` 2.1.2, `zod` 4; Chrome stable.","",
"**Спека:** [2026-10-06-bridge-b1-design.md](../specs/2026-10-06-bridge-b1-design.md), [бриф](../specs/2026-10-27-bridge-b1-brief.md), [карта модулей](../specs/2026-10-27-bridge-b1-modules.md). Граф: `.task-pipeline/graph.json`, пакеты: `.task-pipeline/packets/`. Источник этого файла и пакетов один: `.task-pipeline/plan_src.py`.","",
"## Глобальные ограничения","",
"- Лицензия каждого нового `package.json`: `AGPL-3.0-only OR LicenseRef-PassionCode-Commercial` (`tools/licensing.test.ts`).",
"- Пакеты `core-*` не трогают браузерные API, сеть, часы и случайность (ESLint и `tools/gates/bundle-scan.test.ts`).",
"- Единственный выход в сеть: `@okolos/net`; демон в сеть не ходит (спека §3).",
"- Демон слушает только `127.0.0.1:47871`; `Host`, `Origin`, `Sec-Fetch-Site` проверяются на каждом пути (`fabric-service/0.1`).",
"- Ни один секрет (ключ агента, токен хоста, код входа) не попадает в argv, логи, журнал, URL.",
"- Каждый ответ агенту записан в журнал до отправки; сбой записи означает отказ `internal` (ADR-0019).",
"- Значения полей `password`, `cc-*`, OTP и фрагменты URL агенту не выдаются (спека §3).",
"- Тексты для людей: термины из `docs/brand/terminology.md`, без длинного тире, каждая новая строка через `copylot_check`.",
"- Изменение поведения обновляет `docs/ux/` в том же изменении; `python3 docs/ux/lint.py` → 0.","",
"## Порядок выполнения","",
"| Группа | Задачи | После | Carries |","|---|---|---|---|"]
    groups=[("A",["N-001","N-002","N-013"],[],"—"),("B",["N-003","N-005","N-009","N-010","N-012","N-014"],["A"],None),("B2",["N-006","N-007"],["B"],None),("C",["N-004","N-008","N-015"],["B2"],None),("D",["N-011"],["C"],None),("E",["N-016","N-017","N-018","N-019"],["D"],None),("F",["N-020"],["E"],None),("G",["N-021"],["F"],None)]
    T_by={t['n']:t for t in T}
    for gid,ids,after,c in groups:
        if c is None:
            car=[]
            for i in ids:
                for d in T_by[i]['deps']:
                    car.append(f"data: {d}→{i} {EDGEPAY[(d,i)]}")
            c='; '.join(car)
        L.append(f"| {gid} | {', '.join(ids)} | {', '.join(after) or '—'} | {c} |")
    L+=["","В группах A и B задачи пишут разные файлы (проверено `plan_audit.py`, коллизий 0).",""]
    for t in T:
        L+=[f"### Задача {t['n']}: {t['title']}","",f"**Depends:** {', '.join(t['deps']) or '—'}","",f"**Implements:** {', '.join(t['req'])}","","**Files:**"]
        L+=[f"- {f}" for f in t['files']] or ["- —"]
        L+=["","**Interfaces:**",f"- Consumes: {t['consumes']}",f"- Produces: {t['produces']}","",f"**Definition of done:** {t['dod']}",""]
        for k,x in enumerate(t['tests'],1):
            L.append(f"- [ ] **Тест {k} (пишется первым, наблюдается красным):** {x}")
        L+=[f"- [ ] **Реализация:** минимальный код, после которого тесты 1–{len(t['tests'])} зелёные",f"- [ ] **Проверка узла:** `{next(n['check'] for n in g['nodes'] if n['id']==t['n'])}`","- [ ] **Коммит:** `feat(bridge): …` с `Co-Authored-By`",""]
    return '\n'.join(L)
def packets():
    nodecheck={n['id']:n['check'] for n in g['nodes']}
    for t in T:
        p={"schema_version":"task-pipeline/execution-packet/1","node":t['n'],"intent":t['title'],
           "inputs":[t['consumes']]+[f"{d}: {EDGEPAY[(d,t['n'])]}" for d in t['deps']],
           "decision_refs":DEC,"source_scope":{"edit_targets":paths(t['files']) or ["(проверка без правок)"]},
           "outputs":[t['produces']],"acceptance":t['tests']+[f"проверка узла: {nodecheck[t['n']]}"],
           "guards":GUARDS_ALL,"resume":f"git log --oneline origin/main..bridge/b1-run2 -- {' '.join(paths(t['files'])[:3]) or '.'}; затем первый непройденный тест в списке acceptance"}
        json.dump(p,open(os.path.join(ROOT,'.task-pipeline/packets',t['n']+'.json'),'w'),ensure_ascii=False,indent=1)
if __name__=='__main__':
    open(os.path.join(ROOT,'docs/superpowers/plans/2026-10-27-bridge-b1.md'),'w').write(render())
    packets()
    ids=set(r for t in T for r in t['req']); brief=set(g['requirements'])
    print('implements==brief:', ids==brief, 'missing', sorted(brief-ids), 'extra', sorted(ids-brief))
