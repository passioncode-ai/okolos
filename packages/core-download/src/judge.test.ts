import { describe, expect, it } from 'vitest'

import { judgeDownload, type CheckOutcome, type DownloadEvidence } from './judge.js'

const PASS: CheckOutcome = { ran: true, passed: true }
const skip = (why: string): CheckOutcome => ({ ran: false, why })
const fail = (detail: string): CheckOutcome => ({ ran: true, passed: false, detail })

function evidence(overrides: Partial<DownloadEvidence> = {}): DownloadEvidence {
  return {
    url: 'https://files.test/setup',
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    checks: { feed: PASS, 'file-type': PASS, hash: PASS },
    ...overrides,
  }
}

describe('a file that matched something known', () => {
  it('is blocked, and the match is named', () => {
    const verdict = judgeDownload(
      evidence({ checks: { feed: fail('listed by URLhaus on 2026-08-01'), 'file-type': PASS, hash: PASS } }),
    )
    expect(verdict.action).toBe('block')
    expect(verdict.reasons[0]).toContain('URLhaus')
  })

  it('is blocked on the hash too, not only the URL', () => {
    const verdict = judgeDownload(
      evidence({ checks: { feed: PASS, 'file-type': PASS, hash: fail('this exact file is known malware') } }),
    )
    expect(verdict.action).toBe('block')
  })
})

describe('what the verdict may claim', () => {
  it('says every check passed only when every check ran', () => {
    expect(judgeDownload(evidence()).headline).toBe('passed-all')
  })

  it('says which checks it could run when one could not', () => {
    // The dishonest version of this screen is a green tick the product did not
    // earn, shown while someone decides whether to run a program.
    const verdict = judgeDownload(
      evidence({ checks: { feed: PASS, 'file-type': PASS, hash: skip('the file is behind a login') } }),
    )
    expect(verdict.headline).toBe('passed-what-ran')
    expect(verdict.skipped).toEqual([{ check: 'hash', why: 'the file is behind a login' }])
  })

  it('lists what ran, so the claim can be audited', () => {
    const verdict = judgeDownload(
      evidence({ checks: { feed: PASS, 'file-type': PASS, hash: skip('no bytes available') } }),
    )
    expect(verdict.ran).toEqual(['feed', 'file-type'])
  })

  it('says plainly when nothing could be checked', () => {
    const verdict = judgeDownload(
      evidence({
        checks: {
          feed: skip('the feeds are unavailable'),
          'file-type': skip('no filename was reported'),
          hash: skip('the bytes cannot be re-fetched'),
        },
      }),
    )
    expect(verdict.unchecked).toBe(true)
    expect(verdict.headline).toBe('unchecked')
    expect(verdict.action).toBe('warn')
  })
})

describe('what the file itself gives away', () => {
  it('catches a program wearing a document extension', () => {
    const verdict = judgeDownload(evidence({ filename: 'invoice.pdf.exe' }))
    expect(verdict.action).toBe('warn')
    // The code and the value it needs — the sentence is the surface's (B-75).
    expect(verdict.shape[0]).toEqual({ code: 'double-extension', filename: 'invoice.pdf.exe' })
  })

  it('catches a server calling a program a document', () => {
    const verdict = judgeDownload(evidence({ filename: 'setup.exe', mimeType: 'application/pdf' }))
    expect(verdict.action).toBe('warn')
    expect(verdict.shape[0]).toEqual({
      code: 'name-hides-a-program',
      mimeType: 'application/pdf',
    })
  })

  it('says an archive was not looked inside, when something else was skipped too', () => {
    const verdict = judgeDownload(
      evidence({ filename: 'photos.zip', mimeType: 'application/zip', checks: { feed: PASS, 'file-type': PASS, hash: skip('too large') } }),
    )
    expect(verdict.shape[0]).toEqual({ code: 'is-an-archive' })
  })

  it('does not nag about an ordinary document that passed everything', () => {
    expect(judgeDownload(evidence()).action).toBe('inform')
  })

  it('does not call a plain executable dangerous when every check passed', () => {
    // Programs are downloaded all day. Warning about all of them is the same as
    // warning about none.
    const verdict = judgeDownload(evidence({ filename: 'installer.exe', mimeType: 'application/octet-stream' }))
    expect(verdict.action).toBe('inform')
  })

  it('does warn about an executable when a check was skipped', () => {
    const verdict = judgeDownload(
      evidence({
        filename: 'installer.exe',
        mimeType: 'application/octet-stream',
        checks: { feed: PASS, 'file-type': PASS, hash: skip('the bytes are gone') },
      }),
    )
    expect(verdict.action).toBe('warn')
  })
})

