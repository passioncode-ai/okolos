/**
 * What a download verdict is allowed to say.
 *
 * The rule this file exists to enforce: the verdict never claims more than the
 * checks that actually ran. A file behind authentication cannot be hashed; a
 * stale feed cannot vouch for a URL. Both are ordinary, and both produce the
 * same dishonest output if the missing check is silently treated as a pass —
 * a green tick the product did not earn, on the one screen where the user is
 * deciding whether to run something.
 *
 * So every check reports one of three things: it passed, it failed, or it did
 * not run and here is why. The verdict is assembled from those, and the "did
 * not run" list is part of what the user is shown rather than a footnote.
 */

export type CheckName = 'feed' | 'file-type' | 'hash'

export type CheckOutcome =
  | { readonly ran: true; readonly passed: true }
  | { readonly ran: true; readonly passed: false; readonly detail: string }
  | { readonly ran: false; readonly why: string }

export interface DownloadEvidence {
  /** Final URL after redirects — origin and path, never the query. */
  readonly url: string
  readonly filename: string
  readonly mimeType: string | null
  readonly checks: Readonly<Record<CheckName, CheckOutcome>>
}

/**
 * What the verdict says, as codes rather than sentences.
 *
 * The package held five headlines and five shape sentences in English, in a package with
 * zero dependencies, and the background then joined them and sent the English over an
 * RPC to be rendered (B-75). The words are the surface's;
 * `apps/extension/src/content/download.ts` maps these through `*_KEY` tables, which is
 * the shape the locale gate reads.
 *
 * `reasons` is different and stays words: those come from the checks, and the caller
 * that ran them already resolved them through the catalogue (`downloadListedBy`).
 */
export type DownloadHeadline =
  | 'blocked'
  | 'unchecked'
  | 'needs-a-look'
  | 'passed-all'
  | 'passed-what-ran'

/** A fact about the file itself, with the values a sentence about it needs. */
export type DownloadShape =
  | { readonly code: 'double-extension'; readonly filename: string }
  | { readonly code: 'name-hides-a-program'; readonly mimeType: string }
  | { readonly code: 'type-is-a-program'; readonly filename: string; readonly mimeType: string }
  | { readonly code: 'is-a-program' }
  | { readonly code: 'is-an-archive' }

export interface DownloadVerdict {
  readonly action: 'block' | 'warn' | 'inform'
  readonly headline: DownloadHeadline
  /** Details of the checks that failed — words, resolved by whoever ran them. */
  readonly reasons: readonly string[]
  /** Facts about the file, as codes: the sentence is the surface's to write. */
  readonly shape: readonly DownloadShape[]
  readonly ran: readonly CheckName[]
  readonly skipped: ReadonlyArray<{ readonly check: CheckName; readonly why: string }>
  /** True when nothing could be checked at all. */
  readonly unchecked: boolean
}

/**
 * What counts as a program, and what a shorter list would have cost.
 *
 * Membership here does not block anything — it produces "this is a program, and
 * not every check could be run on it". But it is also the gate on the
 * double-extension check below, so an extension missing from this list disables
 * two things at once: `invoice.pdf.wsf` reads as an ordinary file.
 *
 * The list is grouped by what a person would call the thing, because that is
 * how the omissions were found: no Windows script formats, no control-panel
 * formats, no macro-enabled Office documents — the commonest malicious
 * attachment there is.
 *
 * `.html` and `.svg` are deliberately absent. They do carry payloads, and a
 * saved page is also the most ordinary download there is; a note on every one
 * of them is how a security extension teaches people to ignore its notes.
 *
 * The audit of 2026-10-27 (B-165) found a second gap of the same kind: the
 * types initial-access campaigns moved to after macros were blocked by default.
 * A library (`.dll`) run by `rundll32`, a OneNote notebook carrying an embedded
 * script, an Excel add-in (`.xll`, `.xlam`) that runs on open, the App Installer
 * and ClickOnce manifests that install from a URL inside them, the shell's saved
 * searches and settings shortcuts that open a remote folder or run a command,
 * and Java Web Start. All of them join the program class: none is a container.
 */
const EXECUTABLE =
  new RegExp(
    '\\.(' +
      // Native programs, libraries and installers.
      'exe|dll|msi|msp|com|scr|pif|apk|dmg|pkg|deb|rpm|appx|appxbundle|msix|msixbundle|gadget|' +
      // Manifests that install or launch from an address written inside them.
      'appinstaller|application|jnlp|' +
      // Shell and scripting hosts.
      'bat|cmd|ps1|ps2|psc1|vbs|vbe|js|jse|wsf|wsh|sh|jar|hta|mshxml|' +
      // Formats Windows opens with a program attached to them.
      'lnk|scf|url|reg|msc|cpl|chm|inf|ade|adp|' +
      'library-ms|search-ms|searchconnector-ms|settingcontent-ms|' +
      // Office documents and add-ins that carry code. They look like documents,
      // which is the point of using them.
      'docm|dotm|xlsm|xltm|xlsb|xlam|xll|pptm|potm|ppam|one' +
      ')$',
    'i',
  )

/** Containers: what is inside was not checked, and a mounted one loses the mark of the web. */
const ARCHIVE = /\.(zip|rar|7z|iso|img|cab|arj|lzh|ace|tar|gz|tgz|bz2|xz|zst|vhd|vhdx|wim)$/i

