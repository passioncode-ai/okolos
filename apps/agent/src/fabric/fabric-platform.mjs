// Windows, where the kit needs it (DEC-0032): reading a file's ACL to refuse a token file others can read.
// Part of the Node service kit (FAA-65, layer L1); the twin of fabric_platform.py. Node 20+, no dependency.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ServiceError } from './fabric-base.mjs';

export const WINDOWS_TRUSTED = Object.freeze(['S-1-5-18', 'S-1-5-32-544']);

// Node has no ACL API. Windows PowerShell (5.1, present on every Windows) reads the list through .NET
// and icacls writes it; both get the path through the environment, never argv, and print no contents.
export const SYSTEM_SID = 'S-1-5-18';

export const ADMINISTRATORS_SID = 'S-1-5-32-544';

/** A string SID: revision 1, an identifier authority and up to 15 sub-authorities of 32 bits each. */
const SID_TEXT = /^S-1-\d{1,15}(-\d{1,10}){0,15}$/i;

/** A readable SID in upper case (SIDs compare case-insensitively on their S), or undefined. */
const sidOf = (value) => (typeof value === 'string' && SID_TEXT.test(value) && value.split('-').slice(3).every((part) => Number(part) <= 0xffffffff) ? value.toUpperCase() : undefined);

/**
 * service.md "Windows token files" (DEC-0032, DEC-0033, DEC-0057, FAC-SEM-079) on what a reader has read: `file` is
 * `{isRegularFile, isReparsePoint, realPathInProfile, ownerSid, aces: [{type, sid, mask}]}`, the mask the ACE's unsigned
 * 32-bit access mask. The first refusal `{problem, at, sid?, message}`, or null when the file may be read: a regular
 * file, not a reparse point, inside the profile; owned by the user, SYSTEM or Administrators; every allow ACE with a
 * non-zero mask naming one of those three; deny ACEs ignored; any other ACE type refused; anything unreadable refused.
 * The contract's `windowsTokenAclProblem`; a refusal names the SID, never the contents.
 */
export function windowsTokenAclProblem(file, currentUserSid) {
  const refuse = (problem, at, message, sid) => (sid === undefined ? { problem, at, message } : { problem, at, sid, message });
  const user = sidOf(currentUserSid);
  if (user === undefined) return refuse('unreadable', '/currentUserSid', "the current user's SID is unreadable");
  if (typeof file !== 'object' || file === null || Array.isArray(file)) return refuse('unreadable', '/file', "the token file's metadata is unreadable");
  for (const flag of ['isRegularFile', 'isReparsePoint', 'realPathInProfile']) {
    if (typeof file[flag] !== 'boolean') return refuse('unreadable', `/file/${flag}`, `${flag} is unreadable`);
  }
  if (file.isReparsePoint) return refuse('reparse-point', '/file/isReparsePoint', 'the token file is a reparse point (a symlink or a junction)');
  if (!file.isRegularFile) return refuse('not-regular-file', '/file/isRegularFile', 'the token file is not a regular file');
  if (!file.realPathInProfile) return refuse('outside-profile', '/file/realPathInProfile', "the token file's real path lies outside the user's profile");
  const trusted = new Set([user, SYSTEM_SID, ADMINISTRATORS_SID]);
  const owner = sidOf(file.ownerSid);
  if (owner === undefined) return refuse('unreadable', '/file/ownerSid', 'the owner SID is unreadable');
  if (!trusted.has(owner)) return refuse('owner', '/file/ownerSid', `the token file is owned by ${owner}, not by the current user, SYSTEM or Administrators`, owner);
  if (!Array.isArray(file.aces)) return refuse('unreadable', '/file/aces', 'the ACL is unreadable');
  for (const [index, ace] of file.aces.entries()) {
    const at = `/file/aces/${index}`;
    if (typeof ace !== 'object' || ace === null || Array.isArray(ace)) return refuse('unreadable', at, `ACE ${index} is unreadable`);
    if (typeof ace.type !== 'string') return refuse('unreadable', `${at}/type`, `ACE ${index} has an unreadable type`);
    const trustee = sidOf(ace.sid);
    if (trustee === undefined) return refuse('unreadable', `${at}/sid`, `ACE ${index} names an unreadable SID`);
    if (typeof ace.mask !== 'number' || !Number.isInteger(ace.mask) || ace.mask < 0 || ace.mask > 0xffffffff) return refuse('unreadable', `${at}/mask`, `ACE ${index} has an unreadable access mask`);
    if (ace.type === 'deny') continue;
    if (ace.type !== 'allow') return refuse('ace-type', `${at}/type`, `ACE ${index} for ${trustee} is of a type the rule does not read`, trustee);
    if (ace.mask === 0) continue;
    if (!trusted.has(trustee)) return refuse('ace-sid', `${at}/sid`, `the token file grants access to ${trustee}; only the current user, SYSTEM and Administrators may hold any`, trustee);
  }
  return null;
}

/** windowsTokenAclProblem as one sentence naming the file and the refusal, or null. */
export function tokenFileProblem(file, metadata, user) {
  const problem = windowsTokenAclProblem(metadata, user);
  return problem ? `Token file ${file} refused: ${problem.message}.` : null;
}

