// JavaScript's view of JSON values, once for the whole Node kit (FAA-65, layer L0); the twin of fabric_jsvalue.py.
// The contract's answers are computed by TypeScript; every reader in the kit takes these helpers from here:
// isObject, isString, objects (an array's object items), indexed (with their index as written), show (the
// contract's `show`), toNumber (the contract's `toNumber`), keyOf, jsonEqual (the contract's `jsonEqual`) and jcs
// (RFC 8785). Node 20+, no dependency; nothing here imports another kit module.

/** A plain JSON object (not null, not an array). */
export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isString = (value) => typeof value === 'string';
/** The object items of an array; [] for anything else. */
export const objects = (value) => (Array.isArray(value) ? value.filter(isObject) : []);
/** The object items of an array with their index as written, so an instancePath names the item even after a non-object. */
export const indexed = (value) => (Array.isArray(value) ? value.flatMap((item, index) => (isObject(item) ? [[item, index]] : [])) : []);

/** The contract's `show`: String(value), or its JSON where String() throws (an object whose own `toString` is data). */
export function show(value) {
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    return JSON.stringify(value) ?? typeof value;
  }
}

/** The contract's `toNumber`: Number(value), or NaN where Number() throws. */
export function toNumber(value) {
  try {
    return Number(value);
  } catch {
    return Number.NaN;
  }
}

/** A collision-free key over JSON values. */
export const keyOf = (...parts) => JSON.stringify(parts);

/** The contract's jsonEqual: arrays in order, objects by their members whatever the order, anything else by ===. */
export function jsonEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return a === b;
}

/** RFC 8785: members sorted by UTF-16 code units, numbers in ECMAScript form; refuses what has no canonical form. */
export function jcs(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('a non-finite number has no canonical form');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    if (/\p{Surrogate}/u.test(value)) throw new TypeError('a lone surrogate has no canonical form');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${Array.from(value, (item) => jcs(item)).join(',')}]`;
  if (isObject(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('only plain JSON objects have a canonical form');
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${jcs(key)}:${jcs(value[key])}`).join(',')}}`;
  }
  throw new TypeError(`${typeof value} has no canonical form`);
}
