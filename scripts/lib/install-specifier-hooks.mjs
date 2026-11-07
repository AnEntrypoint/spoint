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
