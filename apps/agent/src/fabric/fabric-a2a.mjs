// The reading side of an A2A Agent Card (DEC-0122): the well-known document's surfaces.a2a member, read as the contract's
// schema reads it (a2aSurfaceFindings, a2aView; a2aSurface builds one), and what a public card must not carry
// (agentCardFindings): no member about the running process, no secret, no securitySchemes entry naming the descriptor's
// token header, every Fabric extension required: false (or absent, which A2A reads as false), and interface URLs where the placement puts them. Serving a
// card, the A2A binding and a client are not here (FAA-10).
// Part of the Node service kit (layer L3); the twin of fabric_a2a.py. Node 20+, no dependency.
import { ServiceError } from './fabric-base.mjs';
import { isObject } from './fabric-jsvalue.mjs';
import { secretValue } from './fabric-secrets.mjs';

/** A2A 1.0 section 8.2: where a peer looks for the public card. */
export const A2A_SURFACE_PATH = '/.well-known/agent-card.json';
/** The A2A version the contract pins (the A2A peer profile); surfaces.a2a.protocolVersion is this constant. */
export const A2A_PROTOCOL_VERSION = '1.0';
/** The contract's extension namespace (decision D6): an extension whose uri starts here is a Fabric fact. */
export const FABRIC_EXTENSION_PREFIX = 'https://fabric.passioncode.ai/';
/** The well-known document's members about the running process, which a public card never carries (DEC-0122 item 2). */
export const PROCESS_MEMBERS = Object.freeze(['build', 'process', 'pid', 'status', 'summary', 'degraded']);
export const MAX_PATH = 2048; // service-common.schema.json originPath maxLength, counted in code points as ajv counts it

// The schema's originPath pattern, under the `u` flag as ajv compiles it.
const ORIGIN_PATH = /^\/(?!\/)[^\s]*$/u;
const HTTPS = /^https:\/\//i;
const MEMBERS = ['path', 'protocolVersion'];

const pointer = (...parts) => parts.map((p) => '/' + String(p).replaceAll('~', '~0').replaceAll('/', '~1')).join('');
const asciiLower = (text) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
const finding = (instancePath, keyword, message) => ({ instancePath, keyword, message });

/** surfaces.a2a against service-well-known.schema.json at the pin, in ajv's order: each finding's instancePath and keyword
 * are the schema error's (test/fixtures/contract/a2a-vectors.json), with a sentence. */
export function a2aSurfaceFindings(value, base = '/surfaces/a2a') {
  if (!isObject(value)) return [finding(base, 'type', 'surfaces.a2a is an object {path, protocolVersion}')];
  const found = MEMBERS.filter((k) => !Object.hasOwn(value, k)).map((k) => finding(base, 'required', `surfaces.a2a has no ${k}`));
  for (const k of Object.keys(value)) {
    if (!MEMBERS.includes(k)) found.push(finding(base, 'additionalProperties', `surfaces.a2a has no member ${k}: the card names its interfaces, bindings and security schemes (DEC-0122)`));
  }
  if (Object.hasOwn(value, 'path')) {
    const path = value.path;
    if (typeof path !== 'string') found.push(finding(`${base}/path`, 'type', 'surfaces.a2a.path is a string'));
    else {
      if ([...path].length > MAX_PATH) found.push(finding(`${base}/path`, 'maxLength', `surfaces.a2a.path is longer than ${MAX_PATH} characters`));
      if (!ORIGIN_PATH.test(path)) found.push(finding(`${base}/path`, 'pattern', 'surfaces.a2a.path is not a path on the service origin (one leading /, no whitespace)'));
    }
  }
  if (Object.hasOwn(value, 'protocolVersion') && value.protocolVersion !== A2A_PROTOCOL_VERSION) {
    found.push(finding(`${base}/protocolVersion`, 'const', `surfaces.a2a.protocolVersion is ${A2A_PROTOCOL_VERSION}, the A2A version the contract pins`));
  }
  return found;
}

/** The findings of a2aSurfaceFindings as sentences; empty when the member is valid. */
export const a2aSurfaceProblems = (value) => a2aSurfaceFindings(value).map((f) => f.message);

/** The surfaces.a2a member for a service that serves its public card at `path` (DEC-0122 item 1). */
export function a2aSurface(path = A2A_SURFACE_PATH) {
  const surface = { path, protocolVersion: A2A_PROTOCOL_VERSION };
  const problems = a2aSurfaceProblems(surface);
  if (problems.length) throw new ServiceError(`surfaces.a2a: ${problems.join('; ')}.`);
  return surface;
}

/** What a host reads of a well-known document's A2A member; never throws. `declared` is whether surfaces.a2a is present,
 * `valid` whether it is the schema's, `path` the card's path when it is, `findings` the schema's. */
export function a2aView(wk) {
  const surfaces = isObject(wk) ? wk.surfaces : undefined;
  if (!isObject(surfaces) || !Object.hasOwn(surfaces, 'a2a')) return { declared: false, valid: false, path: null, protocolVersion: null, findings: [] };
  const findings = a2aSurfaceFindings(surfaces.a2a);
  const valid = findings.length === 0;
  return { declared: true, valid, path: valid ? surfaces.a2a.path : null, protocolVersion: valid ? A2A_PROTOCOL_VERSION : null, findings };
}

const card = (code, instancePath, message) => ({ code, instancePath, message });

