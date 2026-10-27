// What every module of the Node service kit shares: the protocol name, ServiceError, ids, nowIso and expand.
// Part of the Node service kit (FAA-65, layer L1); the twin of fabric_base.py. Node 20+, no dependency.
import os from 'node:os';
import path from 'node:path';

// Reference kit for the fabric-service/0.1 local service extension — Node.js 20+, no dependencies.
// The Node twin of fabric_service.py: same rules, same file formats, interoperable locks.
// Normative source: fabric-agent-contract docs/specification/service.md (DEC-0015; the remote
// placement — an online agent or dashboard at an https origin — DEC-0019; the usage report DEC-0021).
export const PROTOCOL = 'fabric-service/0.1';

export const EXTENSION_KEY = 'https://fabric.passioncode.ai/agent-contract/extensions/service/0.1';

// Lifecycle rules: references/lifecycle.md (the rule for this kit's users; it implements the public
// contract's service specification, Lifecycle), the same values as fabric_service.py.
// A launchd-supervised copy that finds the lock held backs off in-process before its exit 75 (LC-03).
export const SUPERVISOR_ENV = 'FABRIC_SERVICE_SUPERVISOR';

// LC-01: SIGTERM reaches exit in at most 10 s with work in flight — drain 8 s, hard exit 2 s later.
export const DRAIN_SECONDS = 8;

export const ID = /^[a-z][a-z0-9-]{1,62}$/;

export const INSTANCE = /^[a-z][a-z0-9-]{0,31}$/;

// DEC-0032: a local path starts with ~/ (or ~\ on Windows), / (never //) or a drive letter; a network share never does.
// DEC-0057: `//server/…` and `/\\server…` are shares on Windows too, so a leading slash is followed by neither.
export const LOCAL_PATH = /^(~[\\/]|\/(?![\\/])|[A-Za-z]:[\\/])/;

export const UNIT = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,250}\.service$/;

export const TASK = /^\\[A-Za-z0-9 ._\\-]{1,254}$/;

export class ServiceError extends Error {}

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Paths in a descriptor may start with ~/ (or ~\\ on Windows); everything else must be absolute,
 * and a network share is never a local path (DEC-0032). */
export function expand(p, platform = process.platform) {
  if (!LOCAL_PATH.test(String(p))) throw new ServiceError(`Path ${p} must be absolute or start with ~/.`);
  const out = /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p;
  // On Windows an absolute path names its drive: `/x` is relative to the current drive (the Python kit refuses it too).
  const absolute = platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(out) : path.posix.isAbsolute(out);
  if (!absolute) throw new ServiceError(`Path ${p} must be absolute or start with ~/.`);
  return out;
}
