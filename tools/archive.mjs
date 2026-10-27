/**
 * Making the release zip, and reading back what is in it.
 *
 * On macOS and Linux the archive is made by `zip -q -r -X`, as it always was. A stock
 * Windows has no `zip` (B-163), but Windows 10 and later ship bsdtar as
 * `%SystemRoot%\System32\tar.exe`, which writes a zip when the archive name ends in
 * `.zip` and `-a` is given. The full path is used because a Git for Windows shell puts
 * GNU tar first on PATH, and GNU tar cannot write a zip at all. No dependency is added:
 * the zip libraries in the lockfile are other packages' transitive ones.
 *
 * Two tools make two different byte streams, so what the release checks is the
 * archive's contents: `zipEntries` reads the names from the zip's central directory,
 * and the caller compares them with the files it meant to ship.
 */
import path from 'node:path'

/**
 * The command that writes `archive` from `files`, run with `cwd` set to their directory.
 *
 * @param {string} archive          absolute path of the zip to write
 * @param {readonly string[]} files paths relative to the build directory, `/`-separated
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {{ command: string, args: string[] }}
 */
export function archivePlan(archive, files, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const system = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
    // Files by name rather than `.`: bsdtar would store every entry as `./name`.
    return { command: path.win32.join(system, 'System32', 'tar.exe'), args: ['-a', '-c', '-f', archive, ...files] }
  }
  // `-X` drops the extra attributes that make two archives of identical bytes
  // differ; the store cares about none of them and a reviewer diffing two
  // releases does.
  return { command: 'zip', args: ['-q', '-r', '-X', archive, '.'] }
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_FILE_HEADER = 0x02014b50

/**
 * The entry names in a zip, from its central directory, in stored order.
 * Directory entries end in `/`. Throws on a buffer that is not a readable zip.
 *
 * @param {Uint8Array} bytes
 * @returns {string[]}
 */
export function zipEntries(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end record is 22 bytes plus a comment of at most 65535; search back for it.
  let end = -1
  for (let at = buf.length - 22; at >= Math.max(0, buf.length - 22 - 0xffff); at -= 1) {
    if (buf.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) {
      end = at
      break
    }
  }
  if (end < 0) throw new Error('not a zip: no end-of-central-directory record')
  const count = buf.readUInt16LE(end + 10)
  let at = buf.readUInt32LE(end + 16)
  const names = []
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL_FILE_HEADER) {
      throw new Error(`not a zip: central directory entry ${i} is damaged`)
    }
    const nameLength = buf.readUInt16LE(at + 28)
    const extraLength = buf.readUInt16LE(at + 30)
    const commentLength = buf.readUInt16LE(at + 32)
    names.push(buf.toString('utf8', at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
  }
  return names
}

/**
 * What differs between the files meant to ship and the files a zip holds, ignoring
 * directory entries and a leading `./`.
 *
 * @param {readonly string[]} entries  from `zipEntries`
 * @param {readonly string[]} expected relative, `/`-separated
 * @returns {{ missing: string[], extra: string[] }}
 */
export function compareEntries(entries, expected) {
  const held = new Set(entries.filter((name) => !name.endsWith('/')).map((name) => name.replace(/^\.\//, '')))
  const wanted = new Set(expected)
  return {
    missing: [...wanted].filter((name) => !held.has(name)).sort(),
    extra: [...held].filter((name) => !wanted.has(name)).sort(),
  }
}
