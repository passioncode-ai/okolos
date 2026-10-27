import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { open } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { answerAfterRecord, Journal, type JournalEntry } from './journal.js'

const temps: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fresh folder that stands for `<data>/journal`. */
function temp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-agent-journal-'))
  temps.push(dir)
  return path.join(dir, 'journal')
}

/** Every entry in the journal's files, oldest file first, as the disk holds them. */
function onDisk(dir: string): unknown[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .flatMap((name) => readFileSync(path.join(dir, name), 'utf8').split('\n'))
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown)
}

/** The prototype `FileHandle` methods live on, so a spy sees every handle the journal opens. */
async function fileHandlePrototype(): Promise<{ sync: () => Promise<void> }> {
  const where = path.join(path.dirname(temp()), 'probe')
  const handle = await open(where, 'w')
  await handle.close()
  return Object.getPrototypeOf(handle) as { sync: () => Promise<void> }
}

const answered: JournalEntry = {
  at: '2026-10-27T10:00:00.000Z',
  agent: 'claude-code',
  task: 'task-1',
  verb: 'snapshot',
  origin: 'https://example.com',
  outcome: 'answered',
  bytes: 1200,
  verdict: 'clean',
}

describe('record writes the entry down before it returns', () => {
  it('appends one JSON line and fsyncs it before the promise resolves', async () => {
    const dir = temp()
    const journal = Journal.open(dir, { retentionDays: 90 })

    const proto = await fileHandlePrototype()
    const original = proto.sync
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    const sync = vi.spyOn(proto, 'sync').mockImplementation(async function (this: unknown) {
      await held
      return original.call(this)
    })

    let returned = false
    const pending = journal.record(answered).then(() => (returned = true))

    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1))
    // The line is in the file when sync is asked for, and record has not returned yet.
    expect(onDisk(dir)).toEqual([answered])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(returned).toBe(false)

    release()
    await pending
    expect(returned).toBe(true)
    expect(sync).toHaveBeenCalledTimes(1)
  })
})

describe('an answer that is not in the journal is not sent (ADR-0019)', () => {
  it('a read-only folder makes record throw, and answerAfterRecord sends internal instead of the answer', async () => {
    const dir = temp()
    const journal = Journal.open(dir, { retentionDays: 90 })
    chmodSync(dir, 0o500)
    try {
      await expect(journal.record(answered)).rejects.toThrow()

      const sent: unknown[] = []
      const recorded = await answerAfterRecord(journal, answered, (refusal) => {
        sent.push(refusal ?? 'the page content')
      })

      expect(recorded).toBe(false)
      expect(sent).toEqual([
        { success: false, error: { code: 'internal', message: expect.any(String) as string, retryable: true } },
      ])
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(onDisk(dir)).toEqual([])
  })

  it('sends the answer once, and only after its entry is on disk', async () => {
    const dir = temp()
    const journal = Journal.open(dir, { retentionDays: 90 })
    const seenAtSend: unknown[][] = []

    const recorded = await answerAfterRecord(journal, answered, (refusal) => {
      expect(refusal).toBeUndefined()
      seenAtSend.push(onDisk(dir))
    })

    expect(recorded).toBe(true)
    expect(seenAtSend).toEqual([[answered]])
  })
})
