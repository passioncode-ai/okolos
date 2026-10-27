import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { INSTANCE, PORT, SERVICE_ID, serviceDirs } from './dirs.js'

describe('where Okolos Agent keeps its things', () => {
  it('is the service okolos-agent.default on port 47871', () => {
    expect(SERVICE_ID).toBe('okolos-agent')
    expect(INSTANCE).toBe('default')
    expect(PORT).toBe(47871)
  })

  it('keeps data, logs and cache under the home it is given', () => {
    const home = path.join(os.tmpdir(), 'someone')
    expect(serviceDirs(home)).toEqual({
      data: path.join(home, 'Library', 'Application Support', 'okolos-agent'),
      logs: path.join(home, 'Library', 'Logs', 'okolos-agent'),
      cache: path.join(home, 'Library', 'Caches', 'okolos-agent'),
    })
  })

  it('uses the person’s home when given none, and only names the folders', () => {
    // A name, not a side effect: nothing is created by asking.
    expect(serviceDirs().data).toBe(
      path.join(os.homedir(), 'Library', 'Application Support', 'okolos-agent'),
    )
  })
})
