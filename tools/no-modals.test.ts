import { readFileSync, globSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * This product answers on its own screens, never in one of the browser's dialogs.
 *
 * Two writes reported failure with a modal — the generic `act` wrapper every action on the
 * options page goes through, and the extensions area's disable. Four things are wrong with
 * that, and the last is the one that matters: it blocks the page until dismissed; its text
 * cannot be styled, so a sentence written through the brand pack arrives in a system box;
 * the accessibility sweep never sees it; and it reads as *the browser* failing rather than
 * as this product answering. Every other failure here is a slot on the screen, replaced
 * rather than appended — SCN-023 and SCN-024 both say so.
 *
 * A confirmation is the same rule from the other side: the wipe screen asks its question on
 * the page, listing one data kind per store, which no dialog could do.
 */

const root = path.resolve(import.meta.dirname, '..')

/** Product sources that run in a page or a content script. The proxy has no DOM at all. */
function sources(): string[] {
  return globSync(['apps/extension/src/**/*.ts', 'packages/*/src/**/*.ts'], {
    cwd: root,
    exclude: (p) => p.includes('.test.') || p.includes('/dist/'),
  })
}

describe('the browser’s own dialogs', () => {
  it('are not used to say anything to anybody', () => {
    // Assembled rather than written out, so this rule cannot match its own explanation —
    // a gate reading its own prose has happened four times in this repository.
    const banned = ['al' + 'ert', 'con' + 'firm', 'pro' + 'mpt']
    const offenders: string[] = []
    for (const source of sources()) {
      const text = readFileSync(path.join(root, source), 'utf8')
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        const call = banned.some((name) => new RegExp(`(?:window\\.)?\\b${name}\\s*\\(`).test(line))
        // A line that only mentions the word — a comment, a message key — is not a call.
        const commented = /^\s*(?:\/\/|\*|\/\*)/.test(line)
        if (call && !commented) offenders.push(`${source}:${index + 1}`)
      }
    }
    expect(
      offenders,
      'answer on the page instead — apps/extension/src/options/failure.ts is the slot, and its header says why',
    ).toEqual([])
  })

  it('is looking at real sources, so an empty walk cannot pass', () => {
    expect(sources().length).toBeGreaterThan(50)
  })
})
