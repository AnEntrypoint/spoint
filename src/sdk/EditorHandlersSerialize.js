const TEXT_EXTS = new Set(['.js', '.mjs', '.json', '.md', '.txt', '.css', '.html', '.yml', '.yaml', '.svg'])
function isTextFile(name) {
  const i = name.lastIndexOf('.')
  return i >= 0 && TEXT_EXTS.has(name.slice(i).toLowerCase())
}

function sanitizeFsError(e, clientRelativePath) {
  const code = e && e.code ? e.code : (e && e.name) || 'ERROR'
  return `${code}: operation failed on '${clientRelativePath}'`
}

const WORLD_CONFIG_KEYS = ['port', 'tickRate', 'entityTickRate', 'gravity', 'relevanceRadius', 'physicsRadius', 'physicsBodyBudget', 'movement', 'player', 'scene', 'camera', 'animation', 'input', 'spawnPoint', 'spawnPoints', 'playerModel', 'trustedApps']

function serializeEntity(e) {
  const out = { id: e.id }
  if (e.model) out.model = e.model
  out.position = [e.position[0], e.position[1], e.position[2]]
  const r = e.rotation
  if (r && !(r[0] === 0 && r[1] === 0 && r[2] === 0 && r[3] === 1)) out.rotation = [r[0], r[1], r[2], r[3]]
  const s = e.scale
  if (s && !(s[0] === 1 && s[1] === 1 && s[2] === 1)) out.scale = [s[0], s[1], s[2]]
  if (e._appName) out.app = e._appName
  if (e.bodyType && e.bodyType !== 'static') out.bodyType = e.bodyType
  if (e._config) out.config = e._config
  if (e.custom) out.custom = e.custom
  if (e.parent) out.parent = e.parent
  return out
}

function serializeWorld(appRuntime, sourceWorldDef) {
  const def = {}
  const src = sourceWorldDef || {}
  for (const k of WORLD_CONFIG_KEYS) if (src[k] !== undefined) def[k] = src[k]
  const entities = []
  for (const e of appRuntime.entities.values()) {
    const hasNoAuthoredState = !e._appName && !e.model && !e.custom && !e._config && !e.parent
    if (hasNoAuthoredState) continue
    entities.push(serializeEntity(e))
  }
  def.entities = entities
  return def
}

function serializeWorldSource(def) {
  return JSON.stringify(def, null, 2)
}

export { TEXT_EXTS, isTextFile, sanitizeFsError, WORLD_CONFIG_KEYS, serializeEntity, serializeWorld, serializeWorldSource }
