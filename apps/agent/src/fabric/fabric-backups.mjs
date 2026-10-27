// Settings backups (DEC-0025, FAC-SEM-035): canonical form, digest, write, list, check, restore.
// Part of the Node service kit (FAA-65, layer L3); the twin of fabric_backups.py. Node 20+, no dependency.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ID, INSTANCE, ServiceError } from './fabric-base.mjs';
import { atomicWrite, ensurePrivateDir } from './fabric-paths.mjs';
import { scalar } from './fabric-protocols.mjs';
import { isPlainObject, isTimestamp } from './fabric-usage.mjs';

// The twins of fabric_service.make_settings_backup and the rest; both kits write byte-identical files.
export const SETTINGS_BACKUP_FORMAT = 'fabric-settings-backup/1';

export const SETTINGS_BACKUP_KEEP = 14;

export const SETTINGS_BACKUP_MAX_AGE_SECONDS = 24 * 60 * 60;

const TABLE = /^[a-z][a-z0-9_]{0,62}$/;

const SECRET_TABLE = /^(([\s\S]+_)?(account_connections?|account_connection_drafts?|tokens?|secrets?|credentials?|passwords?|login_codes?)|(operator_)?sessions?)$/;

const COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const SECRET_COLUMN = /^(?:[\s\S]+_)?(?:[Tt]oken|[Ss]ecret|[Pp]assword|[Pp]assphrase|[Aa]pi_?[Kk]ey|[Pp]rivate_[Kk]ey|[Cc]ookie|[Ll]ogin_[Cc]ode|[Oo]tp|[Cc]redential)s?$/;

const REASON = /^[a-z][a-z0-9_.-]{0,63}$/;

const SHA256 = /^[0-9a-f]{64}$/;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export const URI = /^[A-Za-z][A-Za-z0-9+.-]*:\S*$/;

const MAX_CELL_CHARS = 1048576;

const MAX_ROW_VALUES = 512;

const STALE_TEMP_MS = 60 * 60 * 1000;

const BACKUP_NAME = /^settings-[0-9]{8}T[0-9]{12}Z\.json$/;

