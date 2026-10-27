// Who may call a service: the descriptor token, the network guard, the operator's one-time login and session, remote placement (DEC-0019), the feed client's token header.
// Part of the Node service kit (FAA-65, layer L3); the twin of fabric_auth.py. Node 20+, no dependency.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL, ServiceError, nowIso } from './fabric-base.mjs';
import { tokenMatches, windowsTokenProblem } from './fabric-platform.mjs';
import { atomicWrite, ensurePrivateDir, servicesDir } from './fabric-paths.mjs';
import { isPlainObject } from './fabric-usage.mjs';
import { validateDescriptor, writeDescriptor } from './fabric-descriptor.mjs';

export const SESSION_COOKIE = 'fabric_session';

// DEC-0019: a remote placement's cookie is host-bound and HTTPS-only.
export const REMOTE_SESSION_COOKIE = '__Host-fabric_session';

const CODE = /^[A-Za-z0-9_-]{16,256}$/;

export function ensureToken(file) {
  if (fs.existsSync(file)) return readToken(file);
  ensurePrivateDir(path.dirname(file));
  const token = crypto.randomBytes(32).toString('base64url');
  atomicWrite(file, token, 0o600);
  return token;
}

/**
 * Refuse a symlink, a file owned by someone else, or one others can read. On Windows the rule is
 * service.md "Windows token files" (DEC-0032, DEC-0033, DEC-0057): windowsTokenAclProblem over the
 * file's flags, owner and ACEs; a refusal names the SID, never the contents.
 */
export function readToken(file) {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink()) throw new ServiceError(`Token file ${file} is a symlink; refusing it.`);
  if (process.platform === 'win32') {
    const problem = windowsTokenProblem(file, info);
    if (problem) throw new ServiceError(problem);
  } else {
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new ServiceError(`Token file ${file} belongs to another user.`);
    if (info.mode & 0o077) throw new ServiceError(`Token file ${file} is readable by others; set mode 0600.`);
  }
  const token = fs.readFileSync(file, 'utf8').trim();
  if (token.length < 16) throw new ServiceError(`Token file ${file} holds no usable token.`);
  return token;
}

/**
 * The one header a client sends the service token in, as the descriptor's `auth` declares it: `header` defaults
 * to Authorization and `scheme` to Bearer; `none` carries the raw token. Never assume `Authorization: Bearer`.
 */
export function tokenHeader(auth, token) {
  const declared = isPlainObject(auth) ? auth : {};
  const name = typeof declared.header === 'string' ? declared.header : 'Authorization';
  const scheme = typeof declared.scheme === 'string' ? declared.scheme : 'Bearer';
  return { name, value: scheme === 'none' ? token : `Bearer ${token}` };
}

/** DEC-0039 (service.md "The session's lifetime"): the longest a service may keep an operator session. */
export const OPERATOR_SESSION_IDLE_SECONDS = 12 * 60 * 60;

export const OPERATOR_SESSION_MAX_SECONDS = 7 * 24 * 60 * 60;

// Compare bytes, not UTF-16 units: a non-ASCII value of the right length must be a refusal, not a RangeError.
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const sessionBound = (value, longest) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ServiceError('a session bound must be a finite number of seconds.');
  return Math.min(Math.trunc(value), longest);
};

// Single-use login codes, and operator sessions with the DEC-0039 lifetime: a session ends 12 h after its
// last use, 7 days after the code was redeemed, on logout, and when the descriptor token rotates. The server
// enforces all four: the cookie carries a signed claim (session id, sign-in time, token revision) and the
// code store keeps a record per session (last use, logout). Rotating the key with revokeAll() ends every one.
export class LoginCodes {
  // `stateDir` — a local service keeps codes, sessions and the session key in files. An online service
  // (DEC-0019) usually has no durable disk: pass `stateDir = null` with `{ store, key }` — `store` like
  // `new MemoryCodeStore()` and `key` a Buffer from a platform secret. A memory store forgets codes AND
  // sessions on a restart, so a deploy signs the operator out (the host signs in again on the page's 401);
  // pass a durable store to keep sessions. `token` is the descriptor token, or a function returning the
  // current one: a session begun under one token is refused once it rotates. A service MAY shorten
  // `idleSeconds` or `maxSeconds`, never lengthen them.
  constructor(stateDir, ttlSeconds = 120, { store = null, key = null, token = null,
    idleSeconds = OPERATOR_SESSION_IDLE_SECONDS, maxSeconds = OPERATOR_SESSION_MAX_SECONDS, clock = () => Date.now() / 1000 } = {}) {
    this.ttl = Math.min(ttlSeconds, 120);
    this.idleSeconds = sessionBound(idleSeconds, OPERATOR_SESSION_IDLE_SECONDS);
    this.maxSeconds = sessionBound(maxSeconds, OPERATOR_SESSION_MAX_SECONDS);
    this.store = store;
    this.fixedKey = key;
    this.token = token;
    this.clock = clock;
    if (stateDir) {
      this.dir = ensurePrivateDir(stateDir);
      this.keyPath = path.join(this.dir, 'session.key');
      this.codesPath = path.join(this.dir, 'login-codes.json');
    } else if (!store || !key) {
      throw new ServiceError('LoginCodes without a state directory needs { store, key }.');
    }
    if (key && Buffer.from(key).length < 32) throw new ServiceError('the session key must be at least 32 bytes.');
  }

