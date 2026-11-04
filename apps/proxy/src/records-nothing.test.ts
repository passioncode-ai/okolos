import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The service records nothing about who asked what, and the privacy page says so.
 *
 * > «Публичная страница `/status` отвечает на вопрос "числится ли домен" и **ничего не
 * > записывает**: ни адреса, ни идентификатора, ни самого запроса.»
 *
 * That page's own format gives every row a "чем это держится" column, and this sentence had
 * nothing in it. The appeal row beside it names a test; this claim named no mechanism at
 * all — measured 2026-08-21. A single `console.log(request.url)` added later would build the
 * browsing history by proxy that the extension declined a permission in order not to have,
 * and no check would notice.
 *
 * Three things are asserted, and the first is the load-bearing one: the writes this service
 * performs are **exactly** the writes it is known to perform.
 */

// Not `new URL(import.meta.url).pathname`: on Windows that is `/D:/…`, a directory
// that does not exist, and the scan below found no files at all (B-164).
const here = import.meta.dirname

/** Every source of the service, excluding its tests. */
function sources(): string[] {
  return globSync('*.ts', { cwd: here })
    .filter((f) => !f.includes('.test.'))
    .map((f) => path.join(here, f))
}

/**
 * Statements this service is allowed to run.
 *
 * `DELETE FROM appeals` appears in `privacy.generated.ts` as well, because the privacy page
 * quotes the sweep's own SQL as its evidence — the page showing what it is held by is the
 * point, not an extra write.
 */
const ALLOWED_WRITES = ['INSERT INTO appeals', 'DELETE FROM appeals']

/** Headers that identify the caller rather than describe the request. */
const IDENTIFYING_HEADERS = [
  'cf-connecting-ip',
  'x-forwarded-for',
  'x-real-ip',
  'cf-ipcountry',
  'user-agent',
]

describe('the service records nothing about who asked what', () => {
  it('is reading the service it claims to check', () => {
    const files = sources().map((f) => path.basename(f))
    expect(files).toContain('router.ts')
    expect(files).toContain('index.ts')
  })

  it('writes only what it is known to write', () => {
    const found: string[] = []
    for (const file of sources()) {
      const body = readFileSync(file, 'utf8')
      for (const match of body.matchAll(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/gi)) {
        const statement = match[0].replace(/\s+/g, ' ')
        if (!ALLOWED_WRITES.some((ok) => statement.toUpperCase().startsWith(ok.toUpperCase()))) {
          found.push(`${path.basename(file)}: ${statement}`)
        }
      }
    }
    expect(found, 'a write nobody declared is a record the privacy page denies').toEqual([])
  })

  it('finds the writes it does allow, so an empty scan cannot pass as a clean one', () => {
    const body = sources()
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
    for (const allowed of ALLOWED_WRITES) {
      expect(body, `${allowed} is gone — has the appeal flow moved?`).toContain(allowed)
    }
  })

  it('logs nothing', () => {
    // A log line is a record. Cloudflare's tail takes whatever a worker prints, so
    // `console.log(request.url)` is the whole defect in one call.
    const logging: string[] = []
    for (const file of sources()) {
      for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        const code = line.trim()
        if (code.startsWith('//') || code.startsWith('*')) continue
        if (/\bconsole\.\w+\(/.test(code)) logging.push(`${path.basename(file)}:${i + 1}`)
      }
    }
    expect(logging, 'a printed request is a recorded request').toEqual([])
  })

  /**
   * A **read**, not a mention. The first version matched the header names anywhere in the
   * sources and went red on `privacy.generated.ts` — the served privacy page names those
   * headers in the very paragraph promising they are not read, and the page is generated
   * into a source file. A gate that cannot tell its subject from its own documentation
   * makes the documentation the thing that gets changed.
   */
  it('never reads a header that identifies the caller', () => {
    const read: string[] = []
    for (const file of sources()) {
      const body = readFileSync(file, 'utf8').toLowerCase()
      for (const header of IDENTIFYING_HEADERS) {
        // `headers.get('cf-connecting-ip')` in any spacing or quoting.
        const call = new RegExp(String.raw`headers\s*\.\s*get\s*\(\s*['"\`]` + header, 'i')
        if (call.test(body)) read.push(`${path.basename(file)}: ${header}`)
      }
    }
    expect(read, 'the rate limit is counted from the appeals table for this reason').toEqual([])
  })
})
