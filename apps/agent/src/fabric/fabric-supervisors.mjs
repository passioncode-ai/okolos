// Supervisors (DEC-0032, LC-14): systemd user units, Task Scheduler tasks and launchd plists, installed and removed without touching what the operator turned off; release pruning (LC-11, LC-15).
// Part of the Node service kit (FAA-65, layer L3); the twin of fabric_supervisors.py. Node 20+, no dependency.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { credentialName, secretArgument, secretUrl, secretValue } from './fabric-secrets.mjs';
import { DRAIN_SECONDS, SUPERVISOR_ENV, ServiceError, TASK, UNIT } from './fabric-base.mjs';
import { atomicWrite, instanceDirs } from './fabric-paths.mjs';
import { SUPERVISOR_ARG, markerArguments } from './fabric-lock.mjs';
import { URI } from './fabric-backups.mjs';

export const DEFAULT_EXIT_TIMEOUT = 15;

/**
 * Keep the release the job runs and the one before it; remove older release directories, newest
 * first by modification time. `current` (a release or a symlink to one) is never removed, even
 * after a rollback. Symlinks and files are left alone. Returns the removed paths.
 */
export function pruneReleases(releasesDir, { keep = 2, current } = {}) {
  if (keep < 2) throw new ServiceError('keep at least the current release and the one before it (keep >= 2).');
  if (!fs.existsSync(releasesDir)) return [];
  const releases = fs.readdirSync(releasesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => path.join(releasesDir, e.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const keepers = [];
  if (current) {
    const resolved = fs.realpathSync(current);
    keepers.push(...releases.filter((p) => fs.realpathSync(p) === resolved));
  }
  for (const release of releases) {
    if (keepers.length >= keep) break;
    if (!keepers.includes(release)) keepers.push(release);
  }
  const removed = releases.filter((p) => !keepers.includes(p));
  for (const release of removed) fs.rmSync(release, { recursive: true, force: true });
  return removed;
}

// The twins of fabric_service.systemd_unit / task_xml and their install and uninstall. `run(argv)`
// returns spawnSync's {status, stdout, stderr}; the tests pass a recorder instead of the real tools.
const defaultRun = (argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', windowsHide: true });

function plain(value, what) {
  // A supervisor file is line- and XML-structured: no control character in anything written into it.
  if (/[\x00-\x1f\x7f]/.test(value)) throw new ServiceError(`${what} holds a control character (a line break, a tab, a NUL); a supervisor file cannot carry it.`);
  return value;
}

/** The supervisor file's writer writes the marker itself; one already in the arguments could only disagree with it. */
function noMarkerArgument(argv) {
  if (markerArguments(argv).length) throw new ServiceError(`${SUPERVISOR_ARG} is written by the supervisor file's writer; leave it out of the program arguments.`);
}

function noSecretInSupervisorFile(argv, environment) {
  // No supervisor file carries a secret (service.md): not in an argument, an environment name or its value.
  for (const arg of argv) {
    if (secretArgument(arg)) throw new ServiceError('An argument carries a credential; a supervisor file never does (read it from the token file or a secret reference).');
  }
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (credentialName(name) || secretValue(String(value))) throw new ServiceError(`Environment ${name} looks like a credential; a supervisor file never carries one.`);
  }
}

function checkRun(result, what) {
  if (result?.status !== 0) throw new ServiceError(`${what} failed: ${String(result?.stderr || result?.stdout || result?.error?.message || '').trim().slice(0, 200)}`);
}

// ExecStart= expands $VAR, so its $ is doubled; Environment= expands none, so `dollar` false leaves it alone (finding 17).
const systemdQuote = (value, dollar = true) => {
  const escaped = plain(value, 'An argument').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  return `"${dollar ? escaped.replace(/\$/g, '$$$$') : escaped}"`;
};

/**
 * A systemd user unit (DEC-0032): Restart=always, RestartSec=10, TimeoutStopSec above the drain time,
 * WantedBy=default.target. The service is told who supervises it (FABRIC_SERVICE_SUPERVISOR=systemd).
 */
export function systemdUnit(unit, programArguments, { workingDirectory, environment = {}, description, stopTimeout = DEFAULT_EXIT_TIMEOUT } = {}) {
  if (!UNIT.test(unit)) throw new ServiceError(`unit must match ${UNIT.source}`);
  const argv = programArguments.map(String);
  if (!argv.length || !argv[0].startsWith('/')) throw new ServiceError('A systemd unit starts an absolute executable.');
  if (!(stopTimeout > DRAIN_SECONDS)) throw new ServiceError(`TimeoutStopSec must outlast the ${DRAIN_SECONDS} s drain.`);
  const env = { ...environment };
  for (const name of Object.keys(env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ServiceError(`Environment name ${JSON.stringify(name)} is not a variable name.`);
  noSecretInSupervisorFile(argv, env);
  noMarkerArgument(programArguments.map(String));
  env[SUPERVISOR_ENV] = 'systemd'; // the unit's writer writes the marker, whatever the caller passed
  const cwd = plain(String(workingDirectory), 'The working directory');
  if (!cwd.startsWith('/')) throw new ServiceError("A systemd unit's working directory is absolute.");
  return [
    '[Unit]', `Description=${plain(description ?? unit, 'The description').replace(/%/g, '%%')}`, '',
    '[Service]', 'Type=simple', `ExecStart=${argv.map((a) => systemdQuote(a)).join(' ')}`,
    // Not quoted: systemd reads WorkingDirectory= as the rest of the line, quotes included.
    `WorkingDirectory=${cwd.replace(/%/g, '%%')}`,
    ...Object.keys(env).sort().map((k) => `Environment=${systemdQuote(`${k}=${env[k]}`, false)}`),
    'Restart=always', 'RestartSec=10', `TimeoutStopSec=${Math.trunc(stopTimeout)}`, 'KillMode=mixed', '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n');
}

const systemdDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');

/**
 * Write the user unit, enable it so it comes back after a login, and (re)start it so the new unit is what runs.
 * The operator's intent wins (LC-14): a unit already installed and disabled stays off — the file is rewritten, so the
 * new version is what starts once they enable it — unless `forceEnable` (the operator asked for it on).
 */
export function systemdInstall(unit, text, { unitDir = systemdDir(), run = defaultRun, platform = process.platform, forceEnable = false } = {}) {
  if (platform !== 'linux') throw new ServiceError('systemd is the supervisor on Linux only.');
  if (!UNIT.test(unit)) throw new ServiceError(`unit must match ${UNIT.source}`);
  fs.mkdirSync(unitDir, { recursive: true });
  const file = path.join(unitDir, unit);
  const state = fs.existsSync(file) ? String(run(['systemctl', '--user', 'is-enabled', unit])?.stdout ?? '').trim() : '';
  atomicWrite(file, text, 0o644);
  checkRun(run(['systemctl', '--user', 'daemon-reload']), 'systemctl --user daemon-reload');
  if (state === 'disabled' && !forceEnable) return file;
  checkRun(run(['systemctl', '--user', 'enable', unit]), 'systemctl --user enable');
  checkRun(run(['systemctl', '--user', 'restart', unit]), 'systemctl --user restart');
  return file;
}

/** Stop it and keep it off across logins (`disable --now`), then remove the unit. */
export function systemdUninstall(unit, { unitDir = systemdDir(), run = defaultRun, platform = process.platform } = {}) {
  if (platform !== 'linux') throw new ServiceError('systemd is the supervisor on Linux only.');
  if (!UNIT.test(unit)) throw new ServiceError(`unit must match ${UNIT.source}`);
  run(['systemctl', '--user', 'disable', '--now', unit]);
  fs.rmSync(path.join(unitDir, unit), { force: true });
  checkRun(run(['systemctl', '--user', 'daemon-reload']), 'systemctl --user daemon-reload');
}

/** One command line from arguments, quoted the way the Microsoft C runtime parses it (Python's list2cmdline). */
export function windowsCommandLine(args) {
  return args.map((arg) => {
    const quote = arg === '' || /[ \t]/.test(arg);
    let out = quote ? '"' : '';
    let slashes = 0;
    for (const c of arg) {
      if (c === '\\') { slashes += 1; continue; }
      if (c === '"') { out += '\\'.repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
      out += '\\'.repeat(slashes) + c;
      slashes = 0;
    }
    return out + '\\'.repeat(quote ? slashes * 2 : slashes) + (quote ? '"' : '');
  }).join(' ');
}

const xml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A per-user Scheduled Task (DEC-0032): a logon trigger, restart on failure every minute, no execution
 * time limit, run only when the user is logged on, created without administrator rights.
 */
export function taskXml(task, programArguments, { workingDirectory, description, user } = {}) {
  if (!TASK.test(task)) throw new ServiceError(`task must match ${TASK.source}`);
  const argv = programArguments.map(String);
  if (!argv.length || !/^[A-Za-z]:[\\/]/.test(argv[0])) throw new ServiceError('A task starts a drive-absolute executable (C:\\...).');
  for (const arg of argv) plain(arg, 'An argument');
  plain(String(workingDirectory), 'The working directory');
  plain(description ?? task, 'The description');
  noSecretInSupervisorFile(argv, {});
  noMarkerArgument(argv);
  // A task's Exec action carries no environment, so the marker is an argument (DEC-0057), before any `--`.
  const cut = argv.includes('--') ? argv.indexOf('--') : argv.length;
  argv.splice(cut, 0, SUPERVISOR_ARG, 'task-scheduler');
  const who = user ?? (process.env.USERNAME ? `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME}` : '');
  if (!who) throw new ServiceError('Name the user the task runs as (DOMAIN\\user); USERNAME is not set.');
  plain(who, 'The user');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(description ?? task)}</Description><URI>${xml(task)}</URI></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(who)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(who)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(argv[0])}</Command><Arguments>${xml(windowsCommandLine(argv.slice(1)))}</Arguments><WorkingDirectory>${xml(workingDirectory)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

const TASK_DISABLED = /<Settings>(?:(?!<\/Settings>)[\s\S])*<Enabled>false<\/Enabled>/;

/**
 * Create (or replace) the task from its XML without administrator rights, then (re)start it so the new definition
 * is what runs. A task already installed and disabled stays off (LC-14) unless `forceEnable`.
 */
export function taskInstall(task, xmlText, { run = defaultRun, platform = process.platform, forceEnable = false } = {}) {
  if (platform !== 'win32') throw new ServiceError('Task Scheduler is the supervisor on Windows only.');
  const query = run(['schtasks', '/Query', '/TN', task, '/XML']);
  const existed = query?.status === 0;
  const keepOff = existed && !forceEnable && TASK_DISABLED.test(String(query?.stdout ?? ''));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-task-'));
  const file = path.join(dir, 'task.xml');
  try {
    // schtasks reads the encoding the declaration names: UTF-16 little-endian with its byte order mark.
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xmlText, 'utf16le')]));
    checkRun(run(['schtasks', '/Create', '/TN', task, '/XML', file, '/F']), 'schtasks /Create');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (keepOff) {
    checkRun(run(['schtasks', '/Change', '/TN', task, '/DISABLE']), 'schtasks /Change /DISABLE');
    return;
  }
  if (existed) run(['schtasks', '/End', '/TN', task]);
  checkRun(run(['schtasks', '/Run', '/TN', task]), 'schtasks /Run');
}

/** End the running task, then delete it. */
export function taskUninstall(task, { run = defaultRun, platform = process.platform } = {}) {
  if (platform !== 'win32') throw new ServiceError('Task Scheduler is the supervisor on Windows only.');
  run(['schtasks', '/End', '/TN', task]);
  checkRun(run(['schtasks', '/Delete', '/TN', task, '/F']), 'schtasks /Delete');
}

// The twins of fabric_service.launchd_plist / launchd_loaded / launchd_override / launchd_install / launchd_uninstall.
// `run(argv)` returns spawnSync's {status, stdout, stderr}; the tests pass a launchd stand-in, never the real launchctl.
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,250}$/;

const DEFAULT_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launchdLabel(label) {
  if (!LABEL.test(String(label))) throw new ServiceError(`label must match ${LABEL.source}`);
  return String(label);
}

function plistValue(value, depth) {
  // plistlib.dumps's layout, byte for byte: one tab per level, keys sorted, & < > escaped, empty containers self-closed.
  const pad = '\t'.repeat(depth);
  if (value === true || value === false) return `${pad}<${value}/>\n`;
  if (Number.isInteger(value)) return `${pad}<integer>${value}</integer>\n`;
  if (typeof value === 'string') return `${pad}<string>${plain(value, 'A plist string').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>\n`;
  if (Array.isArray(value)) return value.length ? `${pad}<array>\n${value.map((v) => plistValue(v, depth + 1)).join('')}${pad}</array>\n` : `${pad}<array/>\n`;
  const keys = Object.keys(value).sort();
  if (!keys.length) return `${pad}<dict/>\n`;
  const inner = keys.map((k) => `${pad}\t<key>${plain(k, 'A plist key').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</key>\n${plistValue(value[k], depth + 1)}`).join('');
  return `${pad}<dict>\n${inner}${pad}</dict>\n`;
}

/**
 * The launchd job: RunAtLoad + KeepAlive true + ThrottleInterval 10, ProcessType Standard, ExitTimeOut above the drain.
 * FABRIC_SERVICE_SUPERVISOR=launchd tells the lock to back off instead of exiting into a respawn loop (DEC-0057).
 * No secret is written: an environment name ending TOKEN/SECRET/PASSWORD/KEY (a `*_FILE` path is fine), a value or an
 * argument shaped like a credential is refused. Returns the XML text, the same bytes Python's plistlib writes.
 */
export function launchdPlist(label, programArguments, { workingDirectory, stdoutPath, environment = {}, exitTimeout = DEFAULT_EXIT_TIMEOUT } = {}) {
  launchdLabel(label);
  const argv = programArguments.map(String);
  if (!argv.length) throw new ServiceError('A launchd job starts a program; ProgramArguments is empty.');
  if (!(exitTimeout > DRAIN_SECONDS)) throw new ServiceError(`ExitTimeOut must outlast the ${DRAIN_SECONDS} s drain.`);
  if (workingDirectory === undefined || stdoutPath === undefined) throw new ServiceError('A launchd job names its working directory and its log file.');
  const env = { ...environment };
  for (const [name, value] of Object.entries(env)) {
    if (/(TOKEN|SECRET|PASSWORD|KEY)$/.test(name) && !name.endsWith('_FILE')) throw new ServiceError(`Environment variable ${name} looks like a secret; pass a *_FILE path instead.`);
    if (secretValue(String(value))) throw new ServiceError(`Environment ${name} holds a value shaped like a credential; a plist never carries one.`);
  }
  for (const arg of argv) {
    if (secretArgument(arg)) throw new ServiceError('An argument carries a credential; a plist never does (read it from the token file or a secret reference).');
  }
  noMarkerArgument(argv);
  if (env.PATH === undefined) env.PATH = DEFAULT_PATH;
  env[SUPERVISOR_ENV] = 'launchd'; // the plist's writer writes the marker, whatever the caller passed
  const job = {
    Label: label,
    ProgramArguments: argv,
    WorkingDirectory: String(workingDirectory),
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
    ExitTimeOut: Math.trunc(exitTimeout),
    // Standard, never Background: macOS starves a Background job under load and every host then reports an outage.
    ProcessType: 'Standard',
    StandardOutPath: String(stdoutPath),
    StandardErrorPath: String(stdoutPath),
    EnvironmentVariables: env,
  };
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0">\n${plistValue(job, 0)}</plist>\n`;
}

function launchdDomain(platform, uid) {
  // DEC-0032: launchd is macOS's supervisor; Linux has systemd and Windows Task Scheduler.
  if (platform !== 'darwin') throw new ServiceError('launchd is the supervisor on macOS only; use systemdInstall on Linux and taskInstall on Windows.');
  return `gui/${uid ?? process.getuid()}`;
}

/** True when launchd has the job loaded (`launchctl print gui/<uid>/<label>` answers). */
export function launchdLoaded(label, { run = defaultRun, platform = process.platform, uid } = {}) {
  return run(['launchctl', 'print', `${launchdDomain(platform, uid)}/${launchdLabel(label)}`])?.status === 0;
}

const OVERRIDE_ROW = /^\s*"([^"]+)"\s*=>\s*(\S+)\s*$/;

