// Pure entity/world serialization + text-file-extension helpers for EditorHandlers.js's
// createEditorHandlers: no fs/path dependency, no closure state -- split out as the one genuinely
// self-contained block in this file (containedReal/containedRealCreateParent/prefab-persistence all
// depend on the Node-vs-Worker fs handle dance at this file's own top, and stay there).

const TEXT_EXTS = new Set(['.js', '.mjs', '.json', '.md', '.txt', '.css', '.html', '.yml', '.yaml', '.svg'])
function isTextFile(name) {
  const i = name.lastIndexOf('.')
  return i >= 0 && TEXT_EXTS.has(name.slice(i).toLowerCase())
}

// Node's raw fs error messages embed the server's ABSOLUTE filesystem path (e.g. "ENOENT: ...,
// mkdir 'C:\dev\spoint\apps\...'" or a null-byte TypeError quoting the full resolved path) -- sending
// that verbatim to an editor client leaks server directory layout to whatever authored the request.
// Found live via an adversarial VERIFY-phase sweep (null-byte path, overlong-path ENOENT) against the
// real server: both errors round-tripped with the absolute apps-root path intact. Strip it down to the
// operation-relevant leaf (Node error CODE + the client-relative path already known from payload.path)
// so the client still gets an actionable reason without the server's real directory structure.
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
    // Keep any entity carrying authored state: an app, a model, custom props (incl. a primitive's mesh/editorProp
    // edits), a saved app config, OR a hierarchy parent (a reparented empty anchor). The old filter dropped an
    // entity that had only a _config or only a parent, silently losing that authoring on save.
    if (!e._appName && !e.model && !e.custom && !e._config && !e.parent) continue
    entities.push(serializeEntity(e))
  }
  def.entities = entities
  return def
}

function serializeWorldSource(def) {
  return JSON.stringify(def, null, 2)
}

export { TEXT_EXTS, isTextFile, sanitizeFsError, WORLD_CONFIG_KEYS, serializeEntity, serializeWorld, serializeWorldSource }
