import { describe, expect, it } from 'vitest'

describe('the loopback client', () => {
  it('refuses any host but this machine before a byte leaves', async () => {
    const { loopbackPost } = await import('./loopback.js')
    await expect(loopbackPost('http://attacker.test/mcp', '{}')).rejects.toThrow(/only to its own door/)
    await expect(loopbackPost('https://127.0.0.1/mcp', '{}')).rejects.toThrow(/only to its own door/)
  })
})
