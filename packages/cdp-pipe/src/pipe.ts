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
  private nextId = 1
  private pending = ''
  private readonly waiting = new Map<number, Waiting>()
  private readonly listeners = new Map<string, Set<EventListener>>()
  /** Why no further answer can arrive; set once the pipe or the process is gone. */
  private closedBecause: string | undefined
  private exited = false
  private readonly exit: Promise<void>
  private closing: Promise<void> | undefined

  private constructor(child: ChildProcess, requestTimeoutMs: number) {
    this.child = child
    this.pid = child.pid as number
    this.requestTimeoutMs = requestTimeoutMs
    this.toBrowser = child.stdio[3] as Writable
    const fromBrowser = child.stdio[4] as Readable
    fromBrowser.setEncoding('utf8')
    fromBrowser.on('data', (chunk: string) => this.read(chunk))
    fromBrowser.on('end', () => this.fail('the pipe from the browser closed'))
    // A write after the browser is gone fails with EPIPE; unhandled, it would
    // take the owner's process down with it.
    this.toBrowser.on('error', (cause) => this.fail(`the pipe to the browser broke (${cause.message})`))
    // Unread stderr would fill the pipe and stall the browser.
    ;(child.stdio[2] as Readable).resume()
    this.exit = new Promise((resolve) => {
      child.once('exit', () => {
        this.exited = true
        this.fail('the browser exited')
        resolve()
      })
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
      child.once('spawn', () => resolve(new CdpPipe(child, options.requestTimeoutMs ?? 10_000)))
    })
  }

  /** Sends one CDP command, to the browser or (with sessionId) to an attached target. */
  send<T = unknown>(method: string, params?: object, sessionId?: string): Promise<T> {
    const id = this.nextId++
    const message = { id, method, params: params ?? {}, ...(sessionId === undefined ? {} : { sessionId }) }
    return new Promise<T>((resolve, reject) => {
      if (this.closedBecause !== undefined) {
        reject(new Error(`${method}: ${this.closedBecause}`))
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
   * SIGTERM to the group, waits graceMs; then SIGKILL to the group. The group
   * is swept even when the browser left on its own, because a child of it may
   * not have. Calling it again returns the same promise.
   */
  close(graceMs = 2000): Promise<void> {
    this.closing ??= this.shutdown(graceMs)
    return this.closing
  }

  private async shutdown(graceMs: number): Promise<void> {
    if (!this.exited) {
      // The answer does not matter: the process leaving is the answer, and
      // the signals below are the guarantee.
      this.send('Browser.close').catch(() => undefined)
      await until(() => this.exited, graceMs)
    }
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (!groupAlive(this.pid)) break
      signalGroup(this.pid, signal)
      if (await until(() => !groupAlive(this.pid), graceMs)) break
    }
    await this.exit
    for (const stream of this.child.stdio) stream?.destroy()
  }

  private fail(reason: string): void {
    this.closedBecause ??= reason
    for (const [id, waiting] of this.waiting) {
      this.waiting.delete(id)
      waiting.reject(new Error(`${waiting.method}: ${reason}`))
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
          listener(message.params, message.sessionId)
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

/** Whether any process of the group led by pid still exists. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (cause) {
    // EPERM: the group exists and is not ours to signal; count it as alive so
    // close() does not report a group gone that is not.
    return (cause as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // the group left between the check and the signal
  }
}

/** Polls until the condition holds or ms pass; answers whether it held. */
async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return true
}
