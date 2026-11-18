/**
 * The SDKs' numeric form, `unix_seconds × 10^8 + 8 digits`, here per clock hour, so the start
 * is never older than the contract's seven days. The 8 digits come from `sessionFor`.
 */
export function sessionIdAt(nowMs: number, suffix: number): string {
  const hourStart = Math.floor(nowMs / 3_600_000) * 3_600
  return (BigInt(hourStart) * 100_000_000n + BigInt(suffix % 100_000_000)).toString()
}

/**
 * The session of one install in one clock hour, the same in every wake of that hour: the
 * worker (Chrome) and the event page (Firefox) start again after ~30 s idle, so a suffix drawn
 * at start would make one session per wake. Derived from the install id and the hour (FNV-1a),
 * so nothing is stored and the switch-off that deletes the id ends its sessions too.
 */
export function sessionFor(nowMs: number, iid: string): string {
  const hourStart = Math.floor(nowMs / 3_600_000) * 3_600
  let hash = 0x811c9dc5
  for (const char of `${iid}:${hourStart}`) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return sessionIdAt(nowMs, hash % 100_000_000)
}