describe('the shapes this list is a claim about', () => {
  /**
   * Membership in the executable list does not block anything — it says "this
   * is a program, and not every check could be run on it", and it is what makes
   * the double-extension check work at all: `hasDoubleExtension` requires the
   * real extension to be recognised. So an extension missing from the list
   * silently disables two things at once, and the cost of adding one is a
   * sentence on a screen rather than a blocked file.
   *
   * The list held 18 extensions on 2026-08-08 and none of the Windows script
   * and control-panel formats that carry payloads today, nor macro-enabled
   * Office documents, which are the commonest malicious attachment there is.
   */
  const SKIPPED = { ran: false as const, why: 'the file is behind a login' }

  const named = (filename: string) =>
    judgeDownload(
      evidence({ filename, mimeType: null, checks: { feed: PASS, 'file-type': PASS, hash: SKIPPED } }),
    )

  it('recognises the Windows script and control formats used to deliver payloads', () => {
    for (const ext of ['wsf', 'jse', 'vbe', 'pif', 'msc', 'cpl', 'reg', 'chm', 'scf', 'url', 'msix', 'appx']) {
      const verdict = named(`invoice.${ext}`)
      expect(verdict.shape.map((entry) => entry.code), ext).toContain('is-a-program')
    }
  })

  it('recognises the Windows types used for initial access in 2026 (B-165)', () => {
    // Libraries, OneNote and Excel add-ins, the App Installer and ClickOnce
    // manifests, the shell's saved searches and settings shortcuts, and Java Web
    // Start: each of these runs something when opened, and none was on the list
    // the audit of 2026-10-27 read.
    for (const ext of [
      'dll',
      'one',
      'xll',
      'xlam',
      'appinstaller',
      'msixbundle',
      'appxbundle',
      'library-ms',
      'search-ms',
      'searchConnector-ms',
      'settingcontent-ms',
      'application',
      'jnlp',
    ]) {
      const verdict = named(`invoice.${ext}`)
      expect(verdict.shape.map((entry) => entry.code), ext).toContain('is-a-program')
    }
  })

  it('sees a new type behind a decoy extension, and in either case', () => {
    expect(judgeDownload(evidence({ filename: 'счёт.pdf.one', mimeType: null })).shape.map((e) => e.code)).toContain(
      'double-extension',
    )
    expect(named('Report.SEARCH-MS').shape.map((entry) => entry.code)).toContain('is-a-program')
  })

  it('keeps every type listed before 2026-10-27 in the class it had', () => {
    // The list grew; nothing on it moved. A type changing class changes the
    // sentence a person reads, so the old membership is pinned here.
    const program = [
      'exe', 'msi', 'msp', 'com', 'scr', 'pif', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'appx', 'msix', 'gadget',
      'bat', 'cmd', 'ps1', 'ps2', 'psc1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'sh', 'jar', 'hta', 'mshxml',
      'lnk', 'scf', 'url', 'reg', 'msc', 'cpl', 'chm', 'inf', 'ade', 'adp',
      'docm', 'dotm', 'xlsm', 'xltm', 'xlsb', 'pptm', 'potm', 'ppam',
    ]
    const archive = [
      'zip', 'rar', '7z', 'iso', 'img', 'cab', 'arj', 'lzh', 'ace', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst',
      'vhd', 'vhdx', 'wim',
    ]
    for (const ext of program) {
      expect(named(`file.${ext}`).shape.map((entry) => entry.code), ext).toEqual(['is-a-program'])
    }
    for (const ext of archive) {
      expect(named(`file.${ext}`).shape.map((entry) => entry.code), ext).toEqual(['is-an-archive'])
    }
  })

  it('recognises the remaining initial-access types (B-165, round 1)', () => {
    // A rogue Remote Desktop file, a ClickOnce shortcut, a troubleshooter package
    // (the ms-msdt payload as a file), a OneNote package, Excel's web query and
    // SYLK formats, a Visual Studio Tools for Office add-in, and the two script
    // component formats `regsvr32` loads. Each runs or connects something on open.
    for (const ext of ['rdp', 'appref-ms', 'diagcab', 'onepkg', 'iqy', 'slk', 'vsto', 'wsc', 'sct']) {
      expect(named(`invoice.${ext}`).shape.map((entry) => entry.code), ext).toContain('is-a-program')
    }
  })

  it('reads the type past a trailing dot or space, which Windows drops', () => {
    // Windows strips trailing dots and spaces from a name and runs the file by the
    // extension that is left; a list anchored at the very end missed all three.
    for (const name of ['a.one.', 'a.one ', 'report.dll. . ']) {
      expect(named(name).shape.map((entry) => entry.code), JSON.stringify(name)).toContain('is-a-program')
    }
    expect(named('invoice.pdf.dll.').shape.map((entry) => entry.code)).toContain('double-extension')
  })

  it('sees a decoy extension with a space before the real one', () => {
    expect(named('invoice.pdf .dll').shape.map((entry) => entry.code)).toContain('double-extension')
  })

  it('does not read a longer name as one of the new types', () => {
    // `.one` and `.application` are short words; only the last extension counts.
    for (const name of ['phone.txt', 'application.pdf', 'one.docx', 'notes.onetoc2.txt']) {
      expect(named(name).shape, name).toEqual([])
    }
  })

  it('recognises macro-enabled Office documents, which look like documents', () => {
    for (const ext of ['docm', 'xlsm', 'pptm', 'xlsb', 'dotm']) {
      expect(named(`отчёт.${ext}`).shape.map((entry) => entry.code), ext).toContain('is-a-program')
    }
  })

  it('recognises the containers used to carry a payload past the browser', () => {
    // .vhd and .cab join .iso and .img: a mounted container is where a file
    // arrives without the mark of the web.
    for (const ext of ['cab', 'vhd', 'vhdx', 'tar', 'gz', 'tgz', 'wim']) {
      expect(named(`photos.${ext}`).shape.map((entry) => entry.code), ext).toContain('is-an-archive')
    }
  })

  it('still sees a program hidden behind a decoy extension it now knows', () => {
    // The double-extension check is only as wide as the executable list.
    const verdict = judgeDownload(evidence({ filename: 'счёт.pdf.wsf', mimeType: null }))
    expect(verdict.shape.map((entry) => entry.code)).toContain('double-extension')
  })

  it('treats a wider decoy set, because a decoy is whatever looks harmless', () => {
    for (const decoy of ['rtf', 'htm', 'html', 'gif', 'mp4', 'eml', 'msg', 'xml']) {
      const verdict = judgeDownload(evidence({ filename: `letter.${decoy}.exe`, mimeType: null }))
      expect(verdict.shape.map((entry) => entry.code), decoy).toContain('double-extension')
    }
  })

  it('says nothing about an ordinary document', () => {
    // The cost of widening a list is here: a plain download must stay quiet.
    for (const name of ['отчёт.pdf', 'photo.jpg', 'notes.txt', 'таблица.xlsx', 'page.html']) {
      const verdict = judgeDownload(evidence({ filename: name }))
      expect(verdict.action, name).toBe('inform')
    }
  })
})

