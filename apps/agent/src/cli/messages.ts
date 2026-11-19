import { readFileSync } from 'node:fs'
import path from 'node:path'

import { fromCatalogue, type Catalogue } from '@okolos/i18n'

import { defaultLocalesDir, type Locale } from '../service/messages.js'

/** Every catalogue key the CLI says to the person at the terminal. */
export const CLI_KEYS = ['cliPairCode', 'cliPairWaiting', 'cliPairSaved', 'cliPairRefused', 'cliNotPaired', 'cliPairExists', 'cliReleaseFailed'] as const

export interface CliMessages {
  /** The code to compare with the one Okolos Agent's page shows. */
  code(name: string, code: string): string
  waiting(): string
  saved(file: string): string
  refused(why: string): string
  notPaired(name: string): string
  /** The name already has a key here; `--replace` swaps it. */
  exists(name: string): string
  releaseFailed(name: string, why: string): string
}

export function cliMessages(locale: Locale, localesDir: string = defaultLocalesDir()): CliMessages {
  const file = path.join(localesDir, locale, 'messages.json')
  const catalogue = JSON.parse(readFileSync(file, 'utf8')) as Catalogue
  const missing = CLI_KEYS.filter((key) => typeof catalogue[key]?.message !== 'string')
  if (missing.length > 0) {
    // i18n-exempt: a start failure for whoever installs the daemon, naming the catalogue file and its missing keys
    throw new Error(`The agent catalogue ${file} lacks ${missing.join(', ')}.`)
  }
  const say = fromCatalogue(catalogue)
  return {
    code: (name, code) => say('cliPairCode', [name, code]),
    waiting: () => say('cliPairWaiting'),
    saved: (where) => say('cliPairSaved', [where]),
    refused: (why) => say('cliPairRefused', [why]),
    notPaired: (name) => say('cliNotPaired', [name]),
    exists: (name) => say('cliPairExists', [name]),
    releaseFailed: (name, why) => say('cliReleaseFailed', [name, why]),
  }
}
