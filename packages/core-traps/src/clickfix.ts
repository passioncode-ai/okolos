/**
 * ClickFix: the page copies a command, and asks the user to run it.
 *
 * The attack does not exploit the browser at all. It persuades a person to
 * paste a line into a box outside it — Win+R, a terminal, PowerShell — where no
 * browser protection reaches. The host is usually a legitimate site that has
 * been compromised, so nothing about the domain gives it away.
 *
 * Three signals, and the third one is load-bearing in a way the first draft of
 * this file missed. "Copy this, paste it in your terminal, press Enter" with a
 * scripted copy behind it describes a ClickFix page — and it equally describes
 * every installation page on every developer site in the world, which is where
 * the copy button that fires `execCommand('copy')` actually lives.
 *
 * What separates them is the pretext. Real documentation asks you to run a
 * command because you asked how to install something. A ClickFix page asks you
 * to run one to prove you are human, or to fix an error it invented. No
 * genuine verification has ever required a terminal, so that claim is the
 * signal that cannot be innocent, and nothing here fires without it.
 */

export interface ClickFixEvidence {
  /** Visible text of the page, already truncated by the collector. */
  readonly text: string
  /** True when a copy happened that no human gesture initiated. */
  readonly scriptedCopy: boolean
  /** What was copied, when it could be read at all. */
  readonly copied: string | null
}

export interface ClickFixVerdict {
  readonly confidence: 'high' | 'medium'
  readonly signals: readonly string[]
  /** Verbatim, for showing the user. Null when it could not be read. */
  readonly copied: string | null
  /** True when the warning rests on the page's wording alone. */
  readonly copyUnreadable: boolean
}

/**
 * Where the page tells the user to paste.
 *
 * Russian alongside English, because that is the language of the people this
 * product is built for — the watchlist ships `sberbank.ru` and `gosuslugi.ru`,
 * and a campaign written for them used to pass clean. That is not an evasion,
 * it is the normal case for this audience.
 *
 * Two things about the Russian side. `\b` does not mark a word boundary next
 * to Cyrillic in a non-unicode regex, so the alternatives are matched without
 * it — they are long enough that a substring hit is not a false positive on
 * its own, and the verdict needs the pretext as well. And `\w` is
 * `[A-Za-z0-9_]`: it matches no Cyrillic at all, so `командн\w*` never
 * reached the `ую` of "командную". The classes are spelled out.
 */
const RUN_TARGET =
  /\b(win\s*\+\s*r|windows\s*\+\s*r|run dialog|powershell|command prompt|cmd\.exe|terminal|iex|invoke-expression)\b|(командн[а-яё]*\s+строк|терминал|окно\s+«?выполнить|диалог[а-яё]*\s+выполнить|win\s*\+\s*r)/i

/** The instruction to paste, in the phrasings these campaigns actually use. */
const PASTE_STEP =
  /\b(ctrl\s*\+\s*v|cmd\s*\+\s*v|⌘\s*v|paste (?:it|the|this)|press enter|hit enter)\b|(встав[а-яё]те|вставить|нажмите\s+(?:enter|ввод|ентер))/i

/**
 * The pretext: a verification that a real one never asks for.
 *
 * This is the signal the whole verdict rests on — without it the page is
 * documentation however much the rest matches — so the Russian side is
 * deliberately narrow: the exact claims these campaigns make, not the word
 * "проверка" on its own, which appears on half the internet.
 */
const PRETEXT =
  /\b(verify (?:you are|you're) (?:a )?human|i am not a robot|i'm not a robot|captcha|verification (?:step|code|failed)|fix (?:the|this) (?:error|issue))\b|(подтвердите,?\s+что\s+вы\s+не\s+робот|я\s+не\s+робот|капч[а-яё]+|проверка\s+не\s+пройдена|подтверждение\s+личности|исправить\s+ошибку|чтобы\s+исправить)/i

/** What a copied ClickFix payload looks like. */
const PAYLOAD = /\b(powershell|iex|invoke-expression|curl\s|wget\s|mshta|certutil|bitsadmin|base64|cmd\s*\/c|bash\s+-c|\/bin\/sh)\b/i

/**
 * The Windows programs that run something for a payload (B-165, audit 2026-10-27).
 *
 * The campaigns moved past PowerShell to programs every Windows machine already has:
 * `msiexec` installing a package from a URL, `rundll32` and `regsvr32` loading a
 * library, `conhost --headless` hiding the window, `forfiles /c` and
 * `wmic process call create` starting a process. Unlike the words above, these are
 * matched **with the switch or the argument that makes them a command**, because the
 * names alone are ordinary prose on every administrator's how-to page: "use msiexec to
 * repair the installer" is not a payload, `msiexec /q /i https://…` is.
 */
const LAUNCHER =
  /\b(msiexec(?:\.exe)?\s+["']?\/[a-z]|rundll32(?:\.exe)?\s+\S+,|rundll32(?:\.exe)?\s+javascript:|regsvr32(?:\.exe)?\s+\/[a-z]|conhost(?:\.exe)?\s+--headless\b|forfiles(?:\.exe)?\s+(?:\/[a-z]\s+\S+\s+)*\/c\b|wmic(?:\.exe)?\s+process\s+call\s+create\b)/i

function isCommand(copied: string): boolean {
  return PAYLOAD.test(copied) || LAUNCHER.test(copied)
}

export function detectClickFix(evidence: ClickFixEvidence): ClickFixVerdict | null {
  const signals: string[] = []
  const text = evidence.text

  if (evidence.scriptedCopy) signals.push('copy-not-made-by-you')
  if (RUN_TARGET.test(text)) signals.push('names-a-place-outside-the-browser')
  if (PASTE_STEP.test(text)) signals.push('tells-you-to-paste')
  if (PRETEXT.test(text)) signals.push('fake-verification')
  if (evidence.copied !== null && isCommand(evidence.copied)) signals.push('copied-text-is-a-command')

  const pagePattern =
    signals.includes('names-a-place-outside-the-browser') && signals.includes('tells-you-to-paste')
  const pretext = signals.includes('fake-verification')

  // Without the pretext this is a documentation page, however much the rest of
  // it matches. With it, a copy that happened or a command on the clipboard is
  // what turns suspicion into a verdict.
  if (!(pretext && pagePattern)) return null
  const strong = evidence.scriptedCopy || signals.includes('copied-text-is-a-command')

  return {
    confidence: strong ? 'high' : 'medium',
    signals,
    copied: evidence.copied,
    copyUnreadable: evidence.scriptedCopy && evidence.copied === null,
  }
}
