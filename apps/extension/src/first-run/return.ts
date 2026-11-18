/**
 * Paint the first-run tab again when it is shown again. Its usage notice opens the settings in a
 * new tab and this one stays behind it; a person who switches usage and error data off there and
 * comes back would otherwise read that Okolos sends it (B-215, round 21; SCN-050).
 */
export function repaintOnReturn(doc: Pick<Document, 'addEventListener' | 'visibilityState'>, paint: () => void): void {
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') paint()
  })
}
