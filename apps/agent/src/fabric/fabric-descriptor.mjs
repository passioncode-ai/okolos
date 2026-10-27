// How a service is found (fabric-service/0.1): its descriptor, peers and app descriptors (DEC-0061, DEC-0069), build identity and the well-known document.
// Part of the Node service kit (FAA-65, layer L3); the twin of fabric_descriptor.py. Node 20+, no dependency.
import fs from 'node:fs';
import path from 'node:path';
import { credentialName, secretArgument, secretUrl, secretValue } from './fabric-secrets.mjs';
import { ID, INSTANCE, LOCAL_PATH, PROTOCOL, ServiceError, TASK, UNIT, expand } from './fabric-base.mjs';
import { atomicWrite, ensurePrivateDir, servicesDir } from './fabric-paths.mjs';
import { protocolsFindings } from './fabric-protocols.mjs';
import { CONNECTIONS_EXTENSION_KEY, connectionsView } from './fabric-connections.mjs';
import { ACTIONS_EXTENSION_KEY, actionsExtension, actionsExtensionRules } from './fabric-actions.mjs';
import { a2aSurfaceProblems } from './fabric-a2a.mjs';
import { ROUTES } from './fabric-usage.mjs';

// The embedded dashboard declaration (fabric-dashboard/0.1, DEC-0036 ED-9), under the well-known
// document's `extensions`. The kit is assets/dashboard-kit; its version is the one in kit.json.
export const DASHBOARD_EXTENSION_KEY = 'https://fabric.passioncode.ai/agent-contract/extensions/dashboard/0.1';

export const DASHBOARD_KIT = 'fabric-dashboard-kit@1.1.5';

export const REFERENCE_THEMES = ['graphite', 'fabric', 'paper', 'forest', 'ocean', 'ember', 'contrast'];

export const STATUSES = ['starting', 'ready', 'degraded', 'stopping'];

export const PLACEMENTS = ['local', 'remote'];

const ORIGIN = /^http:\/\/127\.0\.0\.1:([0-9]{3,5})$/;

const REMOTE_ORIGIN = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?::([0-9]{1,5}))?$/;

const RESERVED_HOST = /(^|\.)(localhost|local|internal|home\.arpa|lan|localdomain)$/;

// DEC-0061: `node` (Project Observatory's node supervises its children, no supervisor file); DEC-0069: `person` (an app a
// person installs and starts; its descriptor says it is installed, never that it runs).
export const MANAGERS = Object.freeze(['launchd', 'systemd', 'task-scheduler', 'node', 'person', 'none']);

/** Managers that write no launchd label or plist (DEC-0057, DEC-0061, DEC-0069). */
const NOT_LAUNCHD = Object.freeze(['systemd', 'task-scheduler', 'node', 'person']);

const AUTH_HEADER = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

export const descriptorPath = (id, instance = 'default', dir = servicesDir()) => path.join(dir, `${id}.${instance}.json`);

export function readDescriptors(dir = servicesDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort().flatMap((n) => {
    try {
      return [[path.join(dir, n), JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))]];
    } catch {
      return [];
    }
  });
}

