import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildAgent } from './build-agent.mjs'

describe('the Okolos Agent bundle (N-011)', () => {
  it('is one ES module that runs under plain node, carries the fabric kit, and has the probe beside it', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-agent-build-'))
    try {
      const out = await buildAgent(path.join(dir, 'bin'))
      const bundle = readFileSync(path.join(out, 'okolos-agent.mjs'), 'utf8')
      // The fabric kit's .mjs files, which tsc would not copy, are inside (plan N-011, test 19).
      expect(bundle).toContain('fabric-service/0.1')
      expect(bundle).not.toMatch(/from ['"]\.\.?\//)
      expect(readFileSync(path.join(out, 'agent-probe.js'), 'utf8')).toContain('__okolosAgentProbe')
      const run = spawnSync(process.execPath, [path.join(out, 'okolos-agent.mjs')], { encoding: 'utf8', timeout: 30_000 })
      expect(run.status).toBe(2)
      expect(run.stderr).toContain('okolos-agent serve')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
