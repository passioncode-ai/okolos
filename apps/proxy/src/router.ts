/**
 * Every route this backend has, and what each one is allowed to know.
 *
 * The rules are the same everywhere: no cookies are set, no identifiers are
 * read, nothing about a request is stored except what an appeal explicitly
 * contains. A domain lookup is answered and forgotten.
 */
import { displayFeedNameRu, isOurFeed, OUR_FEEDS } from '@okolos/core-feeds'

import { PRIVACY_HTML } from './privacy.generated.js'
import { PUBLIC_STYLE } from './style.generated.js'

export interface Env {
  readonly DB: D1Like
  /** Base URL where signed feed files are published. */
  readonly FEEDS_BASE?: string
  /**
   * Bearer token for reading appeals back.
   *
   * Unset means the route does not exist — a 404 rather than a 401, because an
   * endpoint that admits to existing invites the guessing that follows. Nothing
   * else on this service is authenticated and nothing else needs to be: appeals
   * are the one thing here that somebody wrote in confidence.
   */
  readonly APPEALS_TOKEN?: string
}

export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>
      first<T = unknown>(): Promise<T | null>
      all<T = unknown>(): Promise<{ results: T[] }>
    }
  }
}

/**
 * The headers every response carries, whatever it is.
 *
 * There were none. A grep for CSP, `x-content-type-options`, `referrer-policy`,
 * HSTS or `x-frame-options` across the whole repository returned nothing, on a
 * service whose pages are quoted by crawlers and whose form posts a domain owner
 * types their contact details into.
 *
 * The policy is as narrow as it is because the pages have earned it: they are
 * rendered whole on the server, with no script of any kind, so `script-src
 * 'none'` costs nothing and closes the class outright. `frame-ancestors 'none'`
 * rather than `x-frame-options` alone — the header is legacy and the directive is
 * what modern browsers read — and both are sent, because the legacy one still
 * decides in browsers that ignore the other.
 */
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  // Two years, subdomains included. The service is https-only in every
  // environment it is deployed to, and a downgrade is how a form post is read.
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  // No browsing data reaches this service, and no interface it serves needs a
  // camera, a microphone or a location.
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
}

const HTML_HEADERS = {
  ...SECURITY_HEADERS,
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=300',
}

const JSON_HEADERS = {
  ...SECURITY_HEADERS,
  'content-type': 'application/json; charset=utf-8',
  // Nothing here is cacheable per-user because nothing here is per-user.
  'cache-control': 'public, max-age=300',
  'access-control-allow-origin': '*',
}

/**
 * The same JSON headers without the open CORS grant.
 *
 * Used for anything a cross-origin page must not be able to read. `*` on a
 * public lookup is right — the answer is public — and `*` on an appeal's reply
 * would hand an attacker's page the reference it just filed under somebody
 * else's domain.
 */
const PRIVATE_JSON_HEADERS = { ...JSON_HEADERS, 'access-control-allow-origin': '' }

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...JSON_HEADERS, 'access-control-allow-headers': 'content-type' },
    })
  }

  // HEAD is a GET without a body, and the platform strips the body itself.
  // Testing for GET alone sent every crawler, link checker and monitor to the
  // 404 — on the surface whose whole purpose is being found and quoted.
  const readOnly = request.method === 'GET' || request.method === 'HEAD'

  if (url.pathname === '/status/domain' && readOnly) {
    return domainStatus(url.searchParams.get('domain'), env)
  }

  if (url.pathname === '/appeal' && request.method === 'POST') {
    return appeal(request, env, url)
  }

  if (url.pathname === '/appeals' && readOnly) {
    return listAppeals(request, env, url)
  }

  if (url.pathname.startsWith('/feeds/') && readOnly) {
    return servePublishedFeed(url.pathname.slice('/feeds/'.length), env)
  }

  if (url.pathname === '/status' && readOnly) {
    return statusPage(url, env)
  }

  // A stable address, because a store listing links to it and a person
  // deciding about the permissions has not installed anything yet.
  if (url.pathname === '/' && readOnly) {
    return landingPage(url)
  }

  if (url.pathname === '/privacy' && readOnly) {
    return privacyPage()
  }

  if (url.pathname === '/healthz') {
    return json({ ok: true })
  }

  return json({ error: 'not found' }, 404)
}

