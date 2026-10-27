// The contract's one credential detector (Fabric Agent Contract DEC-0044, `src/secret-shape.ts` at the pin): a name
// that can only carry a credential, a value shaped like one, a launch argument that carries one, and a URL that does
// (LC-21). A port held to the contract's own answers by test/fixtures/contract/profile-vectors.json. No dependencies.

/** A name's words: split at `.`, `_`, `-` and camelCase humps, lowercased (`APIKey` is `api key`). */
export function nameWords(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

export const CREDENTIAL_WORDS = Object.freeze([
  'token', 'secret', 'password', 'passwd', 'pass', 'passphrase', 'credential', 'credentials', 'cookie', 'authorization',
  'bearer', 'jwt', 'otp', 'apikey', 'signature', 'sig',
  'accesstoken', 'idtoken', 'authtoken', 'refreshtoken', 'sessionid', 'sessiontoken', 'logincode', 'authcode', 'privatekey',
  'clientsecret', 'secretkey', 'accesskey',
]);
export const CREDENTIAL_PAIRS = Object.freeze({
  key: ['private', 'api', 'access', 'secret', 'session', 'auth', 'signing', 'encryption', 'master', 'client', 'login', 'refresh'],
  auth: ['token', 'code', 'header'],
  session: ['token', 'id'],
  code: ['login', 'auth', 'access', 'session'],
});

const withSingulars = (words) => [...words, ...words.filter((word) => word.length > 2 && word.endsWith('s')).map((word) => word.slice(0, -1))];

/** Whether a name — a parameter, a header, an environment variable, a config key — can only carry a credential. */
export function credentialName(name) {
  const split = nameWords(name);
  const words = withSingulars(split);
  if (words.some((word) => CREDENTIAL_WORDS.includes(word))) return true;
  if (split.length === 1 && words.some((word) => Object.hasOwn(CREDENTIAL_PAIRS, word))) return true;
  return Object.entries(CREDENTIAL_PAIRS).some(([word, partners]) => words.includes(word) && partners.some((partner) => words.includes(partner)));
}

/** A JWT or JWS anywhere in a value. */
export const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/;
/** A value that says it is a credential, or a provider key's shape. */
export const SECRET_VALUE = /(^bearer\s.+|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20,})/i;
const LONG_RUN = /[A-Za-z0-9+/=_-]{40,}/g;
export const longSecret = (value) => (value.match(LONG_RUN) ?? []).some((run) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run));

/** Whether a value could be a credential: a JWT anywhere, a provider key or `Bearer …`, or a long secret-shaped run. */
export const secretValue = (value) => JWT_SHAPE.test(value) || SECRET_VALUE.test(value) || longSecret(value);

export const BEARER_INSIDE = /\bbearer\s+(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{12,}=*/i;
const PATH_LIKE = /^(?:[/~.]|[A-Za-z]:[\\/]|[a-z][a-z0-9+.-]*:\/\/)/i;
const pathLike = (piece) =>
  PATH_LIKE.test(piece) ||
  (/[\\/]/.test(piece) && (/\.[A-Za-z0-9]{1,8}$/.test(piece) || piece.split(/[\\/]/).some((segment) => /^[a-z][a-z0-9_-]{2,}$/.test(segment))));

/** The same for a launch argument or a server's command and URL: a long run is looked for between path separators. */
export const secretArgument = (value) =>
  JWT_SHAPE.test(value) || SECRET_VALUE.test(value) || BEARER_INSIDE.test(value) ||
  value.split(/[\s=]/).some((piece) => (pathLike(piece) ? piece.split(/[\\/]/).some((part) => longSecret(part)) : longSecret(piece)));

const decodeKeepingPlus = (raw) => { try { return decodeURIComponent(raw); } catch { return raw; } };

/** Each query or fragment piece's raw value by its decoded name, with `+` kept. */
export function rawValues(query) {
  const values = new Map();
  for (const piece of query.split('&')) {
    if (piece === '') continue;
    const at = piece.indexOf('=');
    const name = [...new URLSearchParams(at < 0 ? piece : piece.slice(0, at)).keys()][0] ?? '';
    values.set(name, [...(values.get(name) ?? []), at < 0 ? '' : decodeKeepingPlus(piece.slice(at + 1))]);
  }
  return values;
}

/** Whether a URL an MCP entry or a launch names carries a credential (LC-21). */
export function secretUrl(value) {
  if (secretArgument(value)) return true;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.password !== '') return true;
  for (const part of [url.search, url.hash]) {
    for (const [name, values] of rawValues(part.slice(1))) {
      if (values.some((raw) => (raw !== '' && credentialName(name)) || secretValue(raw))) return true;
    }
  }
  return false;
}
