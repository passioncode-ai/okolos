export declare function guardKeyedBuilds(
  dirs: readonly string[],
  options?: { log?: (line: string) => void },
): {
  arm(): void
  disarm(): void
  watch(child: import('node:child_process').ChildProcess): void
  drop(): void
}
