/**
 * The walker every gate shares, checked against a directory built for the
 * purpose rather than against this repository.
 *
 * Reading the real tree would make these checks agree with whatever the tree
 * happens to hold today — and the defect this module exists to close was
 * precisely a gate whose verdict depended on which folders a person had opened
 * in Finder. So the fixtures are made here: a directory with a directory, a
 * file, and a dotfile in it, which is the shape `readdirSync` cannot tell apart
 * and this module must.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { directoriesIn, filesIn, filesUnder, posixRelative, toPosix } from './tree.mjs'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'okolos-tree-'))
  mkdirSync(path.join(dir, 'ru'))
  mkdirSync(path.join(dir, 'en'))
  writeFileSync(path.join(dir, '.DS_Store'), 'Finder wrote this')
  writeFileSync(path.join(dir, 'notes.md'), '# not a directory')
  writeFileSync(path.join(dir, 'messages.json'), '{}')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('directoriesIn', () => {
  it('names the directories and nothing else', () => {
    expect(directoriesIn(dir)).toEqual(['en', 'ru'])
  })

  it('excludes the dotfile that caused this module to exist', () => {
    // Named separately from the assertion above, because the general shape and
    // this specific entry are two different claims: a filter keyed on a leading
    // dot would satisfy one and not the other.
    expect(directoriesIn(dir)).not.toContain('.DS_Store')
  })

  it('differs from the raw read, so the filter is load-bearing', () => {
    // Without this, the two checks above would also pass against a `directoriesIn`
    // that did no filtering at all — on a fixture that happened to hold only
    // directories. The fixture holds three non-directories on purpose, and this
    // is what asserts the fixture is doing its job.
    const raw = ['.DS_Store', 'en', 'messages.json', 'notes.md', 'ru']
    expect(directoriesIn(dir)).not.toEqual(raw)
    expect(raw.length - directoriesIn(dir).length).toBe(3)
  })

  it('sorts, so a gate quoting a count cannot also depend on read order', () => {
    expect(directoriesIn(dir)).toEqual([...directoriesIn(dir)].sort())
  })
})

describe('filesIn', () => {
  it('keeps only files whose name ends with the suffix', () => {
    expect(filesIn(dir, '.json')).toEqual(['messages.json'])
  })

  it('excludes directories even when the suffix would match', () => {
    mkdirSync(path.join(dir, 'looks.json'))
    try {
      expect(filesIn(dir, '.json')).toEqual(['messages.json'])
    } finally {
      rmSync(path.join(dir, 'looks.json'), { recursive: true })
    }
  })

  it('a suffix nothing matches returns empty rather than everything', () => {
    // The failure mode worth pinning: a suffix check written as a truthiness
    // test would return the whole listing here.
    expect(filesIn(dir, '.nope')).toEqual([])
  })
})

describe('filesUnder', () => {
  /**
   * Built here, not read from the repository — the same reason the fixtures above are:
   * a check against the real tree agrees with whatever the tree happens to hold today,
   * and the defect this module closes was a verdict that depended on which folders
   * somebody had opened in Finder. My first version of these tests read `packages/`,
   * which is that mistake with a new name.
   */
  let deep: string

  beforeAll(() => {
    deep = mkdtempSync(path.join(tmpdir(), 'okolos-under-'))
    mkdirSync(path.join(deep, 'src', 'nested'), { recursive: true })
    mkdirSync(path.join(deep, 'node_modules', 'dep'), { recursive: true })
    mkdirSync(path.join(deep, 'dist'), { recursive: true })
    writeFileSync(path.join(deep, 'top.ts'), '')
    writeFileSync(path.join(deep, 'src', 'middle.ts'), '')
    writeFileSync(path.join(deep, 'src', 'nested', 'bottom.ts'), '')
    writeFileSync(path.join(deep, 'src', 'notes.md'), '')
    writeFileSync(path.join(deep, '.DS_Store'), 'Finder wrote this')
    writeFileSync(path.join(deep, 'node_modules', 'dep', 'index.ts'), '')
    writeFileSync(path.join(deep, 'dist', 'built.ts'), '')
  })

  afterAll(() => {
    rmSync(deep, { recursive: true, force: true })
  })

  it('finds every depth, and sorts', () => {
    const found = filesUnder(deep, '.ts').map((file) => posixRelative(deep, file))
    expect(found).toEqual(['src/middle.ts', 'src/nested/bottom.ts', 'top.ts'].sort())
  })

  it('skips node_modules and dist by default, because every caller did', () => {
    // Six gates walked the tree themselves and all six skipped exactly these two. The
    // parameter exists so a caller can say otherwise, not so each can invent a list.
    const found = filesUnder(deep, '.ts').map((file) => posixRelative(deep, file))
    expect(found.some((file) => file.startsWith('node_modules/'))).toBe(false)
    expect(found.some((file) => file.startsWith('dist/'))).toBe(false)
  })

  it('honours a caller that wants a different skip', () => {
    const found = filesUnder(deep, '.ts', { skip: ['node_modules'] }).map((file) =>
      posixRelative(deep, file),
    )
    expect(found).toContain('dist/built.ts')
    expect(found.some((file) => file.startsWith('node_modules/'))).toBe(false)
  })

  it('throws on a directory that is not there, rather than answering "no files"', () => {
    /**
     * The guard the eleven gates depend on and none of them exercises. A gate handed a
     * path that does not exist and answered with an empty list is absence reading as a
     * pass — this project's most-repeated defect — so the walker refuses, and the one
     * caller for whom missing is a real state (`build-age`, reporting "no build")
     * checks for it itself.
     */
    expect(() => filesUnder(path.join(deep, 'nowhere'), '.ts')).toThrow()
  })

  it('takes the suffix as a requirement, so a dotfile cannot pass as a source', () => {
    // The same reason `filesIn` demands one: a caller asking for "the files" is a
    // caller that will accept `.DS_Store` as one.
    expect(filesUnder(deep, '.ts').every((file) => file.endsWith('.ts'))).toBe(true)
    expect(filesUnder(deep, '.md').map((file) => path.basename(file))).toEqual(['notes.md'])
  })
})

describe('naming a file the way the repository does (B-164)', () => {
  it('turns a Windows separator into /, which is how every gate spells a path', () => {
    // The separator is a parameter so the Windows spelling is checked on every machine.
    expect(toPosix('packages\\ui\\src\\x.ts', '\\')).toBe('packages/ui/src/x.ts')
  })

  it('leaves a POSIX path exactly as it was', () => {
    expect(toPosix('packages/ui/src/x.ts', '/')).toBe('packages/ui/src/x.ts')
  })

  it('answers relative paths with / on this platform too', () => {
    expect(posixRelative(path.join('a', 'b'), path.join('a', 'b', 'c', 'd.ts'))).toBe('c/d.ts')
  })
})
