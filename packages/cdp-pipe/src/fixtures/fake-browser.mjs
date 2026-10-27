/**
 * A fake browser for the cdp-pipe tests: speaks CDP the way Chrome does under
 * `--remote-debugging-pipe` (NUL-framed JSON, read from fd 3, written to fd 4),
 * so CdpPipe is tested on a real process, real pipes and a real process group,
 * without starting Chrome and without touching the network.
 *
 * Methods it answers:
 *   Fake.echo            -> result: the params it was sent, plus the sessionId if any
 *   Fake.argv            -> result: { argv } (the arguments after the script path)
 *   Fake.silence         -> never answers (the timeout test)
 *   Fake.fail            -> error: { code: -32000, message: params.message }
 *   Fake.emit            -> sends the event params.event (with params.sessionId, if
 *                           given), then answers {}
 *   Fake.spawnGrandchild -> starts a process in this process's group (as Chrome's
 *                           helpers are) and answers { pid }, so a test can see
 *                           whether close() ends the whole group
 *   Browser.close        -> answers {} and exits, like Chrome; with --ignore-close it
 *                           never answers and stays
 *   anything else        -> the error Chrome gives for an unknown method
 *
 * Flags: --ignore-close (see above), --ignore-term (SIGTERM does nothing, so only
 * SIGKILL ends it).
 *
 * Every process it leaves has a deadline: it exits when fd 3 closes (its owner
 * is gone) or after 60 s, whichever comes first, and a grandchild lives at most
 * 60 s. A failed test cannot leave a process running for longer than that.
 */
import { spawn } from 'node:child_process'
import { Socket } from 'node:net'
import process from 'node:process'
import { setTimeout } from 'node:timers'

const LIFETIME_MS = 60_000

const argv = process.argv.slice(2)
const ignoreClose = argv.includes('--ignore-close')
if (argv.includes('--ignore-term')) process.on('SIGTERM', () => {})

setTimeout(() => process.exit(0), LIFETIME_MS).unref()

// Pipe handles over the inherited fds, not network sockets: `Socket({ fd })` is
// how Node reads a pipe without a blocking thread-pool read. An fs read stream
// on fd 3 held a thread-pool thread in read(2), and process.exit then waited
// for it forever (measured: the fake answered Browser.close and never exited).
const fromOwner = new Socket({ fd: 3, readable: true, writable: false })
fromOwner.setEncoding('utf8')
const toOwner = new Socket({ fd: 4, readable: false, writable: true })

const write = (message) => toOwner.write(`${JSON.stringify(message)}\0`)

function handle(message) {
  const { id, method, params = {}, sessionId } = message
  const at = sessionId === undefined ? {} : { sessionId }
  switch (method) {
    case 'Fake.echo':
      return write({ id, result: { ...params, ...at }, ...at })
    case 'Fake.argv':
      return write({ id, result: { argv } })
    case 'Fake.silence':
      return undefined
    case 'Fake.fail':
      return write({ id, error: { code: -32000, message: params.message }, ...at })
    case 'Fake.emit': {
      const eventAt = params.sessionId === undefined ? {} : { sessionId: params.sessionId }
      write({ method: params.event, params: params.params ?? {}, ...eventAt })
      return write({ id, result: {}, ...at })
    }
    case 'Fake.spawnGrandchild': {
      // Inherits this process's group, as Chrome's renderers and GPU process do.
      const grandchild = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${LIFETIME_MS})`], {
        stdio: 'ignore',
      })
      return write({ id, result: { pid: grandchild.pid } })
    }
    case 'Browser.close':
      if (ignoreClose) return undefined
      return toOwner.write(`${JSON.stringify({ id, result: {} })}\0`, () => process.exit(0))
    default:
      return write({ id, error: { code: -32601, message: `'${method}' wasn't found` }, ...at })
  }
}

let pending = ''
fromOwner.on('data', (chunk) => {
  const parts = (pending + chunk).split('\0')
  pending = parts.pop() ?? ''
  for (const part of parts) if (part.length > 0) handle(JSON.parse(part))
})
fromOwner.on('end', () => process.exit(0))
