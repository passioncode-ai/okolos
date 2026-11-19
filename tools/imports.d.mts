/**
 * Types for the import-graph walker, which is plain ESM so both gates can share
 * one definition of how a specifier resolves here. A test that treats these as
 * `any` is a test that cannot catch a rename — the same reason
 * `wireframes.d.mts` exists.
 */

export declare const root: string

export declare function resolve(spec: string, from: string): string | null
export declare function specifiers(file: string): string[]
export declare function reachableFrom(entries: readonly string[]): Set<string>

export declare function tsEntriesFromBuild(): string[]
export declare function pageEntriesFromBuild(): string[]
export declare function workerEntryFromWrangler(): string[]
export declare function binEntriesFromPackages(): string[]
/** The entries Okolos Agent's build bundles (build-agent.mjs, build-agent-probe.mjs). */
export declare function agentEntriesFromBuild(): string[]
export declare function entryPoints(): string[]
