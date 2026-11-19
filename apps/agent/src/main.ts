#!/usr/bin/env node
/**
 * `okolos-agent`: the daemon and its two client commands (K3, N-011).
 *
 *   okolos-agent serve [--port <port>]       the service: door, access, journal, agent window
 *   okolos-agent pair --name <name>          asks the person for access and saves the key
 *   okolos-agent mcp-stdio --name <name>     an MCP stdio server relaying to the door
 *
 * The release runs the bundle `tools/build-agent.mjs` writes; the probe's script
 * (`agent-probe.js`) sits beside it. The language of the sentences a person
 * reads is `OKOLOS_AGENT_LOCALE` (`ru` by default, `en`).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { createAgent } from './agent.js'
import { cliMessages } from './cli/messages.js'
import { relay } from './cli/mcp-stdio.js'
import { pair } from './cli/pair.js'
import { PORT, serviceDirs } from './service/dirs.js'
import type { Locale } from './service/http.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const USAGE = 'okolos-agent serve [--port <port>] | pair --name <name> | mcp-stdio --name <name>'

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

/** The version the release carries: the package.json beside the bundle's folder. */
function version(): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

async function main(args: readonly string[]): Promise<number> {
  const locale: Locale = process.env.OKOLOS_AGENT_LOCALE === 'en' ? 'en' : 'ru'
  const command = args[0]
  const base = `http://127.0.0.1:${PORT}`
  if (command === 'serve') {
    const port = Number(option(args, '--port') ?? PORT)
    const agent = await createAgent({
      port,
      version: version(),
      buildRoot: path.resolve(here, '..'),
      probeSource: readFileSync(path.join(here, 'agent-probe.js'), 'utf8'),
      locale,
    })
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        void agent.close().then(resolve)
      }
      process.once('SIGTERM', stop)
      process.once('SIGINT', stop)
    })
    return 0
  }
  const name = option(args, '--name')
  if ((command === 'pair' || command === 'mcp-stdio') && name !== undefined) {
    const say = cliMessages(locale)
    const dirs = serviceDirs()
    if (command === 'pair') return pair({ name, base, dirs, say, print: (line) => process.stdout.write(`${line}\n`) })
    const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
    return relay({
      name,
      base,
      dirs,
      say,
      input: lines,
      output: (line) => process.stdout.write(`${line}\n`),
      error: (line) => process.stderr.write(`${line}\n`),
    })
  }
  process.stderr.write(`${USAGE}\n`)
  return 2
}

process.exitCode = await main(process.argv.slice(2))
