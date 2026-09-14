const MINIMAP_EXTENT_RADIUS_FRACTION = 0.25
const MINIMAP_MAX_EXTENT_M = 16384

export function resolveTerrainConfig(worldDef) {
  const entity = (worldDef?.entities || []).find(e => e && e.app === 'terrain')
  return (entity && entity.config) || worldDef?.terrain || null
}

export function minimapExtentOf(tcfg) {
  return Number.isFinite(tcfg.minimapExtent) ? tcfg.minimapExtent : Math.min(tcfg.radius * MINIMAP_EXTENT_RADIUS_FRACTION, MINIMAP_MAX_EXTENT_M)
}

export function minimapDescriptor(worldId, tcfg) {
  if (!tcfg || tcfg.enabled === false || !Number.isFinite(tcfg.seed)) return null
  return { base: `/apps/world/${worldId}.${tcfg.seed | 0}.minimap`, center: tcfg.center || [0, 0], extent: minimapExtentOf(tcfg) }
}

function reseedTerrainConfig(cfg, seed) {
  const reseeded = { ...cfg, seed }
  if (cfg.vegetation && typeof cfg.vegetation === 'object') reseeded.vegetation = { ...cfg.vegetation, seed }
  return reseeded
}

export function withTerrainSeed(worldDef, seed) {
  if (!Number.isInteger(seed)) throw new TypeError(`withTerrainSeed: seed must be an integer, got ${JSON.stringify(seed)}`)
  if (!worldDef || typeof worldDef !== 'object') return worldDef
  const reseededBySource = new Map()
  const reseed = cfg => {
    if (!reseededBySource.has(cfg)) reseededBySource.set(cfg, reseedTerrainConfig(cfg, seed))
    return reseededBySource.get(cfg)
  }
  const isConfigObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
  const reseedEntity = e => {
    if (!e || e.app !== 'terrain') return e
    const next = { ...e }
    if (isConfigObject(e.config)) next.config = reseed(e.config)
    if (isConfigObject(e.custom) && Number.isFinite(e.custom.seed)) next.custom = reseed(e.custom)
    return next
  }
  const next = { ...worldDef }
  if (isConfigObject(worldDef.terrain)) next.terrain = reseed(worldDef.terrain)
  if (Array.isArray(worldDef.entities)) next.entities = worldDef.entities.map(reseedEntity)
  return next
}