/** Escapes text for HTML. The domain arrives in a query string. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The public status page, rendered here with the answer already in it.
 *
 * A page assembled by a script says nothing to the second reader every public
 * page has — a crawler, or anything quoting it — and the answer to "is this
 * domain listed" is exactly the kind of thing that gets quoted. So it is
 * served whole, and needs no JavaScript to be read.
 *
 * One question, one address: `/status?domain=x`, with a canonical link to the
 * normalised form so `Evil.TEST.` and `evil.test` do not become two pages.
 */
/** Names this service publishes. Anything else is a 404, not a database query. */
/**
 * The feeds this service publishes and can therefore lift a listing from.
 *
 * Used for two decisions that must not disagree: which feed name `/feeds/:name`
 * will serve, and whether an appeal is ours to act on. Ownership used to be
 * `feed.startsWith('okolos')` — a naming convention standing in for a
 * permission check, and one that was already wrong: the only feed actually
 * published is called `phishing`, so every listing we can lift was being sent
 * to a third party that has never heard of it.
 */
const PUBLISHED_FEEDS = new Set(Object.keys(OUR_FEEDS))

/**
 * Serves a published feed exactly as it was published.
 *
 * The extension verifies it against a key compiled into its build, so anything
 * this worker changed on the way out would fail verification — which is the
 * point. It never signs and never assembles: the private half of the key is
 * not here.
 *
 * A feed that has not been published is a 404, not an empty snapshot. An empty
 * one would be a signed claim that nothing is dangerous, and the extension
 * would install zero rules believing that was the answer.
 */
async function servePublishedFeed(name: string, env: Env): Promise<Response> {
  if (!PUBLISHED_FEEDS.has(name)) return json({ error: 'not found' }, 404)

  let row: { body: string; updated_at: string } | null
  try {
    row = await env.DB.prepare('SELECT body, updated_at FROM feeds WHERE name = ?')
      .bind(name)
      .first<{ body: string; updated_at: string }>()
  } catch {
    return json({ error: 'the feed could not be read' }, 503)
  }

  if (!row) return json({ error: 'no feed has been published under that name' }, 404)

  return new Response(row.body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Short: a blocking feed that is an hour stale is a phishing site that
      // stayed up an hour longer.
      'cache-control': 'public, max-age=900',
      'last-modified': new Date(row.updated_at).toUTCString(),
    },
  })
}

/**
 * The privacy policy, served whole and without a script.
 *
 * Generated from `docs/privacy.md` so the document a reader sees and the one the
 * repository keeps cannot drift; a test compares the committed markup with what
 * the generator produces.
 */
/**
 * The visual layer, inlined into every public page.
 *
 * All three shipped with none until 2026-08-21 — Times New Roman, browser bullets, text edge
 * to edge across a wide window — while the markup, the copy and the metadata were all right.
 * Found by rendering them and looking, on the surfaces a stranger meets first. A worker has
 * no CSS build and no filesystem, so the sheet is generated from `packages/ui/src/tokens.ts`
 * into `style.generated.ts` rather than hand-copied here, which would be the second place a
 * colour lives.
 */
const STYLE_TAG = `<style>${PUBLIC_STYLE}</style>`

function privacyPage(): Response {
  return new Response(
    `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Приватность — Okolos</title>
<meta name="description" content="Что Okolos отправляет с устройства, что не отправляет, и сколько хранит.">
${STYLE_TAG}
</head>
<body>
<main>
${PRIVACY_HTML}
</main>
</body>
</html>`,
    { status: 200, headers: HTML_HEADERS },
  )
}

/**
 * The page a stranger lands on, written for two readers at once.
 *
 * A person arrives asking what this is and whether it can be trusted. A crawler
 * or an assistant arrives to quote it, and can only quote what is in the markup
 * — so every claim is a sentence in the HTML rather than something a script
 * fills in, there is no script at all, and the structured block below says the
 * same things in the form a machine reads.
 *
 * Every claim here is one this project can prove: they come from
 * `docs/brand/facts.md`, where each row carries the file, command or measured
 * number behind it. Two of the four sections are about what the product does
 * **not** do, which is not modesty — a security tool that lists only its
 * powers is describing a product nobody can check.
 */
