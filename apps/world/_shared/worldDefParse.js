export class WorldDefParseError extends Error {
  constructor(code, world, detail) {
    super('[world-parse] ' + world + ': ' + code + ': ' + detail)
    this.name = 'WorldDefParseError'
    this.code = code
    this.world = world
  }
}

const PRESET_NAMES = ['arena', 'platformer', 'planet', 'rts', 'tps']

export const WORLD_DEF_FIELDS = {
  presets: { kind: 'array', readBy: 'src/shared/worldPresets.js:30 expandWorldPresets' },
  name: { kind: 'string', readBy: 'src/stage/StageLoader.js:23' },
  relevanceRadius: { kind: 'number', readBy: 'src/stage/StageLoader.js:64' },
  planetRadius: { kind: 'number', readBy: 'src/stage/StageLoader.js:44 stagePlanetRadius' },
  shape: { kind: 'string|null', readBy: 'src/stage/StageLoader.js:66' },
  gravity: { kind: 'number|array', readBy: 'src/stage/StageLoader.js:67' },
  spawnPoint: { kind: 'array', readBy: 'src/stage/StageLoader.js:68' },
  spawnPoints: { kind: 'array', readBy: 'src/shared/worldDefaults.js:26 worldSpawnPoints' },
  entities: { kind: 'array', readBy: 'src/stage/StageLoader.js:72' },
  terrain: { kind: 'object', readBy: 'src/shared/terrainConfig.js resolveTerrainConfig' },
  players: { kind: 'object', readBy: 'src/shared/clusterConfig.js declaredWeaponRangeM' },
  maxWeaponRangeM: { kind: 'number', readBy: 'src/shared/clusterConfig.js declaredWeaponRangeM' },
  tickRate: { kind: 'number', readBy: 'src/shared/worldDefaults.js worldTickRate' },
  entityTickRate: { kind: 'number', readBy: 'src/sdk/ServerBoot.js boot' },
  port: { kind: 'number', readBy: 'src/sdk/ServerBoot.js boot' },
  movement: { kind: 'object', readBy: 'src/sdk/ServerBoot.js boot' },
  player: { kind: 'object', readBy: 'src/sdk/ServerBoot.js boot' },
  physicsRadius: { kind: 'number', readBy: 'src/sdk/ServerBoot.js boot' },
  physicsBodyBudget: { kind: 'number', readBy: 'src/sdk/ServerBoot.js boot' },
  presence: { kind: 'object', readBy: 'src/sdk/ServerBoot.js boot' },
  equipment: { kind: 'object', readBy: 'src/shared/worldDefaults.js worldEquipment' },
  input: { kind: 'object', readBy: 'src/shared/worldDefaults.js worldInput' },
  playerModel: { kind: 'string', readBy: 'src/stage/StageLoader.js worldPlayerModel' },
  iceServers: { kind: 'array', readBy: 'src/shared/worldDefaults.js worldIceServers' },
  scene: { kind: 'object', readBy: 'client/core/SceneSetup.js:312 applySceneConfig' },
  netcode: { kind: 'object', readBy: 'client/app.js:1335 _warnNetcodeProfileDowngraded' },
  placeableApps: { kind: 'array', readBy: 'src/apps/appsManifest.js:20 worldAppNames' },
  trustedApps: { kind: 'array', readBy: 'src/apps/appsManifest.js:20 worldAppNames' }
}

for (const presetName of PRESET_NAMES) {
  WORLD_DEF_FIELDS[presetName] = { kind: 'object', readBy: 'src/shared/worldPresets.js:39 own[name]' }
}