/** A name whose real extension is hidden behind a decoy one. */
function hasDoubleExtension(filename: string): boolean {
  const parts = filename.toLowerCase().split('.')
  if (parts.length < 3) return false
  // A decoy is whatever looks harmless in a filename, so the set is wider than
  // "document": an image, a video and a saved message all read as safe.
  const decoy =
    /^(pdf|doc|docx|rtf|odt|xls|xlsx|ods|ppt|pptx|odp|txt|csv|xml|json|jpg|jpeg|png|gif|bmp|webp|svg|mp3|mp4|avi|mov|htm|html|eml|msg|log)$/
  return decoy.test(parts[parts.length - 2] as string) && EXECUTABLE.test(filename)
}

/** Types that carry code, whatever the name in front of them says. */
const EXECUTABLE_MIME =
  /^application\/(x-msdownload|x-msdos-program|x-executable|x-mach-binary|vnd\.microsoft\.portable-executable|x-sh|x-shellscript|java-archive|x-apple-diskimage)$|^application\/octet-stream$/i

/** Names a person reads as a document. */
const DOCUMENT_NAME =
  /\.(pdf|docx?|rtf|odt|xlsx?|ods|pptx?|odp|txt|csv|xml|json|jpe?g|png|gif|bmp|webp|svg|mp3|mp4|avi|mov|html?|eml|msg|log)$/i

/**
 * The name and the type telling different stories — in either direction.
 *
 * It fired one way round only: a name that looks executable while the server calls it a
 * document. **The commoner shape is the other one** — `invoice.pdf` served as
 * `application/x-msdownload` — and it passed silently until 2026-08-20 (B-57). Both are
 * the same lie told from opposite ends.
 *
 * Which end is returned rather than a boolean, because the sentence differs and it
 * matters: "the name hides a program" sends a reader to look at the filename, "the
 * server is sending a program under a document's name" sends them to look at the site.
 */
export type MimeDisagreement = 'name-hides-a-program' | 'type-is-a-program' | null

function mimeDisagrees(filename: string, mimeType: string | null): MimeDisagreement {
  if (!mimeType) return null
  const claimsDocument = /^(text\/|image\/|application\/pdf)/i.test(mimeType)
  if (EXECUTABLE.test(filename) && claimsDocument) return 'name-hides-a-program'
  /**
   * `application/octet-stream` is in the executable list and is also what a great many
   * servers send for anything they cannot classify — so it counts only against a name
   * that reads as a document. A `.zip` served as `octet-stream` is ordinary; an
   * `invoice.pdf` served that way is a file whose two halves disagree.
   */
  if (EXECUTABLE_MIME.test(mimeType) && DOCUMENT_NAME.test(filename)) return 'type-is-a-program'
  return null
}

export function judgeDownload(evidence: DownloadEvidence): DownloadVerdict {
  const names: CheckName[] = ['feed', 'file-type', 'hash']
  const ran = names.filter((name) => evidence.checks[name].ran)
  const skipped = names
    .map((name) => ({ name, outcome: evidence.checks[name] }))
    .filter((entry): entry is { name: CheckName; outcome: { ran: false; why: string } } => !entry.outcome.ran)
    .map((entry) => ({ check: entry.name, why: entry.outcome.why }))

  const failures = names
    .map((name) => ({ name, outcome: evidence.checks[name] }))
    .filter((entry) => entry.outcome.ran && !entry.outcome.passed)

  const reasons = failures.map((entry) =>
    entry.outcome.ran && !entry.outcome.passed ? entry.outcome.detail : '',
  )

  if (failures.length > 0) {
    return {
      action: 'block',
      headline: 'blocked',
      reasons,
      shape: [],
      ran,
      skipped,
      unchecked: false,
    }
  }

  // Shape problems are not matches against anything: they are facts about the
  // file that a person can verify by looking at its name.
  const shape: DownloadShape[] = []
  if (hasDoubleExtension(evidence.filename)) {
    shape.push({ code: 'double-extension', filename: evidence.filename })
  }
  const disagreement = mimeDisagrees(evidence.filename, evidence.mimeType)
  if (disagreement === 'name-hides-a-program' && evidence.mimeType !== null) {
    shape.push({ code: 'name-hides-a-program', mimeType: evidence.mimeType })
  }
  if (disagreement === 'type-is-a-program' && evidence.mimeType !== null) {
    shape.push({
      code: 'type-is-a-program',
      filename: evidence.filename,
      mimeType: evidence.mimeType,
    })
  }
  if (shape.length === 0 && EXECUTABLE.test(evidence.filename) && skipped.length > 0) {
    shape.push({ code: 'is-a-program' })
  }
  if (shape.length === 0 && ARCHIVE.test(evidence.filename) && skipped.length > 0) {
    shape.push({ code: 'is-an-archive' })
  }

  if (ran.length === 0) {
    return {
      action: 'warn',
      headline: 'unchecked',
      reasons: [],
      shape,
      ran,
      skipped,
      unchecked: true,
    }
  }

  if (shape.length > 0) {
    return {
      action: 'warn',
      headline: 'needs-a-look',
      reasons: [],
      shape,
      ran,
      skipped,
      unchecked: false,
    }
  }

  return {
    action: 'inform',
    headline: skipped.length === 0 ? 'passed-all' : 'passed-what-ran',
    reasons: [],
    shape: [],
    ran,
    skipped,
    unchecked: false,
  }
}