function byCodePoint(a, b) {
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * The settings canonical form (DEC-0025, DEC-0043): keys sorted by code point at every level, `", "` and `": "`,
 * strings escaped as JSON requires and nothing else, integers in decimal — Python's
 * `json.dumps(value, sort_keys=True, ensure_ascii=False)`. Refuses a fraction, an unsafe integer and non-JSON.
 */
/** CT-25 (DEC-0052): a lone surrogate in a string or a key has no canonical form — Python cannot encode it as UTF-8. */
function settingsString(text) {
  if (/\p{Surrogate}/u.test(text)) throw new ServiceError('a lone surrogate has no canonical form');
  return JSON.stringify(text);
}

export function settingsCanonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new ServiceError(`${value} has no canonical form: a settings backup stores a fraction as its decimal string`);
    return String(value);
  }
  if (typeof value === 'string') return settingsString(value);
  if (Array.isArray(value)) return `[${value.map(settingsCanonicalJson).join(', ')}]`;
  if (isPlainObject(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort(byCodePoint).map((key) => `${settingsString(key)}: ${settingsCanonicalJson(value[key])}`).join(', ')}}`;
  }
  throw new ServiceError(`${typeof value} is not a JSON value`);
}

/** The `sha256` a settings backup carries: SHA-256 of the UTF-8 canonical JSON of `tables`. */
export const settingsBackupDigest = (tables) => crypto.createHash('sha256').update(settingsCanonicalJson(tables), 'utf8').digest('hex');

/** Why a reader refuses this settings backup: its shape and FAC-SEM-035. Empty means intact. */
export function settingsBackupProblems(doc) {
  if (!isPlainObject(doc)) return ['a settings backup is a JSON object'];
  const problems = [];
  if (doc.format !== SETTINGS_BACKUP_FORMAT) problems.push(`format must be ${SETTINGS_BACKUP_FORMAT}, not ${JSON.stringify(doc.format ?? null)}: a reader refuses a format it does not know`);
  for (const key of ['format', 'service', 'created_at', 'reason', 'sha256', 'counts', 'tables']) if (!(key in doc)) problems.push(`missing ${key}`);
  for (const key of Object.keys(doc)) if (!['format', 'service', 'created_at', 'reason', 'sha256', 'counts', 'tables', 'extensions'].includes(key)) problems.push(`${key} is not a settings backup field`);
  if ('extensions' in doc) {
    if (!isPlainObject(doc.extensions)) problems.push('extensions is an object');
    else for (const key of Object.keys(doc.extensions)) if (!URI.test(key)) problems.push(`extensions key ${JSON.stringify(key)} is not a URI`);
  }
  if ('service' in doc) {
    const s = doc.service;
    if (!isPlainObject(s) || Object.keys(s).sort().join() !== 'id,instance,schema,version') problems.push('service is {id, instance, version, schema}');
    else {
      if (!ID.test(String(s.id))) problems.push(`service.id must match ${ID.source}`);
      if (!INSTANCE.test(String(s.instance))) problems.push(`service.instance must match ${INSTANCE.source}`);
      if (!(typeof s.version === 'string' && s.version.length <= 64)) problems.push('service.version is a string of at most 64 characters');
      if (!((Number.isInteger(s.schema) && s.schema >= 0) || (typeof s.schema === 'string' && s.schema.length >= 1 && s.schema.length <= 64))) problems.push('service.schema is a whole number or a short string');
    }
  }
  if ('created_at' in doc && !isTimestamp(doc.created_at)) problems.push('created_at is a UTC timestamp');
  if ('reason' in doc && !(typeof doc.reason === 'string' && REASON.test(doc.reason))) problems.push(`reason must match ${REASON.source}`);
  if ('sha256' in doc && !(typeof doc.sha256 === 'string' && SHA256.test(doc.sha256))) problems.push('sha256 is 64 lowercase hex digits');
  const tables = isPlainObject(doc.tables) ? doc.tables : {};
  const counts = isPlainObject(doc.counts) ? doc.counts : {};
  if ('tables' in doc && !isPlainObject(doc.tables)) problems.push('tables is an object');
  if ('counts' in doc && !isPlainObject(doc.counts)) problems.push('counts is an object');
  let canonical = true;
  for (const name of [...Object.keys(tables), ...Object.keys(counts).filter((n) => !Object.hasOwn(tables, n))]) {
    if (LONE_SURROGATE.test(name)) canonical = false;
    if (!TABLE.test(name) || SECRET_TABLE.test(name)) problems.push(`table ${name} is never backed up: it can only hold connections, tokens, secrets, credentials, passwords, login codes or sessions (or its name is not a table name)`);
  }
  for (const [name, count] of Object.entries(counts)) if (!(Number.isInteger(count) && count >= 0)) problems.push(`counts.${name} is a whole number`);
  for (const [name, table] of Object.entries(tables)) {
    if (!isPlainObject(table) || Object.keys(table).sort().join() !== 'columns,rows') { problems.push(`tables.${name} is {columns, rows}`); continue; }
    let columns = table.columns;
    if (!(Array.isArray(columns) && columns.length >= 1 && columns.length <= 512 && new Set(columns.map(String)).size === columns.length)) {
      problems.push(`tables.${name}.columns is 1 to 512 distinct names`);
      if (!Array.isArray(columns)) columns = [];
    }
    for (const column of columns) {
      if (!(typeof column === 'string' && COLUMN.test(column)) || SECRET_COLUMN.test(String(column))) problems.push(`column ${name}.${column} is refused: its name says it holds a credential value (name the secret, never store it: secret_name, token_slot)`);
    }
    if (!Array.isArray(table.rows)) { problems.push(`tables.${name}.rows is a list`); continue; }
    table.rows.forEach((row, i) => {
      const at = `/tables/${name}/rows/${i}`;
      if (!Array.isArray(row)) { problems.push(`${at} is a list of values`); return; }
      if (row.length !== columns.length) problems.push(`FAC-SEM-035 ${at}: row has ${row.length} values for ${columns.length} columns`);
      if (row.length > MAX_ROW_VALUES) problems.push(`${at} holds more than ${MAX_ROW_VALUES} values`);
      row.forEach((cell, j) => {
        if (typeof cell === 'number' && !Number.isSafeInteger(cell)) {
          canonical = false;
          problems.push(`FAC-SEM-035 ${at}/${j}: a fraction or an unsafe integer has no canonical form; store it as a string`);
        } else if (typeof cell === 'string' && cell.length > MAX_CELL_CHARS) {
          problems.push(`${at}/${j} is longer than ${MAX_CELL_CHARS} characters`);
        } else if (typeof cell === 'string' && LONE_SURROGATE.test(cell)) {
          canonical = false;
          problems.push(`FAC-SEM-035 ${at}/${j}: a string with a lone surrogate cannot be encoded as UTF-8`);
        } else if (!(cell === null || ['boolean', 'number', 'string'].includes(typeof cell))) {
          canonical = false;
          problems.push(`${at}/${j} is not a JSON scalar`);
        }
      });
    });
    if (counts[name] !== table.rows.length) problems.push(`FAC-SEM-035 /counts/${name}: counts says ${counts[name] ?? 'nothing'} for ${table.rows.length} rows`);
  }
  for (const name of Object.keys(counts)) if (!Object.hasOwn(tables, name)) problems.push(`FAC-SEM-035 /counts/${name}: counts names ${name}, which the backup does not carry`);
  if (canonical && isPlainObject(doc.tables)) {
    let digest = null;
    try {
      digest = settingsBackupDigest(tables);
    } catch (error) {
      problems.push(`FAC-SEM-035 /tables: the tables have no canonical form (${error.message})`);
    }
    if (digest !== null && doc.sha256 !== digest) problems.push('FAC-SEM-035 /sha256: the checksum does not match the tables: the file is damaged and a reader refuses it');
  }
  return problems;
}

/** Where every service keeps its settings backups — outside its data directory (DEC-0025). */
export function settingsBackupRoot(platform = process.platform) {
  if (platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support/PassionCode');
  if (platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'PassionCode');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'PassionCode');
}

export function settingsBackupDir(id, instance = 'default', root = settingsBackupRoot()) {
  if (!ID.test(id)) throw new ServiceError(`Service id ${id} must match ${ID}.`);
  if (!INSTANCE.test(instance)) throw new ServiceError(`instance must match ${INSTANCE}`);
  return path.join(root, 'settings-backups', id, instance);
}

const microStamp = (ms) => `${new Date(ms).toISOString().slice(0, 23)}000Z`;

/** A snapshot of the operator's decisions and bindings (the tables on the service's allow-list). Refuses a file a reader would refuse. */
export function makeSettingsBackup({ id, instance = 'default', version, schema, tables, reason, now = Date.now() }) {
  const doc = {
    format: SETTINGS_BACKUP_FORMAT, service: { id, instance, version, schema }, created_at: microStamp(now), reason, sha256: '',
    counts: Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, (table?.rows ?? []).length])), tables,
  };
  try {
    doc.sha256 = settingsBackupDigest(tables);
  } catch (error) {
    throw new ServiceError(`This snapshot has no canonical form: ${error.message}`);
  }
  const problems = settingsBackupProblems(doc);
  if (problems.length) throw new ServiceError(`This snapshot would be refused: ${problems.join('; ')}`);
  return doc;
}

const backupName = (doc) => `settings-${doc.created_at.replace(/[-:]/g, '').replace(/\.(\d+)Z$/, (_, f) => `${(f + '000000').slice(0, 6)}Z`)}.json`;

/** The snapshot files, newest first. */
export function settingsBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => BACKUP_NAME.test(n)).sort().reverse().map((n) => path.join(dir, n));
}

/** The first number written with a fraction or an exponent outside a string (`1.0`, `1e2`); JSON.parse would read
 *  `1.0` as the integer 1, where the Python reader — and the canonical form — sees a fraction. */
function fractionLexeme(text) {
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      const lexeme = text.slice(i).match(/^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/)[0];
      if (/[.eE]/.test(lexeme)) return lexeme;
      i += lexeme.length - 1;
    }
  }
  return null;
}

/** A snapshot a reader may trust, or ServiceError naming why it is refused (FAC-SEM-035). */
export function readSettingsBackup(file) {
  let doc;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
    const fraction = fractionLexeme(text);
    if (fraction) throw new Error(`${fraction} is not an integer: a fraction is stored as its decimal string`);
    doc = JSON.parse(text);
  } catch (error) {
    throw new ServiceError(`Settings backup ${file} cannot be read: ${error.message}`);
  }
  const problems = settingsBackupProblems(doc);
  if (problems.length) throw new ServiceError(`Settings backup ${file} is refused: ${problems.join('; ')}`);
  return doc;
}

/**
 * Write a snapshot: atomically, 0600 in a 0700 directory, named by its time. A temporary file an interrupted write
 * left is removed first; a snapshot whose checksum equals the newest file's is not written again (null). After a
 * write, all but the `keep` newest are removed (at least 14).
 */
export function writeSettingsBackup(doc, dir, { keep = SETTINGS_BACKUP_KEEP } = {}) {
  const problems = settingsBackupProblems(doc);
  if (problems.length) throw new ServiceError(`This snapshot would be refused: ${problems.join('; ')}`);
  ensurePrivateDir(dir);
  // Only a temporary file an interrupted write left: one a concurrent writer is still filling is younger.
  for (const left of fs.readdirSync(dir)) {
    const at = path.join(dir, left);
    try {
      if (left.startsWith('.settings-') && fs.statSync(at).mtimeMs < Date.now() - STALE_TEMP_MS) fs.rmSync(at, { force: true });
    } catch { /* gone meanwhile */ }
  }
  const existing = settingsBackups(dir);
  if (existing.length) {
    try {
      if (readSettingsBackup(existing[0]).sha256 === doc.sha256) return null;
    } catch { /* a damaged newest file is no reason to skip a good snapshot */ }
  }
  const file = path.join(dir, backupName(doc));
  atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`, 0o600);
  // The newest by name, but never the one just written: a clock that stepped back must not delete it.
  for (const old of settingsBackups(dir).filter((f) => f !== file).slice(Math.max(keep, SETTINGS_BACKUP_KEEP) - 1)) fs.rmSync(old, { force: true });
  return file;
}

