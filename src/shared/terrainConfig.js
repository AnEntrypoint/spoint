import { anchorBasis, tangentLocalToDir } from '../terrain/PlanetFrame.js'
import { isWorldName, WORLD_DIR } from './worldName.js'
import { canonicalJSON } from './canonicalJSON.js'
import { FNV1A_32_OFFSET_BASIS, fnv1aStepString } from './fnv1a.js'

const MINIMAP_EXTENT_RADIUS_FRACTION = 0.25
const MINIMAP_MAX_EXTENT_M = 16384
const DEFAULT_MINIMAP_RES = 256
export let DEFAULT_TERRAIN_HASH_VERSION = 2
export let LEGACY_TERRAIN_HASH_VERSION = 1
export let TERRAIN_HASH_VERSIONS = Object.freeze([1, 2])

const PARSED_TERRAIN_CONFIG = Symbol('parsedTerrainConfig')

export function isParsedTerrainConfig(v) {
  return !!v && v[PARSED_TERRAIN_CONFIG] === true
}

export function assertTerrainHashVersion(v) {
  if (!TERRAIN_HASH_VERSIONS.includes(v)) throw new RangeError(`terrain hashVersion must be one of ${TERRAIN_HASH_VERSIONS.join(', ')}, got ${JSON.stringify(v)}`)
  return v
}

function parsedTerrainOf(tcfg) {
  if (isParsedTerrainConfig(tcfg)) return tcfg
  const p = parseTerrainConfig(tcfg)
  if (!p.ok) throw new TypeError(`terrain ${p.path ? `${p.path}: ` : ''}${p.reason}`)
  return p.config
}

export function resolveTerrainConfig(worldDef) {
  const entity = (worldDef?.entities || []).find(e => e && e.app === 'terrain')
  return (entity && entity.config) || worldDef?.terrain || null
}

export function terrainHashVersionOf(tcfg) {
  if (isParsedTerrainConfig(tcfg)) return tcfg.hashVersion
  return assertTerrainHashVersion(tcfg?.hashVersion ?? DEFAULT_TERRAIN_HASH_VERSION)
}

// A carve already in parsed form ({dir, innerM, outerM}) arrives here after a world def crosses
// the wire, where the parse marker is lost. Accept it only when its shape is valid, so a
// re-parse is an identity rather than a refusal.
function isParsedCarve(c) {
  return !!c && Array.isArray(c.dir) && c.dir.length === 3 && c.dir.every(Number.isFinite)
    && Number.isFinite(c.innerM) && c.innerM >= 0 && Number.isFinite(c.outerM) && c.outerM > c.innerM
}

export function terrainCarvesOf(tcfg) {
  if (isParsedTerrainConfig(tcfg)) return tcfg.carves
  const carves = tcfg?.carves
  if (carves == null || terrainHashVersionOf(tcfg) === LEGACY_TERRAIN_HASH_VERSION) return []
  if (!Array.isArray(carves)) throw new TypeError(`terrain carves must be an array, got ${JSON.stringify(carves)}`)
  const radius = tcfg.radius
  if (!(radius > 0)) throw new RangeError(`terrain carves need a positive terrain radius, got ${JSON.stringify(radius)}`)
  const basis = anchorBasis(tcfg.anchorDir || [0, 1, 0])
  return carves.map((c) => {
    if (isParsedCarve(c)) return c
    const [x, z] = c?.center || []
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(c.radius >= 0) || !(c.falloff > 0)) throw new RangeError(`terrain carve needs center [x, z], radius >= 0 and falloff > 0, got ${JSON.stringify(c)}`)
    return { dir: tangentLocalToDir(basis, radius, x, z), innerM: c.radius, outerM: c.radius + c.falloff }
  })
}

export function parseTerrainConfig(tcfg) {
  if (!tcfg || typeof tcfg !== 'object' || Array.isArray(tcfg)) return { ok: false, path: '', reason: 'terrain config must be a plain object' }
  if (tcfg.seed !== undefined && !Number.isFinite(tcfg.seed)) return { ok: false, path: 'seed', reason: 'must be a finite number' }
  if (tcfg.radius !== undefined && !(Number.isFinite(tcfg.radius) && tcfg.radius > 0)) return { ok: false, path: 'radius', reason: 'must be a positive finite number' }
  let hashVersion, carves
  try { hashVersion = terrainHashVersionOf(tcfg) } catch (e) { return { ok: false, path: 'hashVersion', reason: e.message } }
  try { carves = terrainCarvesOf(tcfg) } catch (e) { return { ok: false, path: 'carves', reason: e.message } }
  const config = {
    ...tcfg,
    seed: tcfg.seed,
    radius: tcfg.radius,
    reliefScale: tcfg.reliefScale,
    anchorDir: tcfg.anchorDir || [0, 1, 0],
    center: tcfg.center || [0, 0],
    enabled: tcfg.enabled !== false,
    hashVersion,
    carves,
    carveInputs: hashVersion === LEGACY_TERRAIN_HASH_VERSION ? [] : (tcfg.carves || []),
    extent: minimapExtentOf(tcfg),
    res: minimapResOf(tcfg),
  }
  Object.defineProperty(config, PARSED_TERRAIN_CONFIG, { value: true })
  return { ok: true, config: Object.freeze(config) }
}

export function parseTerrainHashOverride(raw) {
  if (raw == null || raw === '') return null
  return assertTerrainHashVersion(Number(raw))
}

export function minimapBaseName(worldId, tcfg) {
  const v = terrainHashVersionOf(tcfg)
  const hashTag = v === DEFAULT_TERRAIN_HASH_VERSION ? '' : `.h${v}`
  return `${worldId}.${tcfg.seed | 0}${hashTag}.minimap`
}