  key() {
    if (this.fixedKey) return Buffer.from(this.fixedKey);
    if (!fs.existsSync(this.keyPath)) atomicWrite(this.keyPath, crypto.randomBytes(32), 0o600);
    return fs.readFileSync(this.keyPath);
  }

  load() {
    if (this.store) return this.store.load();
    try { return JSON.parse(fs.readFileSync(this.codesPath, 'utf8')); } catch { return {}; }
  }

  save(codes) {
    const horizon = this.clock() - 3600;
    const kept = Object.fromEntries(Object.entries(codes).filter(([, v]) => (v.expires ?? 0) > horizon));
    if (this.store) { this.store.save(kept); return; }
    atomicWrite(this.codesPath, JSON.stringify(kept), 0o600);
  }

  issue() {
    const code = crypto.randomBytes(24).toString('base64url');
    const expires = this.clock() + this.ttl;
    const codes = this.load();
    codes[crypto.createHash('sha256').update(code).digest('hex')] = { expires, used: false };
    this.save(codes);
    return { url: `/fabric/v1/login?code=${code}`, expiresAt: new Date(expires * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  }

  // The code is recorded as used BEFORE it is honoured, and burned even when expired.
  redeem(code) {
    if (!code || !CODE.test(code)) return null;
    const digest = crypto.createHash('sha256').update(code).digest('hex');
    const codes = this.load();
    const entry = codes[digest];
    if (!entry || entry.used) return null;
    entry.used = true;
    this.save(codes);
    const now = this.clock();
    if (entry.expires < now) return null;
    const session = crypto.randomBytes(18).toString('base64url');
    const signedInAt = Math.trunc(now);
    codes[LoginCodes.recordKey(session)] = { expires: signedInAt + this.maxSeconds, signedInAt, lastUsedAt: now };
    this.save(codes);
    const claim = `v2.${session}.${signedInAt}.${this.tokenRevision()}`;
    return `${claim}.${this.mac(claim)}`;
  }

  /** True while the session is live; a use within the bounds refreshes the idle bound. */
  sessionValid(value) {
    const parsed = this.parse(value);
    if (!parsed) return false;
    const [session, signedInAt] = parsed;
    const now = this.clock();
    if (now >= signedInAt + this.maxSeconds) return false;
    const codes = this.load();
    const record = codes[LoginCodes.recordKey(session)];
    if (!record || record.signedInAt !== signedInAt || record.loggedOutAt != null) return false;
    const last = Number(record.lastUsedAt ?? 0);
    if (now >= last + this.idleSeconds) return false;
    if (now - last >= Math.min(60, Math.max(1, Math.trunc(this.idleSeconds / 10)))) {
      record.lastUsedAt = now;
      this.save(codes);
    }
    return true;
  }

  /** End this session on the server; clear the browser's copy with expiredSessionCookieHeader(). */
  logout(value) {
    const parsed = this.parse(value);
    if (!parsed) return false;
    const codes = this.load();
    const record = codes[LoginCodes.recordKey(parsed[0])];
    if (!record || record.signedInAt !== parsed[1] || record.loggedOutAt != null) return false;
    record.loggedOutAt = this.clock();
    this.save(codes);
    return true;
  }

  parse(value) {
    if (typeof value !== 'string' || !/^[\x21-\x7e]*$/.test(value)) return null;
    const parts = value.split('.');
    if (parts.length !== 5 || parts[0] !== 'v2' || !parts[1] || !/^\d+$/.test(parts[2])) return null;
    if (!safeEqual(parts[4], this.mac(parts.slice(0, 4).join('.')))) return null;
    if (!safeEqual(parts[3], this.tokenRevision())) return null;
    return [parts[1], Number(parts[2])];
  }

  mac(claim) { return crypto.createHmac('sha256', this.key()).update(claim).digest('hex'); }

  tokenRevision() {
    const token = typeof this.token === 'function' ? this.token() : this.token;
    if (!token) return '-';
    return crypto.createHmac('sha256', this.key()).update(`token-revision\0${token}`).digest('hex').slice(0, 16);
  }

  static recordKey(session) { return `s:${crypto.createHash('sha256').update(session).digest('hex')}`; }

  revokeAll() {
    if (this.fixedKey) throw new ServiceError('a platform-held session key is rotated on the platform, not here.');
    atomicWrite(this.keyPath, crypto.randomBytes(32), 0o600);
  }
}

/** DEC-0019: a code store held in memory — for an online service with no durable disk. */
export class MemoryCodeStore {
  constructor() { this.codes = {}; }
  load() { return JSON.parse(JSON.stringify(this.codes)); }
  save(codes) { this.codes = JSON.parse(JSON.stringify(codes)); }
}

/** The cookie lives no longer than the absolute bound (DEC-0039); the server ends it sooner. */
export const sessionCookieHeader = (value, maxAge = OPERATOR_SESSION_MAX_SECONDS) => `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;

/** DEC-0019: the remote cookie — `__Host-` name, Secure, no Domain, Path=/. */
export const remoteSessionCookieHeader = (value, maxAge = OPERATOR_SESSION_MAX_SECONDS) => `${REMOTE_SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;

/** The header that clears the browser's session cookie, sent with a logout. */
export const expiredSessionCookieHeader = (remote = false) => (remote ? remoteSessionCookieHeader : sessionCookieHeader)('', 0);

/**
 * DEC-0019: the request guard of an online service. `origin` is the service's own origin
 * (`https://agent.example.com`). `forwardedProto` is the platform-set scheme where TLS ends
 * before the process (`x-forwarded-proto`); pass `undefined` when the process terminates TLS.
 * Returns the refusal sentence, or null.
 */
export function checkRemoteRequest(origin, host, requestOrigin, secFetchSite, forwardedProto) {
  const own = new URL(origin);
  // A default port, written or not, names the same host (finding 15): the URL drops it from `own`; drop it from the request too.
  const dropped = (value) => { const port = { 'https:': ':443', 'http:': ':80' }[own.protocol]; return port && value.endsWith(port) ? value.slice(0, -port.length) : value; };
  if (dropped(String(host ?? '').toLowerCase()) !== own.host) return `Host ${host} is not this service.`;
  if (forwardedProto !== undefined && forwardedProto !== null && String(forwardedProto).split(',')[0].trim() !== 'https') return 'This service answers over https only.';
  if (requestOrigin !== undefined && requestOrigin !== null && dropped(String(requestOrigin)) !== own.origin) return `Origin ${requestOrigin} is not this service.`;
  if (secFetchSite === 'cross-site') return 'Cross-site requests are refused.';
  return null;
}

/**
 * DEC-0019: may this request read the well-known document? A local service answers anyone (the
 * loopback guard already ran); a remote one only the bearer of the service token. A `false`
 * answer is a `401` with an EMPTY body — nothing about the service is disclosed.
 */
export function wellKnownAllowed(placement, authorization, token, scheme = 'Bearer') {
  return placement !== 'remote' || tokenMatches(authorization, token, scheme);
}

/** The token directory a host-side installer uses for remote services on this computer. */
export function remoteTokenFile(id, instance = 'default', dir = servicesDir()) {
  return path.join(path.dirname(dir), 'tokens', `${id}.${instance}.token`);
}

/**
 * DEC-0019, installer side: register an online service on THIS computer. Writes the token file
 * (0600, never printed) and the descriptor; the same token must be set on the hosting platform as
 * a secret. Returns the descriptor path. `token` is read from the caller — a file or stdin —
 * never from an argument vector.
 */
/**
 * DEC-0019, installer side: register an online service on THIS computer — the token file (0600, never printed) and the
 * descriptor. DEC-0061: `installedBy` defaults to `{by: 'person', role: 'operator', tool: 'fabric-service register-remote'}`
 * (a person runs this); `runner` (`{kind?, credentialKind}`) says how its model calls sign in, as a kind and never a
 * credential; `peer` (`{endpoint, custody, residency, maxDataClass}`) offers it to others and needs `runner`.
 * FAA-120: `source` (`{repository: 'https://github.com/owner/name'}`) names the repository of its code, as the schema's
 * `source.repository`; Fabric Dashboards reads it.
 */
export function registerRemote({ id, instance = 'default', name, summary, origin, token, doctor, dir = servicesDir(),
  installedBy = { by: 'person', role: 'operator', tool: 'fabric-service register-remote' }, runner, peer, source }) {
  if (!token || String(token).trim().length < 16) throw new ServiceError('the service token must be at least 16 characters.');
  const tokenFile = remoteTokenFile(id, instance, dir);
  const d = {
    protocol: PROTOCOL, id, instance, name, ...(summary ? { summary } : {}), placement: 'remote', origin,
    auth: { tokenFile }, lifecycle: { manager: 'none' }, ...(doctor ? { commands: { doctor } } : {}),
    installedAt: nowIso(), installedBy, ...(runner ? { runner: { ...runner } } : {}), ...(peer ? { peer: { ...peer } } : {}),
    ...(source != null ? { source: isPlainObject(source) ? { ...source } : source } : {}),
  };
  const problems = validateDescriptor(d);
  if (problems.length) throw new ServiceError(`Descriptor is invalid: ${problems.join('; ')}.`);
  ensurePrivateDir(path.dirname(tokenFile));
  atomicWrite(tokenFile, String(token).trim(), 0o600);
  return writeDescriptor(d, dir);
}

export function cookieValue(header, name = SESSION_COOKIE) {
  for (const part of String(header ?? '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}
