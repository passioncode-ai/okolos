// A service's events (DEC-0029): making them, paging them and the JSONL event log.
// Part of the Node service kit (FAA-65, layer L3); the twin of fabric_events.py. Node 20+, no dependency.
import { ServiceError } from './fabric-base.mjs';
import { feedDataProblems } from './fabric-protocols.mjs';

export const LEVELS = ['info', 'notice', 'warning', 'error'];

export const EVENTS_DEFAULT_LIMIT = 50;

export const EVENTS_MAX_LIMIT = 200;

const KIND = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,5}$/;

const TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/;

const SPAN_ID = /^(?!0{16}$)[0-9a-f]{16}$/;

/** One activity event. `data` (DEC-0070) adds machine-readable fields, `{schema, value}`, never a secret: refused here, so no feed carries one. */
export function makeEvent(id, at, kind, level, text, { subject, link, notify, traceId, spanId, data } = {}) {
  if (!LEVELS.includes(level)) throw new ServiceError(`level must be one of ${LEVELS.join(', ')}.`);
  if (!KIND.test(kind)) throw new ServiceError(`kind ${kind} must be dotted lowercase.`);
  const sentence = String(text).split(/\s+/).filter(Boolean).join(' ');
  if (!sentence) throw new ServiceError('An event needs a sentence.');
  if (link !== undefined && (!link.startsWith('/') || link.startsWith('//'))) throw new ServiceError('link must be a path on this service.');
  if ((traceId === undefined) !== (spanId === undefined)) throw new ServiceError('An event carries traceId and spanId together, or neither.');
  if (traceId !== undefined && !(TRACE_ID.test(traceId) && SPAN_ID.test(spanId))) throw new ServiceError('traceId is 32 and spanId 16 lowercase hex characters, not all zeros.');
  const event = { id: String(id), at, kind, level, text: sentence.slice(0, 500) };
  if (subject) event.subject = subject;
  if (link) event.link = link;
  if (notify) event.notify = true;
  if (traceId !== undefined) Object.assign(event, { traceId, spanId });
  if (data !== undefined) {
    const problems = feedDataProblems(data);
    if (problems.length) throw new ServiceError(`Event data: ${problems.join('; ')}.`);
    event.data = { schema: data.schema, value: data.value };
  }
  return event;
}

export function parseLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return EVENTS_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new ServiceError('limit must be an integer.');
  return Math.max(1, Math.min(EVENTS_MAX_LIMIT, n));
}

// fetch(after, limit) returns events with ids greater than `after`, ascending
// (or the newest `limit`, ascending, when after is null) — a view over the log you already keep.
export async function eventsPage(fetch, after, limit) {
  const events = (await fetch(after ?? null, limit)).slice(0, limit);
  return { events, cursor: events.length ? events.at(-1).id : (after ?? null) };
}
