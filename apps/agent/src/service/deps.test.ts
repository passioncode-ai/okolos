import { describe, expect, it } from 'vitest'

/**
 * Later nodes of the bridge import the contracts and the CDP pipe from apps/agent. A package
 * that is not declared in apps/agent/package.json resolves from the repository root by luck in
 * one runner and fails with ERR_MODULE_NOT_FOUND in another, so the resolution is asserted here,
 * from this directory, through the workspace links pnpm makes for the declared dependencies.
 */
describe('apps/agent resolves its workspace dependencies', () => {
  it('imports @okolos/contracts', async () => {
    const contracts = await import('@okolos/contracts')
    expect(contracts.BRIDGE_VERBS.length).toBeGreaterThan(0)
  })

  it('imports @okolos/cdp-pipe', async () => {
    const pipe = await import('@okolos/cdp-pipe')
    expect(typeof pipe.CdpPipe).toBe('function')
  })

  it('imports @okolos/core-snapshot', async () => {
    const snapshot = await import('@okolos/core-snapshot')
    expect(typeof snapshot.buildSnapshot).toBe('function')
    expect(typeof snapshot.pageOf).toBe('function')
  })

  it('imports @okolos/storage', async () => {
    const storage = await import('@okolos/storage')
    expect(storage.RETENTION_DAYS.journal).toBeGreaterThan(0)
  })
})