describe('a name and a type that disagree, in both directions', () => {
  /**
   * The check fired one way round only: a name that looks executable while the server
   * calls it a document. The commoner shape is the other one — `invoice.pdf` served as
   * `application/x-msdownload` — and it passed silently until 2026-08-20 (B-57).
   *
   * Both are the same lie told from opposite ends, and the sentence has to say which
   * end, because "the name hides a program" and "the server is sending a program under
   * a document's name" send a reader to look at different things.
   */
  it('flags a program dressed as a document by its name', () => {
    const verdict = judgeDownload({
      url: 'https://files.example.test/invoice.exe',
      filename: 'invoice.pdf.exe',
      mimeType: 'application/pdf',
      checks: { feed: PASS, 'file-type': PASS, hash: PASS },
    })
    expect(verdict.shape.map((entry) => entry.code)).toContain('double-extension')
  })

  it('flags a program dressed as a document by its type', () => {
    // The name is innocent and the wire says otherwise. Nothing looked at this.
    const verdict = judgeDownload({
      url: 'https://files.example.test/invoice.pdf',
      filename: 'invoice.pdf',
      mimeType: 'application/x-msdownload',
      checks: { feed: PASS, 'file-type': PASS, hash: PASS },
    })
    expect(verdict.shape.map((entry) => entry.code)).toContain('type-is-a-program')
  })

  it('says nothing when the name and the type agree', () => {
    /**
     * The other side of the guard, and the reason it is narrow: a document served as a
     * document, and a program served as a program, are both ordinary. A check that
     * flagged either would fire on most of the web.
     */
    for (const [filename, mimeType] of [
      ['report.pdf', 'application/pdf'],
      ['installer.exe', 'application/x-msdownload'],
      ['photo.jpg', 'image/jpeg'],
      ['archive.zip', 'application/zip'],
    ] as const) {
      const verdict = judgeDownload({
        url: `https://files.example.test/${filename}`,
        filename,
        mimeType,
        checks: { feed: PASS, 'file-type': PASS, hash: PASS },
      })
      expect(
        verdict.shape.map((entry) => entry.code),
        `${filename} as ${mimeType}`,
      ).not.toContain('type-is-a-program')
    }
  })
})
