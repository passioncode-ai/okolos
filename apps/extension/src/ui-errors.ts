/**
 * An error nothing on an extension page caught: `error_occurred{ui, unexpected}` (B-206).
 *
 * The page sends no event itself (ADR-0021): it tells the worker, which counts the pair once a
 * UTC day. Told once per page load, because a page that throws in a loop would otherwise send a
 * message per throw. A resource that failed to load does not reach `window`, so only code faults
 * and unhandled rejections are told.
 */
export function countUncaughtErrors(target: Pick<EventTarget, 'addEventListener'>, tell: () => Promise<unknown>): void {
  let told = false
  const once = (): void => {
    if (told) return
    told = true
    // Telling is the least important thing at that moment and must not become another failure.
    void tell().catch(() => undefined)
  }
  target.addEventListener('error', once)
  target.addEventListener('unhandledrejection', once)
}
