import { describe, expect, it } from 'vitest'

import { nextVersion, readServed, refuseBackwards } from './served.mjs'

/**
 * The feed's version comes from what is served, not from a file in the worktree (F1).
 *
 * `version = previous + 1` was read from the tracked `feeds/phishing.json`. With the
 * worktree at v51 and HEAD at v42, one `git checkout -- .` makes the next run publish
 * v43 — and every extension holding v51 refuses v43…v51 as replays for about four
 * days, while the smoke test passes because the worker serves what was signed.
 */

function answer(status: number, body: unknown): typeof fetch {
  return (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as typeof fetch
}

const SERVED = {
  update: { kind: 'snapshot', body: { name: 'phishing', version: 51, updatedAt: '2026-10-03T00:54:23.113Z', entries: ['a.test', 'b.test'] } },
  signature: 'c2ln',
}

describe('reading the served feed', () => {
  it('reads version, timestamp and entries from the signed body', async () => {
    const served = await readServed({ base: 'https://w.test', fetchImpl: answer(200, SERVED) })
    expect(served).toMatchObject({ state: 'served', version: 51, updatedAt: '2026-10-03T00:54:23.113Z', count: 2 })
  })

  it('treats 404 as nothing published yet, which is a first run', async () => {
    expect(await readServed({ base: 'https://w.test', fetchImpl: answer(404, { error: 'no feed' }) })).toEqual({ state: 'absent' })
  })

  it('throws on anything else, because a version cannot be guessed', async () => {
    await expect(readServed({ base: 'https://w.test', fetchImpl: answer(503, 'down') })).rejects.toThrow(/503/)
    await expect(readServed({ base: 'https://w.test', fetchImpl: answer(200, 'not json') })).rejects.toThrow(/JSON/)
    await expect(
      readServed({ base: 'https://w.test', fetchImpl: answer(200, { update: { body: { version: -1 } } }) }),
    ).rejects.toThrow(/version/)
  })

  it('bounds the request, so a hung network cannot hang the run', async () => {
    let signal: AbortSignal | undefined
    const capture = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Response(JSON.stringify(SERVED))
    }) as typeof fetch
    await readServed({ base: 'https://w.test', fetchImpl: capture, timeoutMs: 1234 })
    expect(signal, 'no AbortSignal on the request').toBeInstanceOf(AbortSignal)
  })

  it('gives up at its deadline', async () => {
    const hangs = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as typeof fetch
    await expect(readServed({ base: 'https://w.test', fetchImpl: hangs, timeoutMs: 50 })).rejects.toThrow()
  })

  it('asks past the cache, so a fifteen-minute edge copy cannot hide a newer version', async () => {
    let asked = ''
    const capture = (async (url: string) => {
      asked = url
      return new Response(JSON.stringify(SERVED))
    }) as typeof fetch
    await readServed({ base: 'https://w.test', fetchImpl: capture, now: () => 42 })
    expect(asked).toBe('https://w.test/feeds/phishing?cb=42')
  })
})

describe('choosing the next version', () => {
  it('is one past the highest version anyone has seen', () => {
    expect(nextVersion({ served: 51, local: [42] })).toBe(52)
    expect(nextVersion({ served: 51, local: [60] })).toBe(61)
    expect(nextVersion({ served: null, local: [] })).toBe(1)
  })

  it('refuses a version that is not newer than the served one, and says why', () => {
    expect(refuseBackwards(52, 51)).toBeNull()
    expect(refuseBackwards(51, 51)).toMatch(/replay/)
    expect(refuseBackwards(43, 51)).toMatch(/43.*51/)
    expect(refuseBackwards(1, null)).toBeNull()
  })
})
