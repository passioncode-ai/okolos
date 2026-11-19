/**
 * Test fixture: lets a plain `node` child run the service's TypeScript sources.
 *
 * Node strips types itself, but the sources import each other as `./x.js` (the repository's
 * convention, which tsc keeps), and no `.js` file exists beside a `.ts` one. This hook resolves a
 * relative `.js` specifier that has no file to the `.ts` beside it, and nothing else. It lets the
 * tests start a second copy of the service as a real process and stop one with a real SIGTERM.
 *
 *   node --import ./ts-hooks.mjs ./run-service.mjs <home>
 */
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, URL } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
      const target = new URL(specifier, context.parentURL)
      if (!existsSync(fileURLToPath(target))) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
    }
    return nextResolve(specifier, context)
  },
})