export const TERRAIN_DEF_FIELDS = {
  enabled: { kind: 'boolean', readBy: 'src/shared/terrainConfig.js resolveTerrainConfig' },
  clusters: { kind: 'object', readBy: 'src/shared/clusterConfig.js:35 resolveClusterConfig' },
  anchorDir: { kind: 'array', readBy: 'src/terrain/PlanetFrame.js anchorDir' },
  radius: { kind: 'number', readBy: 'src/shared/clusterConfig.js:35 resolveClusterConfig' },
  reliefScale: { kind: 'number', readBy: 'src/terrain/PlanetFrame.js reliefScale' },
  maxLevel: { kind: 'number', readBy: 'src/terrain/PlanetFrame.js maxLevel' },
  offsetY: { kind: 'number', readBy: 'src/terrain/PlanetFrame.js offsetY' },
  center: { kind: 'array', readBy: 'src/terrain/PlanetFrame.js center' },
  physics: { kind: 'object', readBy: 'src/terrain/TerrainPhysics.js' },
  seed: { kind: 'number', readBy: 'src/shared/terrainConfig.js terrainBakeKey' },
  bakedHeightfield: { kind: 'object|string', readBy: 'src/terrain/TerrainPhysics.js' },
  carves: { kind: 'array|object', readBy: 'src/shared/terrainConfig.js terrainBakeKey' },
  timeOfDay: { kind: 'object|number', readBy: 'src/apps/AppEnvironment.js' },
  weather: { kind: 'object', readBy: 'src/behaviours/fire.js' },
  vegetation: { kind: 'object', readBy: 'client/core/Vegetation.js' }
}

export const ENTITY_DEF_FIELDS = {
  id: { kind: 'string', readBy: 'src/stage/StageLoader.js:73' },
  app: { kind: 'string', readBy: 'src/stage/StageLoader.js:74' },
  model: { kind: 'string', readBy: 'src/stage/StageLoader.js:75' },
  position: { kind: 'array', readBy: 'src/stage/StageLoader.js:76 vecOK' },
  rotation: { kind: 'array', readBy: 'src/stage/StageLoader.js:77 vecOK' },
  scale: { kind: 'array', readBy: 'src/stage/StageLoader.js:78 vecOK' },
  config: { kind: 'object', readBy: 'src/stage/StageLoader.js:79' },
  custom: { kind: 'object', readBy: 'src/stage/StageLoader.js:80' },
  bodyType: { kind: 'string', readBy: 'src/stage/StageLoader.js:81' }
}

const BODY_TYPES = ['dynamic', 'kinematic']

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const KIND_READERS = {
  array: Array.isArray,
  string: function (v) { return typeof v === 'string' },
  number: Number.isFinite,
  boolean: function (v) { return typeof v === 'boolean' },
  object: isPlainObject
}

