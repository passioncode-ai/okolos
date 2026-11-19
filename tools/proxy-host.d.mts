/** Types for `proxy-host.mjs`; the gates are TypeScript and a `.mjs` without one is `any`. */

/** The host of `PROXY_ORIGIN` in the text of `config.ts`; throws when it is not declared. */
export function proxyHostIn(source: string): string
/** The host of `PROXY_ORIGIN`, read from `apps/extension/src/config.ts` (or `file`). */
export function proxyHost(file?: string): string
