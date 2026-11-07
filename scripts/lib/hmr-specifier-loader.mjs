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
