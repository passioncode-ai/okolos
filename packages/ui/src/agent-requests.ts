import { t } from '@okolos/i18n'

/**
 * Agents' requests to lift a gate, as the person answers them (B-218 wave (d), spec
 * `docs/superpowers/specs/2026-11-19-agent-door-wave-d.md`): one line each, built by the caller
 * from the agent's checked name, the gate in the catalogue's words and the host, never a word of
 * the agent's (WD-2), with «Разрешить» and «Отказать». The popup (SCR-02) and the block page
 * (SCR-05) draw the same thing.
 */
export interface AgentRequestLine {
  readonly id: string
  readonly line: string
}

export function renderAgentRequests(
  doc: Document,
  requests: readonly AgentRequestLine[],
  onRequest: (requestId: string, allow: boolean) => void,
): HTMLElement | null {
  if (requests.length === 0) return null
  const list = doc.createElement('section')
  list.setAttribute('data-role', 'agent-requests')
  for (const request of requests) {
    const item = doc.createElement('div')
    item.setAttribute('data-role', 'agent-request')
    item.setAttribute('data-request', request.id)
    item.append(
      text(doc, 'agent-request-line', request.line),
      text(doc, 'agent-request-note', t('agentRequestNote')),
      button(doc, 'agent-request-allow', t('agentRequestAllow'), () => onRequest(request.id, true)),
      button(doc, 'agent-request-decline', t('agentRequestDecline'), () => onRequest(request.id, false)),
    )
    list.append(item)
  }
  return list
}

function text(doc: Document, role: string, content: string): HTMLParagraphElement {
  const el = doc.createElement('p')
  el.setAttribute('data-role', role)
  el.textContent = content
  return el
}

function button(doc: Document, role: string, label: string, onClick: () => void): HTMLButtonElement {
  const el = doc.createElement('button')
  el.type = 'button'
  el.setAttribute('data-role', role)
  el.textContent = label
  el.addEventListener('click', onClick)
  return el
}
