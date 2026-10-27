/**
 * A CDP client over `--remote-debugging-pipe` (REQ-54).
 *
 * The browser is started by `launch` and owned by the CdpPipe it returns
 * (lifecycle rule LC-02: every child has an owner, a deadline and a process
 * group). It runs `detached`, so it leads its own process group and the group
 * can be ended as one.
 *
 * Wire: the browser reads requests from its fd 3 and writes answers and events
 * to its fd 4, each message JSON followed by a NUL byte. No port is opened and
 * nothing here touches the network.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

import { CdpError, type CdpErrorKind } from './errors.js'
import { splitFrames } from './frames.js'

export interface LaunchOptions {
  /** The browser executable. */
  readonly binary: string
  /** The caller's arguments; launch appends the pipe and the profile flags. */
  readonly args: readonly string[]
  /** The profile directory, passed as `--user-data-dir`. */
  readonly userDataDir: string
  /** How long a request may wait for its answer before it is rejected. */
  readonly requestTimeoutMs?: number
  /**
   * Hears a listener registered with on() that threw. The other listeners and
   * the pipe go on either way. Default: one stderr line naming the event and
   * the error's class, never the params (they can carry page content).
   */
  readonly onListenerError?: (error: unknown, event: string) => void
  /**
   * Hears that close() gave up: the browser had not exited graceMs after
   * SIGKILL to its group (a group it may not signal, EPERM). close() resolves
   * anyway. Default: one stderr line naming the pid.
   */
  readonly onCloseIncomplete?: (pid: number) => void
  /** The signal sender; tests inject a failing one. Default: process.kill. */
  readonly kill?: typeof process.kill
}

function reportCloseIncomplete(pid: number): void {
  process.stderr.write(`cdp-pipe: browser ${pid} had not exited after SIGKILL to its group; close() gave up\n`)
}

function reportListenerError(error: unknown, event: string): void {
  const kind = error instanceof Error ? error.name : typeof error
  process.stderr.write(`cdp-pipe: a listener of ${event} threw (${kind})\n`)
}

/** One message from the browser: an answer (id) or an event (method). */
interface Incoming {
  readonly id?: number
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
  readonly method?: string
  readonly params?: unknown
  /** Set on events from an attached target (flat sessions). */
  readonly sessionId?: string
}

/** Receives one CDP event; sessionId is set when the event came from an attached target. */
export type EventListener<P = unknown> = (params: P, sessionId?: string) => void

/** How the browser process ended: an exit code, or the signal that ended it. */
export interface ExitInfo {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

/** Per-call settings of send(). */
export interface SendOptions {
  /** This request's deadline, instead of the pipe's requestTimeoutMs. */
  readonly timeoutMs?: number
}

/**
 * What a consumer of a CDP connection depends on. CdpPipe is the one over a
 * real browser; a consumer's tests hand it a plain object instead, which a
 * class with private members could never be.
 *
 * Every rejection of send() is a CdpError (./errors.ts).
 */
export interface CdpTransport {
  readonly pid: number
  send<T = unknown>(method: string, params?: object, sessionId?: string, opts?: SendOptions): Promise<T>
  on<P = unknown>(event: string, listener: EventListener<P>): () => void
  /** Hears the browser process end, whoever ended it; returns the function that unsubscribes. */
  onExit(listener: (info: ExitInfo) => void): () => void
  close(graceMs?: number): Promise<void>
}

interface Waiting {
  readonly method: string
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
}

/** How often close() looks whether the browser and its group are gone. */
const POLL_MS = 25

export class CdpPipe {
  readonly pid: number

  private readonly child: ChildProcess
  private readonly toBrowser: Writable
  private readonly requestTimeoutMs: number
  private readonly onListenerError: (error: unknown, event: string) => void
  private readonly onCloseIncomplete: (pid: number) => void
  private readonly kill: typeof process.kill
  private nextId = 1
  private pending = ''
  private readonly waiting = new Map<number, Waiting>()
  private readonly listeners = new Map<string, Set<EventListener>>()
  /** Why no further answer can arrive; set once the pipe or the process is gone. */
  private closedBecause: { readonly kind: CdpErrorKind; readonly reason: string } | undefined
  private exited = false
  private closing: Promise<void> | undefined

  private constructor(child: ChildProcess, options: LaunchOptions) {
    this.child = child
    this.pid = child.pid as number
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    this.onListenerError = options.onListenerError ?? reportListenerError
    this.onCloseIncomplete = options.onCloseIncomplete ?? reportCloseIncomplete
    this.kill = options.kill ?? process.kill.bind(process)
    this.toBrowser = child.stdio[3] as Writable
    const fromBrowser = child.stdio[4] as Readable
    fromBrowser.setEncoding('utf8')
    fromBrowser.on('data', (chunk: string) => this.read(chunk))
    fromBrowser.on('end', () => this.fail('closed', 'the pipe from the browser closed'))
    // An unhandled 'error' on any of the browser's streams would take the
    // owner's process down with it, and every session on the pipe. A write after
    // the browser is gone fails with EPIPE; a read can fail too (EIO).
    fromBrowser.on('error', (cause) => this.fail('closed', `the pipe from the browser broke (${cause.message})`))
    this.toBrowser.on('error', (cause) => this.fail('closed', `the pipe to the browser broke (${cause.message})`))
    // A browser that stops reading fd 3 ends our side of it too, and a write to
    // a stream already closed fails in its callback only, with no 'error': without
    // this, the request would wait out its whole deadline.
    this.toBrowser.on('close', () => this.fail('closed', 'the pipe to the browser closed'))
    const stderr = child.stdio[2] as Readable
    stderr.on('error', (cause) => this.fail('closed', `the browser's stderr broke (${cause.message})`))
    // Unread stderr would fill the pipe and stall the browser.
    stderr.resume()
    child.once('exit', () => {
      this.exited = true
      this.fail('exited', 'the browser exited')
    })
  }

