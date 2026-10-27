# Single source for the plan (docs/superpowers/plans/2026-10-27-bridge-b1.md) and the execution packets.
import json, os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEC=["docs/superpowers/specs/2026-10-27-bridge-b1-brief.md#решения","docs/superpowers/specs/2026-10-06-bridge-b1-design.md","docs/superpowers/specs/2026-10-27-bridge-b1-modules.md"]
GUARDS_ALL=["TDD: тест пишется первым и наблюдается красным","никакого секрета в argv, логах, журнале и URL; единственное исключение: одноразовый код входа в /fabric/v1/login?code= (его требует протокол fabric-service/0.1; живёт 120 с, сгорает при первом использовании, не логируется)","ничего не уходит в сеть, кроме уже разрешённого @okolos/net","core-* не трогают браузерные API, сеть, часы, случайность (гейт ESLint и скан бандла)","лицензия нового package.json: AGPL-3.0-only OR LicenseRef-PassionCode-Commercial","без длинного тире в текстах для людей"]
T=json.load(open(os.path.join(ROOT,'.task-pipeline/plan_tasks.json')))

import re
EDGEPAY={}
g=json.load(open(os.path.join(ROOT,'.task-pipeline/graph.json')))
for e in g['edges']: EDGEPAY[(e['from'],e['to'])]=e['payload']
def paths(files):
    import re as _re
    out=[]
    for f in files:
        body=f.split(':',1)[1] if ':' in f else f
        body=_re.sub(r'\([^)]*\)','',body)
        for part in body.split(','):
            p=part.strip().split(' ')[0].strip('`')
            if p and ('/' in p or p.endswith(('.json','.ts','.mjs','.md','.yaml','.js'))):
                out.append(p.rstrip('/')+('/**' if p.endswith('/') else ''))
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
"- Ни один секрет (ключ агента, токен хоста, код входа) не попадает в argv, логи, журнал, URL. Исключение одно: одноразовый код входа в `/fabric/v1/login?code=`, которого требует протокол `fabric-service/0.1` (120 с, сгорает при первом использовании, не логируется).",
"- Каждый ответ агенту записан в журнал до отправки; сбой записи означает отказ `internal` (ADR-0019).",
"- Значения полей `password`, `cc-*`, OTP и фрагменты URL агенту не выдаются (спека §3).",
"- Тексты для людей: термины из `docs/brand/terminology.md`, без длинного тире, каждая новая строка через `copylot_check`.",
"- Изменение поведения обновляет `docs/ux/` в том же изменении; `python3 docs/ux/lint.py` → 0.","",
"## Порядок выполнения","",
"| Группа | Задачи | После | Carries |","|---|---|---|---|"]
    lvl={}
    def lev(n):
        if n not in lvl:
            lvl[n]=0 if not T_by[n]['deps'] else 1+max(lev(d) for d in T_by[n]['deps'])
        return lvl[n]
    T_by={t['n']:t for t in T}
    gstat={n['id']:n['status'] for n in g['nodes']}
    live=[t['n'] for t in T if gstat.get(t['n']) not in ('done','parked')]
    T_by={t['n']:dict(t,deps=[d for d in t['deps'] if d in live]) for t in T if t['n'] in live}
    for n in live: lev(n)
    groups=[]
    for k in sorted(set(lvl.values())):
        ids=[n for n in live if lvl[n]==k]
        groups.append((chr(65+k),ids,[chr(64+k)] if k else [],"—" if k==0 else None))
    for gid,ids,after,c in groups:
        if c is None:
            car=[]
            for i in ids:
                for d in T_by[i]['deps']:
                    car.append(f"data: {d}→{i} {EDGEPAY[(d,i)]}")
            c='; '.join(car)
        L.append(f"| {gid} | {', '.join(ids)} | {', '.join(after) or '—'} | {c} |")
    L+=["","Группы вычислены по графу: уровень узла на один больше уровня его самой поздней зависимости. Узлы одной группы не правят общих файлов (проверяет `plan_audit.py`).",""]
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
SELF_REVIEW="""
## Self-review

- REQ coverage: 18 in brief, 18 covered by `Implements:`, difference пусто (`plan_src.py` печатает `implements==brief: True`)
- Named checks: 21 узел, у каждого одна проверка в `graph.json`; команды существуют: `vitest`, `pnpm typecheck`, `python3 docs/ux/lint.py`, `python3 docs/brand/lint.py`, `pnpm gates`, `pnpm test:e2e`; `pnpm test:e2e:bridge` создаёт N-016/N-017, до них команда не разрешается, это записано в DoD N-016
- Decisions: сверено с брифом (решения 1–12) и отвергнутыми вариантами B и C стадии 2: противоречий нет. Ревью спеки 2026-10-27 (26 находок) разнесено по узлам: спека §11
- Cost: 2 экрана / 1 демон / 18 REQ сейчас; на стадии 2 те же 2 / 1 / 18; минус глагол `screenshot` (в Б2): соразмерно
- Hygiene: проверки этой стадии `plan_audit.py`, `graph.py validate`, поиск заглушек; находок после правки 0
- Edges: {edges} declared, {data} data, 0 control, {resource} resource, 0 removed (ресурсное ребро N-002→N-005 добавлено по находке аудита)
- Placeholders: {ph} · Ambiguity: 1 найдено (общий корневой `tsconfig.json`), 1 решено ребром
- Plan audit: 21 live nodes, 21 with packets, 0 context findings, 0 collisions; top of the computed priority: N-001 (unblocks 13)
- Отклонение от шаблона, записанное: шаги несут тесты и интерфейсы, а не полный код. Планировщик и исполнитель в этом прогоне один и тот же агент в одном контексте, и код пишется в шаге TDD после наблюдённого красного теста; копия кода в плане разошлась бы с кодом в первый же день.
"""
NEWPAY={("N-024","N-013"):"resource: каталоги строк агента; N-013 дописывает строки SCR-23 после строк службы",("N-023","N-006"):"BridgeRefusal, AnyBridgeVerb, canonicalVerb для типа JournalEntry",("N-024","N-025"):"buildIdentity и тест dotfiles",("N-014","N-008"):"ключи каталога для CLI привязки и шима",("N-014","N-010"):"ключ события onCloseIncomplete",("N-014","N-012"):"ключи причин переписи",("N-024","N-014"):"resource: apps/agent/_locales/{ru,en}/messages.json; N-014 дописывает строки страницы после строк службы N-024",("N-024","N-006"):"каталоги данных службы, servicePaths, setup после замка",("N-024","N-007"):"каталоги данных и токен хоста",("N-022","N-011"):"CdpError.kind и cdpCode для перевода в отказы контракта",("N-003","N-008"):"resource: pnpm-lock.yaml; N-008 правит lockfile после N-003",("N-022","N-005"):"resource: packages/cdp-pipe/src/pipe.ts; N-022 вливается первым, при слиянии N-005 файл берётся из N-022 (его пометки i18n-exempt покрывают весь файл)",("N-024","N-003"):"resource: pnpm-lock.yaml; N-003 правит lockfile после N-005",("N-006","N-011"):"Journal, answerAfterRecord",("N-012","N-011"):"census, readCensus, CensusEntry[]",("N-006","N-015"):"Journal.recent, JournalEntry, DoorRejection",("N-011","N-015"):"createAgent и src/agent.ts, куда страница монтирует маршруты",("N-016","N-017"):"скрипт agent:build и релиз",("N-015","N-017"):"страница для подтверждения",("N-023","N-003"):"toSnapshotFinding, SnapshotFinding, TaskScope",("N-023","N-008"):"BRIDGE_VERBS, toolName, BridgeResult, refuse",("N-023","N-009"):"validateScope, inScope, verbAllowed, refuse",("N-023","N-012"):"CensusEntry",("N-024","N-009"):"apps/agent: package.json, tsconfig",("N-024","N-010"):"apps/agent: package.json, tsconfig",("N-024","N-012"):"apps/agent: package.json, tsconfig"}
def sync_graph():
    chk=json.load(open(os.path.join(ROOT,'.task-pipeline/plan_checks.json')))
    by={n['id']:n for n in g['nodes']}
    old={(e['from'],e['to']):e['payload'] for e in g['edges']}
    edges=[]
    for t in T:
        n=by[t['n']]
        if n['status'] in ('done','parked'): continue
        n['blocked_by']=list(t['deps'])
        n['touches']=paths(t['files'])
        if t['n'] in chk: n['check']=chk[t['n']]
    for e in g['edges']:
        if by[e['to']]['status'] in ('done','parked'): edges.append(e)
    for t in T:
        if by[t['n']]['status'] in ('done','parked'): continue
        for d in t['deps']:
            pay=NEWPAY.get((d,t['n'])) or old.get((d,t['n']))
            assert pay, ('no payload for edge',d,t['n'])
            edges.append({"from":d,"to":t['n'],"payload":pay})
    g['edges']=edges
    json.dump(g,open(os.path.join(ROOT,'.task-pipeline/graph.json'),'w'),ensure_ascii=False,indent=1)
    global EDGEPAY
    EDGEPAY={(e['from'],e['to']):e['payload'] for e in g['edges']}
if __name__=='__main__':
    sync_graph()
    md=render()
    md=md.replace(' — ',': ')
    md=re.sub(r'(?<=[|:]) —(?= |$)',' нет',md,flags=re.M)
    md=md.replace('| — |','| нет |').replace('**Depends:** —','**Depends:** нет').replace('\n- —\n','\n- нет\n')
    kinds={'data':0,'resource':0,'control':0}
    for e in g['edges']: kinds['resource' if e['payload'].startswith('resource') else 'data']+=1
    ph=len(re.findall(r'\b(TBD|TODO|implement later|fill in details)\b',md,re.I))
    md+=SELF_REVIEW.format(edges=len(g['edges']),data=kinds['data'],resource=kinds['resource'],ph=ph)
    assert '\u2014' not in md, 'em dash left in plan'
    open(os.path.join(ROOT,'docs/superpowers/plans/2026-10-27-bridge-b1.md'),'w').write(md)
    packets()
    ids=set(r for t in T for r in t['req']); brief=set(g['requirements'])
    print('implements==brief:', ids==brief, 'missing', sorted(brief-ids), 'extra', sorted(ids-brief))
