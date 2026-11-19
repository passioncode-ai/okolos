import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A node id defined twice in one Mermaid flow merges two steps into one: Mermaid keeps the last
 * label and wires both steps' edges to it, so the drawn flow says something the text does not.
 * On 2026-10-27 a new FLW-22 step reused the id `Q` of «Panel asks the person» and the rendered
 * flow sent the approval panel to `invalid_scope`; docs/ux/lint.py does not read diagrams.
 *
 * What it does NOT catch: a wrong edge between two correctly named steps.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Ids that carry a label (`ID[...]`, `ID{...}`, `ID(...)`) more than once in one diagram. */
export function duplicateIds(diagram: string): string[] {
  const ids = [...diagram.matchAll(/(?:^|[\s>|])([A-Za-z_][A-Za-z0-9_]*)\s*[[{(]/gm)].map((m) => m[1]!)
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
}

const flows = readFileSync(path.join(root, 'docs/ux/flows.md'), 'utf8')
const diagrams = [...flows.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map((m) => m[1]!)

describe('every flow diagram defines each step once', () => {
  it('reads the diagrams, so an empty list cannot pass', () => {
    expect(diagrams.length).toBeGreaterThan(10)
  })

  it('has no node id labelled twice in one diagram', () => {
    expect(diagrams.flatMap((d, i) => duplicateIds(d).map((id) => `diagram ${i + 1}: ${id}`))).toEqual([])
  })

  it('would notice the id that merged two FLW-22 steps', () => {
    expect(duplicateIds('flowchart TD\n  Q[Agent asks] --> T[Task]\n  T --> Q[Panel asks the person]\n')).toEqual(['Q'])
  })
})
