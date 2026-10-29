import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { SCREENS, attributeRoles, composedRoles, rolesOf, wireframe } from './wireframes.mjs'

/**
 * The wireframes are generated, so this test is what makes them true.
 *
 * A screen that gains a control now fails the build until its wireframe is
 * regenerated. Without this the generator would be a one-off script and the
 * files would drift back into fiction within a release — which is what a
 * hand-written wireframe does, only faster.
 */

const root = process.cwd()
const read = (id: string): string =>
  readFileSync(path.join(root, 'docs/ux/wireframes', `${id}.md`), 'utf8')

describe('every screen has a wireframe, and it is current', () => {
  for (const id of Object.keys(SCREENS)) {
    it(`${id} matches what its renderer emits`, () => {
      expect(read(id)).toBe(wireframe(id))
    })
  }
})

describe('the generator reads something real', () => {
  it('finds elements in every screen, so an empty result cannot pass as agreement', () => {
    // Two empty strings compare equal. If the extraction silently returned
    // nothing, every test above would go green on nothing at all.
    for (const [id, screen] of Object.entries(SCREENS)) {
      expect(rolesOf(screen.source).length, `${id} has no addressable elements`).toBeGreaterThan(2)
    }
  })

  it('names the renderer as the authority, not the document', () => {
    expect(read('SCR-06')).toContain('the renderer is right and this file is stale')
  })
})

describe('the generator and the cross-check mean the same thing by "elements"', () => {
  it('lists every composed role the check knows about', () => {
    /**
     * The defect this closes (B-71). `popup.ts` renders the queue from
     * `queue/queue.ts`, so `[data-role=item]` is addressable on SCR-02 — the cross-check
     * walked one hop of imports and knew that, and the generated wireframe listed one
     * file's roles under a heading that said "elements of the screen". Two answers to the
     * same question, and the one a person reads was the narrower.
     *
     * Both sides call `composedRoles` now, and this holds the output to it: a generator
     * that goes back to own-roles-only fails here rather than quietly shipping a document
     * that omits what is on the screen.
     */
    let composedTotal = 0
    for (const [id, screen] of Object.entries(SCREENS)) {
      const text = wireframe(id)
      const own = new Set(rolesOf(screen.source))
      for (const { role } of composedRoles(screen.source)) {
        if (own.has(role)) continue
        composedTotal += 1
        expect(text, `${id} omits the composed role ${role}`).toContain(`\`${role}\``)
      }
    }
    // At least one screen must actually be composed, or this passes on an empty walk —
    // which is what it would have done had the walk been broken instead of the generator.
    expect(composedTotal, 'no screen composed anything — the import walk is broken').toBeGreaterThan(
      0,
    )
  })

  it('keeps a role the screen also emits in its own list, not attributed elsewhere', () => {
    /**
     * Tested directly, because the tree has no instance of it: no screen here emits a
     * role one of its components also emits. That is what makes this a rule worth pinning
     * rather than one worth trusting — the day two files both emit `title`, the wireframe
     * would otherwise tell a reader to change the component when the screen is what
     * writes it. A guard whose case the tree does not contain cannot be checked through
     * the tree.
     */
    const composed = [
      { role: 'title', from: 'a/b.ts' },
      { role: 'item', from: 'a/b.ts' },
      { role: 'item', from: 'c/d.ts' },
    ]
    expect(attributeRoles(['title', 'footer'], composed)).toEqual([
      { role: 'item', from: 'a/b.ts' },
    ])
  })

  it('names the file to change beside a composed role, and not for its own', () => {
    // A reader who wants to change `item` must be sent to `queue/queue.ts`, not to
    // `popup.ts`. A role the screen emits itself carries no "from" for the same reason:
    // sending them to a component that also happens to emit it would be a wrong address.
    const text = wireframe('SCR-02')
    expect(text).toContain('— from `packages/ui/src/queue/queue.ts`')
    const popup = SCREENS['SCR-02']
    if (popup === undefined) throw new Error('SCR-02 is not in SCREENS')
    for (const role of rolesOf(popup.source)) {
      expect(text, `${role} is the screen's own and was attributed elsewhere`).not.toContain(
        `\`${role}\` — from`,
      )
    }
  })

  it('says which kind of element each list holds', () => {
    // The heading was the actual defect: "Elements, in the order the renderer emits them"
    // over a list that was one file's roles. A reader cannot tell a screen with nothing
    // composed from a generator that cannot see composition unless the document says
    // which it is.
    const composed = wireframe('SCR-02')
    expect(composed).toContain('Elements this screen emits itself')
    expect(composed).toContain('through the components it composes')

    const plain = wireframe('SCR-16')
    expect(plain).toContain('Elements this screen emits itself')
    expect(plain).not.toContain('through the components it composes')
  })
})

