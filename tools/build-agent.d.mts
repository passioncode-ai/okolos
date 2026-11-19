/** Types for `build-agent.mjs` (see `feed/bounded.d.mts` for why these are hand-written). */
export const AGENT_ENTRY: string
export const AGENT_OUT: string
/** Builds the daemon bundle and the probe into `outDir`; answers it. */
export function buildAgent(outDir?: string): Promise<string>
