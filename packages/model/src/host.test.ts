import { describe, expect, it, vi } from 'vitest'
import { createInferenceHost, type InferenceDeps } from './host.js'
import type { InferenceRuntime } from './session.js'

const WEIGHTS = new Uint8Array([1, 2, 3]).buffer

const workingRuntime: InferenceRuntime = {
  create: async () => ({ run: async () => 0.9 }),
}

function deps(overrides: Partial<InferenceDeps> = {}): InferenceDeps {
  return {
    ensureHost: async () => 'background',
    weights: async () => WEIGHTS,
    runtime: () => workingRuntime,
    ...overrides,
  }
}

describe('nothing scores until everything is in place', () => {
  it('is unavailable before it has been prepared', () => {
    const host = createInferenceHost(deps())
    expect(host.available()).toBe(false)
    expect(host.status()).toBe('not-prepared')
  })

  it('is unavailable when the browser has nowhere to run a model', async () => {
    const host = createInferenceHost(deps({ ensureHost: async () => 'none' }))
    await host.prepare()
    expect(host.status()).toBe('no-host')
    expect(host.available()).toBe(false)
  })

  it('is unavailable when the user has not agreed to fetch the weights', async () => {
    const host = createInferenceHost(deps({ weights: async () => null }))
    await host.prepare()
    expect(host.status()).toBe('no-weights')
  })

  it('is unavailable while no runtime is bundled', async () => {
    // The honest state of this product today: the classifier's weights carry a
    // licence question, so no runtime ships and stage 3 simply never fires.
    const host = createInferenceHost(deps({ runtime: () => null }))
    await host.prepare()
    expect(host.status()).toBe('no-runtime')
  })

  it('is unavailable when every backend refuses to start', async () => {
    const host = createInferenceHost(
      deps({
        runtime: () => ({
          create: async () => {
            throw new Error('no gpu, no wasm')
          },
        }),
      }),
    )
    await host.prepare()
    expect(host.status()).toBe('no-backend')
    expect(host.available()).toBe(false)
  })

  it('refuses to score when it was never prepared', async () => {
    await expect(createInferenceHost(deps()).score('text')).rejects.toThrow(/not prepared/)
  })
})

describe('running the model where the browser allows it', () => {
  it('runs in the background page when there is one', async () => {
    const host = createInferenceHost(deps())
    await host.prepare()
    expect(host.available()).toBe(true)
    await expect(host.score('text')).resolves.toBeCloseTo(0.9)
  })

  it('asks the offscreen document when the worker cannot run it itself', async () => {
    const remoteScore = vi.fn(async () => 0.42)
    const runtime = vi.fn(() => workingRuntime)
    const host = createInferenceHost(
      deps({ ensureHost: async () => 'offscreen', remoteScore, runtime }),
    )
    await host.prepare()

    await expect(host.score('text')).resolves.toBeCloseTo(0.42)
    // The worker never loads weights it cannot use.
    expect(runtime).not.toHaveBeenCalled()
  })

  it('is unavailable when there is an offscreen host but no way to reach it', async () => {
    const host = createInferenceHost(deps({ ensureHost: async () => 'offscreen' }))
    await host.prepare()
    expect(host.status()).toBe('no-host')
  })

  it('treats "no model there" as a failure, not as a score of zero', async () => {
    const host = createInferenceHost(
      deps({ ensureHost: async () => 'offscreen', remoteScore: async () => null }),
    )
    await host.prepare()
    await expect(host.score('text')).rejects.toThrow(/no model/)
  })
})

describe('preparing is done once', () => {
  it('opens a single session however many pages are scored', async () => {
    const create = vi.fn(async () => ({ run: async () => 0.5 }))
    const host = createInferenceHost(deps({ runtime: () => ({ create }) }))
    await host.prepare()
    await host.score('a')
    await host.score('b')
    expect(create).toHaveBeenCalledTimes(1)
  })
})
