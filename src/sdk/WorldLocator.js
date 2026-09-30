import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WORLD_INDEX, worldFileRel, defaultWorldNameOf, isWorldName } from '../shared/worldName.js'
import { expandWorldPresets } from '../shared/worldPresets.js'

export function worldRoots(project, sdkRoot) {
  return [...new Set([project, sdkRoot].filter(Boolean).map(r => resolve(r)))]
}

export function findWorldFile(name, roots) {
  for (const root of roots) {
    const fp = resolve(root, worldFileRel(name))
    if (existsSync(fp)) return fp
  }
  return null
}

export async function readDefaultWorldName(roots) {
  const index = findWorldFile(WORLD_INDEX, roots)
  if (!index) return null
  return defaultWorldNameOf(await import(pathToFileURL(index).href))
}

export async function locateWorld({ project, sdkRoot, name = null }) {
  const roots = worldRoots(project, sdkRoot)
  const requested = name === '' ? null : name
  if (requested != null && !isWorldName(requested)) throw new TypeError(`[world] WORLD must be a world file stem, got ${JSON.stringify(requested)}`)
  const worldName = requested ?? await readDefaultWorldName(roots)
  if (worldName == null) return { name: null, path: null }
  const path = findWorldFile(worldName, roots)
  if (!path) throw new Error(`[world] world "${worldName}" not found: no ${worldFileRel(worldName)} under ${roots.join(' or ')}`)
  return { name: worldName, path }
}

export async function loadWorldModule(path) {
  if (!path) return {}
  return expandWorldPresets((await import(pathToFileURL(path).href + `?t=${Date.now()}`)).default || {})
}
