import { describe, expect, it } from 'vitest'

import { CdpError } from './errors.js'

describe('CdpError', () => {
  it('is an Error that carries the kind and the method, so a caller maps it without reading the text', () => {
    const error = new CdpError('timeout', 'Page.navigate', 'no answer within 300 ms')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('CdpError')
    expect(error.kind).toBe('timeout')
    expect(error.method).toBe('Page.navigate')
    expect(error.cdpCode).toBeUndefined()
    expect(error.message).toBe('Page.navigate: no answer within 300 ms')
  })

  it('has a kind for a browser that could not be started', () => {
    const error = new CdpError('launch', 'launch', 'cannot start /no/such/browser: spawn ENOENT')
    expect(error.kind).toBe('launch')
    expect(error.message).toBe('launch: cannot start /no/such/browser: spawn ENOENT')
  })

  it('carries the CDP error code when the browser answered with an error', () => {
    const error = new CdpError('cdp', 'Target.attachToTarget', 'No target with given id found', -32000)
    expect(error.kind).toBe('cdp')
    expect(error.cdpCode).toBe(-32000)
    expect(error.message).toBe('Target.attachToTarget: No target with given id found')
  })
})
