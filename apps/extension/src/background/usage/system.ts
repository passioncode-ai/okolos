/**
 * The SDKs' numeric form, `unix_seconds × 10^8 + 8 random digits`, here per clock hour: a
 * worker that wakes and sleeps all day keeps one session an hour instead of one per wake,
 * and the start is never older than the contract's seven days.
 */
export function sessionIdAt(nowMs: number, suffix: number): string {
  const hourStart = Math.floor(nowMs / 3_600_000) * 3_600
  return (BigInt(hourStart) * 100_000_000n + BigInt(suffix % 100_000_000)).toString()
}
