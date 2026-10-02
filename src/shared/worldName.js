const WORLD_FILE_STEM = /^[A-Za-z0-9_-]{1,128}$/

export const WORLD_DIR = 'apps/world'
export const WORLD_INDEX = 'index'
export const WORLD_FIXTURES_DIR = 'apps/world/_fixtures'

export function isWorldName(v) {
  return typeof v === 'string' && WORLD_FILE_STEM.test(v)
}

export function worldFileRel(name) {
  if (!isWorldName(name)) throw new TypeError(`world name must be a world file stem, got ${JSON.stringify(name)}`)
  return `${WORLD_DIR}/${name}.js`
}

export function worldFileCandidates(name) {
  const rel = worldFileRel(name)
  return [rel, `${WORLD_FIXTURES_DIR}/${name}.js`]
}

export function defaultWorldNameOf(indexModule) {
  const named = indexModule?.defaultWorld
  if (named === undefined) return WORLD_INDEX
  if (!isWorldName(named)) throw new TypeError(`${WORLD_DIR}/${WORLD_INDEX}.js defaultWorld must be a world file stem, got ${JSON.stringify(named)}`)
  return named
}
