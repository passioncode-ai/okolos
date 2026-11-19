import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ANSWER_WAIT_MS, CODE_LIFETIME_MS, ExtensionLink, isExtensionOrigin, MAX_BATCH, MAX_WAITING } from './link.js'

const CHROME = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const FIREFOX = 'moz-extension://3f1c2a9e-5b7d-4c11-9a0b-2e6f8d4c1a77'

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function link(now: () => number = Date.now) {
  const dir = mkdtempSync(path.join(tmpdir(), 'okolos-link-'))
  dirs.push(dir)
  const file = path.join(dir, 'extension.json')
  return { link: new ExtensionLink({ file, now }), file }
}

function paired(now: () => number = Date.now) {
  const made = link(now)
  const { code } = made.link.issueCode()
  const answer = made.link.pair(code, CHROME)
  if (!('token' in answer)) throw new Error('the pairing in this fixture failed')
  return { ...made, token: answer.token }
}

describe('which origins the link takes (B-218)', () => {
  it('takes a Chrome or Firefox extension origin and nothing a web page has', () => {
    expect(isExtensionOrigin(CHROME)).toBe(true)
    expect(isExtensionOrigin(FIREFOX)).toBe(true)
    for (const origin of ['https://evil.example', 'null', 'chrome-extension://', 'chrome-extension://ABC/', 'file://', undefined]) {
      expect(isExtensionOrigin(origin), String(origin)).toBe(false)
    }
  })
})

describe('pairing by a code the person types', () => {
  it('pairs once with the code, keeps only the token hash, and refuses the code a second time', () => {
    const { link: l, file } = link()
    const { code } = l.issueCode()
    expect(code).toMatch(/^\d{6}$/)
    const answer = l.pair(code, CHROME)
    expect('token' in answer).toBe(true)
    const token = (answer as { token: string }).token
    expect(readFileSync(file, 'utf8')).not.toContain(token)
    expect(l.check(CHROME, token)).toBe(true)
    expect(l.pair(code, CHROME)).toEqual({ refused: 'bad_code' })
  })

  it('refuses a wrong code and leaves the right one standing', () => {
    const { link: l } = link()
    const { code } = l.issueCode()
    const wrong = code === '000000' ? '000001' : '000000'
    expect(l.pair(wrong, CHROME)).toEqual({ refused: 'bad_code' })
    expect('token' in l.pair(code, CHROME)).toBe(true)
  })

  it('refuses a code past its five minutes, and an origin that is not an extension', () => {
    let clock = 1_000
    const { link: l } = link(() => clock)
    const { code } = l.issueCode()
    expect(l.pair(code, 'https://evil.example')).toEqual({ refused: 'bad_origin' })
    clock += CODE_LIFETIME_MS + 1
    expect(l.pair(code, CHROME)).toEqual({ refused: 'expired' })
  })

  it('shows the pending code to the page until it is used or its five minutes pass', () => {
    let clock = 1_000
    const { link: l } = link(() => clock)
    expect(l.pendingCode()).toBeNull()
    const issued = l.issueCode()
    expect(l.pendingCode()).toEqual(issued)
    clock += CODE_LIFETIME_MS + 1
    expect(l.pendingCode()).toBeNull()
    const again = l.issueCode()
    l.pair(again.code, CHROME)
    expect(l.pendingCode()).toBeNull()
  })

  it('checks the origin and the token together', () => {
    const { link: l, token } = paired()
    expect(l.check(FIREFOX, token)).toBe(false)
    expect(l.check(CHROME, `${token}x`)).toBe(false)
    expect(l.check(CHROME, '')).toBe(false)
    expect(l.isPairedOrigin(CHROME)).toBe(true)
    expect(l.isPairedOrigin(FIREFOX)).toBe(false)
  })

  it('is read back after a restart, and a file that is not a link is no link', () => {
    const { file, token } = paired()
    expect(new ExtensionLink({ file }).check(CHROME, token)).toBe(true)
    writeFileSync(file, '{"schema":"something else"}')
    expect(new ExtensionLink({ file }).state()).toEqual({ paired: false })
  })
})

describe('an agent call waits for the extension to wake (WA-5)', () => {
  it('is refused as not connected while nothing is paired', async () => {
    const { link: l } = link()
    const result = await l.ask('okolos.ping', {})
    expect(result.success).toBe(false)
    expect(!result.success && result.error.code).toBe('extension_not_connected')
  })

  it('is handed over once, and the answer reaches the agent', async () => {
    const { link: l } = paired()
    const asked = l.ask('okolos.ping', {})
    const [request] = l.next()
    expect(request).toMatchObject({ verb: 'okolos.ping', input: {} })
    expect(l.next()).toEqual([])
    expect(l.answer(request?.id ?? '', { success: true, data: { extensionVersion: '1.0.0', connectedSince: 'x' } })).toBe(true)
    expect(await asked).toEqual({ success: true, data: { extensionVersion: '1.0.0', connectedSince: 'x' } })
    expect(l.answer(request?.id ?? '', { success: true, data: {} })).toBe(false)
  })

  it('hands at most MAX_BATCH at a time, and the rest on the next ask', () => {
    const { link: l } = paired()
    for (let i = 0; i < MAX_BATCH + 2; i += 1) void l.ask('okolos.ping', {})
    expect(l.next()).toHaveLength(MAX_BATCH)
    expect(l.next()).toHaveLength(2)
  })

  it('is refused as asleep after ANSWER_WAIT_MS, saying when Okolos looks next', async () => {
    vi.useFakeTimers()
    const { link: l } = paired()
    l.next()
    const asked = l.ask('okolos.ping', {})
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS)
    const result = await asked
    expect(!result.success && result.error.code).toBe('extension_asleep')
    expect(!result.success && result.error.retryable).toBe(true)
    expect(!result.success && result.error.message).toMatch(/next around/)
  })

  it('refuses a call past MAX_WAITING at once, rather than queueing without end', async () => {
    const { link: l } = paired()
    for (let i = 0; i < MAX_WAITING; i += 1) void l.ask('okolos.ping', {})
    const result = await l.ask('okolos.ping', {})
    expect(!result.success && result.error.code).toBe('extension_asleep')
  })

  it('takes only a success from the extension; anything else is the daemon refusing it', async () => {
    const { link: l } = paired()
    const asked = l.ask('okolos.ping', {})
    const [request] = l.next()
    l.answer(request?.id ?? '', { success: 'yes' })
    const result = await asked
    expect(!result.success && result.error.code).toBe('internal')
  })
})

describe('disconnecting (WA-4)', () => {
  it('forgets the link, deletes its file and refuses every waiting call as not connected', async () => {
    const { link: l, file, token } = paired()
    const asked = l.ask('okolos.ping', {})
    expect(l.release()).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(l.check(CHROME, token)).toBe(false)
    const result = await asked
    expect(!result.success && result.error.code).toBe('extension_not_connected')
    expect(l.release()).toBe(false)
  })
})
