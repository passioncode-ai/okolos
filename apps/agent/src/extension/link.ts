import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

import { refuse, type AnyBridgeVerb, type BridgeResult } from '@okolos/contracts'

import { atomicWrite } from '../fabric/fabric-service.mjs'
import type { ServiceDirs } from '../service/dirs.js'

/**
 * The link between Okolos Agent and the Okolos extension (B-218 wave (a), spec
 * `docs/superpowers/specs/2026-11-19-agent-door-wave-a.md`).
 *
 * The daemon cannot call the extension (ADR-0018: no native messaging, no externally
 * connectable), so the extension calls in: once paired, its background wakes about once a
 * minute and asks for the requests agents left here. An agent's call waits for that wake, at
 * most ANSWER_WAIT_MS, and is refused with `extension_asleep` past it.
 *
 * One extension at a time, named by its origin (`chrome-extension://<id>`,
 * `moz-extension://<uuid>`) and a token the daemon keeps only as a SHA-256, in the service data
 * folder. A pairing replaces the one before it.
 */

/** How long a code the person asked for on the Okolos Agent page can be typed into Okolos. */
export const CODE_LIFETIME_MS = 5 * 60_000
/** How long an agent's call waits for the extension to answer it. */
export const ANSWER_WAIT_MS = 90_000
/** How often a paired extension wakes to ask for requests; the agent is told when it will next. */
export const WAKE_PERIOD_MS = 60_000
/** The most requests one ask hands over. */
export const MAX_BATCH = 10
/** The most calls waiting at once; one more is refused as asleep rather than queued without end. */
export const MAX_WAITING = 50

const SCHEMA = 'okolos-agent/extension/1'
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension):\/\/[a-z0-9-]{8,64}$/

/** Where the link is kept, beside the pairing store. */
export function extensionStoreFile(dirs: ServiceDirs): string {
  return path.join(dirs.data, 'extension.json')
}

/** Whether `origin` is a browser extension's own origin, the only kind the link takes. */
export function isExtensionOrigin(origin: unknown): origin is string {
  return typeof origin === 'string' && EXTENSION_ORIGIN.test(origin)
}

interface Stored {
  readonly schema: typeof SCHEMA
  readonly origin: string
  readonly tokenHash: string
  readonly pairedAt: number
}

/** A request an agent left for the extension. */
export interface ExtensionRequest {
  readonly id: string
  readonly verb: AnyBridgeVerb
  readonly input: unknown
}

interface Waiting extends ExtensionRequest {
  handed: boolean
  readonly settle: (result: BridgeResult<unknown>) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export type PairRefusal = 'bad_code' | 'expired' | 'bad_origin'

export type LinkState =
  | { readonly paired: false }
  | { readonly paired: true; readonly origin: string; readonly pairedAt: number; readonly lastSeenAt: number | null }

export interface LinkOptions {
  readonly file: string
  readonly random?: (size: number) => Buffer
  readonly now?: () => number
}

export class ExtensionLink {
  readonly #file: string
  readonly #random: (size: number) => Buffer
  readonly #now: () => number
  #stored: Stored | null
  #code: { readonly code: string; readonly expiresAt: number } | null = null
  #lastSeenAt: number | null = null
  readonly #waiting = new Map<string, Waiting>()

  constructor(options: LinkOptions) {
    this.#file = options.file
    this.#random = options.random ?? randomBytes
    this.#now = options.now ?? Date.now
    this.#stored = read(options.file)
  }

  /** A six-digit code for the person to type into Okolos, valid CODE_LIFETIME_MS; a new one replaces the last. */
  issueCode(): { code: string; expiresAt: number } {
    let code = ''
    // Rejection sampling, so every code is equally likely.
    while (code === '') {
      const value = this.#random(4).readUInt32BE(0)
      if (value < 4_294_000_000) code = String(value % 1_000_000).padStart(6, '0')
    }
    this.#code = { code, expiresAt: this.#now() + CODE_LIFETIME_MS }
    return this.#code
  }

