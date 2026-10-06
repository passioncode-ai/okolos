import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { globSync, readFileSync, statSync } from 'node:fs'

import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { KNOWN_HASHES, routeFor } from '../../apps/extension/src/options/views.js'

/**
 * The gates that read what actually ships.
 *
 * ESLint checks the source, which is where a mistake is written — but it reads
 * only the files it is pointed at, and a rule can be silently overridden by a
 * later config block (that exact failure happened once already in this repo).
 * These tests read the built output instead. A promise about what the product
 * does at runtime should be checked against the artefact that runs.
 */

const root = process.cwd()

/** The one module allowed to perform network I/O. */
const TRANSPORT_SOURCE = 'packages/net/src/transport.ts'

const BROWSER_TOKENS = [
  'document.',
  'window.',
  'chrome.',
  'browser.',
  'localStorage',
  'indexedDB',
]
const NETWORK_TOKENS = ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'new WebSocket']

let buildError: string | null = null

const run = promisify(execFile)

/**
 * Asynchronous on purpose. `execFileSync` held the worker's event loop for the
 * whole typecheck and build, and on a loaded machine (load average 340–470,
 * measured 2026-10-06) that outlasted vitest's worker RPC timeout: every test
 * passed and the run still failed with "Timeout calling onTaskUpdate", which
 * blocked the pre-push gate. Awaiting a child process keeps the loop free to
 * answer the runner.
 */
