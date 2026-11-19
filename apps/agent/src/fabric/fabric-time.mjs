// Dates and times the way the contract reads them, once for the whole Node kit (FAA-65, layer L0); the twin of
// fabric_time.py. NaN, never an exception, answers what cannot be read: callers compare it and get a finding.
// Node 20+, no dependency; nothing here imports another kit module.

export const DAY_MS = 86_400_000;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** An RFC 3339 date-time as milliseconds, or NaN: `T`, an offset and a day that exists; a space and `:60` refused (ER-10). */
export function parseRfc3339Ms(value) {
  const match = typeof value === 'string' ? RFC3339.exec(value) : null;
  if (!match) return Number.NaN;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return Number.NaN;
  return Date.parse(value);
}

/** A verifier's clock as milliseconds: a Date, or epoch seconds; NaN for anything else. */
export const clockMs = (at) => (at instanceof Date ? at.getTime() : (typeof at === 'number' && Number.isFinite(at) ? at * 1000 : Number.NaN));

/** A `YYYY-MM-DD` date that exists as midnight UTC in milliseconds; NaN for anything else (the contract's `utcDate`). */
export function utcDateMs(value) {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) return Number.NaN;
  const [y, mo, d] = m.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d);
  const date = new Date(ms);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? ms : Number.NaN;
}

/** The UTC calendar day (`YYYY-MM-DD`) of an instant in milliseconds. Throws a RangeError for NaN or Infinity. */
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** An instant as RFC 3339 in UTC with milliseconds, which parseRfc3339Ms reads back to the same value. */
export const formatRfc3339 = (ms) => new Date(ms).toISOString();

/** The last `days` UTC days ending with the day of `todayMs`, oldest first. */
export function dayWindow(todayMs, days) {
  if (!(days >= 1)) return [];
  const start = Math.floor(todayMs / DAY_MS) * DAY_MS - (days - 1) * DAY_MS;
  return Array.from({ length: days }, (_, i) => utcDay(start + i * DAY_MS));
}

/** Milliseconds since the epoch: from `clock` (milliseconds, as Date.now) when given, so a test fixes the time. */
export const nowMs = (clock = Date.now) => Number(clock());
