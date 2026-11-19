// The page of Okolos Agent (SCR-23, SCR-24). Every string comes from /api/state, which the
// daemon builds from its catalogue in the person's language; this script places them with
// textContent and never writes a sentence of its own. CSP: scripts from this page only.
/* global document, fetch, setInterval */
'use strict'

const POLL_MS = 2000
let strings = {}

const $ = (role, root = document) => root.querySelector(`[data-role="${role}"]`)

function el(tag, role, text) {
  const node = document.createElement(tag)
  if (role) node.dataset.role = role
  if (text !== undefined) node.textContent = text
  return node
}

function show(node, text) {
  node.hidden = text === null || text === undefined || text === ''
  node.textContent = node.hidden ? '' : text
}

function problem(key) {
  const main = $('agent-page')
  main.dataset.state = key === 'pageSessionExpired' ? 'session-expired' : 'stopping'
  $('page-loading').hidden = true
  $('pairing').hidden = true
  $('okolos-link').hidden = true
  $('activity').hidden = true
  // The two sentences come with every state answer; before the first one, the loading line stays.
  show($('page-problem'), strings[key] ?? $('page-loading').textContent)
}

async function post(path, notice = 'pairing-notice') {
  const res = await fetch(path, { method: 'POST', headers: { 'X-Okolos-Request': '1' }, credentials: 'same-origin' })
  if (res.status === 401) return problem('pageSessionExpired')
  if (res.status === 503) return problem('pageStopping')
  const body = await res.json().catch(() => ({}))
  show($(notice), body.notice ?? null)
  await refresh()
}

function renderPairing(view) {
  const section = $('pairing')
  section.hidden = false
  section.dataset.state = view.state
  $('pairing-heading').textContent = strings.pairingHeading
  $('paired-heading').textContent = strings.pairedHeading
  $('pairing-how').textContent = strings.pairingHow
  show($('pairing-error'), view.state === 'error' ? view.error : null)
  show($('pairing-unwritable'), view.unwritable ?? null)
  show($('pairing-empty'), view.state === 'empty' ? strings.pairingEmpty : null)
  const requests = $('pairing-requests')
  requests.replaceChildren(
    ...(view.requests ?? []).map((row) => {
      const li = el('li', 'pairing-request')
      li.dataset.state = row.state
      li.append(el('p', 'pairing-agent', row.agent), el('p', 'pairing-code', row.code), el('p', 'pairing-asked', row.asked))
      if (row.duplicate) li.append(el('p', 'pairing-duplicate', row.duplicate))
      if (row.lookalike) {
        const box = el('div', 'pairing-lookalike')
        box.append(el('p', null, row.lookalike.line))
        const list = el('ul')
        for (const agent of row.lookalike.agents) list.append(el('li', 'pairing-lookalike-agent', agent))
        box.append(list)
        li.append(box)
      }
      if (row.status) {
        li.append(el('p', 'pairing-status', row.status))
      } else {
        li.append(el('p', 'pairing-compare', strings.pairingCompare), el('p', 'pairing-grants', strings.pairingGrants))
        const confirm = el('button', 'pairing-confirm', strings.pairingConfirm)
        const decline = el('button', 'pairing-decline', strings.pairingDecline)
        confirm.addEventListener('click', () => post(`/api/pairing/${encodeURIComponent(row.handle)}/confirm`))
        decline.addEventListener('click', () => post(`/api/pairing/${encodeURIComponent(row.handle)}/decline`))
        li.append(confirm, decline)
      }
      return li
    }),
  )
  $('paired-agents').replaceChildren(
    ...(view.agents ?? []).map((agent) => {
      const li = el('li', 'paired-agent')
      li.append(el('p', 'paired-agent-name', agent.name), el('p', 'paired-since', agent.since), el('p', 'paired-tasks', agent.tasks))
      const revoke = el('button', 'agent-revoke', strings.agentRevoke)
      revoke.addEventListener('click', () => post(`/api/agents/${encodeURIComponent(agent.agentId)}/revoke`))
      li.append(revoke)
      return li
    }),
  )
}

// The Okolos extension's link (B-218): the page shows the code; the person types it into Okolos.
function renderOkolos(view) {
  const section = $('okolos-link')
  section.hidden = false
  section.dataset.state = view.state
  $('okolos-heading').textContent = strings.okolosHeading
  $('okolos-line').textContent = view.line
  show($('okolos-code'), view.code)
  const connect = $('okolos-connect')
  connect.hidden = view.state === 'paired'
  connect.textContent = strings.okolosConnect
  const disconnect = $('okolos-disconnect')
  disconnect.hidden = view.state !== 'paired'
  disconnect.textContent = strings.okolosDisconnect
  // «Disconnected» stays until the person acts again; a new link makes it stale.
  if (view.state === 'paired') show($('okolos-notice'), null)
}

function renderActivity(view) {
  const section = $('activity')
  section.hidden = false
  section.dataset.state = view.state
  $('tasks-heading').textContent = strings.tasksHeading
  $('refusals-heading').textContent = strings.refusalsHeading
  show($('tasks-empty'), view.tasks.length === 0 ? strings.tasksEmpty : null)
  $('agent-tasks').replaceChildren(
    ...view.tasks.map((task) => {
      const li = el('li', 'agent-task')
      for (const field of ['agent', 'profile', 'goal', 'sites', 'time', 'steps', 'window']) li.append(el('p', `task-${field}`, task[field]))
      return li
    }),
  )
  show($('journal-error'), view.journalError)
  $('agent-journal-notes').replaceChildren(...view.notes.map((note) => el('li', 'agent-journal-note', note)))
  const nothing = view.state !== 'journal-unreadable' && view.notes.length === 0 && view.refusals.length === 0 && view.door.length === 0
  show($('refusals-empty'), nothing ? strings.refusalsEmpty : null)
  $('agent-refusals').replaceChildren(...view.refusals.map((line) => el('li', 'agent-refusal', line)))
  $('door-refusals').replaceChildren(...view.door.map((line) => el('li', 'door-refusal', line)))
  const link = $('agent-journal-link')
  link.hidden = view.state === 'journal-unreadable'
  link.textContent = strings.journalLink
}

async function refresh() {
  let res
  try {
    res = await fetch('/api/state', { credentials: 'same-origin' })
  } catch {
    return problem('pageStopping')
  }
  if (res.status === 401) return problem('pageSessionExpired')
  if (res.status === 503) return problem('pageStopping')
  const view = await res.json()
  strings = view.strings
  const main = $('agent-page')
  main.dataset.state = 'success'
  $('page-loading').hidden = true
  $('page-problem').hidden = true
  renderPairing(view.pairing)
  renderOkolos(view.okolos)
  renderActivity(view.activity)
}

document.addEventListener('DOMContentLoaded', () => {
  $('okolos-connect').addEventListener('click', () => {
    show($('okolos-notice'), null)
    void post('/api/extension/code', 'okolos-notice')
  })
  $('okolos-disconnect').addEventListener('click', () => void post('/api/extension/release', 'okolos-notice'))
  void refresh()
  setInterval(() => void refresh(), POLL_MS)
})
