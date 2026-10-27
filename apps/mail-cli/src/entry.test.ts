import { describe, expect, it } from 'vitest'

import { isEntry, type EntryHost } from './entry.js'

/**
 * B-161: the command decided whether to run by comparing the last `/`-separated
 * piece of `argv[1]` with the module URL. Windows hands `argv[1]` over with
 * backslashes, so the piece was the whole path, `main` never ran, and the
 * process exited 0, which `scan.ts` defines as "nothing found". A scan that
 * never happened read as a clean message.
 */
const windows: EntryHost = { platform: 'win32', realpath: (file) => file }
const posix: EntryHost = { platform: 'darwin', realpath: (file) => file }

describe('which file the process was started with', () => {
  it('recognises itself from a Windows argv path', () => {
    expect(
      isEntry(
        'file:///C:/Users/x/okolos/apps/mail-cli/dist/index.js',
        'C:\\Users\\x\\okolos\\apps\\mail-cli\\dist\\index.js',
        windows,
      ),
    ).toBe(true)
  })

  it('ignores case on Windows, where the file system does', () => {
    expect(
      isEntry(
        'file:///C:/Users/x/okolos/apps/mail-cli/dist/index.js',
        'c:\\users\\X\\okolos\\apps\\mail-cli\\dist\\INDEX.js',
        windows,
      ),
    ).toBe(true)
  })

  it('recognises itself from a POSIX argv path', () => {
    expect(
      isEntry(
        'file:///home/x/okolos/apps/mail-cli/dist/index.js',
        '/home/x/okolos/apps/mail-cli/dist/index.js',
        posix,
      ),
    ).toBe(true)
  })

  it('keeps case on POSIX, where two spellings are two files', () => {
    expect(
      isEntry(
        'file:///home/x/okolos/apps/mail-cli/dist/index.js',
        '/home/x/okolos/apps/mail-cli/dist/INDEX.js',
        posix,
      ),
    ).toBe(false)
  })

  it('compares whole paths, not the last name: another index.js is another file', () => {
    expect(
      isEntry('file:///home/x/okolos/apps/mail-cli/dist/index.js', '/home/x/elsewhere/index.js', posix),
    ).toBe(false)
    expect(
      isEntry(
        'file:///C:/Users/x/okolos/apps/mail-cli/dist/index.js',
        'C:\\Users\\x\\elsewhere\\index.js',
        windows,
      ),
    ).toBe(false)
  })

  it('follows a link to the real file, the way npm installs a command', () => {
    const linked: EntryHost = {
      platform: 'linux',
      realpath: (file) =>
        file === '/usr/local/bin/okolos-mail' ? '/home/x/okolos/apps/mail-cli/dist/index.js' : file,
    }
    expect(
      isEntry('file:///home/x/okolos/apps/mail-cli/dist/index.js', '/usr/local/bin/okolos-mail', linked),
    ).toBe(true)
  })

  it('accepts the path without its extension, which node resolves for a main file', () => {
    expect(
      isEntry('file:///home/x/okolos/apps/mail-cli/dist/index.js', '/home/x/okolos/apps/mail-cli/dist/index', posix),
    ).toBe(true)
  })

  it('resolves a relative argv path against the working directory', () => {
    expect(
      isEntry('file:///home/x/okolos/apps/mail-cli/dist/index.js', 'apps/mail-cli/dist/index.js', {
        ...posix,
        cwd: () => '/home/x/okolos',
      }),
    ).toBe(true)
  })

  it('is not the entry when there is no argv path, as under a REPL or an import', () => {
    expect(isEntry('file:///home/x/okolos/apps/mail-cli/dist/index.js', undefined, posix)).toBe(false)
    expect(isEntry('file:///home/x/okolos/apps/mail-cli/dist/index.js', '', posix)).toBe(false)
  })

  it('falls back to the path as given when the real path cannot be read', () => {
    const missing: EntryHost = {
      platform: 'linux',
      realpath: () => {
        throw new Error('ENOENT')
      },
    }
    expect(
      isEntry('file:///home/x/okolos/apps/mail-cli/dist/index.js', '/home/x/okolos/apps/mail-cli/dist/index.js', missing),
    ).toBe(true)
  })
})