function landingPage(url: URL): Response {
  const origin = url.origin
  const structured = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Okolos',
    applicationCategory: 'BrowserApplication',
    operatingSystem: 'Chrome, Edge, Firefox',
    description:
      'Расширение против инструкций, спрятанных на странице для ИИ-ассистента, а не для человека. Работает на устройстве.',
    license: 'https://www.gnu.org/licenses/agpl-3.0.html',
    isAccessibleForFree: true,
    url: origin,
  }

  return new Response(
    `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Okolos — защита от скрытых инструкций для ассистента</title>
<meta name="description" content="Находит на странице текст, спрятанный от человека, но видимый ИИ-ассистенту, и обезвреживает его до того, как ассистент прочтёт. Работает на устройстве, история браузинга никуда не уходит.">
<link rel="canonical" href="${escapeHtml(origin)}/">
<script type="application/ld+json">${JSON.stringify(structured)}</script>
${STYLE_TAG}
</head>
<body>
<main>
<h1>Okolos — защита от скрытых инструкций</h1>

<p data-role="lede">На странице бывает текст, который человек не видит, а
ассистент читает и исполняет. Okolos находит такой текст, обезвреживает его до
того, как ассистент до него доберётся, и умеет вернуть страницу как было.</p>

<h2 id="what">Что он делает</h2>
<ul data-role="does">
<li>Находит текст, скрытый от человека и видимый ассистенту.</li>
<li>Обезвреживает найденное, не ломая страницу, и возвращает как было.</li>
<li>Держит действие агента до решения человека — переходы и отправку форм.</li>
<li>Блокирует страницы по подписанному списку <strong>до</strong> их загрузки.</li>
<li>Предупреждает о доменах-двойниках, включая кириллические подмены.</li>
<li>Судит о загрузках и не выдаёт непроверенное за проверенное.</li>
<li>Следит за изменениями в установленных расширениях.</li>
<li>Проверяет утечки по адресу почты и пароли по префиксу хеша.</li>
<li>Ведёт восстановление после инцидента по шагам.</li>
</ul>

<h2 id="does-not">Чего он не делает</h2>
<p>Это не оговорки мелким шрифтом, а часть обещания.</p>
<ul data-role="does-not">
<li>Не отправляет историю браузинга. Страницы проверяются на устройстве по
списку, скачанному целиком.</li>
<li>Не считает «заблокированные угрозы» и не рисует уровень защиты.</li>
<li>Не хранит события дольше 90 дней.</li>
<li>Не удерживает действие, у которого нет формы и навигации — но
<strong>записывает</strong> такие запросы, пока находка на странице не разобрана.</li>
<li>Не опознаёт агента, который снял флаг автоматизации.</li>
<li>Не выпускает третью ступень на модели: она принимает подписи для
скринридеров за инструкции.</li>
</ul>

<h2 id="trust">Почему этому можно верить</h2>
<p>Не потому, что мы так говорим. Каждый запрос наружу
<strong>записывается в журнал до того, как уйти</strong>, и если запись не
удалась — запрос отменяется. Журнал целиком виден на экране «Что ушло с этого
устройства», выгружается одним файлом и стирается целиком.</p>
<p>Исходный код открыт под GNU AGPL-3.0 — и расширения, и этого сервиса: что он
делает, можно прочитать, а не принять на веру. Пользоваться бесплатно, в том числе
в компании; лицензия для закрытых продуктов — contact@passioncode.ai.</p>

<h2 id="pages">Что ещё здесь есть</h2>
<ul data-role="pages">
<li><a href="/privacy">Приватность</a> — что уходит с устройства, что не уходит и
сколько хранится. Полный список назначений, без исключений.</li>
<li><a href="/status">Статус домена</a> — для владельца сайта: числится ли домен
в списке, в каком именно и с какой даты. Там же подаётся апелляция.</li>
</ul>
</main>
</body>
</html>`,
    { status: 200, headers: HTML_HEADERS },
  )
}

