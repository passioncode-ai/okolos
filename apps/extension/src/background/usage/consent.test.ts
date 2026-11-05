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

    let held = ['technicalAndInteraction']
    const remove = vi.fn(async () => {
      held = []
      return true
    })
    expect(await switchConsent('firefox', { getAll: async () => ({ data_collection: held }), remove }, false)).toBe('off')
    expect(remove).toHaveBeenCalledWith(DATA)
  })

  it('asks Firefox inside the click: the request goes before anything is awaited', () => {
    // Firefox honours permissions.request only while the click is being handled; an await
    // before it (here a getAll that never answers) would give that moment away.
    const request = vi.fn(async () => true)
    void switchConsent('firefox', { getAll: () => new Promise(() => {}), request }, true)
    expect(request).toHaveBeenCalledWith(DATA)
  })

  it('does not say off while Firefox still grants it: a removal that did not take is a failure', async () => {
    const granted = { getAll: async () => ({ data_collection: ['technicalAndInteraction'] }) }
    expect(await switchConsent('firefox', { ...granted, remove: async () => false }, false)).toBe('on')
    expect(
      await switchConsent(
        'firefox',
        {
          ...granted,
          remove: async () => {
            throw new Error('nope')
          },
        },
        false,
      ),
    ).toBe('on')
  })

  it('does not say off when the grant cannot be read back after the removal', async () => {
    let reads = 0
    const getAll = async () => {
      reads += 1
      if (reads === 1) return { data_collection: ['technicalAndInteraction'] }
      throw new Error('gone')
    }
    expect(await switchConsent('firefox', { getAll, remove: async () => true }, false)).not.toBe('off')
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
