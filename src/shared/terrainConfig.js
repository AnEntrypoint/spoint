import { anchorBasis, tangentLocalToDir } from '../terrain/PlanetFrame.js'
import { isWorldName, WORLD_DIR } from './worldName.js'
import { canonicalJSON } from './canonicalJSON.js'
import { FNV1A_32_OFFSET_BASIS, fnv1aStepString } from './fnv1a.js'

const MINIMAP_EXTENT_RADIUS_FRACTION = 0.25
const MINIMAP_MAX_EXTENT_M = 16384
const DEFAULT_MINIMAP_RES = 256
export const DEFAULT_TERRAIN_HASH_VERSION = 2
export const LEGACY_TERRAIN_HASH_VERSION = 1
export const TERRAIN_HASH_VERSIONS = Object.freeze([1, 2])

export function resolveTerrainConfig(worldDef) {
  const entity = (worldDef?.entities || []).find(e => e && e.app === 'terrain')
  return (entity && entity.config) || worldDef?.terrain || null
}

export function terrainHashVersionOf(tcfg) {
  const v = tcfg?.hashVersion ?? DEFAULT_TERRAIN_HASH_VERSION
  if (!TERRAIN_HASH_VERSIONS.includes(v)) throw new RangeError(`terrain hashVersion must be one of ${TERRAIN_HASH_VERSIONS.join(', ')}, got ${JSON.stringify(v)}`)
  return v
}

export function terrainCarvesOf(tcfg) {
  const carves = tcfg?.carves
  if (carves == null || terrainHashVersionOf(tcfg) === LEGACY_TERRAIN_HASH_VERSION) return []
  if (!Array.isArray(carves)) throw new TypeError(`terrain carves must be an array, got ${JSON.stringify(carves)}`)
  const radius = tcfg.radius
  if (!(radius > 0)) throw new RangeError(`terrain carves need a positive terrain radius, got ${JSON.stringify(radius)}`)
  const basis = anchorBasis(tcfg.anchorDir || [0, 1, 0])
  return carves.map((c) => {
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
  return { ok: true, hashVersion, carves }
}

export function parseTerrainHashOverride(raw) {
  if (raw == null || raw === '') return null
  return terrainHashVersionOf({ hashVersion: Number(raw) })
}

export function minimapBaseName(worldId, tcfg) {
  const v = terrainHashVersionOf(tcfg)
  const hashTag = v === DEFAULT_TERRAIN_HASH_VERSION ? '' : `.h${v}`
  return `${worldId}.${tcfg.seed | 0}${hashTag}.minimap`
}

export function minimapTaggedBaseName(worldId, seed, hashVersion) {
  return `${worldId}.${seed | 0}.h${terrainHashVersionOf({ hashVersion })}.minimap`
}

export function minimapExtentOf(tcfg) {
  return Number.isFinite(tcfg.minimapExtent) ? tcfg.minimapExtent : Math.min(tcfg.radius * MINIMAP_EXTENT_RADIUS_FRACTION, MINIMAP_MAX_EXTENT_M)
}

export function minimapResOf(tcfg) {
  return Number.isFinite(tcfg.minimapRes) ? tcfg.minimapRes : DEFAULT_MINIMAP_RES
}

export function minimapDescriptor(worldId, tcfg) {
  if (!isWorldName(worldId) || !tcfg || tcfg.enabled === false || !Number.isFinite(tcfg.seed)) return null
  return { base: `/${WORLD_DIR}/${minimapBaseName(worldId, tcfg)}`, center: tcfg.center || [0, 0], extent: minimapExtentOf(tcfg) }
}

export function terrainBakeKey(tcfg) {
  const hashVersion = terrainHashVersionOf(tcfg)
  const slice = { seed: tcfg.seed ?? null, radius: tcfg.radius ?? null, reliefScale: tcfg.reliefScale ?? null, anchorDir: tcfg.anchorDir || [0, 1, 0], hashVersion, carves: hashVersion === LEGACY_TERRAIN_HASH_VERSION ? [] : (tcfg.carves || []) }
  return (fnv1aStepString(FNV1A_32_OFFSET_BASIS, canonicalJSON(slice)) >>> 0).toString(16).padStart(8, '0')
}

export function minimapBakeParams(tcfg) {
  const parsed = parseTerrainConfig(tcfg)
  if (!parsed.ok) throw new TypeError(`terrain ${parsed.path ? `${parsed.path}: ` : ''}${parsed.reason}`)
  return {
    radius: tcfg.radius,
    reliefScale: tcfg.reliefScale ?? null,
    hashVersion: parsed.hashVersion,
    carves: parsed.carves,
    anchorDir: tcfg.anchorDir || [0, 1, 0],
    extent: minimapExtentOf(tcfg),
    res: minimapResOf(tcfg),
    center: tcfg.center || [0, 0],
  }
}

function reseedTerrainConfig(cfg, seed) {
  const { bakedHeightfield, ...rest } = cfg
  const reseeded = seed === cfg.seed ? { ...cfg } : { ...rest, seed }
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
  terrainHashVersionOf({ hashVersion })
  return mapTerrainConfigs(worldDef, cfg => ({ ...cfg, hashVersion }))
}