async function statusPage(url: URL, env: Env): Promise<Response> {
  const raw = url.searchParams.get('domain')
  const domain = normaliseDomain(raw)

  const shell = (title: string, body: string, canonical?: string): Response =>
    new Response(
      `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(title)}">
${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ''}
${STYLE_TAG}
</head>
<body>
<main>
<h1 data-role="title">Статус домена</h1>
${body}
<form method="get" action="/status" data-role="lookup">
<label for="domain">Домен для проверки</label>
<input id="domain" name="domain" data-role="domain" type="text" placeholder="example.com" value="${escapeHtml(domain ?? '')}">
<button type="submit" data-role="check">Проверить</button>
</form>
</main>
</body>
</html>`,
      { status: 200, headers: HTML_HEADERS },
    )

  if (!domain) {
    return shell(
      'Статус домена — введите домен',
      '<p data-role="hint">Введите домен, чтобы узнать, числится ли он в списке и в каком именно.</p>',
    )
  }

  const canonical = `${url.origin}/status?domain=${encodeURIComponent(domain)}`

  let row: { feed: string; entry_date: string } | null
  try {
    row = await env.DB.prepare('SELECT feed, entry_date FROM listings WHERE domain = ?')
      .bind(domain)
      .first<{ feed: string; entry_date: string }>()
  } catch {
    // Never "clean" when the answer could not be looked up — the same rule the
    // JSON endpoint holds, and for the same reason.
    return shell(
      `Статус домена — ${domain}`,
      `<p data-role="error">Статус <strong>${escapeHtml(domain)}</strong> сейчас не удалось выяснить. Это не утверждение, что домен чист.</p>`,
      canonical,
    )
  }

  if (!row) {
    return shell(
      `${domain} — не числится`,
      `<p data-role="verdict"><strong>${escapeHtml(domain)}</strong> <strong>не числится</strong> ни в одном списке, который несёт этот сервис.</p>`,
      canonical,
    )
  }

  const ours = isOurFeed(row.feed)
  // The list's name, never its identifier. This page is the one a site owner
  // reads when their domain has been blocked, and `phishing` is a database key
  // dressed up as a reason.
  // Russian, because this page is `lang="ru"` and every other word on it is. It printed
  // the English name until 2026-08-20 — to a site owner reading Russian (B-24).
  const named = escapeHtml(displayFeedNameRu(row.feed) ?? row.feed)
  return shell(
    `${domain} — числится`,
    `<p data-role="verdict"><strong>${escapeHtml(domain)}</strong> <strong>числится</strong> в списке <strong>${named}</strong>, запись от ${escapeHtml(row.entry_date)}.</p>` +
      (ours
        ? appealForm(domain)
        : `<p data-role="upstream">Эта запись принадлежит списку ${named}, а не нам. Снять её может только их процедура апелляции; мы следуем их данным.</p>`),
    canonical,
  )
}

/**
 * The appeal, as a plain form.
 *
 * Only for listings we can actually lift: a form against someone else's feed
 * collects a plea nobody reads, and costs the owner the day they should have
 * spent writing to the party that can help.
 *
 * No script, because the owner reading this arrived from an interstitial on a
 * site that is down and has no reason to trust another page's JavaScript — and
 * because a form that needs JS is a form that fails silently when it does not
 * load.
 */
function appealForm(domain: string): string {
  return `<form method="post" action="/appeal" data-role="appeal">
<h2>Оспорить запись</h2>
<input type="hidden" name="domain" value="${escapeHtml(domain)}">
<label for="contact">Как с вами связаться</label>
<input id="contact" name="contact" data-role="contact" type="text" maxlength="200" placeholder="you@${escapeHtml(domain)}">
<label for="message">Что изменилось</label>
<textarea id="message" name="message" data-role="message" maxlength="2000" rows="4"></textarea>
<button type="submit" data-role="send-appeal">Отправить апелляцию</button>
</form>`
}

async function domainStatus(domain: string | null, env: Env): Promise<Response> {
  const normalised = normaliseDomain(domain)
  if (!normalised) return json({ error: 'a domain is required' }, 400)

  let row: { feed: string; entry_date: string } | null
  try {
    row = await env.DB.prepare('SELECT feed, entry_date FROM listings WHERE domain = ?')
      .bind(normalised)
      .first<{ feed: string; entry_date: string }>()
  } catch {
    // Never "clean" when the answer could not be looked up: an owner acting on
    // that would waste a day discovering it was wrong.
    return json(
      { domain: normalised, status: 'unknown', detail: 'the status service could not be reached' },
      503,
    )
  }

  if (!row) {
    return json({ domain: normalised, status: 'not-listed', detail: 'nothing is recorded for this domain' })
  }

  return json({
    domain: normalised,
    status: 'listed',
    // The identifier stays: this is an API, and a caller keying off a display
    // name would break the first time the name is improved.
    feed: row.feed,
    /**
     * The same list, as a person should read it — and in the language the page is in.
     *
     * It was the English name while `/status` is `lang="ru"` throughout, so the API and
     * the page disagreed about what one list is called (B-24). There is no English
     * public page to be consistent with; a second field would be a language nothing here
     * ever shows.
     */
    feedName: displayFeedNameRu(row.feed),
    entryDate: row.entry_date,
    // Most listings are not ours, and saying so is the difference between an
    // owner fixing the problem and an owner arguing with the wrong party.
    appealTo: isOurFeed(row.feed) ? 'okolos' : row.feed,
  })
}

