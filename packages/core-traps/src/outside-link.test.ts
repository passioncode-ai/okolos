import { describe, expect, it } from 'vitest'

import { classifyOutsideLink } from './outside-link.js'

describe('links that hand the click to a Windows program (B-165)', () => {
  it('names the troubleshooting-tool scheme behind Follina', () => {
    const verdict = classifyOutsideLink(
      'ms-msdt:/id PCWDiagnostic /skip force /param "IT_BrowseForFile=$(calc)"',
    )
    expect(verdict).toMatchObject({ kind: 'program', scheme: 'ms-msdt', host: null })
  })

  it('names a saved search that opens a folder on another computer, and the computer', () => {
    const verdict = classifyOutsideLink(
      'search-ms:query=invoice&crumb=location:%5C%5Cfiles.attacker.test@SSL%5CDavWWWRoot%5C&displayname=Downloads',
    )
    expect(verdict).toMatchObject({ kind: 'program', scheme: 'search-ms', host: 'files.attacker.test' })
  })

  it('names the older search scheme too', () => {
    expect(classifyOutsideLink('search:query=x&crumb=location:\\\\10.0.0.5\\share')).toMatchObject({
      kind: 'program',
      scheme: 'search',
      host: '10.0.0.5',
    })
  })

  it('names the App Installer and where it would install from', () => {
    expect(
      classifyOutsideLink('ms-appinstaller:?source=https://cdn.attacker.test/Teams.msix'),
    ).toMatchObject({ kind: 'program', scheme: 'ms-appinstaller', host: 'cdn.attacker.test' })
  })

  it('names the Office command scheme', () => {
    expect(classifyOutsideLink('ms-officecmd:{"id":3,"LocalProviders.LaunchOfficeAppForResult":{}}')).toMatchObject({
      kind: 'program',
      scheme: 'ms-officecmd',
    })
  })

  it('reads the scheme in any case', () => {
    expect(classifyOutsideLink('Search-MS:query=x')?.scheme).toBe('search-ms')
  })

  it('says why, in a code the journal can carry', () => {
    expect(classifyOutsideLink('ms-msdt:/id x')?.signals).toEqual(['ms-msdt', 'opens-a-program'])
  })
})

describe('Office documents opened straight from a link', () => {
  it('names a document fetched over plain http', () => {
    expect(classifyOutsideLink('ms-word:ofe|u|http://files.attacker.test/invoice.docx')).toMatchObject({
      kind: 'program',
      scheme: 'ms-word',
      host: 'files.attacker.test',
      signals: ['ms-word', 'document-not-over-https'],
    })
  })

  it('names a document fetched from a shared folder', () => {
    expect(classifyOutsideLink('ms-excel:ofv|u|\\\\10.0.0.5\\share\\book.xlsx')).toMatchObject({
      kind: 'program',
      host: '10.0.0.5',
    })
  })

  it('leaves the ordinary "open in the desktop app" link alone', () => {
    // SharePoint and OneDrive write these on every document page, over https.
    // A warning on each of them is how a person learns to dismiss this one.
    expect(
      classifyOutsideLink('ms-word:ofe|u|https://contoso.sharepoint.com/sites/team/Shared%20Documents/a.docx'),
    ).toBeNull()
    expect(classifyOutsideLink('ms-powerpoint:ofv|u|https://d.docs.live.net/abc/deck.pptx')).toBeNull()
  })

  it('leaves the bare program launcher alone', () => {
    expect(classifyOutsideLink('ms-excel:')).toBeNull()
  })
})

describe('links to a folder on another computer', () => {
  it('names a file address with a host', () => {
    expect(classifyOutsideLink('file://fileserver.attacker.test/share/invoice.lnk')).toMatchObject({
      kind: 'share',
      scheme: 'file',
      host: 'fileserver.attacker.test',
      signals: ['file', 'points-to-a-network-share'],
    })
  })

  it('names the four-slash form of the same address', () => {
    expect(classifyOutsideLink('file:////10.0.0.5/share/a.exe')).toMatchObject({ kind: 'share', host: '10.0.0.5' })
  })

  it('leaves a file on this computer alone', () => {
    expect(classifyOutsideLink('file:///C:/Users/me/report.pdf')).toBeNull()
    expect(classifyOutsideLink('file://localhost/etc/hosts')).toBeNull()
  })
})

describe('what it does not look at', () => {
  it('ordinary addresses', () => {
    for (const href of [
      'https://example.test/a',
      'http://example.test/',
      'mailto:a@example.test',
      'tel:+15550142',
      'javascript:void(0)',
      '#top',
      '',
      'not a url',
      'ms-settings:privacy',
    ]) {
      expect(classifyOutsideLink(href), href).toBeNull()
    }
  })
})
