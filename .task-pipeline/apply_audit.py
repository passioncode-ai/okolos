import json
P='.task-pipeline/plan_tasks.json'; T=json.load(open(P)); D={t['n']:t for t in T}
def add(n,key,items): D[n][key]=D[n][key]+items
def sub(n,key,old,new):
    v=D[n][key]
    if isinstance(v,str):
        assert old in v,(n,key,old[:40]); D[n][key]=v.replace(old,new); return
    for i,x in enumerate(v):
        if old in x: v[i]=x.replace(old,new); return
    raise AssertionError((n,key,old[:40]))
for t in T:
    if t['n'] in ('N-001','N-002'): continue
    for k in ('consumes','produces','dod'): t[k]=t[k].replace('из N-001','из N-023').replace('(N-001)','(N-023)')
    t['tests']=[x.replace('из N-001','из N-023') for x in t['tests']]
CHK={}
add('N-023','tests',["canonicalVerb(tool): BridgeVerb | BridgeSessionVerb | null экспортирован; неизвестное имя → null (аудит #19)","isLocalAddress(ip) нормализует сырой адрес (скобки, зона %en0, IPv4 в IPv6; пустая строка считается локальной, fail-closed) и делит правило с isLocalHost (аудит #27)"])
D['N-022']['files'].append("Modify: docs/runbooks/development.md (Node >=22.18, аудит #36)")
D['N-003']['deps']=['N-023','N-005']
D['N-003']['files']=["Create: packages/core-snapshot/src/verdict.ts","Modify: packages/core-snapshot/src/snapshot.ts, packages/core-snapshot/src/index.ts","Modify: packages/core-snapshot/package.json (зависимость @okolos/contracts), packages/core-snapshot/tsconfig.json (ссылка на contracts), pnpm-lock.yaml","Test: packages/core-snapshot/src/verdict.test.ts, packages/core-snapshot/src/corpus.test.ts, packages/core-snapshot/src/secrets.test.ts"]
add('N-003','tests',["снимок хранит refMap: ref (HMAC) → backendDOMNodeId; buildSnapshot принимает rootRef как ref и разрешает его через refMap снимка той же задачи (аудит #29)","новые символы импортируются из '@okolos/core-snapshot' (аудит #4)","pnpm install --frozen-lockfile → 0 (аудит #22)"])
CHK['N-003']="pnpm -s exec vitest run packages/core-snapshot && pnpm -s run typecheck"
D['N-004']['files']=["Create: packages/core-snapshot/src/pages.ts","Modify: packages/core-snapshot/src/index.ts","Test: packages/core-snapshot/src/pages.test.ts"]
add('N-004','tests',["paginate возвращает refs строк своей страницы и кладёт вердикт целого снимка в каждую страницу (аудит #29)"])
CHK['N-004']=CHK['N-003']
D['N-005']['files']=["Modify: apps/agent/package.json (зависимости @okolos/contracts, @okolos/cdp-pipe, @okolos/core-snapshot, @okolos/storage — workspace:*), pnpm-lock.yaml","Create: apps/agent/tsconfig.json, apps/agent/src/fabric/ (набор Fabric для Node), apps/agent/src/service/dirs.ts, apps/agent/src/service/http.ts, apps/agent/src/service/wellknown.ts, apps/agent/src/service/events.ts","Modify: tsconfig.json (ссылка на apps/agent), eslint.config.js (apps/agent/src/fabric/**), tools/i18n-sweep.mjs (ROOTS += apps/agent/src), tools/reachable.test.ts (строки исключений до N-011), packages/cdp-pipe/src/pipe.ts (пометки i18n-exempt)","Test: apps/agent/src/service/*.test.ts"]
D['N-005']['consumes']="Node-набор Fabric: holdSingleInstance, ensureToken, checkRequest, buildWellKnown, LoginCodes, makeEvent, eventsPage, Drain, RotatingLog; JsonlEventLog в Node-наборе нет, файл событий пишет service/events.ts (аудит #5)"
add('N-005','tests',["@okolos/contracts, cdp-pipe, core-snapshot, storage разрешаются из apps/agent (аудит #2, #3)","Set-Cookie от /fabric/v1/login: HttpOnly; SameSite=Strict; Path=/; функция проверки сессии экспортирована для N-015 (аудит #12)","pnpm lint, typecheck, i18n:sweep проходят с вендоренным набором и apps/agent/src в обходе (аудит #6, #33)"])
CHK['N-005']="pnpm -s exec vitest run apps/agent/src/service && pnpm -s run typecheck && pnpm -s run lint"
sub('N-006','produces',"`DoorRejection = 'bad_host'|'bad_origin'|'bad_content_type'|'bad_request'` для отказов двери до разбора","`DoorRejection = 'bad_host'|'bad_origin'|'bad_content_type'|'bad_request'`; JournalEntry — объединение по outcome: у 'rejected' нет agent и verb (аудит #38); verb: AnyBridgeVerb, канонический (аудит #19); `answerAfterRecord(journal, entry, send)` — единственная обёртка «запись до ответа», при сбое записи отправляет конверт отказа internal без содержимого страницы (аудит #18); RETENTION_DAYS_JOURNAL = 90, тест сверяет с RETENTION_DAYS.journal из @okolos/storage (аудит #30)")
CHK['N-006']="pnpm -s exec vitest run apps/agent/src/journal && pnpm -s run typecheck"
sub('N-007','produces',"list(now): {requests: PublicRequest[] /* без requestId, с handle для страницы */, agents} }`","list(now): {requests: PublicRequest[] /* без requestId, с handle для страницы */, agents}; confirmByHandle(handle, now); declineByHandle(handle) }`")
add('N-007','tests',["confirmByHandle и declineByHandle работают по handle из list(); requestId в роли handle отвергается (аудит #9)"])
CHK['N-007']="pnpm -s exec vitest run apps/agent/src/pairing && pnpm -s run typecheck"
D['N-008']['files']=["Create: apps/agent/src/door/door.ts, apps/agent/src/door/guard.ts, apps/agent/src/door/stdio-shim.ts, apps/agent/src/cli/pair.ts","Modify: apps/agent/package.json (зависимости @modelcontextprotocol/server, @modelcontextprotocol/node, zod), pnpm-lock.yaml","Test: apps/agent/src/door/door.test.ts, apps/agent/src/door/guard.test.ts, apps/agent/src/door/stdio-shim.test.ts, apps/agent/src/cli/pair.test.ts"]
sub('N-008','produces',"`doorRoute({pairing, journal, tools}): Route`","`doorRoute({pairing, journal, tools, onRevoke}): Route`; ключ агента в `X-Okolos-Agent-Key` (аудит #31); каждый ответ через answerAfterRecord из N-006 (аудит #18); onRevoke(agentId) зовётся при отзыве, подключает N-011 (аудит #13); шим и CLI говорят с дверью через node:http, не fetch (аудит #32); подкоманды pair и mcp-stdio экспортируются функциями, main.ts их подключает в N-011")
sub('N-008','tests',"журнал недоступен: каждый маршрут и вид ответа","журнал недоступен (ответ — конверт internal из answerAfterRecord, без содержимого; аудит #18): каждый маршрут и вид ответа")
sub('N-008','tests',"ключ отозван → 403 not_paired, задачи агента закрыты","ключ отозван → 403 not_paired и вызван onRevoke(agentId); закрытие задач и окон проверяет N-011")
CHK['N-008']="pnpm -s exec vitest run apps/agent/src/door apps/agent/src/cli && pnpm -s run typecheck"
sub('N-009','produces',"`Task {id, agentId, scope, openedAt, stepsUsed, windowId?}`","`Task {id, agentId, scope, openedAt, stepsUsed, windowId?}`; `checkLanded(task, actualUrl): BridgeResult<void>` (аудит #39); SessionOpenResult.sessionId = Task.id")
CHK['N-009']="pnpm -s exec vitest run apps/agent/src/tasks && pnpm -s run typecheck"
sub('N-010','produces',"openWindow(): Promise<{targetId, sessionId}> /* targetId и есть windowId в SessionOpenResult */;","openWindow(): Promise<{targetId, cdpSessionId}> /* targetId и есть windowId в SessionOpenResult; cdpSessionId агенту не уходит (аудит #28) */;")
sub('N-010','produces',"launch: (o) => Promise<CdpTransport> = CdpPipe.launch});","launch: (o) => Promise<CdpTransport> = CdpPipe.launch, extraArgs?: readonly string[] /* для тестов: --host-resolver-rules; --enable-automation и --remote-debugging-port отвергаются (аудит #21) */});")
add('N-010','tests',["extraArgs с --enable-automation или --remote-debugging-port → ошибка конструктора; --host-resolver-rules проходит (аудит #21)"])
CHK['N-010']="pnpm -s exec vitest run apps/agent/src/window && pnpm -s run typecheck"
D['N-011']['deps']=['N-004','N-006','N-008','N-009','N-010','N-012']
D['N-011']['files']=["Create: apps/agent/src/agent.ts (createAgent), apps/agent/src/main.ts (команды serve, pair, mcp-stdio), apps/agent/src/verbs/verbs.ts, apps/agent/src/verbs/probe.ts, tools/build-agent.mjs (бандл демона и пробника, вместе с apps/agent/src/fabric)","Modify: apps/agent/package.json (bin okolos-agent → ./src/main.ts), tools/imports.mjs (бандл агента как точка входа)","Test: apps/agent/src/agent.test.ts, apps/agent/src/verbs/verbs.test.ts, apps/agent/src/verbs/skeleton.chrome.test.ts"]
D['N-011']['consumes']="Tasks и checkLanded (N-009), AgentWindows (N-010), Journal и answerAfterRecord (N-006), doorRoute, pair, mcp-stdio (N-008), buildSnapshot, snapshotVerdict, paginate (N-003, N-004), census и readCensus (N-012), VerbIO, toolName, canonicalVerb, isLocalAddress, toSnapshotFinding (N-023), service из N-005 (capStdoutLog, buildIdentity с корнем релиза), runProbe (бандл apps/extension/src/agent-probe.ts)"
D['N-011']['produces']="`createAgent({dataDir, port, allowLoopbackForTests?, extraChromeArgs?, routes?}): Promise<Agent>` в src/agent.ts: служба, дверь, задачи, окна, журнал, перепись; onRevoke(agentId) закрывает задачи агента и их окна (аудит #13); таймер Journal.sweep раз в сутки (аудит #30); main.ts: serve → createAgent, pair, mcp-stdio; инструменты MCP под toolName: session_open, open, snapshot, read, get, waitFor, close, hygiene_census; схемы zod типа z.ZodType<VerbIO[V]['input']> (аудит #26); журнал хранит canonicalVerb (аудит #19); SessionOpenResult.sessionId = Task.id, cdpSessionId не уходит агенту (аудит #28); находки только через toSnapshotFinding"
add('N-011','tests',["remoteIPAddress пуст или отсутствует: snapshot и read отказывают cleaning_incomplete (аудит #27)","отзыв доступа закрывает задачи агента и их окна: окна с targetId задачи больше нет (аудит #13)","журнал несёт глагол в каноническом виде (session.open), инструмент зовётся session_open (аудит #19)","бандл несёт apps/agent/src/fabric (.mjs набор не копирует tsc)"])
CHK['N-011']="pnpm -s exec vitest run apps/agent/src/agent.test.ts apps/agent/src/verbs && pnpm -s run typecheck"
CHK['N-012']="pnpm -s exec vitest run apps/agent/src/hygiene && pnpm -s run typecheck"
sub('N-014','produces',"47 ключей строк","строки страницы; число ключей меряется командой по каталогу ru (аудит #34)")
add('N-014','tests',["ключи taskProfileAgent и taskProfileDisposable в обоих каталогах, copylot_check (аудит #20)","решить, идут ли через каталог тексты службы N-005 (занятый замок, события, 503): человек читает события в Fabric Dashboards"])
D['N-015']['deps']=['N-006','N-007','N-009','N-011','N-013','N-014']
D['N-015']['files']=["Create: apps/agent/src/dashboard/page.ts, apps/agent/src/dashboard/api.ts, apps/agent/src/dashboard/actions.ts, apps/agent/static/ (набор дашборда Fabric)","Modify: apps/agent/src/agent.ts (монтирует маршруты страницы и инструменты pairing.confirm, pairing.decline, agent.revoke; аудит #10, #11), docs/ux/screens.md, docs/ux/scenarios.md, docs/ux/flows.md (SCR-24 показывает профиль, SCN-045 и FLW-22 называют цель; аудит #20)","Test: apps/agent/src/dashboard/page.test.ts, apps/agent/src/dashboard/api.test.ts, apps/agent/src/dashboard/actions.test.ts"]
D['N-015']['consumes']="Pairing.list/confirmByHandle/declineByHandle/revoke (N-007), Tasks.list (N-009), Journal.recent (N-006), проверка сессии из N-005, createAgent (N-011), refusalKey (N-023), каталоги строк"
sub('N-015','tests',"Set-Cookie от /fabric/v1/login несёт HttpOnly и SameSite=Strict (ревью R8)","страница принимает только сессию, выданную N-005; атрибуты куки проверяет N-005 (аудит #12)")
add('N-015','tests',["GET /api/journal выгружает журнал агентов (JSONL, без содержимого страниц) для [data-role=agent-journal-link] (аудит #40)"])
CHK['N-015']="pnpm -s exec vitest run apps/agent/src/dashboard && pnpm -s run typecheck"
D['N-016']['files']=["Create: tools/install-agent.mjs, tools/install-agent.test.ts","Modify: apps/agent/src/main.ts (команда doctor --json), package.json (agent:build, agent:install, agent:doctor), docs/runbooks/development.md, docs/runbooks/agent.md"]
add('N-016','tests',["релиз содержит бандл, apps/agent/src/fabric и apps/agent/static (аудит #37)","install пишет plist через launchdPlist набора и зовёт capStdoutLog при старте"])
D['N-017']['deps']=['N-015','N-016']
D['N-017']['files']=["Create: e2e/bridge/skeleton.spec.ts, e2e/bridge/scn-044.spec.ts, e2e/bridge/scn-045.spec.ts, playwright.bridge.config.ts","Modify: package.json (test:e2e:bridge, аудит #14), playwright.config.ts (testIgnore bridge/**, аудит #15), docs/runbooks/development.md"]
sub('N-017','consumes',"собранный демон, запущенный в процессе теста через экспорт createAgent({dataDir, port, allowLoopbackForTests: true}) из бандла, а не через CLI и не через переменную окружения","демон в процессе теста через createAgent({dataDir, port, allowLoopbackForTests: true, extraChromeArgs}) импортом из apps/agent/src/agent.ts (типы есть, аудит #35), не через CLI и не через переменную окружения; ключ в X-Okolos-Agent-Key (аудит #31)")
add('N-017','tests',["playwright test --list основного конфига не показывает e2e/bridge (аудит #15)"])
D['N-018']['files']=["Create: docs/adr/0020-bridge-is-part-of-okolos-agent.md, docs/adr/0021-agent-snapshot-in-pages-of-32-kb.md","Modify: docs/adr/README.md, docs/adr/0019-page-content-never-reaches-our-infrastructure.md, docs/adr/0018-agents-get-their-own-extension.md"]
sub('N-019','tests',"tools/reachable.test.ts без строк «Okolos Bridge Б1»","tools/reachable.test.ts без строк исключений моста (их добавили N-002, N-005 и другие)")
D['N-016']['deps']=['N-011','N-012','N-015']
json.dump(T,open(P,'w'),ensure_ascii=False,indent=1)
json.dump(CHK,open('.task-pipeline/plan_checks.json','w'),ensure_ascii=False,indent=1)
print('applied')