/**
 * The largest appeal this service will read, in bytes.
 *
 * The fields are capped at 2000 and 200 characters — **after** the body has been
 * read whole. `request.text()` and `request.json()` pull everything a client
 * chooses to send before any check happens, so the cap described the row and not
 * the read, and an unauthenticated POST could hand the worker as much as it liked.
 */
const APPEAL_BYTES_MAX = 8 * 1024

/** Appeals accepted per domain per window, and the window. */
const APPEALS_PER_DOMAIN = 5
const APPEAL_WINDOW_MS = 60 * 60 * 1000

/**
 * Reads at most `APPEAL_BYTES_MAX` bytes, or refuses.
 *
 * `content-length` is checked first because it is free, and then the stream is
 * read with a running total because the header is optional and a chunked body
 * has none. Both, not either: trusting the header alone is trusting the sender
 * about how much the sender is sending.
 */
async function boundedBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > APPEAL_BYTES_MAX) return null

  const body = request.body
  if (!body) return await request.text()

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > APPEAL_BYTES_MAX) {
      // Cancelled rather than drained: continuing to read a body we have already
      // refused is doing the work the refusal exists to avoid.
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }

  const joined = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    joined.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

/**
 * Whether this request came from somewhere allowed to post the form.
 *
 * There was no check of any kind: no token, no `Origin` read, and the form is
 * `x-www-form-urlencoded`, which needs no preflight — so any page anywhere could
 * file an appeal under any domain, in the visitor's name, with one HTML form and
 * no JavaScript. The JSON path was no better: the preflight answered 204 for
 * every path.
 *
 * `Sec-Fetch-Site` is the modern answer and browsers set it on every request
 * they make; `Origin` is the fallback for those that do not. A request carrying
 * neither is not a browser, and a non-browser cannot be made to act on a
 * visitor's behalf without their knowledge — which is the whole of what this
 * check is for. It is not authentication and does not pretend to be.
 */
function fromAnAllowedOrigin(request: Request, url: URL): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site) return site === 'same-origin' || site === 'same-site' || site === 'none'

  const origin = request.headers.get('origin')
  if (origin === null) return true
  try {
    return new URL(origin).origin === url.origin
  } catch {
    return false
  }
}

