/**
 * The bootstrap's view of tools/is-main.mjs, the one main-module check.
 *
 * The bootstrap is copied out of the checkout into a flat folder
 * (~/.okolos/bin/feed-agent) and may import only its siblings there. In the repo
 * this file re-exports the real helper; the installer copies tools/is-main.mjs
 * itself under this name (BOOTSTRAP_SOURCES in bootstrap.mjs), so the installed
 * folder holds the implementation and no path outside it.
 */
export { isMain } from '../is-main.mjs'
