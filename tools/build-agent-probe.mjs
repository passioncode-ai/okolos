#!/usr/bin/env node
/**
 * Bundles the agent probe (`apps/extension/src/agent-probe-page.ts`) into one
 * script Okolos Agent evaluates in an isolated world of the agent's page
 * (Okolos Bridge, N-011).
 *
 * One self-contained IIFE, like the content script, and built with the same
 * flags: the probe is the extension's own detector, so the agent is never
 * protected by a weaker copy (agent-probe.ts). No test hooks and no page marks
 * ever reach it: a page could read the marks.
 *
 * `node tools/build-agent-probe.mjs <out-file>` writes it; `buildAgentProbe()`
 * answers it as text, for the daemon's tests.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'vite'

import { isMain } from './is-main.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const PROBE_ENTRY = path.join(root, 'apps/extension/src/agent-probe-page.ts')

/** The probe's script, as text. */
export async function buildAgentProbe() {
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    resolve: { conditions: ['import', 'module', 'browser', 'default'] },
    define: {
      __OKOLOS_TEST_HOOKS__: 'false',
      __OKOLOS_PAGE_MARKS__: 'false',
      __OKOLOS_USAGE__: JSON.stringify({ appKey: null, environment: 'sandbox', asIfSending: false }),
    },
    build: {
      write: false,
      target: 'chrome116',
      minify: false,
      rollupOptions: {
        input: PROBE_ENTRY,
        output: { entryFileNames: 'agent-probe.js', format: 'iife', codeSplitting: false },
      },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ('output' in r ? r.output : []))
  const chunk = outputs.find((o) => o.type === 'chunk')
  // i18n-exempt: a build failure for whoever runs the build; never shown to a person in the product
  if (chunk === undefined || chunk.type !== 'chunk') throw new Error('build-agent-probe: vite produced no script')
  return chunk.code
}

if (isMain(import.meta.url)) {
  const out = process.argv[2]
  if (out === undefined) {
    process.stderr.write('usage: node tools/build-agent-probe.mjs <out-file>\n')
    process.exit(2)
  }
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, await buildAgentProbe())
}
