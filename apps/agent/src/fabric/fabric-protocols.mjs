// Protocol revisions (DEC-0067) and an event's machine-readable data (DEC-0070, the feed-data protocols).
// Part of the Node service kit (FAA-65, layer L3); the twin of fabric_protocols.py. Node 20+, no dependency.
import { credentialName, secretArgument, secretUrl, secretValue } from './fabric-secrets.mjs';

// An event about traced work carries traceId and spanId together (fabric-interop/0.1 C3.4 c);
// traceIds(traceparent) in fabric-interop.mjs gives both.

/** Each contract protocol's published revisions, oldest first (the contract's `PROTOCOL_REVISIONS`); a test holds it equal to the contract's. */
export const PROTOCOL_REVISIONS = new Map(Object.entries({
  'access-log': ['1'], approval: ['1'], 'activity-summary': ['1'], 'agent-directory': ['1'], 'call-record': ['1'], 'coding-agents': ['1'], 'credential-decision': ['1'], 'credential-request': ['1'], 'credential-revocation': ['1'], 'enroll-token': ['1'], entitlement: ['1'], 'entitlement-key-set': ['1'], 'estate-record': ['1'], 'execution-packet': ['1'],
  'fabric-actions': ['0.1'], 'fabric-activity': ['0.1'], 'fabric-agent-call': ['1'], 'fabric-connections': ['0.1'], 'fabric-credential-envelope': ['1'], 'fabric-load': ['0.1'], 'fabric-dashboard': ['0.1'], 'fabric-delegation': ['0.1'], 'fabric-device': ['0.1'],
  'fabric-interop': ['0.1', '0.2'], 'fabric-local-channel': ['0.1'], 'fabric-local-runner': ['0.1'], 'fabric-machine-report': ['1'], 'fabric-operator-channel': ['0.1'],
  'fabric-package': ['1'], 'fabric-project-comms': ['0.1'], 'fabric-proposal': ['1'], 'fabric-provider': ['0.1'], 'fabric-relay': ['0.1'],
  'fabric-secret-envelope': ['1'], 'fabric-service': ['0.1'], 'fabric-settings-backup': ['1'], heartbeat: ['1'], 'learning-note': ['1'], 'machine-report': ['1'], mandate: ['1'],
  memory: ['0.1'], 'node-summary': ['1'], 'operator-source': ['1'], 'org-authority': ['1'], 'org-authority-draft': ['1'],
  'org-key-set': ['1'], 'org-key-set-draft': ['1'], 'org-membership': ['1'], 'org-root-registration': ['1'], 'pairing-message': ['1'], pipeline: ['0.1'], 'repair-request': ['1'], 'repair-result': ['1'],
  'revocation-delta': ['1'], 'session-handoff': ['1'], 'service-load': ['1'],
  'share-registration': ['1'], 'share-registration-receipt': ['1'], 'support-quality-daily': ['1'], 'window-lease': ['1'],
}));

export const MAX_PROTOCOLS = 64;

const REVISION = /^([a-z][a-z0-9.-]{0,63})\/([0-9]{1,4}(?:\.[0-9]{1,4}){0,2})$/;

/** `<name>/<revision>` split, or undefined. */
export function parseRevision(value) {
  const m = typeof value === 'string' ? REVISION.exec(value) : null;
  return m ? { name: m[1], revision: m[2] } : undefined;
}

/** The revisions a receiver implementing `name` up to `newest` accepts: N and, when the register has one, N−1. */
export function acceptedRevisions(name, newest) {
  const known = PROTOCOL_REVISIONS.get(name);
  if (!known?.length) return [];
  const top = newest === undefined ? known.length - 1 : known.indexOf(newest);
  if (top < 0) return [];
  return known.slice(Math.max(0, top - 1), top + 1).reverse().map((r) => `${name}/${r}`);
}

/**
 * A receiver's answer to a document naming `received` (DEC-0067, the contract's `negotiateRevision`): `{ok: true}`, the
 * `schema-unsupported` refusal naming what was received (at most 80 characters) and the accepted revisions of that
 * protocol (all of them when it names none the receiver reads), or `{fault: 'no-accepted-revisions'}`.
 */
export function negotiateRevision(received, accepted) {
  const usable = [...new Set((Array.isArray(accepted) ? accepted : []).filter((e) => parseRevision(e) !== undefined))].slice(0, MAX_PROTOCOLS);
  if (!usable.length) return { fault: 'no-accepted-revisions' };
  if (typeof received === 'string' && usable.includes(received)) return { ok: true };
  const parsed = parseRevision(received);
  const same = parsed ? usable.filter((e) => parseRevision(e)?.name === parsed.name) : [];
  return { error: { code: 'schema-unsupported', message: 'this receiver does not read that protocol revision',
    data: { protocol: typeof received === 'string' ? Array.from(received).slice(0, 80).join('') : '', accepted: same.length ? same : usable } } };
}

