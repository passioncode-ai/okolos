/**
 * Types for the access tool, which is plain ESM so it can run as a script
 * without a build step. The test imports it, and a test that treats its exports
 * as `any` cannot catch a rename — the same reason `wireframes.d.mts` exists.
 */

export interface Access {
  readonly name: string
  readonly file: string
  readonly required: boolean
  readonly unblocks: string
  readonly readBy: string
  readonly howToGet?: string
}

export interface Probe {
  readonly ok: boolean
  readonly why: string
}

export type AccessState = 'ok' | 'missing' | 'broken' | 'unverified'

export declare const STORE: string
export declare const ACCESSES: readonly Access[]
export declare const FEED_KEY_ACCESS: Access

export declare function parseEnv(text: string): Record<string, string>
export declare function normaliseValue(raw: string): string
/** Whether POSIX mode bits mean anything on the platform (not on win32). */
export declare function modesApply(platform?: string): boolean
/** The mode problem of a secrets file, or null; null too where modes do not apply. */
export declare function permissionProblem(file: string, platform?: string): string | null
export declare function compiledPublicKey(): string | null
export declare function feedKeyMatches(pem: string, expectedBase64: string | null): Probe
export declare function verdictOf(input: {
  present: boolean
  required: boolean
  probe?: Probe | null
}): { state: AccessState; why: string }