// The raw descriptor, through .NET: every ACE's type, its trustee's SID and its access mask as read (a signed int;
// parseAclReport converts it to the unsigned mask). An inherit-only ACE applies to children only and is left out.
const ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$acl = [System.IO.File]::GetAccessControl($env:FABRIC_ACL_PATH)',
  "$raw = New-Object System.Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorSddlForm('Owner, Access'))",
  '$dacl = $raw.DiscretionaryAcl',
  "$aces = @(if ($dacl) { $dacl | Where-Object { -not ([int]$_.AceFlags -band 8) } | ForEach-Object { @{ type = [string]$_.AceType; sid = $(if ($_.SecurityIdentifier) { $_.SecurityIdentifier.Value } else { '' }); mask = [int64]$_.AccessMask } } })",
  '$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  '[Console]::Out.Write((ConvertTo-Json -Compress -Depth 4 @{ owner = $raw.Owner.Value; aces = $aces; nullDacl = [bool](-not $dacl); user = $user }))',
].join('; ');

function windowsHelper(command, args, extraEnv = {}) {
  // No PSModulePath: the script uses .NET only, and a module path inherited from PowerShell 7 makes
  // Windows PowerShell load the wrong modules.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath'));
  const result = spawnSync(command, args, { env: { ...env, ...extraEnv }, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (result.error || result.status !== 0) {
    throw new ServiceError(`${command} failed: ${(result.error?.message || result.stderr || result.stdout || '').trim().slice(0, 200)}`);
  }
  return result.stdout;
}

/** .NET's AceType names as the rule's ACE type: allow and deny are read, every other type is refused (DEC-0057). */
const ACE_TYPES = { AccessAllowed: 'allow', AccessDenied: 'deny', AccessAllowedObject: 'allow-object', AccessDeniedObject: 'deny-object',
  AccessAllowedCallback: 'allow-callback', AccessDeniedCallback: 'deny-callback', AccessAllowedCallbackObject: 'allow-object-callback',
  AccessDeniedCallbackObject: 'deny-object-callback' };

/**
 * The ACL report PowerShell prints, as (owner SID, ACEs `{type, sid, mask}`, current user). The mask arrives signed
 * (GENERIC_READ 0x80000000 is negative in .NET) and is read as the unsigned 32-bit mask; a NULL DACL grants everyone
 * everything and is read as an allow ACE for Everyone (S-1-1-0).
 */
export function parseAclReport(text) {
  const report = JSON.parse(text);
  const aces = report.nullDacl ? [{ type: 'allow', sid: 'S-1-1-0', mask: 0x1f01ff }]
    : [].concat(report.aces ?? []).map((ace) => ({ type: ACE_TYPES[ace.type] ?? String(ace.type), sid: ace.sid, mask: Number.isInteger(ace.mask) ? ace.mask >>> 0 : ace.mask }));
  return { owner: report.owner ?? '', aces, user: report.user };
}

/** (owner SID, the ACEs on the file itself, the current user's SID). */
export function windowsAcl(file) {
  return parseAclReport(windowsHelper('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT], { FABRIC_ACL_PATH: file }));
}

let userSid = null;

export function windowsUserSid() {
  if (!userSid) {
    const line = windowsHelper('whoami.exe', ['/user', '/fo', 'csv', '/nh']).trim();
    userSid = (line.match(/"(S-1-[0-9-]+)"\s*$/) ?? [])[1];
    if (!userSid) throw new ServiceError('whoami /user printed no SID.');
  }
  return userSid;
}

/**
 * A protected list (inheritance off): this user, SYSTEM, Administrators, full control; a folder hands it down.
 * `/reset` first drops any explicit entry already there (`/inheritance:r` keeps those), so the three are all that remain.
 */
export function windowsProtect(target, { folder }) {
  const grant = folder ? '(OI)(CI)F' : 'F';
  windowsHelper('icacls.exe', [target, '/reset']);
  windowsHelper('icacls.exe', [target, '/inheritance:r', '/grant:r', ...[windowsUserSid(), ...WINDOWS_TRUSTED].map((sid) => `*${sid}:${grant}`)]);
}

export function windowsTokenProblem(file, info) {
  const profile = fs.realpathSync.native(process.env.USERPROFILE || os.homedir()).toLowerCase();
  const real = fs.realpathSync.native(file).toLowerCase();
  const inside = path.win32.relative(profile, real);
  const { owner, aces, user } = windowsAcl(file);
  return tokenFileProblem(file, {
    isRegularFile: info.isFile(), isReparsePoint: info.isSymbolicLink(),
    realPathInProfile: Boolean(inside) && !inside.startsWith('..') && !path.win32.isAbsolute(inside), ownerSid: owner, aces,
  }, user);
}

export function tokenMatches(presented, token, scheme = 'Bearer') {
  if (!presented) return false;
  let value = presented;
  if (scheme === 'Bearer') {
    if (!presented.startsWith('Bearer ')) return false;
    value = presented.slice(7);
  }
  const a = Buffer.from(value.trim());
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function checkRequest(port, host, origin, secFetchSite) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!hosts.has(host)) return `Host ${host} is not this service.`;
  if (origin !== undefined && origin !== null && ![...hosts].some((h) => origin === `http://${h}`)) return `Origin ${origin} is not this service.`;
  if (secFetchSite === 'cross-site') return 'Cross-site requests are refused.';
  return null;
}
