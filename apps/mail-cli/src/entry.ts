import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What the entry decision needs from the machine, passed in so a test can be
 * Windows on a Mac.
 */
export interface EntryHost {
  readonly platform: NodeJS.Platform
  /** `fs.realpathSync`: a command installed as a link names the link, not the file. */
  readonly realpath: (file: string) => string
  /** Only for a relative `argv[1]`; node usually hands over an absolute one. */
  readonly cwd?: () => string
}

/**
 * Whether the module at `moduleUrl` is the file the process was started with.
 *
 * B-161. The first version compared the last `/`-separated piece of `argv[1]`
 * with the module URL. Windows hands `argv[1]` over with backslashes, so the
 * piece was the whole path, `main` never ran, and the process exited 0, which
 * `scan.ts` defines as "nothing found": a scan that never happened read as a
 * clean message. The same comparison also took any file called `index.js` for
 * this one.
 *
 * Whole paths now, each read by the rules of the platform it came from: the
 * URL through `fileURLToPath` with the platform's own separators, `argv[1]`
 * through its real path (a link resolved to the file it names), and case
 * folded on Windows, whose file system ignores it. A path without its
 * extension is accepted because node resolves one for a main file.
 *
 * The command itself does not depend on this: `bin/okolos-mail.mjs` calls
 * `run` unconditionally. This keeps a direct `node index.js` working and keeps an
 * import of the module from running anything.
 */
export function isEntry(moduleUrl: string, argv1: string | undefined, host: EntryHost): boolean {
  if (argv1 === undefined || argv1 === '') return false
  const windows = host.platform === 'win32'
  const paths = windows ? path.win32 : path.posix

  const module = paths.normalize(fileURLToPath(moduleUrl, { windows }))
  // The working directory only for a relative path: `cwd()` throws when the
  // directory was deleted under the process, and an absolute path needs none.
  const given = real(argv1, host)
  const invoked = paths.normalize(
    paths.isAbsolute(given) ? given : paths.resolve(host.cwd?.() ?? '', given),
  )

  const fold = (file: string): string => (windows ? file.toLowerCase() : file)
  const withoutExtension = module.slice(0, module.length - paths.extname(module).length)
  return fold(invoked) === fold(module) || fold(invoked) === fold(withoutExtension)
}

function real(file: string, host: EntryHost): string {
  try {
    return host.realpath(file)
  } catch {
    // A path that cannot be resolved is compared as given; the comparison
    // then fails closed for anything that is not literally this file.
    return file
  }
}