  /**
   * The extension presents the code from `origin`. A code works once; a wrong one is refused
   * and leaves the code standing, so a person who mistyped can type it again.
   */
  pair(code: string, origin: string): { token: string } | { refused: PairRefusal } {
    if (!isExtensionOrigin(origin)) return { refused: 'bad_origin' }
    const issued = this.#code
    if (issued === null) return { refused: 'bad_code' }
    if (this.#now() > issued.expiresAt) {
      this.#code = null
      return { refused: 'expired' }
    }
    if (!sameText(code, issued.code)) return { refused: 'bad_code' }
    this.#code = null
    const token = this.#random(32).toString('base64url')
    const stored: Stored = { schema: SCHEMA, origin, tokenHash: sha256(token), pairedAt: this.#now() }
    atomicWrite(this.#file, `${JSON.stringify(stored)}\n`, 0o600)
    this.#stored = stored
    this.#lastSeenAt = null
    return { token }
  }

  /** Whether a call carries the paired extension's origin and its token. */
  check(origin: unknown, token: unknown): boolean {
    const stored = this.#stored
    if (stored === null || origin !== stored.origin || typeof token !== 'string' || token === '') return false
    return timingSafeEqual(Buffer.from(sha256(token), 'hex'), Buffer.from(stored.tokenHash, 'hex'))
  }

  /** Whether `origin` is the paired extension's. */
  isPairedOrigin(origin: unknown): boolean {
    return this.#stored !== null && origin === this.#stored.origin
  }

  /** Ends the link from either side; every waiting call is refused as not connected. */
  release(): boolean {
    const had = this.#stored !== null
    this.#stored = null
    this.#lastSeenAt = null
    rmSync(this.#file, { force: true })
    for (const waiting of [...this.#waiting.values()]) {
      // i18n-exempt: read by the agent over MCP, not by the person
      this.#settle(waiting, refuse('extension_not_connected', 'Okolos was disconnected from Okolos Agent.'))
    }
    return had
  }

  state(): LinkState {
    const stored = this.#stored
    return stored === null ? { paired: false } : { paired: true, origin: stored.origin, pairedAt: stored.pairedAt, lastSeenAt: this.#lastSeenAt }
  }

  /** An agent's call for the extension: answered when the extension next wakes, or refused. */
  ask(verb: AnyBridgeVerb, input: unknown): Promise<BridgeResult<unknown>> {
    if (this.#stored === null) {
      // i18n-exempt: read by the agent over MCP, not by the person
      return Promise.resolve(refuse('extension_not_connected', 'Okolos is not connected to Okolos Agent; the person connects it on the Okolos Agent page.'))
    }
    if (this.#waiting.size >= MAX_WAITING) return Promise.resolve(refuse('extension_asleep', this.#asleep()))
    return new Promise((resolve) => {
      const id = this.#random(12).toString('base64url')
      const timer = setTimeout(() => {
        const waiting = this.#waiting.get(id)
        if (waiting !== undefined) this.#settle(waiting, refuse('extension_asleep', this.#asleep()))
      }, ANSWER_WAIT_MS)
      timer.unref?.()
      this.#waiting.set(id, { id, verb, input, handed: false, settle: resolve, timer })
    })
  }

  /** The requests not handed over yet, at most MAX_BATCH, for the extension that woke. */
  next(): ExtensionRequest[] {
    this.#lastSeenAt = this.#now()
    const batch: ExtensionRequest[] = []
    for (const waiting of this.#waiting.values()) {
      if (batch.length === MAX_BATCH) break
      if (waiting.handed) continue
      waiting.handed = true
      batch.push({ id: waiting.id, verb: waiting.verb, input: waiting.input })
    }
    return batch
  }

  /** The extension's answer to request `id`; false when nobody waits for it any more. */
  answer(id: string, result: unknown): boolean {
    const waiting = this.#waiting.get(id)
    if (waiting === undefined || !waiting.handed) return false
    this.#settle(waiting, asResult(result))
    return true
  }

  #settle(waiting: Waiting, result: BridgeResult<unknown>): void {
    clearTimeout(waiting.timer)
    this.#waiting.delete(waiting.id)
    waiting.settle(result)
  }

  #asleep(): string {
    const next = this.#lastSeenAt === null ? null : new Date(this.#lastSeenAt + WAKE_PERIOD_MS).toISOString()
    // i18n-exempt: read by the agent over MCP, not by the person
    return next === null
      ? 'Okolos has not woken since it was connected; it looks for requests about once a minute while the browser runs.'
      : `Okolos did not answer in time; it looks for requests about once a minute, next around ${next}.`
  }
}

/** What the extension answered, as the contract's result; anything else is the daemon's own failure. */
function asResult(value: unknown): BridgeResult<unknown> {
  const result = value as { success?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } } | null
  if (result !== null && typeof result === 'object' && result.success === true) return { success: true, data: result.data }
  // i18n-exempt: read by the agent over MCP, not by the person
  return refuse('internal', 'Okolos answered something that is not a result.')
}

function read(file: string): Stored | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const value = JSON.parse(text) as Partial<Stored>
    const valid =
      value.schema === SCHEMA &&
      isExtensionOrigin(value.origin) &&
      typeof value.tokenHash === 'string' &&
      /^[0-9a-f]{64}$/.test(value.tokenHash) &&
      typeof value.pairedAt === 'number'
    // A file that is not a link is no link: the next pairing writes over it.
    return valid ? (value as Stored) : null
  } catch {
    return null
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}
