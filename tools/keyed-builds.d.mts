export declare function guardKeyedBuilds(
  dirs: readonly string[],
  options?: { log?: (line: string) => void },
): {
  arm(): void
  disarm(): void
  watch(child: import('node:child_process').ChildProcess): void
  drop(): void
}
export declare function carriesKey(dir: string, key: string): string[]
export declare function keyedTargets(dist: string, targets: readonly string[]): string[]
/** A target and the half-written build directories beside it (B-226). */
export declare function withLeftovers(dir: string): string[]
