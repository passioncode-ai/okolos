/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest'

import { buildAgentProbe } from './build-agent-probe.mjs'

describe('the agent probe bundle (N-011)', () => {
  it('is one script that defines the probe, carries no extension API and no page marks, and cuts hidden text', { timeout: 60_000 }, async () => {
    const code = await buildAgentProbe()
    expect(code).toContain('__okolosAgentProbe')
    expect(code).not.toMatch(/\bchrome\.(runtime|storage|tabs)\b/)
    expect(code).not.toMatch(/performance\.(mark|measure)\(/)
    expect(code).not.toMatch(/^\s*(import|export)\s/m)
    expect(code.length).toBeLessThan(256 * 1024)

    document.body.innerHTML = '<p>Visible price</p><span style="font-size:0">shipping note for robots</span>'
    // The bundle is evaluated as the daemon evaluates it in the page's isolated world.
    new Function(code)()
    const probe = (globalThis as { __okolosAgentProbe?: (now: string) => { cut: Element[]; truncated: boolean; unresolved: number } }).__okolosAgentProbe
    expect(typeof probe).toBe('function')
    const result = probe?.('2026-11-19T00:00:00Z')
    expect(result?.cut.map((e) => e.textContent)).toEqual(['shipping note for robots'])
    expect(result).toMatchObject({ truncated: false, unresolved: 0 })
  })
})