function valueKind(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function rejectWrongKind(record, fields, code, world, label) {
  for (const key of Object.keys(record)) {
    const value = record[key]
    if (value == null) continue
    const declared = fields[key]
    const holds = declared.kind.split('|').some(function (kind) {
      const reader = KIND_READERS[kind.trim()]
      if (!reader) throw new Error('[world-parse] field ' + JSON.stringify(key) + ' declares kind ' + JSON.stringify(kind) + ', which no reader checks')
      return reader(value)
    })
    if (!holds) {
      throw new WorldDefParseError(code, world, label + ' field ' + JSON.stringify(key) + ' declared ' + declared.kind + ', got ' + valueKind(value))
    }
  }
}

function finiteVector(value, length) {
  return Array.isArray(value) && value.length === length && value.every(function (n) {
    return typeof n === 'number' && Number.isFinite(n)
  })
}

function rejectUnknown(record, fields, code, world, label) {
  for (const key of Object.keys(record)) {
    if (!(key in fields)) {
      throw new WorldDefParseError(code, world, label + ' field ' + JSON.stringify(key) + ' is read by no consumer')
    }
  }
}

function terrainConfigOf(def) {
  const entities = def.entities
  if (Array.isArray(entities)) {
    for (const entity of entities) {
      if (entity && entity.app === 'terrain' && isPlainObject(entity.config)) return entity.config
    }
  }
  return isPlainObject(def.terrain) ? def.terrain : null
}

function parseEntity(entity, world) {
  if (!isPlainObject(entity)) {
    throw new WorldDefParseError('world-entity-not-an-object', world, JSON.stringify(entity))
  }
  rejectUnknown(entity, ENTITY_DEF_FIELDS, 'world-entity-field-unknown', world, 'entity')
  const label = 'entity ' + JSON.stringify(entity.id || entity.app)
  if ('position' in entity && !finiteVector(entity.position, 3)) {
    throw new WorldDefParseError('world-entity-position-invalid', world, label + ' position ' + JSON.stringify(entity.position))
  }
  if ('rotation' in entity && !finiteVector(entity.rotation, 4)) {
    throw new WorldDefParseError('world-entity-rotation-invalid', world, label + ' rotation ' + JSON.stringify(entity.rotation))
  }
  if ('scale' in entity && !finiteVector(entity.scale, 3)) {
    throw new WorldDefParseError('world-entity-scale-invalid', world, label + ' scale ' + JSON.stringify(entity.scale))
  }
  if ('bodyType' in entity && BODY_TYPES.indexOf(entity.bodyType) === -1) {
    throw new WorldDefParseError('world-entity-body-type-unknown', world, label + ' bodyType ' + JSON.stringify(entity.bodyType))
  }
  rejectWrongKind(entity, ENTITY_DEF_FIELDS, 'world-entity-field-type-invalid', world, label)
}

export function parseWorldDef(world, def) {
  if (!isPlainObject(def)) {
    throw new WorldDefParseError('world-def-not-an-object', world, 'got ' + typeof def)
  }
  rejectUnknown(def, WORLD_DEF_FIELDS, 'world-field-unknown', world, 'world')

  if (!('planetRadius' in def)) {
    throw new WorldDefParseError('world-planet-radius-not-declared', world, 'declare planetRadius 0 for a flat chart or the cluster-resolved sphere radius')
  }
  const planetRadius = def.planetRadius
  if (typeof planetRadius !== 'number' || !Number.isFinite(planetRadius) || planetRadius < 0) {
    throw new WorldDefParseError('world-planet-radius-not-a-number', world, 'got ' + JSON.stringify(planetRadius))
  }

  const terrainConfig = terrainConfigOf(def)
  if (terrainConfig) {
    rejectUnknown(terrainConfig, TERRAIN_DEF_FIELDS, 'world-terrain-field-unknown', world, 'terrain')
    rejectWrongKind(terrainConfig, TERRAIN_DEF_FIELDS, 'world-terrain-field-type-invalid', world, 'terrain')
    if (!isPlainObject(terrainConfig.clusters) || typeof terrainConfig.clusters.enabled !== 'boolean') {
      throw new WorldDefParseError('world-clusters-not-declared', world, 'declare terrain.clusters { enabled } so resolveClusterConfig is never reached unstated')
    }
    if (terrainConfig.clusters.enabled === true && !(typeof terrainConfig.radius === 'number' && Number.isFinite(terrainConfig.radius) && terrainConfig.radius > 0)) {
      throw new WorldDefParseError('world-clusters-enabled-without-terrain-radius', world, 'terrain.radius ' + JSON.stringify(terrainConfig.radius))
    }
  }

  if (planetRadius > 0) {
    if (!terrainConfig) {
      throw new WorldDefParseError('world-planet-radius-unreachable', world, 'planetRadius ' + planetRadius + ' with no terrain config')
    }
    if (terrainConfig.clusters.enabled !== true) {
      throw new WorldDefParseError('world-planet-radius-unreachable', world, 'planetRadius ' + planetRadius + ' needs terrain.clusters.enabled true')
    }
    if (terrainConfig.radius !== planetRadius) {
      throw new WorldDefParseError('world-planet-radius-unreachable', world, 'terrain.radius ' + terrainConfig.radius + ' != planetRadius ' + planetRadius)
    }
  } else if (terrainConfig && terrainConfig.clusters.enabled === true) {
    throw new WorldDefParseError('world-clusters-enabled-without-planet-radius', world, 'terrain.radius ' + terrainConfig.radius + ' needs planetRadius ' + terrainConfig.radius)
  }

  if (def.entities != null) {
    if (!Array.isArray(def.entities)) {
      throw new WorldDefParseError('world-entities-not-an-array', world, 'got ' + typeof def.entities)
    }
    for (const entity of def.entities) parseEntity(entity, world)
  }

  rejectWrongKind(def, WORLD_DEF_FIELDS, 'world-field-type-invalid', world, 'world')

  return def
}
