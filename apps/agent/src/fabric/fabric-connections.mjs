// What an agent uses: fabric-connections/0.1, the extension keyed extensions/connections/0.1 (DEC-0096, FAC-SEM-127).
// connectionsView reads a well-known document as the contract's connectionsView does (it never throws);
// connectionsExtension builds the `extensions` entry a service declares, `state` from its own checks and its degraded[].
// Part of the Node service kit (FAA-62, layer L3); the twin of fabric_connections.py. Node 20+, no dependency.
import { ServiceError } from './fabric-base.mjs';
import { BEARER_INSIDE, JWT_SHAPE, longSecret, secretUrl } from './fabric-secrets.mjs';
import { isObject } from './fabric-jsvalue.mjs';

export const CONNECTIONS_EXTENSION_KEY = 'https://fabric.passioncode.ai/agent-contract/extensions/connections/0.1';
export const KINDS = Object.freeze(['service', 'model', 'connector', 'store', 'channel']);
export const STATES = Object.freeze(['ok', 'degraded', 'down', 'unknown']);
export const MAX_CONNECTIONS = 64;
const MEMBERS = ['id', 'kind', 'target', 'capability', 'state', 'label', 'purpose', 'reason', 'lastAt'];
const STRING_MEMBERS = ['id', 'target', 'capability', 'label', 'purpose', 'reason'];

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const TARGET = /^[^\s]+$/u;
const SERVICE_TARGET = /^[a-z0-9][a-z0-9-]{0,63}(\.[a-z0-9][a-z0-9-]{0,63})?$/u;
const CAPABILITY = /^[a-z][a-z0-9._-]{1,127}$/u;
const LINE = /^[^\n\r]+$/u;

// ajv-formats `date-time` in its full mode (the contract's validator): a date, `t` or a space, a time with a zone.
const DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
const TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function fullDate(value) {
  const m = DATE.exec(value);
  if (!m) return false;
  const [year, month, day] = [+m[1], +m[2], +m[3]];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && leap ? 29 : DAYS[month]);
}
function fullTime(value) {
  const m = TIME.exec(value);
  if (!m) return false;
  const [hour, minute, second] = [+m[1], +m[2], +m[3]];
  const sign = m[5] === '-' ? -1 : 1;
  const [zoneH, zoneM] = [+(m[6] || 0), +(m[7] || 0)];
  if (zoneH > 23 || zoneM > 59 || !m[4]) return false;
  if (hour <= 23 && minute <= 59 && second < 60) return true;
  const utcMin = minute - zoneM * sign; // a leap second, at 23:59 UTC only
  const utcHour = hour - zoneH * sign - (utcMin < 0 ? 1 : 0);
  return (utcHour === 23 || utcHour === -1) && (utcMin === 59 || utcMin === -1) && second < 61;
}
/** The `date-time` format as the contract's validator (ajv-formats, full mode) reads it. */
export function dateTime(value) {
  const parts = value.split(/t|\s/i);
  return parts.length === 2 && fullDate(parts[0]) && fullTime(parts[1]);
}

const length = (value) => [...value].length; // code points, as ajv counts them

