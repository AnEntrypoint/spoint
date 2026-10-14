// module.register spelling of the root-absolute specifier remap scripts/hmr-reload-block-witness.mjs
// needs: a client module is served at '/core/Foo.js' and lives at client/core/Foo.js, while
// '/src/...' and '/node_modules/...' live at the repo root. Runs in the loader thread, so it
// derives both roots from its own location and reads no witness state. Used where the running
// node has no in-process registerHooks (>=22.15): CI runs node 20.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_DIR = fileURLToPath(new URL('../../', import.meta.url))
const CLIENT_DIR = join(REPO_DIR, 'client')

export function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('/') || specifier.startsWith('//')) return nextResolve(specifier, context)
  const [path, query = ''] = specifier.split('?')
  let file = null
  if (existsSync(join(CLIENT_DIR, path))) file = join(CLIENT_DIR, path)
  else if (existsSync(join(REPO_DIR, path))) file = join(REPO_DIR, path)
  if (file === null) return nextResolve(specifier, context)
  return nextResolve(pathToFileURL(file).href + (query ? '?' + query : ''), context)
}