// Every string the card holds that is shaped like a credential, by its place; walked without recursion, in the order
// JavaScript lists keys.
function secrets(root) {
  const found = [];
  const stack = [[root, '']];
  while (stack.length) {
    const [node, path] = stack.pop();
    if (typeof node === 'string') {
      if (secretValue(node)) found.push(card('secret', path, `${path || 'the card'} holds a value shaped like a credential: a public card carries no secret (DEC-0122 item 2)`));
    } else if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push([node[i], path + pointer(i)]);
    } else if (isObject(node)) {
      const keys = Object.keys(node);
      for (let i = keys.length - 1; i >= 0; i -= 1) stack.push([node[keys[i]], path + pointer(keys[i])]);
    }
  }
  return found;
}

// D5: a securitySchemes entry that is an API key in the descriptor's own header. With Authorization (the default) the
// card cannot show the token, so nothing is reported.
function descriptorSchemes(root, header) {
  const schemes = root.securitySchemes;
  if (!isObject(schemes) || !header || asciiLower(header) === 'authorization') return [];
  const found = [];
  for (const name of Object.keys(schemes)) {
    const scheme = schemes[name];
    if (!isObject(scheme)) continue;
    let location;
    let named;
    if (isObject(scheme.apiKeySecurityScheme)) ({ location, name: named } = scheme.apiKeySecurityScheme); // A2A 1.0
    else if (scheme.type === 'apiKey') ({ in: location, name: named } = scheme); // the OpenAPI shape of A2A before 1.0
    else continue;
    if (location === 'header' && typeof named === 'string' && asciiLower(named) === asciiLower(header)) {
      found.push(card('descriptor-token-scheme', pointer('securitySchemes', name), `securitySchemes.${name} is an API key in ${header}, the descriptor's token header: an A2A interface never takes the descriptor's token (DEC-0122 item 3)`));
    }
  }
  return found;
}

// D6: an extension under the contract's namespace is not required (A2A 1.0 section 4.4.4): `required` false or absent,
// which A2A reads as false (a protobuf-written card drops a false default); true or a non-boolean is a finding.
function fabricExtensions(root) {
  const extensions = isObject(root.capabilities) ? root.capabilities.extensions : undefined;
  if (!Array.isArray(extensions)) return [];
  const found = [];
  extensions.forEach((extension, i) => {
    const uri = isObject(extension) ? extension.uri : undefined;
    if (typeof uri !== 'string' || asciiLower(uri.slice(0, FABRIC_EXTENSION_PREFIX.length)) !== FABRIC_EXTENSION_PREFIX) return;
    if (Object.hasOwn(extension, 'required') && extension.required !== false) {
      found.push(card('fabric-extension-required', pointer('capabilities', 'extensions', i), `the Fabric extension at capabilities.extensions[${i}] is required, so a peer that does not know it cannot call; it carries required: false (DEC-0122 item 4)`));
    }
  });
  return found;
}

// Where the card's interfaces are (DEC-0122 item 2): on a local placement on the service's loopback origin as written, on
// a remote one https; every one A2A 1.0.
function interfaces(root, origin, remote) {
  const list = root.supportedInterfaces;
  if (!Array.isArray(list) || list.length === 0) return [card('interfaces-missing', '/supportedInterfaces', "the card names no supportedInterfaces: A2A 1.0 lists a card's interfaces there")];
  const found = [];
  list.forEach((entry, i) => {
    const place = pointer('supportedInterfaces', i);
    const url = isObject(entry) ? entry.url : undefined;
    if (typeof url !== 'string') {
      found.push(card('interface-shape', place, `supportedInterfaces[${i}] is not an interface with a url`));
      return;
    }
    if (remote) {
      if (!HTTPS.test(url)) found.push(card('interface-scheme', `${place}/url`, `supportedInterfaces[${i}].url is not https: a loopback or plain-http interface is admitted on a local placement only`));
    } else if (origin && !(url === origin || url.startsWith(`${origin}/`))) {
      found.push(card('interface-origin', `${place}/url`, `supportedInterfaces[${i}].url is not on the service origin ${origin}, where a peer on this computer reaches it`));
    }
    if (entry.protocolVersion !== A2A_PROTOCOL_VERSION) {
      found.push(card('interface-version', `${place}/protocolVersion`, `supportedInterfaces[${i}] does not expose A2A ${A2A_PROTOCOL_VERSION}, the version surfaces.a2a names`));
    }
  });
  return found;
}

/** What a public Agent Card must not carry or say (DEC-0122 items 2 to 4; decisions D5, D6), each finding
 * {code, instancePath, message} naming the place and never the value. `origin` is the service origin the card was read
 * on (its interfaces' place on a local placement; omitted, the place is not judged), `remote` the placement,
 * `descriptorHeader` the descriptor's auth.header (default Authorization). It reads the card only: whether an interface
 * accepts the token cannot be seen without sending it, which DEC-0122 forbids. */
export function agentCardFindings(value, { origin = null, remote = false, descriptorHeader = 'Authorization' } = {}) {
  if (!isObject(value)) return [card('card-shape', '', 'the card is not a JSON object')];
  const found = PROCESS_MEMBERS.filter((k) => Object.hasOwn(value, k))
    .map((k) => card('process-member', pointer(k), `the card carries ${k}, a member about the running process: a public card carries none (DEC-0122 item 2)`));
  found.push(...secrets(value));
  found.push(...descriptorSchemes(value, typeof descriptorHeader === 'string' ? descriptorHeader : ''));
  found.push(...fabricExtensions(value));
  found.push(...interfaces(value, origin, remote));
  return found;
}