/** service-connections-extension.schema.json, read as the contract's validator reads it. */
function shapeProblems(value) {
  if (!isObject(value)) return ['/ type: must be object'];
  // A member's name is never echoed: a secret-shaped name would reach the error text and a probe's evidence.
  const problems = Object.keys(value).filter((key) => key !== 'connections').map(() => '/ additionalProperties: a member other than connections');
  if (!Object.hasOwn(value, 'connections')) return [...problems, '/ required: connections'];
  const connections = value.connections;
  if (!Array.isArray(connections)) return [...problems, '/connections type: must be array'];
  if (connections.length > MAX_CONNECTIONS) problems.push(`/connections maxItems: at most ${MAX_CONNECTIONS}`);
  connections.forEach((item, index) => {
    const at = `/connections/${index}`;
    if (!isObject(item)) { problems.push(`${at} type: must be object`); return; }
    for (const key of ['id', 'kind', 'target', 'state']) if (!Object.hasOwn(item, key)) problems.push(`${at} required: ${key}`);
    for (const key of Object.keys(item)) if (!MEMBERS.includes(key)) problems.push(`${at} additionalProperties: a member the schema does not name`);
    for (const key of [...STRING_MEMBERS, 'lastAt']) if (Object.hasOwn(item, key) && typeof item[key] !== 'string') problems.push(`${at}/${key} type: must be string`);
    const text = (key) => (Object.hasOwn(item, key) && typeof item[key] === 'string' ? item[key] : undefined);
    if (text('id') !== undefined && !ID.test(text('id'))) problems.push(`${at}/id pattern`);
    if (Object.hasOwn(item, 'kind') && !KINDS.includes(item.kind)) problems.push(`${at}/kind enum`);
    if (Object.hasOwn(item, 'state') && !STATES.includes(item.state)) problems.push(`${at}/state enum`);
    const target = text('target');
    if (target !== undefined && !(length(target) >= 1 && length(target) <= 200 && TARGET.test(target))) problems.push(`${at}/target length or pattern`);
    if (text('capability') !== undefined && !CAPABILITY.test(text('capability'))) problems.push(`${at}/capability pattern`);
    for (const key of ['label', 'purpose', 'reason']) {
      const line = text(key);
      if (line !== undefined && !(length(line) >= 1 && length(line) <= 300 && LINE.test(line))) problems.push(`${at}/${key} length or pattern`);
    }
    if (text('lastAt') !== undefined && !dateTime(text('lastAt'))) problems.push(`${at}/lastAt format: date-time`);
    if (Object.hasOwn(item, 'kind')) {
      if (item.kind !== 'service' && Object.hasOwn(item, 'capability')) problems.push(`${at}/capability: only a service connection names a capability`);
      if (item.kind === 'service' && target !== undefined && !SERVICE_TARGET.test(target)) problems.push(`${at}/target pattern: a service target is an id.instance key or a product id`);
    }
  });
  return problems;
}

// The contract's KEY_SHAPE (src/connections.ts): a provider key where it starts a word, case-sensitive prefixes, the
// `sk-` rules and a Telegram bot token.
const KEY_SHAPE = /(?:^|[^A-Za-z0-9])(?:sk-(?=[A-Za-z0-9_-]*\d)(?:(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{32,})|gh[pousr]_[A-Za-z0-9]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20,}|(?:bot)?\d{6,12}:(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{34,35}(?![A-Za-z0-9_-]))/;
const SCHEME = /[a-z][a-z0-9+.-]*:\/\//gi;
const CLOSING = /[)\]}>"'.,;:!?]/;
const TRIED_BACK = 1;
/** The URLs a member may hold, from every scheme in each whitespace-delimited piece, without the closing brackets,
 * quotes and punctuation that end a sentence, and with TRIED_BACK of them put back (`]` closes an IPv6 host). */
function urlsIn(value) {
  const urls = [];
  for (const piece of value.split(/\s+/)) {
    for (const match of piece.matchAll(SCHEME)) {
      const url = piece.slice(match.index);
      let end = url.length;
      while (end > 0 && CLOSING.test(url[end - 1])) end -= 1;
      for (let back = 0; back <= TRIED_BACK && end + back <= url.length; back += 1) urls.push(url.slice(0, end + back));
    }
  }
  return urls;
}
/** A long secret-shaped run in a piece read whole; in a piece that holds a URL, the text before its first scheme's `://`. */
const longRun = (value) =>
  value.split(/\s+/).some((piece) => {
    const at = piece.search(SCHEME);
    const cut = at < 0 ? -1 : piece.indexOf('://', at);
    return longSecret(cut < 0 ? piece : piece.slice(0, cut));
  });
const credential = (value, runs) =>
  JWT_SHAPE.test(value) || KEY_SHAPE.test(value) || BEARER_INSIDE.test(value) || (runs && longRun(value)) || urlsIn(value).some(secretUrl);

