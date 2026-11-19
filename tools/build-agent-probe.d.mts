/** Types for `build-agent-probe.mjs` (see `feed/bounded.d.mts` for why these are hand-written). */
/** The entry the probe is bundled from. */
export const PROBE_ENTRY: string
/** The probe's script, as text: one IIFE that defines `globalThis.__okolosAgentProbe`. */
export function buildAgentProbe(): Promise<string>
