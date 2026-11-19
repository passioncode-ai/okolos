import { describe, expect, it } from 'vitest'

import { syncFeed, FEED_URL } from './feed-sync.js'

/**
 * The path that did not exist.
 *
 * Everything downstream of it was built and tested — signature checking,
 * replay refusal, rollback, rule building — and nothing called any of it,
 * because nothing ever fetched a feed. The blocking list was empty on every
 * install and the tests that proved otherwise seeded storage by hand.
 */

function deps(overrides: Partial<Parameters<typeof syncFeed>[0]> & { body?: unknown; status?: number; throws?: unknown } = {}) {
  /** Key first, then its arguments — the shape the journal is handed. */
  const notes: {
    explainKey: string
    explainArgs: readonly string[]
    /** Beside the sentence, never inside it — see B-115. */
    diagnostic?: string
  }[] = []
  const refreshed: number[] = []
  const applied: unknown[] = []
  const base = {
    audit: {
      writeAudit: async () => undefined,
      now: () => '2026-08-08T00:00:00.000Z',
      newId: () => 'id',
      transport: async () => {
        if (overrides.throws) throw overrides.throws
        return new Response(JSON.stringify(overrides.body ?? { update: {}, signature: 'x' }), {
          status: overrides.status ?? 200,
        })
      },
    } as never,
    apply: async (signed: unknown) => {
      applied.push(signed)
      return { accepted: true }
    },
    refresh: async () => {
      refreshed.push(1)
      return undefined
    },
    // The key and its arguments, kept apart. Joining them into one string was fine
    // while the note took positional arguments; now the shape itself is what these
    // tests are about — a refusal must arrive as its own key, not as a sentence
    // substituted into another message (B-77).
    note: async (
      note: { explainKey: string; explainArgs: readonly string[] },
      diagnostic?: string,
    ) => {
      notes.push({ ...note, ...(diagnostic === undefined ? {} : { diagnostic }) })
    },
    ...overrides,
  }
  return { deps: base as Parameters<typeof syncFeed>[0], notes, refreshed, applied }
}

describe('pulling the blocking feed', () => {
  it('goes through the audited choke point, like everything else that leaves', async () => {
    const written: unknown[] = []
    const { deps: d } = deps({
      audit: {
        writeAudit: async (entry: unknown) => {
          written.push(entry)
        },
        now: () => '2026-08-08T00:00:00.000Z',
        newId: () => 'id',
        transport: async () => new Response(JSON.stringify({ update: {}, signature: 'x' })),
      } as never,
    })
    await syncFeed(d)
    expect(written.length, 'a feed fetch must be logged before it happens').toBeGreaterThan(0)
  })

  it('applies what it fetched and rebuilds the rules', async () => {
    const { deps: d, applied, refreshed } = deps({ body: { update: { kind: 'snapshot' }, signature: 'sig' } })
    const result = await syncFeed(d)
    expect(result).toEqual({ fetched: true, accepted: true })
    expect(applied).toHaveLength(1)
    expect(refreshed, 'a feed nobody installed is a feed nobody is protected by').toHaveLength(1)
  })

  it('keeps the list in force when the update does not verify', async () => {
    const { deps: d, refreshed, notes } = deps({
      apply: async () => ({
        accepted: false,
        explainKey: 'feedRefusedSignature',
        explainArgs: ['Okolos: фишинг', '7'],
        explainArgKeys: ['feedNamePhishing', null],
      }),
    })
    const result = await syncFeed(d)
    expect(result.accepted).toBe(false)
    expect(refreshed, 'rules must not be rebuilt from a feed that was refused').toHaveLength(0)
    /**
     * The refusal's own key, passed through rather than resolved and wrapped.
     *
     * It used to become a substitution inside `feedRefused` — a sentence inside a
     * sentence, resolved on the day of the write. Both halves were wrong: it read as
     * "Обновление отклонено: Обновление подписано не тем ключом…", and the inner half
     * froze in whichever language was active then (B-77).
     */
    expect(notes).toHaveLength(1)
    expect(notes[0]?.explainKey).toBe('feedRefusedSignature')
    expect(notes[0]?.explainArgs).toEqual(['Okolos: фишинг', '7'])
  })

  it('says so when the server refuses, rather than failing silently', async () => {
    const { deps: d, notes } = deps({ status: 503 })
    const result = await syncFeed(d)
    expect(result.fetched).toBe(false)
    expect(notes[0]?.explainKey).toBe('feedFetchStatus')
    expect(notes[0]?.explainArgs).toEqual(['503'])
  })

  it('says so when the fetch throws, and leaves what is in force alone', async () => {
    const { deps: d, notes, refreshed } = deps({ throws: new Error('offline') })
    const result = await syncFeed(d)
    expect(result.fetched).toBe(false)
    expect(refreshed).toHaveLength(0)
    expect(notes[0]?.explainKey).toBe('feedFetchFailed')
    /**
     * The cause travels **beside** the sentence, not as a substitution into it.
     *
     * It used to be an argument, so the reader got "Список блокировок не скачался: Error:
     * offline." — a Russian sentence with an English exception in the middle. The sentence is
     * now whole on its own and the exception is a `diagnostic` the journal shows under it
     * (B-115).
     */
    expect(notes[0]?.explainArgs).toEqual([])
    expect(notes[0]?.diagnostic).toMatch(/offline/)
  })

  it('names a feed address that is not a placeholder', async () => {
    // The model descriptor points at `.invalid` on purpose. This one must not:
    // an address nobody can reach is a feed nobody gets.
    expect(FEED_URL).not.toMatch(/\.invalid/)
    expect(FEED_URL).toMatch(/^https:\/\//)
  })
})