  /** Starts the browser on a pipe; resolves once the process exists. */
  static launch(options: LaunchOptions): Promise<CdpPipe> {
    const child = spawn(
      options.binary,
      [...options.args, '--remote-debugging-pipe', `--user-data-dir=${options.userDataDir}`],
      { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true },
    )
    return new Promise((resolve, reject) => {
      child.once('error', (cause) => reject(new Error(`cannot start ${options.binary}: ${cause.message}`)))
      child.once('spawn', () => resolve(new CdpPipe(child, options)))
    })
  }

  /** Sends one CDP command, to the browser or (with sessionId) to an attached target. */
  send<T = unknown>(method: string, params?: object, sessionId?: string): Promise<T> {
    const id = this.nextId++
    const message = { id, method, params: params ?? {}, ...(sessionId === undefined ? {} : { sessionId }) }
    return new Promise<T>((resolve, reject) => {
      if (this.closedBecause !== undefined) {
        reject(new CdpError(this.closedBecause.kind, method, this.closedBecause.reason))
        return
      }
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`${method}: no answer within ${this.requestTimeoutMs} ms`))
      }, this.requestTimeoutMs)
      this.waiting.set(id, {
        method,
        resolve: (result) => {
          clearTimeout(timer)
          resolve(result as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.toBrowser.write(`${JSON.stringify(message)}\0`)
    })
  }

  /** Subscribes to one CDP event; returns the function that unsubscribes. */
  on<P = unknown>(event: string, listener: EventListener<P>): () => void {
    const set = this.listeners.get(event) ?? new Set<EventListener>()
    this.listeners.set(event, set)
    const entry = listener as EventListener
    set.add(entry)
    return () => {
      set.delete(entry)
    }
  }

  /**
   * Ends the browser and every process in its group (LC-02), and resolves once
   * the browser has exited. Asks first (`Browser.close`), waits graceMs; then
   * SIGTERM to the group, waits graceMs; then SIGKILL to the group, waits
   * graceMs. The group is swept even when the browser left on its own, because
   * a child of it may not have. Hard deadline: 3 x graceMs; a browser still
   * there then is reported through onCloseIncomplete and close() resolves
   * anyway. Calling it again returns the same promise.
   */
  close(graceMs = 2000): Promise<void> {
    this.closing ??= this.shutdown(graceMs)
    return this.closing
  }

  private async shutdown(graceMs: number): Promise<void> {
    // The whole close has a hard deadline: ask, SIGTERM, SIGKILL, one grace each.
    const deadline = Date.now() + 3 * graceMs
    if (!this.exited) {
      // The answer does not matter: the process leaving is the answer, and
      // the signals below are the guarantee.
      this.send('Browser.close').catch(() => undefined)
      await until(() => this.exited, graceMs)
    }
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (!this.groupAlive()) break
      this.signalGroup(signal)
      if (await until(() => !this.groupAlive(), graceMs)) break
    }
    // A group that is gone has an exit event on its way; a group that could
    // not be signalled (EPERM) may never give one, and close() must not hang.
    if (!(await until(() => this.exited, Math.max(deadline - Date.now(), POLL_MS)))) {
      this.onCloseIncomplete(this.pid)
    }
    for (const stream of this.child.stdio) stream?.destroy()
  }

  /** Whether any process of the browser's group still exists. */
  private groupAlive(): boolean {
    try {
      this.kill(-this.pid, 0)
      return true
    } catch (cause) {
      // EPERM: the group exists and is not ours to signal; count it as alive so
      // close() does not report a group gone that is not.
      return (cause as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  private signalGroup(signal: NodeJS.Signals): void {
    try {
      this.kill(-this.pid, signal)
    } catch {
      // the group left between the check and the signal, or may not be signalled
    }
  }

  private fail(kind: CdpErrorKind, reason: string): void {
    this.closedBecause ??= { kind, reason }
    for (const [id, waiting] of this.waiting) {
      this.waiting.delete(id)
      waiting.reject(new CdpError(kind, waiting.method, reason))
    }
  }

  private read(chunk: string): void {
    const { messages, pending } = splitFrames(this.pending, chunk)
    this.pending = pending
    for (const text of messages) {
      const message = parse(text)
      if (message === undefined) continue
      if (typeof message.id === 'number') {
        const waiting = this.waiting.get(message.id)
        if (waiting === undefined) continue
        this.waiting.delete(message.id)
        if (message.error === undefined) waiting.resolve(message.result)
        else waiting.reject(new Error(`${waiting.method}: ${message.error.message} (CDP ${message.error.code})`))
      } else if (typeof message.method === 'string') {
        // A copy: a listener may unsubscribe while the event is being delivered.
        for (const listener of [...(this.listeners.get(message.method) ?? [])]) {
          // Thrown from the stream's handler, a listener's bug would end the
          // owner's process and every session on the pipe with it.
          try {
            listener(message.params, message.sessionId)
          } catch (error) {
            this.onListenerError(error, message.method)
          }
        }
      }
    }
  }
}

/**
 * One frame as a message, or undefined for a frame that is not a JSON object.
 * Such a frame is skipped: thrown from the stream's handler, it would end the
 * owner's process, and with it every other session on the pipe.
 */
function parse(text: string): Incoming | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? (value as Incoming) : undefined
  } catch {
    return undefined
  }
}

/**
 * Polls until the condition holds or ms pass; answers whether it held. The last
 * sleep is cut to the deadline, so a wait does not overrun it by a poll.
 */
async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!condition()) {
    const left = deadline - Date.now()
    if (left <= 0) return false
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, left)))
  }
  return true
}
