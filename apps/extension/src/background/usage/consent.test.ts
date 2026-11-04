import { describe, expect, it, vi } from 'vitest'

import { browserConsent, switchConsent } from './consent.js'

const DATA = { data_collection: ['technicalAndInteraction'] }

describe('Chrome and Edge', () => {
  it('start on: the first run says so, and settings switch it off', async () => {
    expect(await browserConsent('chrome', {})).toBe('on')
    expect(await switchConsent('chrome', {}, false)).toBe('off')
    expect(await switchConsent('chrome', {}, true)).toBe('on')
  })
})

describe('Firefox 140 and later, where the browser asks at install', () => {
  it('is on only while Firefox grants technical and interaction data', async () => {
    expect(await browserConsent('firefox', { getAll: async () => ({ data_collection: ['technicalAndInteraction'] }) })).toBe('on')
    expect(await browserConsent('firefox', { getAll: async () => ({ data_collection: [] }) })).toBe('off')
  })

  it('asks Firefox from the switch, and follows its answer both ways', async () => {
    const request = vi.fn(async () => false)
    expect(await switchConsent('firefox', { getAll: async () => ({ data_collection: [] }), request }, true)).toBe('off')
    expect(request).toHaveBeenCalledWith(DATA)

    const granted = vi.fn(async () => true)
    expect(await switchConsent('firefox', { getAll: async () => ({ data_collection: [] }), request: granted }, true)).toBe('on')

    const remove = vi.fn(async () => true)
    expect(await switchConsent('firefox', { getAll: async () => ({ data_collection: ['technicalAndInteraction'] }), remove }, false)).toBe('off')
    expect(remove).toHaveBeenCalledWith(DATA)
  })

  it('counts a refused or failed request as off', async () => {
    const request = vi.fn(async () => {
      throw new Error('permissions.request may only be called from a user input handler')
    })
    expect(await switchConsent('firefox', { getAll: async () => ({ data_collection: [] }), request }, true)).toBe('off')
  })
})

describe('Firefox 129 to 139, with no built-in consent', () => {
  it('sends nothing: there is no consent to read, so the switch cannot turn it on', async () => {
    expect(await browserConsent('firefox', { getAll: async () => ({ permissions: [], origins: [] }) })).toBe('unsupported')
    expect(await browserConsent('firefox', {})).toBe('unsupported')
    expect(await switchConsent('firefox', { getAll: async () => ({}) }, true)).toBe('unsupported')
  })
})
