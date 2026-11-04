import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { filesUnder } from './tree.mjs'

/**
 * Every message the contract names has somebody listening for it.
 *
 * `inference/score` was sent from the background for two months after the offscreen
 * document that answered it was removed (B-50, B-131). Sending a type nobody receives is
 * not an error anywhere: the adapter answers `undefined`, the caller reads "no score", and
 * the contract keeps describing a conversation that cannot happen.
 *
 * A receiver is a `case 'type'` in a switch over the message or a `message.type === 'type'`
 * test, in any shipped source of the extension: the background answers most of them, the
 * content script the ones pushed to a page.
 */

const root = path.resolve(import.meta.dirname, '..')

function contractTypes(): string[] {
  const source = readFileSync(path.join(root, 'packages/contracts/src/rpc.ts'), 'utf8')
  const start = source.indexOf('export interface RpcMap {')
  const end = source.indexOf('export type RpcType')
  return [...source.slice(start, end).matchAll(/^ {2}'([a-z-]+\/[a-z-]+)':/gm)].map((m) => m[1] as string)
}

function receivers(): string {
  return filesUnder(path.join(root, 'apps/extension/src'), '.ts')
    .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.bench.ts'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')
}

describe('every message in the contract has a receiver', () => {
  it('reads the contract, so an empty sweep cannot pass', () => {
    const types = contractTypes()
    expect(types.length).toBeGreaterThan(20)
    expect(types).toContain('leaks/check')
    expect(types).toContain('frame/finding')
  })

  it('finds a receiver for each type', () => {
    const code = receivers()
    const unanswered = contractTypes().filter(
      (type) => !code.includes(`case '${type}'`) && !code.includes(`message.type === '${type}'`),
    )
    expect(
      unanswered,
      'these types are in RpcMap and no context listens for them: remove them, or build the receiver',
    ).toEqual([])
  })
})
