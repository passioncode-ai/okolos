export declare function guardKeyedBuilds(
  dirs: readonly string[],
  options?: { log?: (line: string) => void },
): { arm(): void; disarm(): void; drop(): void }
