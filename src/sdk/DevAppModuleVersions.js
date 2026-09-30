import { register } from 'node:module'
import { resolve, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BEHAVIOURS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'behaviours')

const HOOKS_SOURCE = `
import { statSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
let roots = [], behavioursDir = ''
export async function initialize(data) { roots = data.roots; behavioursDir = data.behavioursDir }
function behavioursStamp() {
  let max = 0
  try { for (const f of readdirSync(behavioursDir)) max = Math.max(max, statSync(join(behavioursDir, f)).mtimeMs) } catch {}
  return max
}
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context)
  if (!r.url.startsWith('file:')) return r
  const u = new URL(r.url)
  const p = fileURLToPath(u)
  if (!roots.some(root => p.startsWith(root))) return r
  try { u.searchParams.set('mtime', statSync(p).mtimeMs + '-' + behavioursStamp()) } catch { return r }
  return { ...r, url: u.href }
}
`

let registered = false

export function registerAppModuleVersioning(appsDirs) {
  if (registered || !appsDirs?.length) return false
  registered = true
  const roots = [...appsDirs, BEHAVIOURS_DIR].map(d => resolve(d) + sep)
  register('data:text/javascript,' + encodeURIComponent(HOOKS_SOURCE), { data: { roots, behavioursDir: BEHAVIOURS_DIR } })
  return true
}
