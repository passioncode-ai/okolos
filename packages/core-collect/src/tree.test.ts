import { describe, expect, it } from 'vitest'

import { treeView, type AbstractNode } from './tree.js'

/** What the plain tree answers when the collector asks; the walk itself is `collect.test.ts`. */

const leaf: AbstractNode = { tag: 'span', text: 'leaf', key: 'k3' }
const middle: AbstractNode = {
  tag: 'div',
  attributes: { id: 'one' },
  text: 'own ',
  comments: [{ text: 'inner' }],
  children: [leaf],
}
const root: AbstractNode = { tag: 'html', comments: [{ text: 'top', key: 'c' }], children: [middle] }

describe('the view of a plain tree', () => {
  const view = treeView(root, [{ text: 'before html' }])

  it('knows every parent, and the root has none', () => {
    expect(view.parent(leaf)).toBe(middle)
    expect(view.parent(middle)).toBe(root)
    expect(view.parent(root)).toBeNull()
  })

  it('yields the comments outside the root first, then element by element in document order', () => {
    expect([...view.comments()].map((c) => c.text)).toEqual(['before html', 'top', 'inner'])
  })

  it('gives a node its own text and textContent the whole subtree', () => {
    expect(view.ownText(middle)).toBe('own ')
    expect(view.textContent(middle)).toBe('own leaf')
  })

  it('counts ids over the whole tree', () => {
    expect(view.idIsUnique(middle, 'one')).toBe(true)
    const twice = treeView({ tag: 'html', children: [middle, { tag: 'p', attributes: { id: 'one' } }] })
    expect(twice.idIsUnique(middle, 'one')).toBe(false)
    expect(view.idIsUnique(middle, 'missing')).toBe(false)
  })

  it('fills the style values a caller left out, and has none for a node with no style', () => {
    const styled = treeView({ tag: 'p', style: { display: 'none' } })
    const node = styled.root() as AbstractNode
    expect(styled.style(node)).toMatchObject({ display: 'none', opacity: '', backgroundColor: '' })
    expect(view.style(leaf)).toBeNull()
  })

  it('echoes the key and nothing else', () => {
    expect(view.key?.(leaf)).toBe('k3')
    expect(view.key?.(middle)).toBeUndefined()
  })

  it('answers an empty page', () => {
    const empty = treeView(null)
    expect(empty.root()).toBeNull()
    expect([...empty.comments()]).toEqual([])
  })
})