export function validateDescriptor(d) {
  const problems = [];
  const remote = placementOf(d) === 'remote';
  if (d.placement !== undefined && !PLACEMENTS.includes(d.placement)) problems.push('placement must be local or remote');
  // DEC-0069: an app's descriptor says it is installed, never that it runs; its live origin is in its own liveness file.
  const app = d.lifecycle?.manager === 'person';
  const required = ['protocol', 'id', 'instance', 'name', ...(app ? [] : ['origin']), 'auth', 'lifecycle', 'installedAt', 'installedBy'];
  for (const key of remote ? required : [...required, 'paths']) {
    if (!(key in d)) problems.push(`missing ${key}`);
  }
  if (problems.length) return problems;
  if (d.protocol !== PROTOCOL) problems.push(`protocol must be ${PROTOCOL}`);
  if (!ID.test(d.id)) problems.push(`id must match ${ID}`);
  if (!INSTANCE.test(d.instance)) problems.push(`instance must match ${INSTANCE}`);
  if (remote) problems.push(...remoteOriginProblems(d.origin));
  else if (d.origin !== undefined && !ORIGIN.test(d.origin)) problems.push('origin must be http://127.0.0.1:<port>');
  if (!d.auth?.tokenFile) problems.push('auth.tokenFile is required');
  else if (!LOCAL_PATH.test(String(d.auth.tokenFile))) problems.push('auth.tokenFile must be a local path, never a network share');
  for (const value of [...(d.paths?.data !== undefined ? [d.paths.data] : []), ...(d.paths?.logs ?? [])]) {
    if (!LOCAL_PATH.test(String(value))) problems.push(`paths must be local paths, never a network share: ${JSON.stringify(value)}`);
  }
  if (!(typeof (d.auth?.header ?? 'Authorization') === 'string' && AUTH_HEADER.test(d.auth?.header ?? 'Authorization'))) problems.push(`auth.header must match ${AUTH_HEADER.source}`);
  if (!['Bearer', 'none'].includes(d.auth?.scheme ?? 'Bearer')) problems.push('auth.scheme is Bearer or none');
  if ((d.auth?.header ?? 'Authorization') !== 'Authorization' && (d.auth?.scheme ?? 'Bearer') !== 'none') {
    problems.push('a custom auth header carries the raw token: scheme must be none');
  }
  const life = d.lifecycle ?? {};
  const manager = life.manager;
  if (!MANAGERS.includes(manager)) problems.push('lifecycle.manager must be launchd, systemd, task-scheduler, node, person or none');
  // DEC-0069: `app` is the installed app of a person's descriptor, and nothing else's.
  if (manager === 'person' && life.app === undefined) problems.push("a person's app declares lifecycle.app, the installed app");
  if (life.app !== undefined && manager !== 'person') problems.push('lifecycle.app belongs to manager person only');
  if (life.app !== undefined && !LOCAL_PATH.test(String(life.app))) problems.push('lifecycle.app must be a local path');
  if (manager === 'launchd' && !(life.label && String(life.plist ?? '').endsWith('.plist'))) {
    problems.push('a launchd service declares label and plist');
  }
  if (life.plist !== undefined && !LOCAL_PATH.test(String(life.plist))) problems.push('lifecycle.plist must be a local path');
  // DEC-0057, DEC-0061, DEC-0069: a descriptor names one supervisor; launchd's label and plist never sit beside another.
  for (const field of ['label', 'plist']) {
    if (life[field] !== undefined && NOT_LAUNCHD.includes(manager)) problems.push(`lifecycle.${field} belongs to launchd, not to ${manager}`);
  }
  // DEC-0032: `unit` goes with systemd and `task` with Task Scheduler, and with nothing else.
  for (const [field, owner, pattern] of [['unit', 'systemd', UNIT], ['task', 'task-scheduler', TASK]]) {
    if (manager === owner && life[field] === undefined) problems.push(`a ${owner} service declares ${field}`);
    if (life[field] !== undefined && manager !== owner) problems.push(`lifecycle.${field} belongs to manager ${owner} only`);
    if (life[field] !== undefined && !pattern.test(String(life[field]))) problems.push(`lifecycle.${field} must match ${pattern.source}`);
  }
  if (remote) {
    if (manager !== 'none') problems.push('a remote service is supervised by its platform: lifecycle.manager must be none');
    for (const [field, of] of [['label', 'launchd'], ['plist', 'launchd'], ['unit', 'systemd'], ['task', 'Task Scheduler']]) {
      if (life[field] !== undefined) problems.push(`a remote service has no ${of} ${field}`);
    }
    if (d.commands?.update !== undefined) problems.push('a remote service declares no update command');
  }
  problems.push(...descriptorMemberProblems(d));
  for (const [name, argv] of Object.entries(d.commands ?? {})) {
    if (!['doctor', 'update'].includes(name)) problems.push(`unknown command ${name}`);
    else if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string')) problems.push(`command ${name} must be an argument array`);
    else if (!LOCAL_PATH.test(argv[0])) problems.push(`command ${name} must start with an absolute or ~/ executable`);
  }
  return problems;
}

/** DEC-0019: `local` unless the descriptor says `remote`. */

/** The organization edition's data classes, least sensitive first (DEC-0061, DEC-0053). */
export const PEER_DATA_CLASSES = Object.freeze(['public', 'internal', 'confidential', 'restricted']);

/** The kind of a runner's sign-in, never a credential's value (DEC-0061). */
export const CREDENTIAL_KINDS = Object.freeze(['subscription', 'key', 'platform-metered', 'none']);