/** FAC-SEM-099 (DEC-0067): 1 to 64 entries, each once; at most N and N−1 of one protocol, consecutive in the register. */
export function protocolsFindings(protocols, prefix = '/protocols') {
  const flag = (instancePath, message) => ({ code: 'FAC-SEM-099', instancePath, message });
  if (!Array.isArray(protocols)) return [flag(prefix, 'protocols is a list of protocol revisions')];
  if (protocols.length === 0 || protocols.length > MAX_PROTOCOLS) return [flag(prefix, `protocols lists 1 to ${MAX_PROTOCOLS} revisions`)];
  const findings = [];
  const byName = new Map();
  const seen = new Set();
  protocols.forEach((entry, i) => {
    const at = `${prefix}/${i}`;
    const parsed = parseRevision(entry);
    if (!parsed) { findings.push(flag(at, 'a protocol revision is <name>/<revision>, such as fabric-service/0.1')); return; }
    if (seen.has(entry)) { findings.push(flag(at, 'each protocol revision once')); return; }
    seen.add(entry);
    const known = PROTOCOL_REVISIONS.get(parsed.name);
    if (known && !known.includes(parsed.revision)) { findings.push(flag(at, `${parsed.name} has no published revision ${parsed.revision}`)); return; }
    const indices = byName.get(parsed.name) ?? [];
    indices.push(known ? known.indexOf(parsed.revision) : -1);
    byName.set(parsed.name, indices);
    if (indices.length > 2) findings.push(flag(at, 'at most 2 revisions of one protocol: N and N−1'));
    else if (known && indices.length === 2 && Math.abs(indices[0] - indices[1]) !== 1) findings.push(flag(at, 'two revisions of one protocol are N and N−1, consecutive in the register'));
  });
  return findings;
}

const SCHEMA_URI = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;

export const scalar = (v) => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && Array.from(v).length <= 500);

const isPlain = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

const pointerToken = (name) => String(name).replace(/~/g, '~0').replace(/\//g, '~1');

/** FAC-SEM-101 over an events page (the contract's `feedDataFindings`): no credential's name or shape in an event's data. */
export function feedDataFindings(page) {
  const findings = [];
  const check = (named, member, at) => {
    if (typeof member !== 'string') return;
    if (named) findings.push({ code: 'FAC-SEM-101', instancePath: at, message: "an event's data puts no string under a credential's name" });
    else if (secretValue(member) || secretUrl(member)) findings.push({ code: 'FAC-SEM-101', instancePath: at, message: "an event's data carries no value shaped like a credential" });
  };
  (Array.isArray(page?.events) ? page.events : []).forEach((event, i) => {
    if (!isPlain(event) || !isPlain(event.data) || !isPlain(event.data.value)) return;
    for (const [key, member] of Object.entries(event.data.value)) {
      const at = `/events/${i}/data/value/${pointerToken(key)}`;
      const named = credentialName(key);
      check(named, member, at);
      if (Array.isArray(member)) member.forEach((item, j) => check(named, item, `${at}/${j}`));
      else if (isPlain(member)) for (const [inner, leaf] of Object.entries(member)) check(named || credentialName(inner), leaf, `${at}/${pointerToken(inner)}`);
    }
  });
  return findings;
}

/** DEC-0070's `data {schema, value}` as the schema bounds it, then FAC-SEM-101. */
export function feedDataProblems(data) {
  if (!isPlain(data) || Object.keys(data).length !== 2 || !('schema' in data) || !('value' in data)) return ['data is {schema, value}'];
  const problems = [];
  if (!(typeof data.schema === 'string' && SCHEMA_URI.test(data.schema))) problems.push('data.schema is the absolute URI of a payload schema the service publishes');
  const value = data.value;
  if (!isPlain(value) || Object.keys(value).length > 32) return [...problems, 'data.value is an object of at most 32 members'];
  for (const [key, member] of Object.entries(value)) {
    if (scalar(member)) continue;
    if (Array.isArray(member) && member.length <= 32 && member.every(scalar)) continue;
    if (isPlain(member) && Object.keys(member).length <= 32 && Object.values(member).every(scalar)) continue;
    problems.push(`data.value.${key} is a scalar (a string of at most 500 characters), a list of at most 32 scalars or an object of at most 32 scalar members`);
  }
  if (problems.length) return problems;
  return feedDataFindings({ events: [{ data }] }).map((f) => `FAC-SEM-101: ${f.instancePath.replace('/events/0', '')} ${f.message}`);
}
