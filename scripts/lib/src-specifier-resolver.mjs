// Root-absolute specifier resolver for node witnesses that import client/ modules.
//
// Client-side modules in this tree import their server-side siblings by
// root-absolute specifier ('/src/terrain/VegPlacement.js'), which the ESM resolver has
// no notion of: it reads '/src/...' as a filesystem path from the drive root. A node
// witness that imports such a module has to resolve it against the repo root itself.
//
// This is the module.register spelling (node >= 20.6), used where the running node has
// no in-process registerHooks (>= 22.15). CI runs node 20, so a gated witness needs it.
const ROOT = new URL('../../', import.meta.url)

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('/src/')) {
    return { url: new URL(specifier.slice(1), ROOT).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
