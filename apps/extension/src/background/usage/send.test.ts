import type { AuditEntry } from '@okolos/contracts'
import { describe, expect, it } from 'vitest'

import { createUsageSink } from './sink.js'
import { usageSender } from './send.js'

describe('a batch through the network module', () => {
  it('is audited as usage-data naming the event, and the redactor lets an ordinary event through', async () => {
    const audit: AuditEntry[] = []
    const seen: Array<{ url: string; headers?: Readonly<Record<string, string>> }> = []
    let state: Parameters<Parameters<typeof createUsageSink>[0]['save']>[0] | undefined
    const sink = createUsageSink({
      load: async () => state,
      save: async (next) => {
        state = next
      },
      send: usageSender({
        writeAudit: async (entry) => {
          audit.push(entry)
        },
        now: () => '2026-11-04T20:00:00.000Z',
        newId: () => 'a1',
        transport: async (spec) => {
          seen.push(spec)
          return new Response('{}', { status: 200 })
        },
      }),
      now: () => Date.parse('2026-11-04T20:00:00.000Z'),
      randomId: () => '6f0c2b0e-8b5e-4d8c-9a51-2f0f5c3d9e11',
      sessionId: () => '179046373831509896',
      appKey: 'A-SH-0000000000',
      environment: 'production',
      initialConsent: 'on',
      extensionVersion: '0.1.0',
      locale: 'en-US',
    })

    await sink.track('extension_installed', { reason: 'install' })
    await sink.track('error_occurred', { area: 'feed', kind: 'network' })
    await sink.flush()

    expect(audit).toHaveLength(2)
    expect(audit[0]).toMatchObject({
      purpose: 'usage-data',
      destination: 'analytics.passioncode.ai',
      payloadShape: 'usage-event:extension_installed',
      // The alarm that really sends it, so the row can be lined up with the network panel.
      triggeredBy: 'alarm:feeds',
      outcome: 'sent',
    })
    expect(audit[1]?.payloadShape).toBe('usage-event:error_occurred')
    expect(seen[0]?.url).toBe('https://analytics.passioncode.ai/api/v0/event')
    expect(state?.queue).toHaveLength(0)
  })

  it('gives up on a request that never answers, as a transport failure, so nothing waits behind it', async () => {
    const send = usageSender(
      {
        writeAudit: async () => undefined,
        now: () => '2026-11-04T20:00:00.000Z',
        newId: () => 'a1',
        transport: () => new Promise<Response>(() => {}),
      },
      20,
    )
    await expect(send({ url: 'https://analytics.passioncode.ai/api/v0/event', body: '{}', headers: {} })).rejects.toBeInstanceOf(TypeError)
  })
})
