const WORLD_FILE_STEM = /^[A-Za-z0-9_-]{1,128}$/

export let WORLD_DIR = 'apps/world'
export let WORLD_INDEX = 'index'
export let WORLD_FIXTURES_DIR = 'apps/world/_fixtures'

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

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapWorldName = (next) => {
  isWorldName = next.isWorldName
  worldFileRel = next.worldFileRel
  worldFileCandidates = next.worldFileCandidates
  defaultWorldNameOf = next.defaultWorldNameOf
  WORLD_DIR = next.WORLD_DIR
  WORLD_INDEX = next.WORLD_INDEX
  WORLD_FIXTURES_DIR = next.WORLD_FIXTURES_DIR
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapWorldName)
