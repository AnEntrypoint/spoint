import { register } from 'node:module'
import { resolve, sep } from 'node:path'

const HOOKS_SOURCE = `
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
let roots = []
export async function initialize(data) { roots = data.roots }
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context)
  if (!r.url.startsWith('file:')) return r
  const u = new URL(r.url)
  const p = fileURLToPath(u)
  if (!roots.some(root => p.startsWith(root))) return r
  try { u.searchParams.set('mtime', String(statSync(p).mtimeMs)) } catch { return r }
  return { ...r, url: u.href }
}
`

let registered = false

export function registerAppModuleVersioning(appsDirs) {
  if (registered || !appsDirs?.length) return false
  registered = true
  const roots = appsDirs.map(d => resolve(d) + sep)
  register('data:text/javascript,' + encodeURIComponent(HOOKS_SOURCE), { data: { roots } })
  return true
}