/** A subscription runs only in its vendor's runner (DEC-0046): runner kind → login. */
export const SUBSCRIPTION_RUNNERS = Object.freeze({ 'claude-code': 'claude', 'kimi-code': 'kimi', codex: 'chatgpt' });

const PEER_ENDPOINT = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/;

// FAA-120: source.repository is the schema's common `uri`: RFC 3986 characters only (unreserved, reserved and %HH),
// the same in both twins; an authority, when there is one, names a host and a port of digits up to 65535, as Fabric's
// `new URL` reads it. A user:password@ in it is a credential, never the name of a repository.
const SOURCE_URI = /^[A-Za-z][A-Za-z0-9+.-]*:(?:[A-Za-z0-9._~:/?#@!$&'()*+,;=-]|%[0-9A-Fa-f]{2})+$/;
// Brackets belong to an IP-literal host only (RFC 3986 3.2.2); the literal is set aside before the character check.
const IP_LITERAL = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/?#@[\]]*@)?)\[[0-9A-Fa-f:.vV]+\]/;
const URI_AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)(?::([^/?#]*))?/;
function authorityOk(uri) {
  const m = URI_AUTHORITY.exec(uri);
  if (!m) return true;
  const port = m[2];
  return Boolean(m[1]) && (port === undefined || port === '' || (/^[0-9]{1,5}$/.test(port) && Number(port) <= 65535));
}
const URI_PASSWORD = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#@]*:[^/?#@]*@/;
const RESIDENCY = /^(A[B-Z]|[B-PR-WY][A-Z]|Q[A-L]|Z[A-Y])$/;

const RUNNER_KIND_NAME = /^[a-z][a-z0-9-]{1,62}$/;

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

const textOfLength = (v, low = 1, high = 200) => typeof v === 'string' && v.length >= low && v.length <= high;

/** A JSON Pointer token (RFC 6901 §4). */
const pointer = (name) => String(name).replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * DEC-0061 and DEC-0069 on a descriptor's `installedBy`, `runner` and `peer`, as the schema shapes them, with FAC-SEM-085
 * (a peer on a reserved name) and FAC-SEM-086 (a credential-shaped value in `runner` or `installedBy`, named by its
 * place, never its value).
 */
export function descriptorMemberProblems(d) {
  const problems = [];
  const life = isObj(d.lifecycle) ? d.lifecycle : {};
  const by = d.installedBy;
  const places = [];
  if (typeof by === 'string') {
    if (!textOfLength(by)) problems.push('installedBy is the installer and its version, 1 to 200 characters');
    places.push(['/installedBy', by]);
  } else if (isObj(by)) {
    for (const k of Object.keys(by)) if (!['by', 'role', 'tool'].includes(k)) problems.push(`installedBy has no member ${k}`);
    if (!['person', 'node', 'organization'].includes(by.by)) problems.push('installedBy.by is person, node or organization');
    if (by.by === 'person' && !['operator', 'administrator'].includes(by.role)) problems.push('installedBy.role is operator or administrator for a person');
    if (by.by !== 'person' && 'role' in by) problems.push('installedBy.role belongs to a person only');
    if (!textOfLength(by.tool)) problems.push('installedBy.tool is the installer and its version, 1 to 200 characters');
    for (const [k, v] of Object.entries(by)) places.push([`/installedBy/${pointer(k)}`, v]);
  } else problems.push("installedBy is the installer's name or {by, role?, tool}");
  if (life.manager === 'person' && !(isObj(by) && by.by === 'person')) problems.push("an app's descriptor names who installed it as a person: installedBy {by: person, role, tool} (DEC-0069)");
  let runner = d.runner;
  if ('runner' in d) {
    if (!isObj(runner)) { problems.push('runner is {kind?, credentialKind}'); runner = {}; }
    for (const k of Object.keys(runner)) if (!['kind', 'credentialKind'].includes(k)) problems.push(`runner has no member ${k}`);
    if (!CREDENTIAL_KINDS.includes(runner.credentialKind)) problems.push('runner.credentialKind is subscription, key, platform-metered or none');
    if ('kind' in runner && !(typeof runner.kind === 'string' && RUNNER_KIND_NAME.test(runner.kind))) problems.push("runner.kind is a runner kind's name");
    if (runner.credentialKind === 'subscription' && !Object.hasOwn(SUBSCRIPTION_RUNNERS, runner.kind)) problems.push("a subscription runs only in its vendor's runner: runner.kind claude-code, kimi-code or codex");
    for (const [k, v] of Object.entries(runner)) places.push([`/runner/${pointer(k)}`, v]);
  }
  if ('source' in d) {
    const source = isObj(d.source) ? d.source : {};
    if (!isObj(d.source)) problems.push('source is {repository?}');
    for (const k of Object.keys(source)) if (k !== 'repository') problems.push(`source has no member ${k}`);
    if ('repository' in source) {
      const repository = source.repository;
      if (!(typeof repository === 'string' && SOURCE_URI.test(repository.replace(IP_LITERAL, '$1h')))) problems.push('source.repository is a URI (RFC 3986), such as https://github.com/owner/name');
      else if (!authorityOk(repository)) problems.push('source.repository names a host, and a port of digits up to 65535 when it has one');
      else if (URI_PASSWORD.test(repository)) problems.push('source.repository carries no password: it names the repository, never a credential');
      places.push(['/source/repository', repository]);
    }
  }
  if ('peer' in d) {
    let peer = d.peer;
    if (!isObj(peer)) { problems.push('peer is {endpoint, custody, residency, maxDataClass}'); peer = {}; }
    for (const k of Object.keys(peer)) if (!['endpoint', 'custody', 'residency', 'maxDataClass'].includes(k)) problems.push(`peer has no member ${k}`);
    const m = typeof peer.endpoint === 'string' && peer.endpoint.length <= 2048 ? PEER_ENDPOINT.exec(peer.endpoint) : null;
    if (!m) problems.push('peer.endpoint is https://<dns-name>[:<port>][/<path>], no query, fragment, userinfo or IP literal');
    else if (RESERVED_HOST.test(m[1])) problems.push(`FAC-SEM-085: a service offered to others cannot be reached at the reserved name ${m[1]}`);
    if (!['organization-managed', 'personal', 'processor-hosted'].includes(peer.custody)) problems.push('peer.custody is organization-managed, personal or processor-hosted'); // processor-hosted: DEC-0099
    const r = peer.residency;
    if (!Array.isArray(r) || r.length < 1 || r.length > 32 || new Set(r.map((x) => JSON.stringify(x))).size !== r.length || !r.every((x) => typeof x === 'string' && RESIDENCY.test(x))) {
      problems.push('peer.residency is 1 to 32 distinct ISO 3166-1 alpha-2 codes in upper case, EU admitted, no user-assigned code');
    }
    if (!PEER_DATA_CLASSES.includes(peer.maxDataClass)) problems.push('peer.maxDataClass is public, internal, confidential or restricted');
    if (!('runner' in d)) problems.push('a service offered to others declares runner (DEC-0061)');
    else if (isObj(runner) && runner.credentialKind === 'subscription') problems.push('a service offered to others never runs on a subscription (DEC-0061)');
  }
  for (const [place, value] of places) {
    if (typeof value === 'string' && secretArgument(value)) problems.push(`FAC-SEM-086: ${place} holds a value shaped like a credential; it names ${place.startsWith('/source/') ? 'a repository' : 'a kind, a role or an installer'}`);
  }
  return problems;
}

/**
 * The host's check before it routes a request from anyone but the service's operator (DEC-0061, FAC-SEM-088):
 * `not-offered`, `peer-invalid`, `data-class-unknown` or `above-max-data-class`; null when it may. The contract's `peerRefusal`.
 */
export function peerRefusal(descriptor, dataClass) {
  if (!isObj(descriptor) || !isObj(descriptor.peer)) return 'not-offered';
  const max = typeof descriptor.peer.maxDataClass === 'string' ? PEER_DATA_CLASSES.indexOf(descriptor.peer.maxDataClass) : -1;
  if (max < 0) return 'peer-invalid';
  const asked = typeof dataClass === 'string' ? PEER_DATA_CLASSES.indexOf(dataClass) : -1;
  if (asked < 0) return 'data-class-unknown';
  return asked > max ? 'above-max-data-class' : null;
}

/**
 * What an app that writes its own descriptor does with it on a start (DEC-0069): `keep` from a translocated copy (macOS
 * App Translocation); otherwise `write` when there is none, when it is not an app's descriptor, or when its version
 * (`installedBy.tool`) or its path (`lifecycle.app`) differs; `keep` otherwise. The contract's `appDescriptorAction`.
 */
export function appDescriptorAction(existing, tool, appPath) {
  if (appPath.includes('/AppTranslocation/')) return 'keep';
  if (!isObj(existing) || !isObj(existing.installedBy)) return 'write';
  const recorded = isObj(existing.lifecycle) ? existing.lifecycle.app : undefined;
  return existing.installedBy.tool === tool && recorded === appPath ? 'keep' : 'write';
}

/** Whether a reader treats a descriptor as stale (DEC-0069): an app's descriptor whose installed app it did not find. */
export function appDescriptorStale(descriptor, appPresent) {
  if (!isObj(descriptor) || !isObj(descriptor.lifecycle) || descriptor.lifecycle.manager !== 'person') return false;
  return !appPresent;
}

/** Whether `lifecycle.app` of an app's descriptor exists on this machine (a bundle is a folder, an executable a file). */
export function appPresent(descriptor) {
  const app = isObj(descriptor?.lifecycle) ? descriptor.lifecycle.app : undefined;
  try { return typeof app === 'string' && fs.existsSync(expand(app)); } catch { return false; }
}

/** Fabric's own descriptor (Fabric ADR-0139): `services/fabric.default.json`. */
export const FABRIC_SERVICE = Object.freeze(['fabric', 'default']);

/**
 * `present` or `absent` for Fabric's button (DEC-0040 FB-5, DEC-0069, Fabric SCN-142): present when Fabric's own
 * descriptor is registered and, for an app's descriptor, its app is still installed; a server sets `data-fabric="absent"`
 * on the button's script otherwise. The button only follows a link, so the liveness file is not read here.
 */
export function fabricButtonPresence(dir = servicesDir()) {
  let found;
  try { found = JSON.parse(fs.readFileSync(descriptorPath(...FABRIC_SERVICE, dir), 'utf8')); } catch { return 'absent'; }
  if (!isObj(found) || validateDescriptor(found).length) return 'absent';
  return appDescriptorStale(found, appPresent(found)) ? 'absent' : 'present';
}

export function placementOf(d) {
  return d?.placement === 'remote' ? 'remote' : 'local';
}

/** Problems with a remote origin: https, a public DNS name, an optional port, nothing else. */
export function remoteOriginProblems(origin) {
  const m = REMOTE_ORIGIN.exec(String(origin ?? ''));
  if (!m) return ['a remote origin must be https://<dns-name>[:<port>] with no path, query or IP literal'];
  if (RESERVED_HOST.test(m[1])) return [`a remote service cannot live on the reserved name ${m[1]}`];
  if (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return ['the origin port is out of range'];
  return [];
}

export function portOf(origin) {
  const m = ORIGIN.exec(origin);
  if (!m) throw new ServiceError(`Origin ${origin} is not http://127.0.0.1:<port>.`);
  return Number(m[1]);
}

export function writeDescriptor(d, dir = servicesDir()) {
  const problems = validateDescriptor(d);
  if (problems.length) throw new ServiceError(`Descriptor is invalid: ${problems.join('; ')}.`);
  const me = `${d.id}.${d.instance}`;
  // DEC-0019: only a local placement claims a port on this computer; DEC-0069: an app's descriptor names none.
  const port = placementOf(d) === 'remote' || d.origin === undefined ? null : portOf(d.origin);
  for (const [file, other] of readDescriptors(dir)) {
    const key = `${other.id}.${other.instance ?? 'default'}`;
    if (key === me) continue;
    if (port === null) continue; // a remote origin's port is another computer's
    let otherPort = null;
    try { otherPort = portOf(String(other.origin ?? '')); } catch { continue; }
    if (otherPort === port) throw new ServiceError(`Port ${port} is already claimed by ${key} (${file}).`);
  }
  ensurePrivateDir(dir);
  const target = descriptorPath(d.id, d.instance, dir);
  atomicWrite(target, `${JSON.stringify(d, null, 2)}\n`, 0o600);
  return target;
}

export function removeDescriptor(id, instance = 'default', dir = servicesDir()) {
  try { fs.unlinkSync(descriptorPath(id, instance, dir)); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

const THEME_ID = /^[a-z][a-z0-9-]{0,31}$/;

const KIT_REF = /^[a-z][a-z0-9-]{0,63}@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

// What makes value not a valid ED-9 declaration (service-dashboard-extension.schema.json).
export function dashboardExtensionProblems(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['the declaration is not an object'];
  const out = [];
  const extra = Object.keys(value).filter((k) => !['minWidth', 'appearance', 'themes', 'kit'].includes(k)).sort();
  if (extra.length) out.push(`unknown field(s): ${extra.join(', ')}`);
  const w = value.minWidth;
  if (!Number.isInteger(w)) out.push('minWidth is required and must be a whole number of CSS pixels');
  else if (w < 360 || w > 1280) out.push(`minWidth ${w} is outside 360…1280`);
  if ('appearance' in value) {
    const a = value.appearance;
    if (!Array.isArray(a) || a.length > 2 || new Set(a).size !== a.length || a.some((x) => x !== 'scheme' && x !== 'theme')) out.push('appearance is a list of distinct fields from scheme, theme');
  }
  if ('themes' in value) {
    const t = value.themes;
    if (!Array.isArray(t) || t.length < 1 || t.length > 32 || new Set(t).size !== t.length || t.some((x) => typeof x !== 'string' || !THEME_ID.test(x))) out.push('themes is 1…32 distinct theme ids matching ^[a-z][a-z0-9-]{0,31}$');
  }
  if ('kit' in value && !(typeof value.kit === 'string' && KIT_REF.test(value.kit))) out.push(`kit is name@semver, for example ${DASHBOARD_KIT}`);
  return out;
}

// The `extensions` entry a dashboard built from the kit declares (DEC-0036 ED-9). Declare it only
// when the page meets ED-1…ED-6 — check_dashboard_layout.mjs measures that.
export function dashboardExtension({ minWidth = 360, appearance = ['scheme', 'theme'], themes = REFERENCE_THEMES, kit = DASHBOARD_KIT } = {}) {
  const value = { minWidth };
  if (appearance?.length) value.appearance = [...appearance];
  if (themes?.length) value.themes = [...themes];
  if (kit) value.kit = kit;
  const problems = dashboardExtensionProblems(value);
  if (problems.length) throw new ServiceError(`Dashboard declaration: ${problems.join('; ')}.`);
  return { [DASHBOARD_EXTENSION_KEY]: value };
}

// `extensions` is kept as given (a reader ignores keys it does not know); a dashboard declaration in
// it must be valid (dashboardExtension builds one).
const PROFILE_ID = /^[a-z][a-z0-9-]{0,62}$/;

const RUNNER_KIND = /^[a-z][a-z0-9-]{1,62}$/;

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/;

/** DEC-0046: the well-known `configuration` — {slots, resolved} as service-well-known.schema.json types it. */
export function configurationProblems(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return ['configuration is an object'];
  const problems = Object.keys(doc).filter((k) => k !== 'slots' && k !== 'resolved').map((k) => `configuration has no member ${k}`);
  const { slots, resolved } = doc;
  if (!Array.isArray(slots) || slots.length > 2 || new Set(slots).size !== slots.length || !slots.every((s) => s === 'runner' || s === 'model')) problems.push('slots is a list of runner and model, each once');
  if (resolved === null || typeof resolved !== 'object' || Array.isArray(resolved)) return [...problems, 'resolved is an object'];
  const checks = {
    from: (x) => ['request', 'agent', 'binding', 'estate'].includes(x),
    runnerProfile: (x) => typeof x === 'string' && PROFILE_ID.test(x),
    modelProfile: (x) => typeof x === 'string' && PROFILE_ID.test(x),
    runnerKind: (x) => typeof x === 'string' && RUNNER_KIND.test(x),
    route: (x) => ROUTES.includes(x),
    models: (x) => Array.isArray(x) && x.length <= 16 && x.every((m) => typeof m === 'string' && MODEL_ID.test(m)),
  };
  for (const [k, v] of Object.entries(resolved)) {
    if (!Object.hasOwn(checks, k)) problems.push(`resolved has no member ${k}`);
    else if (!checks[k](v)) problems.push(`resolved.${k} is not valid`);
  }
  return problems;
}

// `actions` (DEC-0121 AP-1) is the service's action table, every button its dashboard, app or page offers with the tool
// that performs it and its gate, written under extensions/actions/0.1 by actionsExtension. A declaration FAC-SEM-142
// finds, passed either way, is refused: not its schema's, an id named twice, a humanStep that disagrees with the gate,
// or a tool surfaces.mcp.capabilities does not list.
// `a2a` (DEC-0122) is surfaces.a2a, where the service serves its public Agent Card (a2aSurface builds one); passed here
// or in `surfaces`, never both, and refused when it is not the schema's. A reader pinned before DEC-0122 refuses the
// member, so a service carries it only once its readers are pinned at or after it.
export function buildWellKnown({ id, instance, name, version, build, startedAt, status, degraded = [], surfaces, summary, updateAvailable = null, pid = process.pid, extensions, configuration, protocols, actions, a2a }) {
  if (!STATUSES.includes(status)) throw new ServiceError(`status must be one of ${STATUSES.join(', ')}.`);
  if (!surfaces?.events) throw new ServiceError('surfaces.events is required.');
  if (a2a !== undefined && a2a !== null) {
    if (Object.hasOwn(surfaces, 'a2a')) throw new ServiceError('surfaces.a2a: pass it in surfaces or as a2a, not both.');
    surfaces = { ...surfaces, a2a };
  }
  if (Object.hasOwn(surfaces, 'a2a')) {
    // DEC-0122: a host reads the member by the schema; a service never publishes one it would refuse.
    const problems = a2aSurfaceProblems(surfaces.a2a);
    if (problems.length) throw new ServiceError(`surfaces.a2a: ${problems.join('; ')}.`);
  }
  if (!(build?.commit || build?.digest)) throw new ServiceError('build needs a commit or a digest.');
  const doc = {
    protocol: PROTOCOL,
    service: { id, instance, name, version, build },
    process: { pid, startedAt },
    status: status === 'ready' && degraded.length ? 'degraded' : status,
    degraded: [...degraded],
    surfaces,
    update: { available: updateAvailable },
  };
  if (summary?.length) doc.summary = summary.slice(0, 6);
  if (actions !== undefined && actions !== null) {
    if (extensions && Object.hasOwn(extensions, ACTIONS_EXTENSION_KEY)) throw new ServiceError('Actions declaration: pass the action table or a ready declaration, not both.');
    const capabilities = Array.isArray(surfaces.mcp?.capabilities) ? surfaces.mcp.capabilities : undefined;
    extensions = { ...(extensions ?? {}), ...actionsExtension(actions, { capabilities }) };
  }
  if (extensions && Object.keys(extensions).length) {
    if (DASHBOARD_EXTENSION_KEY in extensions) {
      const problems = dashboardExtensionProblems(extensions[DASHBOARD_EXTENSION_KEY]);
      if (problems.length) throw new ServiceError(`Dashboard declaration: ${problems.join('; ')}.`);
    }
    if (Object.hasOwn(extensions, CONNECTIONS_EXTENSION_KEY)) {
      // DEC-0096: a host hides an invalid declaration (FAC-SEM-127); a service never publishes one.
      const view = connectionsView({ extensions: { [CONNECTIONS_EXTENSION_KEY]: extensions[CONNECTIONS_EXTENSION_KEY] } });
      if (view.reported) throw new ServiceError(`Connections declaration: ${view.errors.join('; ')}.`);
    }
    if (Object.hasOwn(extensions, ACTIONS_EXTENSION_KEY)) {
      // DEC-0121 AP-1: a host reports an invalid declaration (FAC-SEM-142); a service never publishes one. The tools are
      // compared with the capabilities this document's MCP surface lists.
      const findings = actionsExtensionRules({ extensions: { [ACTIONS_EXTENSION_KEY]: extensions[ACTIONS_EXTENSION_KEY] }, surfaces });
      if (findings.length) throw new ServiceError(`Actions declaration: ${findings.map((f) => f.message).join('; ')}.`);
    }
    doc.extensions = { ...extensions };
  }
  if (configuration !== undefined) {
    const problems = configurationProblems(configuration);
    if (problems.length) throw new ServiceError(`configuration: ${problems.join('; ')}.`);
    doc.configuration = configuration;
  }
  if (protocols !== undefined) {
    // DEC-0067: the revisions this service accepts. The document is closed for a reader pinned before DEC-0067, so a
    // service lists them only once its hosts are pinned at or after it.
    const problems = protocolsFindings(protocols);
    if (problems.length) throw new ServiceError(`protocols: ${problems.map((f) => f.message).join('; ')}.`);
    doc.protocols = [...protocols];
  }
  return doc;
}