async function appeal(request: Request, env: Env, url: URL): Promise<Response> {
  // A browser posting the form on /status and a client posting JSON are the
  // same appeal; only the wrapping differs. The owner gets a page back, because
  // a browser handed a JSON body renders it as text and the owner cannot tell
  // whether anything was recorded.
  const asForm = (request.headers.get('content-type') ?? '').includes(
    'application/x-www-form-urlencoded',
  )
  const reply = asForm
    ? appealPage
    : (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: PRIVATE_JSON_HEADERS })

  if (!fromAnAllowedOrigin(request, url)) {
    return reply({ error: 'this appeal did not come from this site — nothing was saved' }, 403)
  }

  const raw = await boundedBody(request)
  if (raw === null) {
    return reply(
      { error: `an appeal may not exceed ${APPEAL_BYTES_MAX} bytes — nothing was saved` },
      413,
    )
  }

  let body: { domain?: unknown; contact?: unknown; message?: unknown }
  if (asForm) {
    const fields = new URLSearchParams(raw)
    body = {
      domain: fields.get('domain') ?? undefined,
      contact: fields.get('contact') ?? undefined,
      message: fields.get('message') ?? undefined,
    }
  } else {
    try {
      body = JSON.parse(raw) as typeof body
    } catch {
      return reply({ error: 'a JSON body is required' }, 400)
    }
  }

  const domain = normaliseDomain(typeof body.domain === 'string' ? body.domain : null)
  if (!domain) return reply({ error: 'a domain is required' }, 400)

  const message = typeof body.message === 'string' ? body.message.slice(0, 2000) : ''
  const contact = typeof body.contact === 'string' ? body.contact.slice(0, 200) : ''

  /**
   * A budget per domain, counted from the table itself.
   *
   * Nothing about the sender is stored — no address, no identifier — so the
   * limit is keyed on the only thing an appeal contains that is worth limiting.
   * It does not stop a flood spread across many domains; it stops the row
   * stuffing that a single HTML page could do, and it does so without this
   * service learning anything new about anyone.
   */
  const since = new Date(Date.now() - APPEAL_WINDOW_MS).toISOString()
  const recent = await countAppeals(env, domain, since)
  if (recent !== null && recent >= APPEALS_PER_DOMAIN) {
    return reply(
      {
        error: `this domain already has ${recent} appeals in the last hour — nothing was saved`,
        domain,
      },
      429,
    )
  }

  /**
   * A duplicate is the same domain, message **and contact**.
   *
   * The reference used to be a 32-bit hash of `domain|message` and it was also
   * the primary key, so an attacker could compute the reference an owner's
   * appeal would get, file it first with their own contact, and the owner's
   * submission came back "already filed" — with the owner's contact details
   * never stored and nothing to tell them why. The reference is random now, and
   * the duplicate check reads the row rather than colliding with it.
   */
  const already = await findAppeal(env, domain, message, contact)
  if (already) return reply({ reference: already.reference, domain, alreadyFiled: true })

  const reference = newReference()
  try {
    await env.DB.prepare(
      'INSERT INTO appeals (reference, domain, contact, message, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(reference, domain, contact, message, new Date().toISOString())
      .run()
  } catch (cause) {
    // The check above is not a lock, so two requests can pass it together. A
    // key conflict here is that race and not a failure — the appeal is on file.
    if (isDuplicate(cause)) return reply({ reference, domain, alreadyFiled: true })
    return reply({ error: 'the appeal could not be recorded — nothing was saved' }, 503)
  }

  return reply({ reference, domain, alreadyFiled: false })
}

/** How many appeals this domain has filed since `since`, or `null` if unknown. */
async function countAppeals(env: Env, domain: string, since: string): Promise<number | null> {
  try {
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM appeals WHERE domain = ? AND created_at > ?',
    )
      .bind(domain, since)
      .first<{ n: number }>()
    return typeof row?.n === 'number' ? row.n : null
  } catch {
    /**
     * A database that cannot be counted must not become a database that cannot
     * be written to: the appeal is the thing this service exists for, and
     * refusing it because the limiter is unavailable would be a denial of
     * service performed on the owner. `null` means "not known", and the insert
     * below is still bounded by the duplicate check and by the body cap.
     */
    return null
  }
}

/** The appeal already on file for this exact submission, if there is one. */
async function findAppeal(
  env: Env,
  domain: string,
  message: string,
  contact: string,
): Promise<{ reference: string } | null> {
  try {
    return await env.DB.prepare(
      'SELECT reference FROM appeals WHERE domain = ? AND message = ? AND contact = ? LIMIT 1',
    )
      .bind(domain, message, contact)
      .first<{ reference: string }>()
  } catch {
    // Unknown, not absent. The insert's own key conflict still catches a repeat.
    return null
  }
}

/**
 * Reads appeals back, for whoever holds the token.
 *
 * The whole tree contained an `INSERT` and a `DELETE` and nothing else: appeals
 * were written, swept after 180 days, and never read by anybody. A form that
 * files a complaint into a table no one opens is a form that lies by existing.
 */
async function listAppeals(request: Request, env: Env, url: URL): Promise<Response> {
  const expected = env.APPEALS_TOKEN
  // Unset means the route does not exist. A 401 would confirm the address.
  if (!expected) return json({ error: 'not found' }, 404)

  const offered = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!timingSafeEqual(offered, expected)) return json({ error: 'not found' }, 404)

  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '50') || 50, 1), 200)
  const rows = await env.DB.prepare(
    'SELECT reference, domain, contact, message, created_at FROM appeals ORDER BY created_at DESC LIMIT ?',
  )
    .bind(limit)
    .all<{
      reference: string
      domain: string
      contact: string | null
      message: string | null
      created_at: string
    }>()

  return new Response(JSON.stringify({ appeals: rows.results }), {
    status: 200,
    // Never cached and never readable cross-origin: this is the one response
    // here that contains something somebody wrote in confidence.
    headers: { ...PRIVATE_JSON_HEADERS, 'cache-control': 'no-store' },
  })
}

