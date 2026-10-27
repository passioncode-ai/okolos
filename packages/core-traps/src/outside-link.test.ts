import { describe, expect, it } from 'vitest'

import { classifyOutsideLink } from './outside-link.js'

describe('links that hand the click to a Windows program (B-165)', () => {
  it('names the troubleshooting-tool scheme behind Follina', () => {
    const verdict = classifyOutsideLink(
      'ms-msdt:/id PCWDiagnostic /skip force /param "IT_BrowseForFile=$(calc)"',
    )
    expect(verdict).toMatchObject({ scheme: 'ms-msdt', host: null })
  })

  it('names a saved search that opens a folder on another computer, and the computer', () => {
    const verdict = classifyOutsideLink(
      'search-ms:query=invoice&crumb=location:%5C%5Cfiles.attacker.test@SSL%5CDavWWWRoot%5C&displayname=Downloads',
    )
    expect(verdict).toMatchObject({ scheme: 'search-ms', host: 'files.attacker.test' })
  })

  it('names the older search scheme too', () => {
    expect(classifyOutsideLink('search:query=x&crumb=location:\\\\10.0.0.5\\share')).toMatchObject({
      scheme: 'search',
      host: '10.0.0.5',
    })
  })

  it('names the App Installer and where it would install from', () => {
    expect(
      classifyOutsideLink('ms-appinstaller:?source=https://cdn.attacker.test/Teams.msix'),
    ).toMatchObject({ scheme: 'ms-appinstaller', host: 'cdn.attacker.test' })
  })

  it('names the Office command scheme', () => {
    expect(classifyOutsideLink('ms-officecmd:{"id":3,"LocalProviders.LaunchOfficeAppForResult":{}}')).toMatchObject({
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
      scheme: 'ms-word',
      host: 'files.attacker.test',
      signals: ['ms-word', 'document-not-over-https'],
    })
  })

  it('names a document fetched from a shared folder', () => {
    expect(classifyOutsideLink('ms-excel:ofv|u|\\\\10.0.0.5\\share\\book.xlsx')).toMatchObject({
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

describe('file addresses, which the browser itself refuses from a page', () => {
  /**
   * Chromium and Firefox both refuse a `file:` navigation from an http(s) page
   * (measured in the product reading of round 1: "Not allowed to load local
   * resource", the address unchanged, no request made). A warning that a shared
   * folder "opens" described what could not happen, so these are not named.
   */
  it('does not name a file address with a host', () => {
    expect(classifyOutsideLink('file://fileserver.attacker.test/share/invoice.lnk')).toBeNull()
    expect(classifyOutsideLink('file:////10.0.0.5/share/a.exe')).toBeNull()
    expect(classifyOutsideLink('file://///evil/share')).toBeNull()
  })

  it('leaves a file on this computer alone', () => {
    expect(classifyOutsideLink('file:///C:/Users/me/report.pdf')).toBeNull()
    expect(classifyOutsideLink('file://localhost/etc/hosts')).toBeNull()
  })
})

describe('the other Office handlers, round 1 of the certification', () => {
  it('names every desktop Office handler when the document is not over https', () => {
    for (const scheme of ['ms-visio', 'ms-access', 'ms-project', 'ms-publisher', 'ms-spd', 'ms-infopath']) {
      expect(classifyOutsideLink(`${scheme}:ofe|u|http://files.attacker.test/a`), scheme).toMatchObject({
        scheme,
        host: 'files.attacker.test',
        signals: [scheme, 'document-not-over-https'],
      })
      expect(classifyOutsideLink(`${scheme}:ofe|u|https://contoso.sharepoint.com/a`), scheme).toBeNull()
    }
  })

  it('names a OneNote link to a notebook over http or on a shared folder', () => {
    expect(classifyOutsideLink('onenote:http://files.attacker.test/nb/a.one')).toMatchObject({
      scheme: 'onenote',
      host: 'files.attacker.test',
    })
    expect(classifyOutsideLink('onenote:\\\\10.0.0.5\\share\\nb')).toMatchObject({ scheme: 'onenote', host: '10.0.0.5' })
    expect(classifyOutsideLink('onenote:ofe|u|http://files.attacker.test/a.one')?.scheme).toBe('onenote')
    expect(classifyOutsideLink('onenote:https://d.docs.live.net/abc/Notebook/')).toBeNull()
    expect(classifyOutsideLink('onenote:')).toBeNull()
  })

  it('reads a percent-encoded separator as the separator', () => {
    expect(classifyOutsideLink('ms-excel:ofe%7Cu%7Chttp://files.attacker.test/a.xlsx')).toMatchObject({
      scheme: 'ms-excel',
      host: 'files.attacker.test',
    })
    expect(classifyOutsideLink('ms-excel:ofe%7cu%7chttps://contoso.sharepoint.com/a.xlsx')).toBeNull()
  })

  it('names the computer a file address in an Office link reaches', () => {
    expect(classifyOutsideLink('ms-word:ofv|u|file://evil.test/s/a.docx')).toMatchObject({
      scheme: 'ms-word',
      host: 'evil.test',
    })
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