describe('the extractor knows about every shape the sources use', () => {
  /**
   * `rolesOf` reads source text and reports the shapes it was taught. On
   * 2026-08-20 a renderer moved from `text(doc, 'wipe-failed', …)` to a local
   * helper `note('wipe-failed', …)`, and the role disappeared from SCR-12's
   * wireframe while the screen still emitted it — and `export-failed`, added in
   * the same change, never appeared at all. The generated file went from true to
   * confidently wrong, and the test above stayed green because it compares the
   * file to the extractor rather than either to the screen.
   *
   * So: the roles a component's **own tests** reach for must all be in its
   * wireframe. Two artefacts maintained by different hands for different reasons,
   * and where they disagree one of them is wrong — which is the only kind of
   * check that catches an extractor being taught too little.
   */
  /**
   * One hop of composition, and it is the generator's function now.
   *
   * This test walked the imports itself and the generator did not, so the gate knew
   * about composition while the document it guards listed one file's roles under a
   * heading that said "elements of the screen" (B-71). Two answers to "what is on this
   * screen", and the one a person reads was the narrower. Importing it here is the whole
   * fix: the wireframe lists composed roles in their own section, and this check and
   * that section can no longer mean different things.
   */
  const testFileFor = (source: string): string | null => {
    const candidate = source.replace(/\.ts$/, '.test.ts')
    try {
      return readFileSync(path.join(root, candidate), 'utf8')
    } catch {
      return null
    }
  }

  it('reports every role a screen’s own tests address', () => {
    const missing: string[] = []
    let checked = 0
    for (const [id, screen] of Object.entries(SCREENS)) {
      const tests = testFileFor(screen.source)
      if (!tests) continue
      checked += 1
      /**
       * Roles the tests expect to *find*, which is not every role they name.
       *
       * A test may assert a role is absent — `[data-role=spinner]` in SCR-01 is
       * asserted null, because a bare spinner is what that screen deliberately
       * does not show. Reading those as "the screen has this" would demand a
       * wireframe entry for an element that must not exist.
       *
       * Lines mentioning `toBeNull` are therefore skipped. That is a heuristic on
       * test text, and it errs by **losing** a comparison rather than inventing
       * one: a positive assertion written on the same line as a negative one goes
       * unchecked, and nothing false is asserted.
       */
      const addressed = new Set(
        tests
          .split(/\r?\n/)
          .filter((line) => !line.includes('toBeNull'))
          .flatMap((line) => [...line.matchAll(/\[data-role=([a-z0-9-]+)\]/g)])
          .map((m) => m[1] as string),
      )
      // One hop through the screen's own local imports: a screen composes
      // components, and their roles are addressable on it. `packages/ui/src/popup`
      // renders the queue, so `[data-role=item]` is reachable there and no amount
      // of reading `popup.ts` will say so.
      const known = new Set([
        ...rolesOf(screen.source),
        ...composedRoles(screen.source).map((entry: { role: string }) => entry.role),
      ])
      for (const role of addressed) {
        if (!known.has(role)) missing.push(`${id}: ${role}`)
      }
    }
    // The check must have had something to read, or an empty comparison passes.
    expect(checked, 'no screen source has a test file beside it — the pairing broke').toBeGreaterThan(
      4,
    )
    expect(
      missing,
      'roles the tests click on and the wireframe does not list — the extractor has not been taught this shape',
    ).toEqual([])
  })
})

describe('a wireframe lists every state its screen record declares', () => {
  it('carries states beyond the four generic ones', async () => {
    // It read only rows named loading, empty, error or success, so the key states of
    // SCR-08 and SCR-12 (B-125) were in the record and missing from the wireframe the
    // record is drawn into.
    const { statesOf } = await import('./wireframes.mjs')
    const names = (id: string) => statesOf(id).map((entry: { state: string }) => entry.state)
    expect(names('SCR-08')).toEqual(expect.arrayContaining(['loading', 'success', 'key unreadable', 'idle, by key state']))
    expect(names('SCR-12')).toEqual(expect.arrayContaining(['no key', 'key saved', 'refused', 'success']))
    for (const id of ['SCR-08', 'SCR-12']) {
      expect(names(id), 'the header row is not a state').not.toContain('State')
    }
  })

  it('leaves out a state the record struck through, and lists each state once', async () => {
    const { SCREENS, statesOf } = await import('./wireframes.mjs')
    expect(statesOf('SCR-04').map((entry: { state: string }) => entry.state)).not.toContain('~~loading~~')
    for (const id of Object.keys(SCREENS)) {
      const names = statesOf(id).map((entry: { state: string }) => entry.state)
      expect(names.some((name: string) => name.includes('~~')), `${id} copies a struck row`).toBe(false)
      expect(new Set(names).size, `${id} lists a state twice: ${names.join(', ')}`).toBe(names.length)
    }
  })
})
