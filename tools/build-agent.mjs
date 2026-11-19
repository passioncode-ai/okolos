#!/usr/bin/env node
/**
 * Builds Okolos Agent (Okolos Bridge, N-011) into `apps/agent/dist/bin/`:
 *
 *   okolos-agent.mjs   the daemon and its CLI, one ES module for Node, every
 *                      dependency inside (the MCP SDK, zod, the fabric kit's .mjs
 *                      files, which tsc would not copy)
 *   agent-probe.js     the probe the daemon evaluates in the agent's page
 *                      (tools/build-agent-probe.mjs)
 *
 * The catalogue stays where the daemon looks for it, `apps/agent/_locales`, two
 * folders up from the bundle. Written beside the target and swapped in at the end,
 * as the extension's build does (B-226).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'vite'

import { buildAgentProbe } from './build-agent-probe.mjs'
import { buildingDir, swapInto, sweepLeftovers } from './dist-swap.mjs'
import { isMain } from './is-main.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const AGENT_ENTRY = path.join(root, 'apps/agent/src/main.ts')
export const AGENT_OUT = path.join(root, 'apps/agent/dist/bin')

/** Builds the daemon and the probe into `outDir` (the release's folder by default). */
export async function buildAgent(outDir = AGENT_OUT) {
  await sweepLeftovers(path.dirname(outDir))
  const building = buildingDir(outDir)
  await rm(building, { recursive: true, force: true })
  await mkdir(building, { recursive: true })
  await build({
    configFile: false,
    logLevel: 'warn',
    ssr: { noExternal: true },
    build: {
      ssr: AGENT_ENTRY,
      outDir: building,
      emptyOutDir: false,
      target: 'node22',
      minify: false,
      rollupOptions: { output: { entryFileNames: 'okolos-agent.mjs', format: 'es', codeSplitting: false } },
    },
  })
  await writeFile(path.join(building, 'agent-probe.js'), await buildAgentProbe())
  await swapInto(outDir, building)
  return outDir
}

if (isMain(import.meta.url)) await buildAgent(process.argv[2] ?? AGENT_OUT)
