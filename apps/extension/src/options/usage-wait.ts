/**
 * The worker's answer, waited for at most `ms` (B-214).
 *
 * `usage/state` waits behind a send that is under way (one at a time in the worker, up to about
 * 28 s on a network that hangs), and the settings page draws its sections one after another, so
 * «Ваши данные» and every repaint after it used to wait too. Past `ms` the section is drawn
 * without the usage block, and `later` runs once the answer arrives, to draw it then.
 *
 * Rejects as the answer rejects, so a worker that refuses still reads as a refusal.
 */
export async function answeredWithin<T>(
  answer: Promise<T>,
  ms: number,
  later: () => void,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void } = {
    set: (fn, wait) => setTimeout(fn, wait),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): Promise<T | 'late'> {
  let handle: unknown
  const late = new Promise<'late'>((resolve) => {
    handle = timers.set(() => resolve('late'), ms)
  })
  try {
    const first = await Promise.race([answer, late])
    if (first === 'late') answer.then(later, () => undefined)
    return first
  } finally {
    timers.clear(handle)
  }
}