/**
 * Compares without leaking the answer through how long it took.
 *
 * The comparison is against a secret, and `a === b` on strings returns at the
 * first differing byte. Over enough attempts that difference is the token.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * A reference nobody can compute in advance.
 *
 * It used to be a 32-bit hash of the domain and the message — guessable by
 * construction, and the primary key besides, so filing an appeal under a
 * predicted reference blocked the real one. Random, and long enough that
 * guessing is not a strategy.
 */
function newReference(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  const body = [...bytes].map((b) => b.toString(36).toUpperCase().padStart(2, '0')).join('')
  return `OK-${body}`
}

/**
 * The same outcome as the JSON body, rendered for the browser that submitted
 * the form. A reference appears only when a row exists to answer for it — an
 * owner quoting a reference for an appeal that was never saved is worse off
 * than one who was told plainly it failed.
 */
function appealPage(
  body: { reference?: string; domain?: string; alreadyFiled?: boolean; error?: string },
  status = 200,
): Response {
  const { reference, domain, alreadyFiled, error } = body
  const inner =
    error !== undefined
      ? `<p data-role="not-saved">${escapeHtml(error)}.</p><p>Nothing about this appeal is on file. Sending it again is safe.</p>`
      : alreadyFiled === true
        ? `<p data-role="already-filed">This appeal for <strong>${escapeHtml(domain ?? '')}</strong> was <strong>already on file</strong>. Its reference is <strong>${escapeHtml(reference ?? '')}</strong> — the same one, because it is the same appeal.</p>`
        : `<p data-role="reference">The appeal for <strong>${escapeHtml(domain ?? '')}</strong> is recorded. Its reference is <strong>${escapeHtml(reference ?? '')}</strong>.</p>`

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Appeal — ${escapeHtml(domain ?? 'domain status')}</title>
<meta name="robots" content="noindex">
</head>
<body>
<main>
<h1 data-role="appeal-title">Appeal</h1>
${inner}
<p data-role="back"><a href="/status${domain !== undefined ? `?domain=${encodeURIComponent(domain)}` : ''}">Back to the domain status</a></p>
</main>
</body>
</html>`,
    {
      status,
      /**
       * The security headers, spread rather than written out.
       *
       * This response was the one that had them and did not: it is built here
       * rather than through `json` or `HTML_HEADERS`, so adding them in one place
       * left exactly this page — the page a domain owner reads after typing their
       * contact details into a form — without a policy. Found by a test that asked
       * every response type the same question.
       *
       * `no-store` stays and overrides the shared `max-age`: an appeal's reply
       * names a reference, and a shared cache holding that is a shared cache
       * holding somebody's complaint.
       */
      headers: {
        ...SECURITY_HEADERS,
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  )
}

/** A primary-key conflict, under whichever wording the driver gives it. */
function isDuplicate(cause: unknown): boolean {
  const message = String((cause as { message?: unknown } | null)?.message ?? cause)
  return /unique constraint|primary key|constraint failed/i.test(message)
}

export function normaliseDomain(raw: string | null): string | null {
  if (!raw) return null
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, '')
  if (trimmed === '') return null
  let hostname: string
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    hostname = url.hostname
  } catch {
    return null
  }
  return isPublicHost(hostname) ? hostname : null
}

/**
 * Whether this is a host the service can honestly answer about.
 *
 * `..` used to normalise to `.` and `../../etc/passwd` to `..`, and both were
 * stored as domains and answered about as domains. Parameterised SQL means it
 * was never an injection; it was nonsense in and nonsense out, and an appeal
 * filed for `.` is a row nobody can act on.
 *
 * A single label is refused for the same reason: this service is about sites
 * on the public internet, and `localhost` is not one. An address literal is
 * kept — a listing can legitimately be one.
 */
function isPublicHost(hostname: string): boolean {
  if (hostname === '') return false
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true
  const labels = hostname.split('.')
  if (labels.length < 2) return false
  return labels.every((label) => /^[a-z0-9-]+$/.test(label))
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}