export function minimapTaggedBaseName(worldId, seed, hashVersion) {
  return `${worldId}.${seed | 0}.h${assertTerrainHashVersion(hashVersion)}.minimap`
}

export function minimapExtentOf(tcfg) {
  if (isParsedTerrainConfig(tcfg)) return tcfg.extent
  return Number.isFinite(tcfg.minimapExtent) ? tcfg.minimapExtent : Math.min(tcfg.radius * MINIMAP_EXTENT_RADIUS_FRACTION, MINIMAP_MAX_EXTENT_M)
}

export function minimapResOf(tcfg) {
  if (isParsedTerrainConfig(tcfg)) return tcfg.res
  return Number.isFinite(tcfg.minimapRes) ? tcfg.minimapRes : DEFAULT_MINIMAP_RES
}

export function minimapDescriptor(worldId, tcfg) {
  if (!isWorldName(worldId) || !tcfg || tcfg.enabled === false || !Number.isFinite(tcfg.seed)) return null
  const c = parsedTerrainOf(tcfg)
  return { base: `/${WORLD_DIR}/${minimapBaseName(worldId, c)}`, center: c.center, extent: c.extent }
}

function terrainBakeSlice(c) {
  return { seed: c.seed ?? null, radius: c.radius ?? null, reliefScale: c.reliefScale ?? null, anchorDir: c.anchorDir, hashVersion: c.hashVersion, carves: c.carveInputs }
}

export function terrainBakeKey(tcfg) {
  const slice = terrainBakeSlice(parsedTerrainOf(tcfg))
  return (fnv1aStepString(FNV1A_32_OFFSET_BASIS, canonicalJSON(slice)) >>> 0).toString(16).padStart(8, '0')
}

// The exact text terrainBakeKey hashes, so a key mismatch can be compared field by field.
export function terrainBakeSliceText(tcfg) {
  return canonicalJSON(terrainBakeSlice(parsedTerrainOf(tcfg)))
}

export function minimapBakeParams(tcfg) {
  const c = parsedTerrainOf(tcfg)
  return { radius: c.radius, reliefScale: c.reliefScale ?? null, hashVersion: c.hashVersion, carves: c.carves, anchorDir: c.anchorDir, extent: c.extent, res: c.res, center: c.center }
}

function reseedTerrainConfig(cfg, seed) {
  const { bakedHeightfield, ...rest } = cfg
  const raw = isParsedTerrainConfig(cfg) ? { ...rest, carves: cfg.carveInputs } : rest
  const reseeded = seed === cfg.seed ? { ...raw } : { ...raw, seed }
  if (cfg.vegetation && typeof cfg.vegetation === 'object') reseeded.vegetation = { ...cfg.vegetation, seed }
  return reseeded
}

function mapTerrainConfigs(worldDef, patchConfig) {
  if (!worldDef || typeof worldDef !== 'object') return worldDef
  const patchedBySource = new Map()
  const patch = cfg => {
    if (!patchedBySource.has(cfg)) patchedBySource.set(cfg, patchConfig(cfg))
    return patchedBySource.get(cfg)
  }
  const isConfigObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
  const patchEntity = e => {
    if (!e || e.app !== 'terrain') return e
    const next = { ...e }
    if (isConfigObject(e.config)) next.config = patch(e.config)
    if (isConfigObject(e.custom) && Number.isFinite(e.custom.seed)) next.custom = patch(e.custom)
    return next
  }
  const next = { ...worldDef }
  if (isConfigObject(worldDef.terrain)) next.terrain = patch(worldDef.terrain)
  if (Array.isArray(worldDef.entities)) next.entities = worldDef.entities.map(patchEntity)
  return next
}

export function withTerrainSeed(worldDef, seed) {
  if (!Number.isInteger(seed)) throw new TypeError(`withTerrainSeed: seed must be an integer, got ${JSON.stringify(seed)}`)
  return mapTerrainConfigs(worldDef, cfg => reseedTerrainConfig(cfg, seed))
}

export function withTerrainHashVersion(worldDef, hashVersion) {
  assertTerrainHashVersion(hashVersion)
  return mapTerrainConfigs(worldDef, cfg => ({ ...cfg, hashVersion }))
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
const _hotSwapTerrainConfig = (next) => {
  isParsedTerrainConfig = next.isParsedTerrainConfig
  assertTerrainHashVersion = next.assertTerrainHashVersion
  resolveTerrainConfig = next.resolveTerrainConfig
  terrainHashVersionOf = next.terrainHashVersionOf
  terrainCarvesOf = next.terrainCarvesOf
  parseTerrainConfig = next.parseTerrainConfig
  parseTerrainHashOverride = next.parseTerrainHashOverride
  minimapBaseName = next.minimapBaseName
  minimapTaggedBaseName = next.minimapTaggedBaseName
  minimapExtentOf = next.minimapExtentOf
  minimapResOf = next.minimapResOf
  minimapDescriptor = next.minimapDescriptor
  terrainBakeKey = next.terrainBakeKey
  minimapBakeParams = next.minimapBakeParams
  withTerrainSeed = next.withTerrainSeed
  withTerrainHashVersion = next.withTerrainHashVersion
  DEFAULT_TERRAIN_HASH_VERSION = next.DEFAULT_TERRAIN_HASH_VERSION
  LEGACY_TERRAIN_HASH_VERSION = next.LEGACY_TERRAIN_HASH_VERSION
  TERRAIN_HASH_VERSIONS = next.TERRAIN_HASH_VERSIONS
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapTerrainConfig)
