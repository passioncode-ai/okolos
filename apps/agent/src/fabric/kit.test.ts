import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as kit from './fabric-service.mjs'

/**
 * The vendored Fabric kit holds the service's guard (checkRequest, tokenMatches, LoginCodes), and the
 * gates exempt it from lint and the sibling-test rule. So this test is what notices an edit:
 *
 * - every `.mjs` here has the SHA-256 that `kit-manifest.json` records, taken from the digests in
 *   the plugin's `kit.json` (fabric-agent-adapter 0.52.0) when the kit was installed; a reinstall of
 *   another version rewrites the manifest in the same change;
 * - every value `fabric-service.d.mts` declares is exported by the kit, with the kind declared, so
 *   the types the service is checked against cannot drift from the code it runs.
 */

const here = path.dirname(fileURLToPath(import.meta.url))

interface Manifest {
  kit: string
  version: string
  files: Record<string, string>
}

const manifest = JSON.parse(readFileSync(path.join(here, 'kit-manifest.json'), 'utf8')) as Manifest
const vendored = readdirSync(here)
  .filter((name) => name.endsWith('.mjs'))
  .sort()

describe('the vendored Fabric kit is the one recorded', () => {
  it('records the kit and its version', () => {
    expect(manifest.kit).toBe('fabric-service-kit')
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('has exactly the files the manifest lists', () => {
    expect(vendored).toEqual(Object.keys(manifest.files).sort())
    expect(vendored.length).toBeGreaterThan(10)
  })

  for (const name of vendored) {
    it(`${name} has its recorded SHA-256`, () => {
      const digest = createHash('sha256').update(readFileSync(path.join(here, name))).digest('hex')
      expect(digest).toBe(manifest.files[name])
    })
  }
})

describe('our declarations match what the kit exports', () => {
  const declarations = readFileSync(path.join(here, 'fabric-service.d.mts'), 'utf8')
  const declared = [...declarations.matchAll(/^export (const|function|class) (\w+)/gm)].map((m) => ({
    kind: m[1] as 'const' | 'function' | 'class',
    name: m[2] as string,
  }))

  it('declares values at all, so an empty sweep cannot pass', () => {
    expect(declared.length).toBeGreaterThan(20)
  })

  for (const { kind, name } of declared) {
    it(`${kind} ${name} is exported as declared`, () => {
      const value = (kit as Record<string, unknown>)[name]
      expect(value, `${name} is not exported by fabric-service.mjs`).toBeDefined()
      // A declared function or class must be callable; a const may be any defined value.
      expect(kind === 'const' || typeof value === 'function', `${name} is not a ${kind}`).toBe(true)
    })
  }
})
