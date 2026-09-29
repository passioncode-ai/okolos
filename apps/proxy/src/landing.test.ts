import { describe, expect, it } from 'vitest'

import { handle } from './router.js'

/**
 * The landing page has two readers and must satisfy both from the markup.
 *
 * A person asks what this is and whether it can be trusted. A crawler or an
 * assistant arrives to quote it and can only quote what is already there — so
 * the answer cannot arrive later, from a script, and the page has none.
 *
 * These rules are the ones that would otherwise be checked once by hand and
 * then quietly stop being true: a title that grew past what a result shows, a
 * description that vanished in a refactor, a script added for one small thing.
 */

const env = {} as never

async function landing(): Promise<{ status: number; html: string }> {
  const response = await handle(new Request('https://okolos-proxy.workers.dev/'), env)
  return { status: response.status, html: await response.text() }
}

describe('the landing page a stranger and a crawler both read', () => {
  it('answers at the root at all', async () => {
    const { status, html } = await landing()
    expect(status).toBe(200)
    expect(html.length).toBeGreaterThan(1500)
  })

  it('names itself in a title short enough to survive a result listing', async () => {
    const { html } = await landing()
    const title = /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? ''
    expect(title).toContain('Okolos')
    expect(title.length).toBeGreaterThan(20)
    expect(title.length).toBeLessThan(70)
  })

  it('carries a description a machine can quote instead of composing one', async () => {
    const { html } = await landing()
    const description = /<meta name="description" content="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(description.length).toBeGreaterThan(80)
    expect(description.length).toBeLessThan(200)
  })

  it('says which address is the real one', async () => {
    const { html } = await landing()
    expect(html).toContain('<link rel="canonical"')
  })

  it('repeats itself in the form a machine reads, and the JSON is valid', async () => {
    const { html } = await landing()
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
    // An invalid block is worse than none: it is a claim to be structured that
    // every reader discards.
    const data = JSON.parse(block) as { '@type': string; name: string; license: string }
    expect(data['@type']).toBe('SoftwareApplication')
    expect(data.name).toBe('Okolos')
    // The organisation's terms (LICENSING.md, ADR-0015), not the AGPL it replaced.
    expect(data.license).toContain('polyformproject.org/licenses/noncommercial')
  })

  it('runs nothing to say what it says', async () => {
    const { html } = await landing()
    // The structured block is data, not code; anything else executes.
    const executable = html.match(/<script(?![^>]*ld\+json)/g) ?? []
    expect(executable).toEqual([])
  })

  it('has one heading and sections under it, not a wall', async () => {
    const { html } = await landing()
    expect(html.match(/<h1>/g) ?? []).toHaveLength(1)
    expect((html.match(/<h2/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('explains the rest of the site by linking to it', async () => {
    const { html } = await landing()
    expect(html).toContain('href="/privacy"')
    expect(html).toContain('href="/status"')
  })

  it('spends as much space on what it does not do as on what it does', async () => {
    const { html } = await landing()
    // A security tool that lists only its powers is describing a product nobody
    // can check. Both lists exist and neither is a token gesture.
    const does = /data-role="does"([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? ''
    const doesNot = /data-role="does-not"([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? ''
    expect((does.match(/<li>/g) ?? []).length).toBeGreaterThanOrEqual(5)
    expect((doesNot.match(/<li>/g) ?? []).length).toBeGreaterThanOrEqual(5)
  })

  it('uses none of the words the brand pack forbids', async () => {
    /**
     * Read from the **text**, not from the markup.
     *
     * This checked the raw HTML, and on 2026-08-21 it went red on `inline-size: 100%` inside
     * the stylesheet the page had just gained: a CSS length is not a claim to a reader. The
     * same shape as a gate reading its own prose — the rule was right and the layer was
     * wrong. Styles, scripts and tags come out first; what is left is what a person reads,
     * which is what the brand pack is about.
     */
    const { html } = await landing()
    const text = html
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<[^>]*>/g, ' ')
    for (const word of ['полностью', 'гарантированно', '100%']) {
      expect(text, `the landing page says "${word}"`).not.toContain(word)
    }
    // The stripping must not empty the page: a blank string contains nothing at all.
    expect(text, 'nothing left to check after stripping').toContain('Okolos')
  })

  it('is in the language the product ships in', async () => {
    const { html } = await landing()
    expect(html).toContain('<html lang="ru">')
  })
})
