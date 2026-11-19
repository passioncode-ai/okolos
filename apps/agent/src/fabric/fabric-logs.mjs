// Logs and stopping (LC-01, LC-12): a rotating log, a capped stdout log, the stop signal and the drain.
// Part of the Node service kit (FAA-65, layer L3); the twin of fabric_logs.py. Node 20+, no dependency.
import fs from 'node:fs';
import path from 'node:path';
import { DRAIN_SECONDS, ServiceError, nowIso } from './fabric-base.mjs';
import { ensurePrivateDir } from './fabric-paths.mjs';

export const DRAIN_GRACE_SECONDS = 2;

export const EXIT_HARD_STOP = 70;

// LC-12: logs rotate by size, 5 x 5 MB by default.
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

export const LOG_BACKUPS = 5;

/**
 * One structured log: JSON lines rotated by size (5 x 5 MB by default), files 0600 in a 0700
 * directory. `service.jsonl` -> `.1` ... `.<backups>`; the oldest falls off. Never pass a token,
 * a cookie, a login code or a request body that may carry one.
 */
export class RotatingLog {
  constructor(file, { maxBytes = LOG_MAX_BYTES, backups = LOG_BACKUPS } = {}) {
    if (maxBytes < 256 || backups < 1) throw new ServiceError('A rotating log needs maxBytes >= 256 and at least one backup.');
    this.file = file;
    this.maxBytes = maxBytes;
    this.backups = backups;
  }

  line(record) {
    let data = Buffer.from(`${JSON.stringify(record)}\n`);
    if (data.length <= this.maxBytes) return data;
    const cut = { ...record, truncated: true };
    let message = String(record.message ?? '');
    while (message) {
      message = message.slice(0, Math.floor(message.length / 2));
      cut.message = message;
      data = Buffer.from(`${JSON.stringify(cut)}\n`);
      if (data.length <= this.maxBytes) return data;
    }
    return Buffer.from(`${JSON.stringify({ at: record.at, level: record.level, message: '', truncated: true })}\n`);
  }

  write(level, message, fields = {}) {
    const data = this.line({ at: nowIso(), level: String(level), message: String(message), ...fields });
    ensurePrivateDir(path.dirname(this.file));
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (size && size + data.length > this.maxBytes) this.rotate();
    const fd = fs.openSync(this.file, 'a', 0o600);
    try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
  }

  rotate() {
    for (let i = this.backups - 1; i > 0; i -= 1) {
      if (fs.existsSync(`${this.file}.${i}`)) fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
    }
    fs.renameSync(this.file, `${this.file}.1`);
  }
}

/**
 * Call once at start: a launchd stdout file over `maxBytes` is copied to `<file>.1` and truncated
 * in place (launchd holds it open for append, so a rename would leave it writing to the old name).
 */
export function capStdoutLog(file, maxBytes = LOG_MAX_BYTES) {
  let size;
  try { size = fs.statSync(file).size; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (size <= maxBytes) return false;
  fs.copyFileSync(file, `${file}.1`);
  fs.chmodSync(`${file}.1`, 0o600);
  fs.truncateSync(file, 0);
  return true;
}

export class Stopping extends ServiceError {}

/**
 * SIGTERM/SIGINT: stop taking new work, drain in-flight work until `deadline` seconds, then hand
 * over with `onStop(drained)`. A hand-over that never settles is cut by a hard exit
 * (EXIT_HARD_STOP) `grace` seconds later.
 *
 *   const drain = new Drain().install((drained) => server.close(() => process.exit(0)),
 *     { onStopping: () => log.append('service.stopping', 'info', 'Stopping.') });
 *   await drain.work(async () => { ... });   // rejects with Stopping once a stop has begun
 */
export class Drain {
  constructor({ deadline = DRAIN_SECONDS, grace = DRAIN_GRACE_SECONDS } = {}) {
    this.deadline = deadline;
    this.grace = grace;
    this.inflight = 0;
    this.stopping = false;
    this.waiters = new Set();
  }

  async work(fn) {
    if (this.stopping) throw new Stopping('The service is stopping and takes no new work.');
    this.inflight += 1;
    try {
      return await fn();
    } finally {
      this.inflight -= 1;
      if (this.inflight === 0) for (const wake of this.waiters) wake();
    }
  }

  /** Refuse new work from now on; false when a stop had already begun. */
  requestStop() {
    if (this.stopping) return false;
    this.stopping = true;
    return true;
  }

  /** Resolves true when in-flight work finished inside `timeoutSeconds`, false otherwise. */
  wait(timeoutSeconds) {
    if (this.inflight === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(true); };
      const timer = setTimeout(() => { this.waiters.delete(wake); resolve(false); }, timeoutSeconds * 1000);
      this.waiters.add(wake);
    });
  }

  install(onStop, { onStopping, signals = ['SIGTERM', 'SIGINT'] } = {}) {
    const handler = () => {
      if (!this.requestStop()) return; // a second signal changes nothing: the hard exit holds the deadline
      setTimeout(() => process.exit(EXIT_HARD_STOP), (this.deadline + this.grace) * 1000).unref();
      (async () => {
        try { await onStopping?.(); } catch (error) { process.stderr.write(`${error?.stack ?? error}\n`); }
        await onStop(await this.wait(this.deadline));
      })();
    };
    for (const signal of signals) process.on(signal, handler);
    return this;
  }
}
