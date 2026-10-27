import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// @ts-expect-error — a plain .mjs helper, deliberately untyped
import { PLACEHOLDER, renderConfig } from './deploy-config.mjs'

/**
 * REQ-25's deploy, on the part of it that can be tested without deploying.
 *
 * The id substitution is the step where a mistake is quiet: a config that
 * still says `set-at-deploy` fails at wrangler with an obscure message, and a
 * config carrying the wrong id deploys against someone else's database.
 */

const root = path.resolve(import.meta.dirname, '..')
const template = readFileSync(path.join(root, 'apps/proxy/wrangler.toml'), 'utf8')
/** Shaped like a D1 id and deliberately not one: this file is public. */
const ID = '00000000-0000-4000-8000-000000000000'

describe('rendering the deploy config', () => {
  it('leaves the placeholder in the template that is committed', () => {
    // The repository must not carry a real account's database id: a clone that
    // deploys would deploy into it.
    expect(template).toContain(PLACEHOLDER)
    expect(template).not.toMatch(/database_id = "[0-9a-f]{8}-/)
  })

  it('substitutes the id and leaves nothing else changed', () => {
    const out = renderConfig(template, ID)
    expect(out).toContain(`database_id = "${ID}"`)
    expect(out).not.toContain(PLACEHOLDER)
    expect(out.split(/\r?\n/)).toHaveLength(template.split(/\r?\n/).length)
  })

  it('refuses an id that is not a uuid, rather than deploying against it', () => {
    for (const bad of ['', 'set-at-deploy', 'okolos', 'deadbeef', '../../etc/passwd']) {
      expect(() => renderConfig(template, bad), `accepted ${JSON.stringify(bad)}`).toThrow()
    }
  })

  it('refuses a template that has lost its placeholder', () => {
    expect(() => renderConfig('name = "okolos-proxy"\n', ID)).toThrow(/placeholder/)
  })
})
