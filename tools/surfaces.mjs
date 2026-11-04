/**
 * The surfaces a store screenshot shows, and a digest of their content.
 *
 * Two callers, one definition: `tools/screenshots.mjs` records the digest when it takes
 * the images, and `tools/listing.test.ts` recomputes it to decide whether the images
 * still show the product.
 *
 * **Content, not history.** The first version of that gate compared commit dates — last
 * commit touching the screenshots against last touching these paths — and the rule can
 * demand the impossible: a surface change that alters no pixel leaves the four files
 * byte-identical, so git records nothing and no commit can ever satisfy it. The second
 * version had a subtler form of the same fault: a receipt naming a commit cannot name the
 * commit it is part of, so it is stale the moment it is committed.
 *
 * A digest of the content has neither problem. It changes whenever the surfaces change,
 * it is knowable before the commit exists, and it needs no repository history at all —
 * which also means it works on the shallow clone CI makes by default.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { filesUnder, posixRelative } from './tree.mjs'

/** What the four images actually render: the UI package, the options page, the style sheet. */
export const SURFACES = [
  'packages/ui/src',
  'apps/extension/src/options',
  'apps/extension/src/pages.css',
]

/**
 * What a surface is made of — named by suffix rather than "every file".
 *
 * Two reasons, both measured elsewhere in this repository. `readdirSync` returns
 * *entries*, and macOS writes `.DS_Store` into any folder Finder has displayed (B-58), so
 * "every file" would make this digest disagree between two machines looking at identical
 * code. And a test file changing alters no pixel: including `.test.ts` would demand a
 * re-shoot for work that cannot show up in an image.
 */
const SUFFIX = ['.ts', '.css', '.html']

/** Every surface file, sorted, so two machines walk them in the same order. */
function surfaceFiles(root) {
  const files = []
  for (const surface of SURFACES) {
    const absolute = path.join(root, surface)
    if (statSync(absolute).isDirectory()) {
      for (const suffix of SUFFIX) {
        files.push(...filesUnder(absolute, suffix).filter((file) => !file.endsWith('.test.ts')))
      }
    } else {
      files.push(absolute)
    }
  }
  // Sorted by the repository's spelling: a backslash sorts elsewhere than `/` (B-164).
  return files.sort((a, b) => {
    const left = posixRelative(root, a)
    const right = posixRelative(root, b)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/**
 * A digest over the content of every surface file.
 *
 * The path goes into the hash as well as the bytes: a file renamed with its content intact
 * changes what the screenshot shows — imports move, and a screen can stop being rendered
 * at all — so it must change the digest too.
 */
export function surfacesDigest(root) {
  const hash = createHash('sha256')
  for (const file of surfaceFiles(root)) {
    // `/` on every platform, so a Windows checkout of the same tree has the same digest.
    hash.update(posixRelative(root, file))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 32)
}
