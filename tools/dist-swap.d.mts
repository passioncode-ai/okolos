/** Types for the build's directory swap, plain ESM so `build.mjs` imports it as is. */
export declare function buildingDir(finalDir: string, pid?: number): string
export declare function swapInto(finalDir: string, builtDir: string, pid?: number): Promise<void>
export declare function sweepLeftovers(distDir: string): Promise<string[]>
