/**
 * Test fixture: one copy of the service as a real process, on a temporary home and a free port.
 *
 *   node --import ./ts-hooks.mjs ./run-service.mjs <home>
 *
 * Prints one JSON line `{"port":…,"pid":…}` once it listens, then serves until SIGTERM, which the
 * service drains and answers with exit 0. A copy that finds the lock held exits 75 on its own, before
 * it prints anything. It never touches the real ~/Library folders or port 47871: the home is the
 * argument and the port is 0.
 *
 * A watchdog ends it after 60 s, so a failed test cannot leave a server listening.
 */
import process from 'node:process'
import { setTimeout } from 'node:timers'

import { serviceDirs } from '../dirs.ts'
import { startService } from '../http.ts'

const home = process.argv[2]
if (!home) {
  process.stderr.write('usage: run-service.mjs <home>\n')
  process.exit(2)
}

setTimeout(() => process.exit(3), 60_000).unref()

const service = await startService({ port: 0, dirs: serviceDirs(home), handleSignals: true })
process.stdout.write(`${JSON.stringify({ port: service.port, pid: process.pid })}\n`)
