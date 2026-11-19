/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { fromCatalogue, useResolver, type Catalogue } from '@okolos/i18n'
import { describe, expect, it, vi } from 'vitest'

import { renderAgentRequests } from './agent-requests.js'

const CATALOGUE = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../../apps/extension/_locales/ru/messages.json'), 'utf8'),
) as Catalogue
useResolver(fromCatalogue(CATALOGUE))

describe('agents\' requests to lift a gate (B-218 wave (d))', () => {
  it('draws nothing when none waits', () => {
    expect(renderAgentRequests(document, [], vi.fn())).toBeNull()
  })

  it('draws the caller\'s line, the note and the two answers, each telling which request', () => {
    const onRequest = vi.fn()
    const el = renderAgentRequests(document, [{ id: 'r1', line: 'Агент scout просит снять блокировку для phish.example' }], onRequest) as HTMLElement
    expect(el.querySelector('[data-role=agent-request-line]')?.textContent).toBe('Агент scout просит снять блокировку для phish.example')
    expect(el.querySelector('[data-role=agent-request-note]')?.textContent).toBe(CATALOGUE['agentRequestNote']?.message)
    expect(el.querySelector('[data-role=agent-request-allow]')?.textContent).toBe(CATALOGUE['agentRequestAllow']?.message)
    ;(el.querySelector('[data-role=agent-request-decline]') as HTMLButtonElement).click()
    expect(onRequest).toHaveBeenCalledWith('r1', false)
  })
})