/** True when there is no snapshot or the newest is older than 24 hours. */
export function backupDue(dir, now = Date.now()) {
  const newest = settingsBackups(dir)[0];
  if (!newest) return true;
  const m = path.basename(newest).match(/^settings-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})\d{3}Z\.json$/);
  // A name no calendar has: take a fresh snapshot rather than trust it (Date.UTC would roll it over).
  if (!isTimestamp(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)) return true;
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
  return (now - at) / 1000 > SETTINGS_BACKUP_MAX_AGE_SECONDS;
}

/** The source of an automatic restore: the newest intact snapshot with content; damaged ones are returned with the reason. */
export function newestIntactBackup(dir) {
  const skipped = [];
  for (const file of settingsBackups(dir)) {
    let doc;
    try {
      doc = readSettingsBackup(file);
    } catch (error) {
      skipped.push({ file, reason: error.message });
      continue;
    }
    if (Object.values(doc.counts).some((n) => n > 0)) return { file, doc, skipped };
  }
  return { file: null, doc: null, skipped };
}

/**
 * What restoring `doc` would do — it adds and never overwrites (DEC-0025). `current[table]` is `{columns, key,
 * required, existing}` (existing primary keys as arrays). The twin of fabric_service.restore_plan. A manual restore
 * shows this plan first; applying it is the operator's decision, taken on the page or relayed by their agent with
 * `_meta.decision` (DEC-0121), never the agent's own act.
 */
