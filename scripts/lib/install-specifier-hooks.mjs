// Portable install of the root-absolute specifier remap for node witnesses.
//
// Client-side modules in this tree import their server-side siblings by root-absolute
// specifier ('/src/terrain/VegPlacement.js', '/node_modules/...'), which the ESM resolver
// has no notion of: it reads '/src/...' as a path from the drive root.
//
// package.json declares engines.node ">=18", so a gated witness may not depend on
// registerHooks (>=22.15). CI runs node 20.20.2, where `import { registerHooks } from
// 'node:module'` throws at link time -- the witness exits 1 having printed nothing, which
// the gate cannot tell apart from a witness that never asserted.
//
// So: registerHooks where the running node has it, module.register (>=20.6) otherwise, and
// a named refusal below that rather than silence.
const ROOT = new URL('../../', import.meta.url)
const REMAP = ['/src/', '/node_modules/']

export function remapPrefixes() {
  return REMAP
}

export function resolve(specifier, context, nextResolve) {
  for (const prefix of REMAP) {
    if (specifier.startsWith(prefix)) {
      return nextResolve(new URL(specifier.slice(1), ROOT).href, context)
    }
  }
  return nextResolve(specifier, context)
}

export async function installSpecifierHooks() {
  const mod = await import('node:module')
  if (typeof mod.registerHooks === 'function') {
    mod.registerHooks({ resolve })
    return 'registerHooks'
  }
  if (typeof mod.register === 'function') {
    mod.register('./specifier-resolve-loader.mjs', import.meta.url)
    return 'module.register'
  }
  throw new Error(
    '[specifier-hooks] this node exposes neither registerHooks (>=22.15) nor register (>=20.6), ' +
      'so root-absolute specifiers cannot be resolved; refusing rather than failing as silence'
  )
}