/** What the schema cannot state: an id named twice, a credential in any string member. */
function beyondShape(list) {
  const errors = [];
  const seen = new Set();
  list.forEach((connection, index) => {
    if (seen.has(connection.id)) errors.push(`/connections/${index}/id duplicate: it is named twice`);
    seen.add(connection.id);
    for (const member of STRING_MEMBERS) {
      const value = connection[member];
      const runs = member !== 'id' && member !== 'capability' && !(member === 'target' && connection.kind === 'model');
      if (typeof value === 'string' && credential(value, runs)) errors.push(`/connections/${index}/${member} credential: a connection never carries a credential`);
    }
  });
  return errors;
}

const none = () => ({ declared: false, reported: false, connections: [], errors: [] });

/** A host's reading of a well-known document's connections (the contract's connectionsView): never throws. */
export function connectionsView(wellKnown) {
  const extensions = isObject(wellKnown) && isObject(wellKnown.extensions) ? wellKnown.extensions : undefined;
  if (extensions === undefined || !Object.hasOwn(extensions, CONNECTIONS_EXTENSION_KEY)) return none();
  const value = extensions[CONNECTIONS_EXTENSION_KEY];
  let errors = shapeProblems(value);
  if (!errors.length) errors = beyondShape(value.connections);
  if (errors.length) return { ...none(), reported: true, errors };
  const degraded = Array.isArray(wellKnown.degraded) ? wellKnown.degraded : [];
  const failing = new Set(degraded.filter(isObject).map((entry) => entry.source).filter((source) => typeof source === 'string'));
  return { declared: true, reported: false, connections: value.connections.map((c) => ({ ...c, failing: failing.has(c.id) })), errors: [] };
}

const pointerToken = (token) => token.replace(/~/g, '~0').replace(/\//g, '~1');

/** FAC-SEM-127: the connections a well-known document declares are valid, each id once, no credential. */
export function connectionsRules(wellKnown) {
  const view = connectionsView(wellKnown);
  const at = `/extensions/${pointerToken(CONNECTIONS_EXTENSION_KEY)}`;
  return view.errors.map((error) => ({ code: 'FAC-SEM-127', instancePath: at, message: `the connections declaration is invalid (${error}); a host treats it as not declared and reports it (DEC-0096)` }));
}

/**
 * The `extensions` entry a service declares (DEC-0096): what it uses, each connection's `state` from the service's
 * own checks (`states`, by id), else `degraded` when a degraded[].source names it, else `unknown`; a declared `state`
 * is kept. Throws ServiceError on a declaration a host would hide: a service never publishes one that reads as
 * "declared nothing".
 */
export function connectionsExtension(declared, options = {}) {
  const { degraded: givenDegraded, states: givenStates } = options ?? {};
  const degraded = givenDegraded ?? [];
  const states = givenStates ?? {};
  if (!Array.isArray(declared) || !Array.isArray(degraded) || !isObject(states)) {
    throw new ServiceError('Connections declaration: declared and degraded are lists, states an object by id.');
  }
  const failing = new Set(degraded.filter(isObject).map((entry) => entry.source).filter((source) => typeof source === 'string'));
  const connections = declared.map((item) => {
    if (!isObject(item)) return item; // the shape check names it and the declaration is refused
    const connection = { ...item };
    if (!Object.hasOwn(connection, 'state')) {
      const id = typeof connection.id === 'string' ? connection.id : undefined;
      // An invalid check value is refused by the shape check, never read as a missing one.
      connection.state = id !== undefined && Object.hasOwn(states, id) ? states[id] : (failing.has(id) ? 'degraded' : 'unknown');
    }
    return connection;
  });
  const value = { connections };
  const view = connectionsView({ extensions: { [CONNECTIONS_EXTENSION_KEY]: value } });
  if (view.reported) throw new ServiceError(`Connections declaration: ${view.errors.join('; ')}.`);
  return { [CONNECTIONS_EXTENSION_KEY]: value };
}