async function build(): Promise<void> {
  // tsc -b emits every package's dist; the extension bundles come from vite.
  try {
    await run('pnpm', ['typecheck'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    await run('pnpm', ['build'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  } catch (cause) {
    // Caught rather than thrown: a throw in beforeAll marks these tests
    // *skipped*, and a gate that reports "skipped" when the thing it guards is
    // broken is worse than no gate — it reads as absence of a problem. Found
    // by planting a defect that broke the build.
    buildError = cause instanceof Error ? cause.message : String(cause)
  }
}

function filesIn(pattern: string): string[] {
  return globSync(pattern, { cwd: root }).map((p) => path.join(root, p))
}

/**
 * Removes string, template and regex literals, and comments.
 *
 * A browser API cannot be *called* from inside a string, so a token found
 * there is a mention rather than a use — and one package's whole job is to
 * mention them: the extension analyser searches other people's code for
 * `document.cookie` and `localStorage.getItem`. Scanning the raw text made
 * that package unshippable and the only alternatives were exempting it (which
 * blinds the gate for everything in it) or splicing the strings so the scanner
 * cannot read them (which makes the source worse to satisfy a tool).
 *
 * Stripping literals is the third option, and it narrows nothing: every real
 * call still shows up, as the planted-defect check below asserts.
 *
 * **Only on source, never on a minified bundle.** The regex-literal pass has to
 * guess where a regex starts, and minified output is full of division and of
 * slashes inside surviving strings — so a false opening runs to the next slash
 * and deletes everything between. Measured 2026-08-20: a gate that read a bundle
 * through this helper stayed green with `crypto.randomUUID()` plainly present in
 * the file, because the span containing it had been eaten. The bundle checks in
 * this file read the raw text for exactly that reason, and a token found in a
 * bundle's string literal is rare enough to name as an exception when it happens.
 */
function executable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    // Regex literals last, and before the string passes above would have eaten
    // their quotes: a pattern like /['"`]/ contains quote characters, and
    // stripping strings first turns the rest of the file into nonsense.
    .replace(/\/(?![*/])(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/g, '/re/')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

function offenders(files: string[], tokens: string[]): Array<{ file: string; token: string }> {
  const hits: Array<{ file: string; token: string }> = []
  for (const file of files) {
    const source = executable(readFileSync(file, 'utf8'))
    for (const token of tokens) {
      if (source.includes(token)) hits.push({ file: path.relative(root, file), token })
    }
  }
  return hits
}

beforeAll(async () => {
  await build()
}, 300_000)

describe('the artefact these gates read', () => {
  it('was actually built', () => {
    expect(buildError, 'the build failed, so nothing below was really checked').toBeNull()
  })
})

describe('REQ-01 — the detectors stay browser-free in the artefact, not just in the source', () => {
  it('ships no browser API inside any core-* bundle', () => {
    const built = filesIn('packages/core-*/dist/**/*.js')
    expect(built.length).toBeGreaterThan(0)
    expect(offenders(built, BROWSER_TOKENS)).toEqual([])
  })

  it('ships no network call inside any core-* bundle', () => {
    const built = filesIn('packages/core-*/dist/**/*.js')
    expect(offenders(built, NETWORK_TOKENS)).toEqual([])
  })
})

describe('REQ-08 — exactly one module may reach the network', () => {
  it('finds fetch in the transport source and nowhere else in the workspace', () => {
    const sources = [
      ...filesIn('packages/*/src/**/*.ts'),
      ...filesIn('apps/*/src/**/*.ts'),
    ].filter((f) => !f.endsWith('.test.ts'))

    // `page-watch` wraps the *page's* `fetch` from the MAIN world and calls it
    // through with the arguments it was handed. It initiates nothing, so it is
    // not egress this product is answerable for — but it is the one place other
    // than the transport that touches the API at all, so it is named here
    // rather than left to pass because it happens not to spell `fetch(`.
    // The rule below is what actually holds it to observing.
    const PAGE_WATCH = 'apps/extension/src/page-watch/index.ts'
    const withFetch = offenders(sources, ['fetch(', '.fetch =', 'XMLHttpRequest.prototype'])
      .map((h) => h.file)
      .filter((f) => f !== PAGE_WATCH)
    expect(withFetch).toEqual([TRANSPORT_SOURCE])

    // And it must still be there: an exemption for a file that no longer exists
    // silently becomes an exemption for nothing. `sources` holds absolute
    // paths, `offenders` reports repo-relative ones — compared like with like.
    expect(sources.map((f) => path.relative(root, f))).toContain(PAGE_WATCH)
  })

  it('leaves no stray network call in the shipped extension bundles', () => {
    // The extension may legitimately contain the transport, so an occurrence
    // is only acceptable when it arrived through it: any bundle carrying a
    // network token must also carry the audit-log write that precedes it.
    // The two directories the browsers actually load. `dist/` also holds tsc's
    // per-module output — `dist/page-watch/index.js` and its siblings — which
    // ships to nobody, and scanning it made this gate fire on a file that is
    // not part of any bundle.
    for (const file of [...filesIn('apps/extension/dist/chrome/*.js'), ...filesIn('apps/extension/dist/firefox/*.js')]) {
      const source = readFileSync(file, 'utf8')
      const reachesNetwork = NETWORK_TOKENS.some((t) => source.includes(t))
      if (!reachesNetwork) continue
      // One bundle is exempt, narrowly and by name: the MAIN-world watcher
      // wraps the page's own `fetch` and calls it through untouched. It has no
      // audit entry because it sends nothing of ours — the rule above proves
      // that from its source, and this line makes the exemption a decision
      // rather than a hole.
      if (path.basename(file) === 'page-watch.js') continue
      expect(source, `${path.relative(root, file)} sends without the audit log`).toContain(
        'outbound_log',
      )
    }
  })
})

describe('the page watcher observes and never sends', () => {
  /**
   * The one module outside the transport that touches `fetch`, and the reason
   * it is allowed to: it wraps what the page calls and hands the call straight
   * back. If it ever composed a request of its own, REQ-08's promise — one
   * module reaches the network — would be false, and the exemption above would
   * be covering it.
   */
  const source = readFileSync(path.join(root, 'apps/extension/src/page-watch/index.ts'), 'utf8')

  it('is there to be checked', () => {
    expect(source.length).toBeGreaterThan(500)
  })

  it('names no destination of its own', () => {
    // A URL literal here would mean it had somewhere to send something.
    expect(source).not.toMatch(/https?:\/\/[a-z]/i)
  })

  it('calls the original with the arguments it was given, and nothing else', () => {
    expect(source).toContain('originalFetch.apply(this as never, args)')
    // No `new Request(`, no second argument built here — the page's call goes
    // through as the page made it.
    expect(source).not.toContain('new Request(')
  })

  it('never awaits its own decision before calling through', () => {
    // `await` between reading the call and making it is how observing turns
    // into holding, which is the thing this module promises not to do.
    const body = source.slice(source.indexOf('export function watchPage'))
    expect(body).not.toContain('await ')
  })
})

describe('what the shipped extension is made of', () => {
  it('builds a self-contained content script — a split chunk would not load', () => {
    for (const browser of ['chrome', 'firefox']) {
      const content = readFileSync(
        path.join(root, `apps/extension/dist/${browser}/content.js`),
        'utf8',
      )
      expect(content).not.toMatch(/^\s*import\s/m)
      expect(content).not.toMatch(/from\s*["'][./]/)
    }
  })

  it('ships surfaces the page cannot reach into', () => {
    // REQ-35 added a build flag that opens the shadow root so end-to-end tests
    // can click the controls a user clicks. The production build must never
    // carry it: an open root would let a hostile page hide the warning about
    // itself, which is the property the whole surface rests on.
    for (const browser of ['chrome', 'firefox']) {
      const content = readFileSync(
        path.join(root, `apps/extension/dist/${browser}/content.js`),
        'utf8',
      )
      expect(content, `${browser} build must use a closed shadow root`).toContain('"closed"')
      expect(content, `${browser} build must not carry the test hook`).not.toContain('"open"')
    }
  })

  it('ships nothing the product does not produce', () => {
    /**
     * The build copies `icons` and `_locales` wholesale, and wholesale includes
     * what nobody wrote: macOS puts a `.DS_Store` into any folder its Finder has
     * displayed, and both of those are hand-maintained. It was reaching
     * `dist/<target>/_locales/` and going into the store archive — `unzip -l`
     * found it — while `pnpm package:check` passed all eight checks, because it
     * asks whether every file the manifest names is present and never whether
     * the package holds a file nobody named.
     *
     * `package.mjs` refuses such an archive now, and that is the guard that
     * matters at release. This is the one that catches it a week earlier: it runs
     * inside `pnpm test`, so inside `pnpm gates` and inside the pre-push hook,
     * where `package:check` does not.
     */
    const SHIPPED = new Set(['.js', '.html', '.css', '.png', '.json'])
    for (const browser of ['chrome', 'firefox']) {
      const base = path.join(root, `apps/extension/dist/${browser}`)
      // `statSync` and not the extension alone: `**/*` matches directories too,
      // and a directory has no extension — the first version of this check
      // reported `chunks`, `assets`, `icons` and the three locale folders as
      // foreign files. It was red for a reason that had nothing to do with the
      // build, which is the failure mode a new gate is most likely to have and
      // the reason to read what it names rather than trust that it fired.
      const files = filesIn(`apps/extension/dist/${browser}/**/*`).filter((p) =>
        statSync(p).isFile(),
      )
      expect(files.length, `${browser} build is empty`).toBeGreaterThan(10)
      const foreign = files
        .map((file) => path.relative(base, file))
        .filter(
          (file) =>
            file.split(path.sep).some((part) => part.startsWith('.')) ||
            !SHIPPED.has(path.extname(file)),
        )
      expect(foreign, `${browser} build carries files the product does not produce`).toEqual([])
    }
  })

  it('ships a manifest beside the code in both builds', () => {
    for (const browser of ['chrome', 'firefox']) {
      const manifest = JSON.parse(
        readFileSync(path.join(root, `apps/extension/dist/${browser}/manifest.json`), 'utf8'),
      ) as { manifest_version: number }
      expect(manifest.manifest_version).toBe(3)
    }
  })
})

describe('the scanner reads code, not prose', () => {
  it('loses a token that is only mentioned inside a string', () => {
    expect(executable('const PATTERN = /document\\.cookie/')).not.toContain('document.')
    expect(executable("const t = 'localStorage.getItem'")).not.toContain('localStorage')
  })

  it('keeps a token that is actually called', () => {
    // The point of stripping literals is to lose mentions, not uses. Without
    // this the previous test could be satisfied by stripping everything.
    expect(executable('const c = document.cookie')).toContain('document.')
    expect(executable('localStorage.setItem(k, v)')).toContain('localStorage')
    expect(executable('await fetch("https://x.test")')).toContain('fetch(')
  })

  it('is not fooled by a comment either way', () => {
    expect(executable('// never use document.cookie here')).not.toContain('document.')
  })
})

describe('every address in the shipped bundle is one the options page resolves', () => {
  /**
   * The source-side twin of this rule lives in `tools/options-routes.test.ts`.
   * It is here as well because the source rule can only see addresses written
   * as literals: a producer that assembles one — a template, a concatenation, a
   * helper in another package — is invisible to it. The bundle is where every
   * address has already become a string, whatever built it.
   */
  const ADDRESS = /options\.html(#[\w=%.-]*)/g

  /**
   * The four browser builds, and only those.
   *
   * `dist/` also holds `tsc -b`'s per-directory emit, which **keeps comments** —
   * so the first version of this rule read `interstitial/appeal-link.js` and
   * failed on `options.html#appeal`, an address that file's own doc comment
   * names as the dead one it stopped using. A gate that reads prose reports the
   * documentation of a fixed defect as the defect itself.
   */
  const BUNDLES = ['chrome', 'chrome-e2e', 'firefox', 'firefox-e2e'].flatMap((build) =>
    // `**`, not `*`: the build puts everything shared between pages into
    // `dist/<build>/chunks/`, and the route table is shared by four of them.
    // Reading only the entry files meant reading past the module this rule
    // exists to check — which the "not blind" test below is what noticed.
    filesIn(`apps/extension/dist/${build}/**/*.js`),
  )

  /**
   * `hashFor('recovery', kind)` compiles to `"#recovery=" + encodeURIComponent(kind)`,
   * so every bundle contains the constructor's literal half with nothing after
   * it. That is the table building an address, not a producer opening a broken
   * one.
   */
  const CONSTRUCTED = '#recovery='

  it('finds bundles to read', () => {
    expect(BUNDLES.length).toBeGreaterThan(3)
  })

  it('resolves every address the build actually contains', () => {
    const unresolved: string[] = []
    for (const file of BUNDLES) {
      for (const [, hash] of readFileSync(file, 'utf8').matchAll(ADDRESS)) {
        if ((hash as string) === CONSTRUCTED) continue
        if (routeFor(hash as string).unrecognised !== undefined) {
          unresolved.push(`${path.relative(root, file)} -> ${hash as string}`)
        }
      }
    }
    expect(unresolved, 'the built extension opens an address the page does not know').toEqual([])
  })

  it('the sweep is not blind — the table it checks against really shipped', () => {
    // This guard fired the moment the producers moved onto `optionsPageFor`,
    // and it was right to. `optionsPageFor` compiles to `"options.html" +
    // hashFor(view)`, so a whole address stopped existing as one literal
    // anywhere in the build, and the rule above went from checking every
    // address to checking none — while still passing.
    //
    // What the artefact can still prove is that the vocabulary shipped. A build
    // whose table lost an entry would open the overview for that area, in
    // silence, on every surface at once.
    const text = BUNDLES.map((file) => readFileSync(file, 'utf8')).join('\n')
    expect(text, 'no bundle mentions the options page at all').toContain('options.html')
    const missing = KNOWN_HASHES.filter((hash) => !text.includes(hash))
    expect(missing, 'the shipped build is missing addresses the table declares').toEqual([])
  })
})

describe('nothing that runs on a page may need a secure context', () => {
  /**
   * The manifest matches plain-HTTP pages, and a `[SecureContext]` API is
   * `undefined` on one. Measured 2026-08-20: the agent gate's first act was
   * `crypto.randomUUID()`, taken **before** `preventDefault` and outside any
   * `try` — so on every `http://` page the description threw `TypeError`, the
   * exception left the capture-phase listener, and a listener that throws does not
   * cancel its event. The gate was a total no-op on exactly the pages a poisoned
   * document is cheapest to serve from.
   *
   * The bundles, not the sources: what runs on a page is what was shipped, and a
   * dependency can bring one of these in without anybody in this repository
   * typing it.
   */
  const SECURE_ONLY = [
    'randomUUID',
    'crypto.subtle',
    'navigator.locks',
    'requestStorageAccess',
    'navigator.serviceWorker',
  ]

  /** The bundles a content script actually injects into somebody's page. */
  const inPage = () =>
    [...filesIn('apps/extension/dist/chrome/*.js'), ...filesIn('apps/extension/dist/firefox/*.js')]
      .filter((file) => ['content.js', 'page-watch.js'].includes(path.basename(file)))

  it('is looking at bundles that exist', () => {
    // Two targets, two bundles each. An empty list would make every assertion
    // below pass by having nothing to read.
    expect(inPage().length, 'no in-page bundle was found to scan').toBe(4)
  })

  it('calls no secure-context API from a bundle that runs on any page', () => {
    const offenders: string[] = []
    for (const file of inPage()) {
      /**
       * Raw, not through `executable`. That helper's regex-literal pass guesses
       * where a regex begins, and on minified output a false opening eats
       * everything to the next slash — this gate first stayed green with
       * `crypto.randomUUID()` sitting in the bundle for precisely that reason.
       */
      const source = readFileSync(file, 'utf8')
      for (const api of SECURE_ONLY) {
        if (source.includes(api)) offenders.push(`${path.relative(root, file)}: ${api}`)
      }
    }
    expect(
      offenders,
      'these are undefined on an http page, and the manifest matches http pages',
    ).toEqual([])
  })

  it('still uses the randomness that is available there', () => {
    // The replacement, asserted so this does not become "no ids at all". The gate
    // needs an id per action or its journal cannot tell two actions apart.
    const content = inPage().filter((f) => path.basename(f) === 'content.js')
    expect(content.length).toBe(2)
    for (const file of content) {
      expect(readFileSync(file, 'utf8'), `${path.relative(root, file)}`).toContain(
        'getRandomValues',
      )
    }
  })
})
