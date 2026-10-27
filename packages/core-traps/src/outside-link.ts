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
 * written inside the link. A file address with a host opens a shared folder on another
 * computer, and Windows sends that computer the person's sign-in details when it does.
 *
 * Pure and local: the address is read, never fetched. What comes back is codes and the
 * one value a sentence needs (the remote host, when the address names one); the words
 * are the surface's, like every other detector here.
 */

export type OutsideLinkKind = 'program' | 'share'

export interface OutsideLinkVerdict {
  /** `program` when a Windows program takes the address, `share` for a network folder. */
  readonly kind: OutsideLinkKind
  /** The scheme in lower case, without the colon: `search-ms`, `file`. */
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
const OFFICE_SCHEMES: ReadonlySet<string> = new Set(['ms-word', 'ms-excel', 'ms-powerpoint'])

export function classifyOutsideLink(href: string): OutsideLinkVerdict | null {
  const address = href.trim()
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(address)?.[1]?.toLowerCase()
  if (scheme === undefined) return null

  if (PROGRAM_SCHEMES.has(scheme)) {
    return { kind: 'program', scheme, host: remoteHost(decoded(address)), signals: [scheme, 'opens-a-program'] }
  }

  if (OFFICE_SCHEMES.has(scheme)) {
    const document = /\|u\|(.+)$/i.exec(address)?.[1]?.trim()
    if (document === undefined || /^https:\/\//i.test(document)) return null
    return {
      kind: 'program',
      scheme,
      host: remoteHost(decoded(document)),
      signals: [scheme, 'document-not-over-https'],
    }
  }

  if (scheme === 'file') {
    const host = shareHost(address)
    return host === null ? null : { kind: 'share', scheme, host, signals: [scheme, 'points-to-a-network-share'] }
  }

  return null
}

/** Percent-decoded where it can be; a malformed escape leaves the address as written. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * The first other computer an address names: a `\\host\share` path or an http(s) URL,
 * whichever comes first. `@SSL` and a port end the name, as they do for Windows.
 */
function remoteHost(text: string): string | null {
  const unc = /\\\\([^\\/@:%?&|"'\s]+)/.exec(text)
  const url = /\bhttps?:\/\/([^\\/@:?&|"'\s#]+)/i.exec(text)
  const first = [unc, url]
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => a.index - b.index)[0]
  return first?.[1]?.toLowerCase() ?? null
}

/** The host of a file address that points off this computer, or null for a local file. */
function shareHost(address: string): string | null {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (host !== '' && host !== 'localhost') return host
  // `file:////host/share`: the parser leaves the host empty and the path starting `//`.
  if (url.pathname.startsWith('//')) {
    const named = url.pathname.slice(2).split('/')[0]?.toLowerCase() ?? ''
    return named === '' || named === 'localhost' ? null : named
  }
  return null
}