/**
 * The operator's launchd override for `label`: 'disabled', 'enabled', null when none is recorded (a first install), or
 * 'unknown' when the table cannot be read. macOS 14+ prints `=> disabled|enabled`, older releases `=> true|false`.
 */
export function launchdOverride(label, { run = defaultRun, platform = process.platform, uid } = {}) {
  const result = run(['launchctl', 'print-disabled', launchdDomain(platform, uid)]);
  if (result?.status !== 0) return 'unknown';
  for (const line of String(result.stdout ?? '').split('\n')) {
    const match = OVERRIDE_ROW.exec(line);
    if (match && match[1] === label) return ['disabled', 'true'].includes(match[2]) ? 'disabled' : 'enabled';
  }
  return null;
}

async function wellKnownOf(origin) {
  try {
    const response = await fetch(`${origin}/.well-known/fabric-service`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/**
 * Write and lint the plist, bootout and WAIT for the unload, bootstrap (retrying launchd's EIO 5 times), then poll the
 * well-known document until it answers with this identity; resolves to that document.
 *
 * The operator's intent wins (LC-14): only a first install (no override recorded) enables the label. A label the
 * operator disabled stays disabled and unloaded — the plist is still rewritten, so the new release is what starts once
 * they turn it back on — and the answer is {disabled: true, label, plist, loaded}. `forceEnable` is for an operator
 * who asked for the service to be switched on.
 */
export async function launchdInstall(label, plistPath, plistText, { origin, serviceId, instance = 'default', timeout = 40, forceEnable = false,
  run = defaultRun, platform = process.platform, uid, fetchWellKnown = wellKnownOf, sleep = pause } = {}) {
  const domain = launchdDomain(platform, uid);
  launchdLabel(label);
  if (!origin || !serviceId) throw new ServiceError('launchdInstall needs the origin and the service id it waits to see answer.');
  const opts = { run, platform, uid };
  atomicWrite(plistPath, plistText, 0o644);
  const lint = run(['plutil', '-lint', String(plistPath)]);
  if (lint?.status !== 0) throw new ServiceError(`plist failed plutil -lint: ${String(lint?.stdout || lint?.stderr || '').trim().slice(0, 200)}`);
  const target = `${domain}/${label}`;
  const override = launchdOverride(label, opts);
  if (forceEnable || override === null) run(['launchctl', 'enable', target]);
  else if (override === 'disabled') return { disabled: true, label, plist: String(plistPath), loaded: launchdLoaded(label, opts) };
  run(['launchctl', 'bootout', target]);
  const unloaded = Date.now() + 15_000;
  while (launchdLoaded(label, opts) && Date.now() < unloaded) await sleep(250);
  let last = '';
  for (let attempt = 0; ; attempt += 1) {
    const result = run(['launchctl', 'bootstrap', domain, String(plistPath)]);
    if (result?.status === 0) break;
    last = String(result?.stderr || result?.stdout || '').trim();
    if (attempt === 4) throw new ServiceError(`launchctl bootstrap failed: ${last.slice(0, 200)}`);
    await sleep(1000);
  }
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const doc = await fetchWellKnown(origin);
    if (doc?.service?.id === serviceId && doc?.service?.instance === instance) return doc;
    await sleep(500);
  }
  throw new ServiceError(`${origin} did not answer as ${serviceId}.${instance} within ${timeout} s; read its log.`);
}

/**
 * Symmetric with launchdInstall (LC-14): bootout and WAIT until the job is gone, remove the plist, and reset the
 * override to enabled — launchctl has no verb that deletes an override, and a leftover `disabled` would keep a later
 * fresh install off. Data stays unless `purge` (then `serviceId` names whose data, logs and cache go, and `instance` which
 * instance's, so one context's purge never reaches another's, FAA-125). A job still
 * loaded at `timeout` seconds throws, leaving the plist and the data in place.
 */
export async function launchdUninstall(label, plistPath, { timeout = 30, purge = false, serviceId, instance = 'default', run = defaultRun, platform = process.platform, uid, sleep = pause } = {}) {
  const domain = launchdDomain(platform, uid);
  launchdLabel(label);
  if (purge && !serviceId) throw new ServiceError('purge needs the service id whose data, logs and cache to remove.');
  const dirs = purge ? instanceDirs(serviceId, instance, platform) : {}; // one instance's folders only (FAA-125)
  const opts = { run, platform, uid };
  const target = `${domain}/${label}`;
  run(['launchctl', 'bootout', target]);
  const deadline = Date.now() + timeout * 1000;
  while (launchdLoaded(label, opts)) {
    if (Date.now() >= deadline) throw new ServiceError(`launchd job ${label} is still loaded ${timeout} s after bootout; nothing was removed.`);
    await sleep(100);
  }
  let plistRemoved = true;
  try {
    fs.unlinkSync(plistPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    plistRemoved = false;
  }
  run(['launchctl', 'enable', target]);
  const purged = [];
  for (const dir of Object.values(dirs)) {
    try { fs.lstatSync(dir); } catch { continue; }
    fs.rmSync(dir, { recursive: true, force: true }); // a symlinked folder: the link goes, never what it points at
    purged.push(dir);
  }
  return { unloaded: true, plistRemoved, override: 'enabled', purged };
}
