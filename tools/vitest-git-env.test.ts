import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { dropGitLocation, GIT_LOCATION } from './vitest-git-env'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('tests run without the hook’s GIT_DIR (B-160)', () => {
  it('is loaded as a setup file for every test', () => {
    expect(readFileSync(path.join(root, 'vitest.config.ts'), 'utf8')).toMatch(/setupFiles:\s*\[[^\]]*'tools\/vitest-git-env\.ts'/)
  })

  it('removes every location variable git reads, and nothing else', () => {
    const env: Record<string, string | undefined> = { PATH: '/bin', HOME: '/h' }
    for (const name of GIT_LOCATION) env[name] = '/somewhere/.git'
    dropGitLocation(env)
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' })
  })

  it('leaves this worker, and a child it starts, with none of them', () => {
    for (const name of GIT_LOCATION) expect(process.env[name], name).toBeUndefined()
    const child = spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(${JSON.stringify(GIT_LOCATION)}.filter((n) => n in process.env)))`], { encoding: 'utf8' })
    expect(JSON.parse(child.stdout)).toEqual([])
  })
})