export function restorePlan(doc, current) {
  const problems = settingsBackupProblems(doc);
  if (problems.length) throw new ServiceError(`A damaged snapshot is never restored: ${problems.join('; ')}`);
  const plan = { source: { created_at: doc.created_at, sha256: doc.sha256 }, tables: {}, unknownTables: [] };
  for (const [name, table] of Object.entries(doc.tables)) {
    const now = current[name];
    if (!now) { plan.unknownTables.push(name); continue; }
    const columns = now.columns ?? [], key = now.key ?? [], required = now.required ?? [];
    const existing = new Set((now.existing ?? []).map((k) => JSON.stringify([...k])));
    const shared = table.columns.filter((c) => columns.includes(c));
    const missing = required.filter((c) => !table.columns.includes(c));
    const entry = {
      insert: [], present: 0, droppedColumns: table.columns.filter((c) => !columns.includes(c)),
      defaultedColumns: columns.filter((c) => !table.columns.includes(c)), missingRequired: missing, refused: [],
    };
    const planned = new Set();
    for (const row of table.rows) {
      const values = Object.fromEntries(table.columns.map((c, i) => [c, row[i]]));
      const ident = key.map((c) => values[c] ?? null);
      if (key.some((c) => !table.columns.includes(c))) entry.refused.push({ key: ident, reason: 'the primary key is not in the snapshot' });
      else if (planned.has(JSON.stringify(ident))) entry.refused.push({ key: ident, reason: 'the snapshot holds this key twice' });
      else if (existing.has(JSON.stringify(ident))) entry.present += 1;
      else if (missing.length) entry.refused.push({ key: ident, reason: `required column ${missing.join(', ')} is not in the snapshot` });
      else {
        planned.add(JSON.stringify(ident));
        entry.insert.push(Object.fromEntries(shared.map((c) => [c, values[c]])));
      }
    }
    plan.tables[name] = entry;
  }
  return plan;
}
