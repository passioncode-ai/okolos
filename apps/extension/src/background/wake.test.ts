import { describe, expect, it, vi } from 'vitest'
import { createPlatform } from '@okolos/platform'
import type { WebExtensionApi } from '@okolos/platform'
import { FEED_INTERVAL_MS, INVENTORY_INTERVAL_MS, SWEEP_INTERVAL_MS } from '@okolos/storage'

import { ensureRules, memoryDueStore, runIfDue, WAKE_ALARMS } from './wake.js'

/**
 * What a service-worker wake-up costs (LC-08: idle means idle).
 *
 * An MV3 worker wakes for every page that messages it, so anything at the top of
 * the background runs hundreds of times a day. Before this, each wake rebuilt every
 * blocking rule (remove-all, add-all), listed every installed extension, and reset
 * all three alarms — the daily inventory alarm never fired at all. These tests drive
 * the real adapter on a fake clock and count the work.
 */

const HOUR = 60 * 60 * 1000
const START = Date.parse('2026-10-03T00:00:00.000Z')

function fakeChrome() {
  const alarms = new Map<string, { name: string; periodInMinutes: number }>()
  const calls = { alarmCreate: 0, dnrUpdate: 0, managementGetAll: 0 }
  let rules: Array<{ id: number }> = []
  const api = {
    storage: { local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined } },
    alarms: {
      create: (name: string, info: { periodInMinutes: number }) => {
        calls.alarmCreate += 1
        alarms.set(name, { name, periodInMinutes: info.periodInMinutes })
      },
      get: async (name: string) => alarms.get(name),
      onAlarm: { addListener: vi.fn() },
    },
    runtime: {
      getURL: (p: string) => `chrome-extension://test/${p}`,
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn() },
    },
    tabs: { query: async () => [], create: vi.fn() },
    declarativeNetRequest: {
      getDynamicRules: async () => rules,
      updateDynamicRules: async (update: { removeRuleIds?: number[]; addRules?: unknown[] }) => {
        calls.dnrUpdate += 1
        rules = (update.addRules ?? []) as Array<{ id: number }>
      },
    },
    management: {
      getAll: async () => {
        calls.managementGetAll += 1
        return []
      },
      setEnabled: async () => undefined,
      getSelf: async () => ({ id: 'self' }),
    },
  } as unknown as WebExtensionApi
  return { api, calls, setRules: (n: number) => (rules = Array.from({ length: n }, (_, i) => ({ id: i + 1 }))) }
}

/** One wake-up, doing what the top of `background/index.ts` does. */
async function wake(
  platform: ReturnType<typeof createPlatform>,
  store: ReturnType<typeof memoryDueStore>,
  now: number,
  work: { feed: () => Promise<void>; sweep: () => Promise<void>; review: () => Promise<void> },
): Promise<void> {
  await Promise.all([
    runIfDue(store, 'feed:lastAttemptedAt', FEED_INTERVAL_MS, now, work.feed),
    runIfDue(store, 'retention:lastSweptAt', SWEEP_INTERVAL_MS, now, work.sweep),
    runIfDue(store, 'inventory:lastReviewedAt', INVENTORY_INTERVAL_MS, now, work.review),
    ...WAKE_ALARMS.map((alarm) => platform.alarms.create(alarm.name, alarm.periodInMinutes)),
  ])
}

describe('a day of wake-ups on a fake clock', () => {
  it('stays inside the idle budget: daily work runs daily, alarms are created once, rules are left alone', async () => {
    const chrome = fakeChrome()
    const platform = createPlatform('chrome', chrome.api)
    const store = memoryDueStore()
    let feeds = 0
    let sweeps = 0
    const review = async () => {
      await (chrome.api.management as { getAll(): Promise<unknown> }).getAll()
    }

    // One wake a minute for twenty-four hours: a browser in steady use.
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      await wake(platform, store, START + minute * 60_000, {
        feed: async () => void (feeds += 1),
        sweep: async () => void (sweeps += 1),
        review,
      })
    }

    expect(chrome.calls.alarmCreate, 'three alarms, created once each').toBe(3)
    expect(chrome.calls.managementGetAll, 'the inventory is a daily review').toBe(1)
    expect(feeds, 'a feed pull every six hours').toBe(4)
    expect(sweeps, 'a retention sweep every twelve hours').toBe(2)
    expect(chrome.calls.dnrUpdate, 'no wake-up rebuilds the rules').toBe(0)
  })
})

describe('running work only when it is owed', () => {
  it('records the attempt before the work, so a failure does not retry on every wake', async () => {
    const store = memoryDueStore()
    const failing = vi.fn(async () => {
      throw new Error('management is unavailable')
    })
    await expect(runIfDue(store, 'k', HOUR, START, failing)).resolves.toBe(true)
    await expect(runIfDue(store, 'k', HOUR, START + 60_000, failing)).resolves.toBe(false)
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it('runs again once the interval has passed', async () => {
    const store = memoryDueStore()
    const work = vi.fn(async () => undefined)
    await runIfDue(store, 'k', HOUR, START, work)
    await runIfDue(store, 'k', HOUR, START + HOUR, work)
    expect(work).toHaveBeenCalledTimes(2)
  })
})

describe('repairing the rules only when they are wrong', () => {
  it('leaves rules that already match the stored feed', async () => {
    const rebuild = vi.fn(async () => undefined)
    await expect(
      ensureRules({ installed: async () => 3, expected: async () => 3, rebuild }),
    ).resolves.toBe('kept')
    expect(rebuild).not.toHaveBeenCalled()
  })

  it('rebuilds when the installed count differs — a browser that lost them, or never had them', async () => {
    const rebuild = vi.fn(async () => undefined)
    await expect(
      ensureRules({ installed: async () => 0, expected: async () => 250, rebuild }),
    ).resolves.toBe('rebuilt')
    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a stored feed, exactly as the rebuild itself would', async () => {
    const rebuild = vi.fn(async () => undefined)
    await expect(
      ensureRules({ installed: async () => 0, expected: async () => null, rebuild }),
    ).resolves.toBe('kept')
    expect(rebuild).not.toHaveBeenCalled()
  })

  it('works against the adapter: a correct set is left alone, a missing one is installed once', async () => {
    const chrome = fakeChrome()
    const platform = createPlatform('chrome', chrome.api)
    chrome.setRules(5)
    const rebuild = async () => platform.blocking.replaceRules(Array.from({ length: 5 }, (_, i) => ({ id: i + 1 })))
    await ensureRules({ installed: () => platform.blocking.ruleCount(), expected: async () => 5, rebuild })
    expect(chrome.calls.dnrUpdate).toBe(0)
    chrome.setRules(0)
    await ensureRules({ installed: () => platform.blocking.ruleCount(), expected: async () => 5, rebuild })
    await ensureRules({ installed: () => platform.blocking.ruleCount(), expected: async () => 5, rebuild })
    expect(chrome.calls.dnrUpdate).toBe(1)
  })
})
