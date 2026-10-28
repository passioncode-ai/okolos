/**
 * A link that leaves the browser: the click goes to a program on the computer.
 *
 * The audit of 2026-10-27 (B-165) found these addresses dropped without a word. The
 * agent gate and the platform adapter both keep http(s) and nothing else, which is right
 * for what they do (a journal line must not carry a query string) and left a whole class
 * of link unexamined. Some schemes exist to hand an address to a Windows program, and
 * campaigns use exactly that: `ms-msdt:` ran the troubleshooting tool behind Follina,
 * `search-ms:` opens Explorer on a folder served from another computer so a program
 * there looks like a local file, `ms-appinstaller:` installs a package from an address
 * written inside the link.
 *
 * **What it does not name: a bare `file:` address.** The first version named a file
 * address with a host as a shared folder on another computer. Round 1 of the
 * certification measured what the browser does with one: Chromium and Firefox refuse a
 * `file:` navigation from an http(s) page on their own ("Not allowed to load local
 * resource", the address unchanged, no request made). A warning about an opening that
 * cannot happen is a claim the product did not check, so that branch is gone. A shared
 * folder is still named where a program does the opening: inside a `search-ms:` link or
 * an Office link, which the browser does hand over.
 *
 * Pure and local: the address is read, never fetched. What comes back is codes and the
 * one value a sentence needs (the remote host, when the address names one); the words
 * are the surface's, like every other detector here.
 */

export interface OutsideLinkVerdict {
  /** The scheme in lower case, without the colon: `search-ms`, `ms-word`. */
  readonly scheme: string
  /** The other computer the address reaches, when it names one. */
  readonly host: string | null
  /** The scheme and the reason, as codes: what the journal records. */
  readonly signals: readonly string[]
}

/**
 * Schemes with no ordinary use from a web page.
 *
 * Each one asks Windows to start a program with arguments the page wrote. A page that
 * genuinely needs a person to open a troubleshooter or a saved search does not exist,
 * so these are named whenever they are clicked.
 */
const PROGRAM_SCHEMES: ReadonlySet<string> = new Set([
  'ms-msdt',
  'search-ms',
  'search',
  'ms-appinstaller',
  'ms-officecmd',
])

/**
 * Office's "open this document in the desktop app" schemes.
 *
 * Unlike the set above these are everyday links: SharePoint and OneDrive put one on
 * every document page, as `ms-word:ofe|u|https://…`. What is not everyday is the
 * document arriving over plain http or from a shared folder, which is how a remote
 * template or a sign-in leak is delivered. So only that shape is named.
 */
const OFFICE_SCHEMES: ReadonlySet<string> = new Set([
  'ms-word',
  'ms-excel',
  'ms-powerpoint',
  // The rest of the desktop Office handlers take the same `ofe|u|<document>` form, and
  // round 1 of the certification found them passing silently.
  'ms-visio',
  'ms-access',
  'ms-project',
  'ms-publisher',
  'ms-spd',
  'ms-infopath',
  // OneNote also takes the notebook straight after the colon: `onenote:http://…`.
  'onenote',
])

export function classifyOutsideLink(href: string): OutsideLinkVerdict | null {
  const address = href.trim()
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(address)?.[1]?.toLowerCase()
  if (scheme === undefined) return null

  if (PROGRAM_SCHEMES.has(scheme)) {
    const host = scheme === 'search-ms' || scheme === 'search' ? searchLocation(address) : remoteHost(decoded(address))
    return { scheme, host, signals: [scheme, 'opens-a-program'] }
  }

  if (OFFICE_SCHEMES.has(scheme)) {
    const document = officeDocument(scheme, address)
    if (document === null || /^https:\/\//i.test(document)) return null
    return {
      scheme,
      host: remoteHost(document),
      signals: [scheme, 'document-not-over-https'],
    }
  }

  return null
}

/**
 * The document an Office link would open, decoded, or null when it names none.
 *
 * Read on the decoded address so `ofe%7Cu%7Chttp://…` is the same link as
 * `ofe|u|http://…`: the handler decodes it before it fetches.
 */
function officeDocument(scheme: string, address: string): string | null {
  const plain = decoded(address)
  const named = /\|u\|(.+)$/i.exec(plain)?.[1]?.trim()
  if (named !== undefined && named !== '') return named
  const rest = plain.slice(scheme.length + 1).trim()
  if (rest === '') return null
  if (scheme === 'onenote') return rest
  // The short form, `ms-word:http://…`: every Office handler opens a document written
  // straight after the colon, the same as `ofe|u|`. Round 2 of the certification
  // measured it passing silently. Read only when what follows is an address (a scheme)
  // or a shared folder, so a launcher argument that is neither stays unnamed.
  return /^(?:[a-z][a-z0-9+.-]*:|\\\\)/i.test(rest) ? rest : null
}

/**
 * Percent-decoded where it can be. Each run of valid escapes is decoded on its own, so one
 * stray `%` (or a broken UTF-8 run) no longer leaves the whole address undecoded (round 4).
 */
function decoded(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run)
    } catch {
      return run
    }
  })
}

/**
 * The first other computer an address names: a `\\host\share` path (also `\\?\UNC\host\`
 * and `//host/`), an http(s) URL or a `file://host/` address (also `file:////host/`), whichever
 * comes first. A user name before `@` is skipped; `@SSL` and a port end the name, as they do
 * for Windows; an IPv6 literal is named whole, brackets included; `file:///` (a local path)
 * and `file://localhost/` name no other computer.
 */
function remoteHost(text: string): string | null {
  const HOST = String.raw`(\[[0-9a-f:.]+\]|[^\\/@:%?&|"'\s#\[\]]+)`
  const longUnc = new RegExp(String.raw`\\\\\?\\UNC\\` + HOST, 'i').exec(text)
  const unc = new RegExp(String.raw`(?:\\\\|(?<![:/])//)(?!\?\\)` + HOST, 'i').exec(text)
  // A user name before `@` is not the computer: `http://microsoft.com@evil.example/` fetches from evil.example.
  const url = new RegExp(String.raw`\bhttps?://(?:[^\\/?#\s]*@)?` + HOST, 'i').exec(text)
  const file = new RegExp(String.raw`\bfile://(?:/{2})?(?:[^\\/?#\s]*@)?(?!localhost[\\/])(?!/)` + HOST, 'i').exec(text)
  const first = [longUnc, unc, url, file]
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => a.index - b.index)[0]
  return first?.[1]?.toLowerCase() ?? null
}

/**
 * Where a `search-ms:` or `search:` link sends Explorer: its `crumb=location:` parameter, read
 * alone so a page cannot put a decoy address in `displayname` or `query` before it (round 5).
 */
function searchLocation(address: string): string | null {
  const crumb = /(?:^|[?&:])crumb=location:([^&]*)/i.exec(decoded(address))?.[1]
  return crumb === undefined ? null : remoteHost(crumb)
}
