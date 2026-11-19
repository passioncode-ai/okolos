/**
 * The probe as Okolos Agent evaluates it in a page (Okolos Bridge, N-011).
 *
 * `tools/build-agent-probe.mjs` bundles this file into one script. The daemon
 * evaluates it in an isolated world of the agent's page, so the page's own
 * scripts can neither see nor replace it, and then calls
 * `globalThis.__okolosAgentProbe(now)`. The answer stays a live object: the
 * daemon reads the elements of `cut` and `cutVisible` as CDP object handles and
 * maps them to backend node ids; only the counts and the reduced verdicts are
 * copied by value.
 */
import { runProbe, type ProbeResult } from './agent-probe.js'

declare global {
  var __okolosAgentProbe: ((now: string) => ProbeResult) | undefined
}

globalThis.__okolosAgentProbe = (now: string): ProbeResult => {
  const started = performance.now()
  return runProbe(document, { url: location.href, now, elapsed: () => performance.now() - started })
}
