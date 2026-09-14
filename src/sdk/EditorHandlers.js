import { MSG } from '../protocol/MessageTypes.js'
import { vecOK } from '../shared/vecGuard.js'
import { minimapDescriptor, resolveTerrainConfig, withTerrainSeed } from '../shared/terrainConfig.js'
import { BIOME_PRESETS } from '../terrain/BiomeOverride.js'
import { createGrassDecal } from '../terrain/GrassDecal.js'
import { createEditOpLog } from './EditOpLog.js'
import { createAgentEditServer } from './AgentEditServer.js'
import { createPrefabSpawner } from './PrefabSpawner.js'
import { PrefabLibrary } from '../editor/PrefabLibrary.js'
import { TEXT_EXTS, isTextFile, sanitizeFsError, WORLD_CONFIG_KEYS, serializeEntity, serializeWorld, serializeWorldSource } from './EditorHandlersSerialize.js'

const isNode = typeof process !== 'undefined' && process.versions?.node
let _fs = null, _path = null, _bakeMinimapIfMissing = null
if (isNode) {
  _fs = await import('node:fs')
  _path = await import('node:path')
  const _minimapBakePath = (() => './' + 'MinimapBake' + '.js')()
  _bakeMinimapIfMissing = (await import(_minimapBakePath)).bakeMinimapIfMissing
}
const readdirSync = _fs?.readdirSync, existsSync = _fs?.existsSync
const readFileSync = _fs?.readFileSync, writeFileSync = _fs?.writeFileSync
const statSync = _fs?.statSync, mkdirSync = _fs?.mkdirSync
const realpathSync = _fs?.realpathSync
const unlinkSync = _fs?.unlinkSync, renameSync = _fs?.renameSync, rmSync = _fs?.rmSync

const resolvePath = _path?.resolve || (() => ''), joinPath = _path?.join || (() => ''), dirnamePath = _path?.dirname || (() => ''), pathSep = _path?.sep || '/'


function _clientSuppliedId(payload, appRuntime, key = 'entityId') {
  const id = payload?.[key]
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
  if (appRuntime.entities.has(id)) return null
  return id
}


function containedReal(filePath, rootDir) {
  if (!realpathSync || !rootDir) return null
  let rootReal
  try { rootReal = realpathSync(rootDir) } catch { return null }
  const prefix = rootReal.endsWith(pathSep) ? rootReal : rootReal + pathSep
  let real
  try {
    real = realpathSync(filePath)
  } catch {
    let dirReal
    try { dirReal = realpathSync(dirnamePath(filePath)) } catch { return null }
    const dirPrefix = dirReal.endsWith(pathSep) ? dirReal : dirReal + pathSep
    return (dirReal === rootReal || dirPrefix.startsWith(prefix)) ? filePath : null
  }
  return (real === rootReal || real.startsWith(prefix)) ? real : null
}

function containedRealCreateParent(filePath, rootDir) {
  if (!realpathSync || !mkdirSync || !rootDir) return null
  let rootReal
  try { rootReal = realpathSync(rootDir) } catch { return null }
  const prefix = rootReal.endsWith(pathSep) ? rootReal : rootReal + pathSep
  const dir = dirnamePath(filePath)
  let existingAncestor = dir, missingSuffix = []
  while (true) {
    try { realpathSync(existingAncestor); break } catch {
      const parent = dirnamePath(existingAncestor)
      const reachedFilesystemRoot = parent === existingAncestor
      if (reachedFilesystemRoot) return null
      missingSuffix.unshift(existingAncestor.slice(parent.length + pathSep.length) || existingAncestor)
      existingAncestor = parent
    }
  }
  const ancestorReal = realpathSync(existingAncestor)
  const ancestorPrefix = ancestorReal.endsWith(pathSep) ? ancestorReal : ancestorReal + pathSep
  if (!(ancestorReal === rootReal || ancestorPrefix.startsWith(prefix))) return null
  if (missingSuffix.length) mkdirSync(joinPath(ancestorReal, ...missingSuffix), { recursive: true })
  return joinPath(ancestorReal, ...missingSuffix, filePath.slice(dir.length + pathSep.length))
}


const _prefabs = new Map()
let _prefabsLoaded = false
function _prefabsPath() { return resolvePath(process.cwd(), 'data', 'prefabs.json') }
function _loadPrefabsFromDisk() {
  if (_prefabsLoaded || !isNode || !readFileSync) return
  _prefabsLoaded = true
  try {
    const p = _prefabsPath()
    if (existsSync(p)) { const arr = JSON.parse(readFileSync(p, 'utf8')); for (const pf of arr) _prefabs.set(pf.name, pf) }
  } catch (e) { console.error('[prefab] load error:', e.message) }
}
function _persistPrefabs() {
  if (!isNode || !writeFileSync) return
  try {
    const dataDir = resolvePath(process.cwd(), 'data')
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
    writeFileSync(_prefabsPath(), JSON.stringify([..._prefabs.values()], null, 2))
  } catch (e) { console.error('[prefab] persist error:', e.message) }
}

export function createEditorHandlers(ctx) {
  const { connections, appRuntime } = ctx
  _loadPrefabsFromDisk()

  const editOpLog = createEditOpLog()

  const agentEditServer = createAgentEditServer()

  const prefabLibrary = new PrefabLibrary(isNode ? process.cwd() : '.')
  const prefabSpawner = createPrefabSpawner(appRuntime, prefabLibrary)
  const PREFAB_NAME_RE = /^[a-z0-9-]+$/

  const COLLIDER_TYPES = new Set(['box', 'sphere', 'capsule', 'convex', 'trimesh', 'none'])

  const PRIMITIVE_EDITOR_PROPS = [
    { key: 'color', type: 'color', label: 'Color', default: '#cccccc' },
    { key: '_collider', type: 'select', label: 'Collider', options: ['box', 'sphere', 'capsule', 'convex', 'none'], default: 'box' },
    { key: '_wetness', type: 'range', label: 'Wetness', min: 0, max: 1, step: 0.05, default: 0 },
  ]

  function syncEntityCollider(entity, changes) {
    if (!ctx.physics || entity._physicsBodyId === undefined) return
    const isDynamic = entity.bodyType === 'dynamic'
    const colliderChanged = changes.custom && Object.prototype.hasOwnProperty.call(changes.custom, '_collider')
    const scaleChanged = !!changes.scale
    if (colliderChanged || scaleChanged) { rebuildEntityCollider(entity); return }
    if (isDynamic) {
      if (changes.position) ctx.physics.setBodyPosition(entity._physicsBodyId, entity.position)
      if (changes.position || changes.rotation) ctx.physics.setBodyVelocity(entity._physicsBodyId, [0, 0, 0])
      return
    }
    if (changes.position || changes.rotation) ctx.physics._repositionBody?.(entity._physicsBodyId, entity.position, entity.rotation)
  }

  function rebuildEntityCollider(entity) {
    if (!ctx.physics) return
    if (entity._physicsBodyId !== undefined) {
      ctx.physics.removeBody(entity._physicsBodyId)
      appRuntime._physicsBodyToEntityId?.delete(entity._physicsBodyId)
      entity._physicsBodyId = undefined
    }
    const requested = entity.custom?._collider
    const type = COLLIDER_TYPES.has(requested) ? requested : (entity.collider?.type || 'box')
    if (type === 'none') { entity.collider = null; return }
    const finish = (bid) => { entity._physicsBodyId = bid; appRuntime._physicsBodyToEntityId?.set(bid, entity.id) }
    const toBox = () => { entity.collider = { type: 'box', size: [0.5, 0.5, 0.5] }; finish(ctx.physics.addBody('box', [0.5, 0.5, 0.5], entity.position, 'static', { rotation: entity.rotation })) }
    if (type === 'trimesh' && entity.model) {
      entity.collider = { type: 'trimesh', model: entity.model }
      ctx.physics.addStaticTrimeshAsync(appRuntime.resolveAssetPath(entity.model), 0, entity.position, entity.scale || [1, 1, 1], entity.rotation)
        .then(finish)
        .catch(e => { console.error(`[collider] trimesh rebuild failed for ${entity.model}, falling back to box:`, e.message); toBox() })
      return
    }
    if (type === 'convex' && entity.model) {
      const sc = entity.scale || [1, 1, 1]
      import('../physics/GLBLoader.js').then(({ extractAllVerticesFromGLBAsync }) =>
        extractAllVerticesFromGLBAsync(appRuntime.resolveAssetPath(entity.model))
      ).then(mesh => {
        const raw = mesh.vertices
        const points = (sc[0] === 1 && sc[1] === 1 && sc[2] === 1) ? Array.from(raw) : Array.from(raw).map((v, i) => v * sc[i % 3])
        entity.collider = { type: 'convex', points }
        finish(ctx.physics.addBody('convex', points, entity.position, 'static', { rotation: entity.rotation }))
      }).catch(e => { console.error(`[collider] convex rebuild failed for ${entity.model}, falling back to box:`, e.message); toBox() })
      return
    }
    if (type === 'sphere') { entity.collider = { type: 'sphere', radius: 0.5 }; finish(ctx.physics.addBody('sphere', 0.5, entity.position, 'static', { rotation: entity.rotation })); return }
    if (type === 'capsule') { entity.collider = { type: 'capsule', radius: 0.3, height: 1.8 }; finish(ctx.physics.addBody('capsule', [0.3, 0.9], entity.position, 'static', { rotation: entity.rotation })); return }
    toBox()
  }

  function sendError(clientId, message, detail) {
    if (clientId == null) return
    connections.send(clientId, MSG.EDITOR_ERROR, { message, ...(detail || {}) })
  }

  function groupEntities(entityIds) {
    const members = (entityIds || []).filter(id => appRuntime.entities.has(id))
    if (!members.length) return null
    const centroid = [0, 0, 0]
    for (const id of members) {
      const wt = appRuntime.getWorldTransform(id) || { position: appRuntime.entities.get(id).position }
      centroid[0] += wt.position[0]; centroid[1] += wt.position[1]; centroid[2] += wt.position[2]
    }
    centroid[0] /= members.length; centroid[1] /= members.length; centroid[2] /= members.length
    const groupId = 'group-' + Math.random().toString(36).slice(2, 10)
    const group = appRuntime.spawnEntity(groupId, { position: centroid, custom: { _group: true } })
    for (const id of members) appRuntime.reparent(id, groupId)
    return group
  }

  const HANDLERS = {
    [MSG.EDITOR_UPDATE]: (payload, clientId) => {
      const { entityId, changes } = payload || {}
      if (entityId && changes) {
        const entity = appRuntime.entities.get(entityId)
        if (entity) {
          if (changes.position) { if (vecOK(changes.position, 3)) entity.position = changes.position; else sendError(clientId, 'EDITOR_UPDATE: malformed position, ignored', { entityId, field: 'position' }) }
          if (changes.rotation) { if (vecOK(changes.rotation, 4)) entity.rotation = changes.rotation; else sendError(clientId, 'EDITOR_UPDATE: malformed rotation, ignored', { entityId, field: 'rotation' }) }
          if (changes.scale) { if (vecOK(changes.scale, 3)) entity.scale = changes.scale; else sendError(clientId, 'EDITOR_UPDATE: malformed scale, ignored', { entityId, field: 'scale' }) }
          if (changes.custom) entity.custom = { ...entity.custom, ...changes.custom }
          if (changes.custom && Object.prototype.hasOwnProperty.call(changes.custom, '_interactable')) appRuntime._hydrateInteractable?.(entityId, entity)
          if (changes.bodyType) appRuntime.changeBodyType(entityId, changes.bodyType)
          syncEntityCollider(entity, changes)
          appRuntime.fireEvent(entityId, 'onEditorUpdate', changes)
          editOpLog.record(MSG.EDITOR_UPDATE, { entityId, changes }, clientId, (seq, op) => {
            connections.broadcast(MSG.EDIT_OP_LOG, op)
          })
          if (changes.custom) appRuntime.contexts?.get(entityId)?._fireConfigChange?.()
          ctx.placedModelStorage?.persist(appRuntime)
          if (changes.custom) connections.broadcast(MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
        }
      }
    },
    [MSG.PLACE_MODEL]: (payload, clientId) => {
      const { url, position } = payload || {}
      if (url && typeof url === 'string') {
        const id = _clientSuppliedId(payload, appRuntime) || 'placed-' + Math.random().toString(36).slice(2, 10)
        const pos = vecOK(position, 3) ? position : [0, 0, 0]
        appRuntime.spawnEntity(id, { model: url, position: pos, app: 'placed-model', autoTrimesh: true, config: { collider: 'trimesh' } })
        connections.send(clientId, MSG.EDITOR_SELECT, { entityId: id })
        connections.broadcast(MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
        ctx.placedModelStorage?.persist(appRuntime)
      } else {
        sendError(clientId, 'PLACE_MODEL: missing or invalid url, nothing placed')
      }
    },
    [MSG.PLACE_APP]: (payload, clientId) => {
      const { appName, position, config } = payload || {}
      const PRIMITIVE = { 'box-static': 'box', 'sphere-static': 'sphere', 'capsule-static': 'capsule', 'cylinder-static': 'cylinder' }
      if (appName && PRIMITIVE[appName]) {
        const meshKind = PRIMITIVE[appName]
        const id = _clientSuppliedId(payload, appRuntime) || appName + '-' + Math.random().toString(36).slice(2, 8)
        const pos = vecOK(position, 3) ? position : [0, 1, 0]
        const { scale, ...customConfig } = config || {}
        const spawnCfg = { position: pos, bodyType: 'static', custom: { mesh: meshKind, ...customConfig } }
        if (vecOK(scale, 3)) spawnCfg.scale = scale
        appRuntime.spawnEntity(id, spawnCfg)
        connections.send(clientId, MSG.EDITOR_SELECT, { entityId: id, editorProps: PRIMITIVE_EDITOR_PROPS })
        connections.broadcast(MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
        ctx.placedModelStorage?.persist(appRuntime)
        return
      }
      if (appName && appRuntime._appDefs.has(appName)) {
        const id = _clientSuppliedId(payload, appRuntime) || appName + '-' + Math.random().toString(36).slice(2, 8)
        const pos = vecOK(position, 3) ? position : [0, 0, 0]
        const appDef = appRuntime._appDefs.get(appName)
        const appServerDef = appDef?.server || appDef
        const editorProps = appServerDef?.editorProps || appDef?.editorProps || []
        const seeded = { ...(config || {}) }
        for (const f of editorProps) if (f && f.key && f.default !== undefined && seeded[f.key] === undefined) seeded[f.key] = f.default
        const bodyType = appServerDef?.bodyType || appDef?.bodyType || 'static'
        appRuntime.spawnEntity(id, { app: appName, position: pos, bodyType, config: seeded })
        connections.send(clientId, MSG.EDITOR_SELECT, { entityId: id, editorProps })
        connections.broadcast(MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
        ctx.placedModelStorage?.persist(appRuntime)
        return
      }
      connections.send(clientId, MSG.EDITOR_SELECT, { entityId: null, error: 'app not found: ' + appName })
    },
    [MSG.LIST_APPS]: (payload, clientId) => {
      const apps = []
      const declaredDesc = (appDef) => {
        const serverMod = appDef?.server || appDef
        return (typeof appDef?.description === 'string' && appDef.description)
            || (typeof serverMod?.description === 'string' && serverMod.description) || ''
      }
      const CHANNEL_RE = /\.bus\.(on|once)\(\s*(['"`])((?:(?!\2).)+)\2/g
      const EMIT_RE = /\.bus\.emit\(\s*(['"`])((?:(?!\1).)+)\1/g
      const scrapeChannels = (src) => {
        const listens = new Set(), emits = new Set()
        let m
        CHANNEL_RE.lastIndex = 0
        while ((m = CHANNEL_RE.exec(src))) listens.add(m[3])
        EMIT_RE.lastIndex = 0
        while ((m = EMIT_RE.exec(src))) emits.add(m[2])
        return { listens: [...listens], emits: [...emits] }
      }
      if (isNode && readdirSync) {
        const appsRoot = resolvePath(process.cwd(), 'apps')
        try {
          for (const name of readdirSync(appsRoot)) {
            const idxPath = joinPath(appsRoot, name, 'index.js')
            if (!existsSync(idxPath)) continue
            const appDef = appRuntime._appDefs.get(name)
            const serverMod = appDef?.server || appDef
            const src = readFileSync(idxPath, 'utf8')
            let description = declaredDesc(appDef)
            if (!description) {
              const descMatch = src.match(/\/\/\s*(.+)/)
              description = descMatch ? descMatch[1].trim() : ''
            }
            const { listens, emits } = scrapeChannels(src)
            apps.push({ name, description, hasEditorProps: !!(serverMod?.editorProps?.length), channels: listens, emitsChannels: emits })
          }
        } catch (e) {}
      } else {
        for (const [name, appDef] of appRuntime._appDefs) {
          const serverMod = appDef?.server || appDef
          apps.push({ name, description: declaredDesc(appDef), hasEditorProps: !!(serverMod?.editorProps?.length), channels: [], emitsChannels: [] })
        }
      }
      connections.send(clientId, MSG.APP_LIST, { apps })
    },
    [MSG.LIST_APP_FILES]: (payload, clientId) => {
      const { appName } = payload || {}
      if (appName && isNode && readdirSync) {
        const appsRoot = resolvePath(process.cwd(), 'apps')
        const appDir = containedReal(resolvePath(joinPath(appsRoot, appName)), appsRoot)
        if (appDir && existsSync(appDir)) {
          const files = []
          const scan = (dir, prefix) => {
            try {
              for (const entry of readdirSync(dir)) {
                const full = joinPath(dir, entry)
                const rel = prefix ? prefix + '/' + entry : entry
                if (statSync(full).isDirectory()) scan(full, rel)
                else files.push(rel)
              }
            } catch (e) {}
          }
          scan(appDir, '')
          connections.send(clientId, MSG.APP_FILES, { appName, files })
        } else {
          connections.send(clientId, MSG.APP_FILES, { appName, files: [], error: 'not found' })
        }
      } else if (appName) {
        connections.send(clientId, MSG.APP_FILES, { appName, files: ['index.js'] })
      }
    },
    [MSG.GET_SOURCE]: (payload, clientId) => {
      const { appName, file } = payload || {}
      if (appName) {
        if (isNode && readFileSync) {
          const appsRoot = resolvePath(process.cwd(), 'apps')
          const real = containedReal(resolvePath(joinPath(appsRoot, appName, file || 'index.js')), appsRoot)
          if (real && existsSync(real)) {
            if (!isTextFile(file || 'index.js')) {
              connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source: null, binary: true, size: statSync(real).size })
            } else {
              connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source: readFileSync(real, 'utf8'), mtimeMs: statSync(real).mtimeMs })
            }
          } else {
            connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source: null, error: 'not found' })
          }
        } else {
          const wantFile = file || 'index.js'
          if (wantFile === 'index.js') {
            const source = ctx.appLoader?.getClientModule(appName) || ''
            connections.send(clientId, MSG.SOURCE, { appName, file: wantFile, source })
          } else {
            fetch(`/apps/${appName}/${wantFile}`).then(r => r.ok ? r.text() : Promise.reject(new Error(String(r.status))))
              .then(source => connections.send(clientId, MSG.SOURCE, { appName, file: wantFile, source }))
              .catch(e => connections.send(clientId, MSG.SOURCE, { appName, file: wantFile, source: null, error: e.message }))
          }
        }
      }
    },
    [MSG.SAVE_SOURCE]: (payload, clientId) => {
      const { appName, file, source, baseMtimeMs } = payload || {}
      if (appName && source != null) {
        if (isNode && writeFileSync) {
          const appsRoot = resolvePath(process.cwd(), 'apps')
          const filePath = resolvePath(joinPath(appsRoot, appName, file || 'index.js'))
          const real = containedReal(filePath, appsRoot) || containedRealCreateParent(filePath, appsRoot)
          if (real) {
            let onDiskMtime = null
            try { onDiskMtime = existsSync(real) ? statSync(real).mtimeMs : null } catch {}
            if (baseMtimeMs != null && onDiskMtime != null && onDiskMtime > baseMtimeMs) {
              connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source: null, conflict: true, error: 'file changed on disk since last load', mtimeMs: onDiskMtime, diskSource: readFileSync(real, 'utf8') })
              return
            }
            try {
              writeFileSync(real, source, 'utf8')
              const mtimeMs = statSync(real).mtimeMs
              connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source, mtimeMs })
              editOpLog.record(MSG.SAVE_SOURCE, { appName, file: file || 'index.js', source, mtimeMs }, clientId, (seq, op) => {
                connections.broadcast(MSG.EDIT_OP_LOG, op)
              })
            } catch (e) {
              connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source: null, error: sanitizeFsError(e, appName + '/' + (file || 'index.js')) })
            }
          } else {
            connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source: null, error: 'path escapes apps root' })
          }
        } else if ((file || 'index.js') === 'index.js') {
          ctx.appLoader?.loadFromString(appName, source)
          connections.send(clientId, MSG.SOURCE, { appName, file: 'index.js', source })
          connections.broadcast(MSG.APP_MODULE, { app: appName, code: source, trusted: ctx.currentWorldDef?.trustedApps?.includes(appName) || undefined })
          editOpLog.record(MSG.SAVE_SOURCE, { appName, file: 'index.js', source }, clientId, (seq, op) => {
            connections.broadcast(MSG.EDIT_OP_LOG, op)
          })
        } else {
          connections.send(clientId, MSG.SOURCE, { appName, file, source: null, error: 'cannot save non-index files in singleplayer (no real filesystem, and no hot-load path for helper modules) -- edit on a real server instead' })
        }
      }
    },
    [MSG.SCENE_GRAPH]: (payload, clientId) => {
      connections.send(clientId, MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
    },
    [MSG.SAVE_WORLD]: (payload, clientId) => {
      const rawName = (payload || {}).name
      const name = typeof rawName === 'string' ? rawName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') : ''
      if (!name) { connections.send(clientId, MSG.WORLD_SAVED, { ok: false, error: 'invalid world name (use a-z 0-9 -)' }); return }
      const worldDef = serializeWorld(appRuntime, ctx.currentWorldDef)
      if (!isNode || !writeFileSync) {
        connections.send(clientId, MSG.WORLD_SAVED, { ok: true, name, def: worldDef, downloadOnly: true })
        return
      }
      try {
        const worldsRoot = resolvePath(process.cwd(), 'apps', 'world')
        if (!existsSync(worldsRoot)) mkdirSync(worldsRoot, { recursive: true })
        const filePath = resolvePath(joinPath(worldsRoot, name + '.js'))
        const escapesWorldsRoot = filePath !== worldsRoot && !filePath.startsWith(worldsRoot + pathSep)
        if (escapesWorldsRoot) { connections.send(clientId, MSG.WORLD_SAVED, { ok: false, error: 'path escapes apps/world' }); return }
        if (existsSync(filePath) && !payload.overwrite) { connections.send(clientId, MSG.WORLD_SAVED, { ok: false, exists: true, name, error: 'a world named "' + name + '" already exists' }); return }
        const source = 'export default ' + serializeWorldSource(worldDef) + '\n'
        writeFileSync(filePath, source, 'utf8')
        connections.send(clientId, MSG.WORLD_SAVED, { ok: true, name, path: 'apps/world/' + name + '.js', entityCount: worldDef.entities.length })
      } catch (e) {
        connections.send(clientId, MSG.WORLD_SAVED, { ok: false, error: e.message })
      }
    },
    [MSG.LIST_WORLDS]: (payload, clientId) => {
      if (!isNode || !readdirSync) { connections.send(clientId, MSG.WORLD_LIST, { worlds: [] }); return }
      try {
        const worldsRoot = resolvePath(process.cwd(), 'apps', 'world')
        const worlds = existsSync(worldsRoot) ? readdirSync(worldsRoot).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)) : []
        connections.send(clientId, MSG.WORLD_LIST, { worlds })
      } catch (e) {
        connections.send(clientId, MSG.WORLD_LIST, { worlds: [], error: e.message })
      }
    },
    [MSG.TERRAIN_RESEED]: (payload, clientId) => {
      const seed = Number.isFinite(payload?.seed) ? (payload.seed | 0) : null
      if (seed === null) { connections.send(clientId, MSG.TERRAIN_CONFIG, { ok: false, error: 'invalid seed' }); return }
      const terrainEnt = [...appRuntime.entities.values()].find(e => e._appName === 'terrain' || e.app === 'terrain')
      const wd = ctx.currentWorldDef
      const reseededWd = wd ? withTerrainSeed(wd, seed) : null
      const reseededCfg = resolveTerrainConfig(reseededWd)
      const newCfg = reseededCfg || { ...((terrainEnt && terrainEnt.custom) || {}), seed }
      if (wd && !reseededCfg) wd.terrain = newCfg
      else if (wd) {
        if (reseededWd.terrain) wd.terrain = reseededWd.terrain
        if (Array.isArray(wd.entities)) reseededWd.entities.forEach((e, i) => { if (e !== wd.entities[i]) wd.entities[i] = e })
      }
      ;(async () => {
        try {
          if (ctx._terrainStreamer?.stop) ctx._terrainStreamer.stop()
          if (ctx._terrainStreamer?._trunkStreamer?.stop) ctx._terrainStreamer._trunkStreamer.stop()
          if (ctx._terrainStreamer?._rockStreamer?.stop) ctx._terrainStreamer._rockStreamer.stop()
          const { setupTerrainStreaming } = await import('../terrain/TerrainPhysics.js')
          ctx._terrainStreamer = await setupTerrainStreaming({ physics: ctx.physics, playerManager: ctx.playerManager, terrain: newCfg })
          const worldId = appRuntime.worldName || wd?.name || (typeof process !== 'undefined' && process.env?.WORLD) || 'world'
          const newMinimap = minimapDescriptor(worldId, newCfg)
          if (wd) wd._minimap = newMinimap
          connections.broadcast(MSG.TERRAIN_CONFIG, { ok: true, config: newCfg, minimap: newMinimap })
          if (isNode && newCfg.enabled !== false && Number.isFinite(newCfg.seed)) {
            _bakeMinimapIfMissing?.(worldId, newCfg, { force: true }).catch(e => console.error('[minimap] reseed re-bake failed:', e?.message || e))
          }
        } catch (e) {
          console.error('[terrain] reseed failed:', e?.message || e)
          connections.send(clientId, MSG.TERRAIN_CONFIG, { ok: false, error: e?.message || String(e) })
        }
      })()
    },
    [MSG.TERRAIN_SCULPT]: (payload, clientId) => {
      const { brush, x, z, radius } = payload || {}
      let { strength } = payload || {}
      const validBrush = brush === 'raise' || brush === 'lower' || brush === 'smooth' || brush === 'flatten'
      if (brush === 'flatten' && !Number.isFinite(strength)) strength = 1
      if (!validBrush || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0 || !Number.isFinite(strength) || strength === 0) {
        connections.send(clientId, MSG.TERRAIN_SCULPT_ACK, { ok: false, error: 'invalid sculpt payload' })
        return
      }
      const streamer = ctx._terrainStreamer
      if (!streamer || !streamer.heightDelta || typeof streamer.resculpt !== 'function') {
        connections.send(clientId, MSG.TERRAIN_SCULPT_ACK, { ok: false, error: 'no active terrain streamer' })
        return
      }
      if (brush === 'flatten' && typeof streamer.baseHeightFn !== 'function') {
        connections.send(clientId, MSG.TERRAIN_SCULPT_ACK, { ok: false, error: 'flatten brush unavailable: no base heightFn on streamer' })
        return
      }
      const deltaBefore = streamer.heightDelta.deltaAt(x, z)
      let touched = 0, targetHeight
      if (brush === 'smooth') {
        ;({ touched } = streamer.heightDelta.applySmoothBrush(x, z, radius, Math.min(1, Math.abs(strength))))
      } else if (brush === 'flatten') {
        targetHeight = streamer.baseHeightFn(x, z) + deltaBefore
        ;({ touched } = streamer.heightDelta.applyFlattenBrush(streamer.baseHeightFn, x, z, radius, targetHeight, Math.min(1, Math.abs(strength))))
      } else {
        ;({ touched } = streamer.heightDelta.applyRaiseBrush(x, z, radius, brush === 'lower' ? -Math.abs(strength) : Math.abs(strength)))
      }
      const deltaAfter = streamer.heightDelta.deltaAt(x, z)
      ;(async () => {
        try {
          await streamer.resculpt()
          const ack = { ok: true, brush, x, z, radius, strength, touched, cellCount: streamer.heightDelta.cellCount, strokeCount: streamer.heightDelta.strokeCount, deltaBefore, deltaAfter, targetHeight }
          connections.broadcast(MSG.TERRAIN_SCULPT_ACK, ack)
        } catch (e) {
          console.error('[terrain] sculpt resculpt failed:', e?.message || e)
          connections.send(clientId, MSG.TERRAIN_SCULPT_ACK, { ok: false, error: e?.message || String(e) })
        }
      })()
    },
    [MSG.TERRAIN_PAINT_BIOME]: (payload, clientId) => {
      const { biome, x, z, radius } = payload || {}
      let { strength } = payload || {}
      const preset = BIOME_PRESETS[biome]
      if (!Number.isFinite(strength)) strength = 1
      if (!preset || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0 || !Number.isFinite(strength) || strength <= 0) {
        connections.send(clientId, MSG.TERRAIN_PAINT_BIOME_ACK, { ok: false, error: 'invalid paint-biome payload' })
        return
      }
      const streamer = ctx._terrainStreamer
      if (!streamer || !streamer.biomeOverride || typeof streamer.repaintBiome !== 'function') {
        connections.send(clientId, MSG.TERRAIN_PAINT_BIOME_ACK, { ok: false, error: 'no active terrain streamer' })
        return
      }
      const { touched } = streamer.biomeOverride.applyPaintBrush(x, z, radius, preset, Math.min(1, Math.abs(strength)))
      ;(async () => {
        try {
          await streamer.repaintBiome()
          const ack = { ok: true, biome, x, z, radius, strength, touched, cellCount: streamer.biomeOverride.cellCount, strokeCount: streamer.biomeOverride.strokeCount }
          connections.broadcast(MSG.TERRAIN_PAINT_BIOME_ACK, ack)
        } catch (e) {
          console.error('[terrain] paint-biome repaint failed:', e?.message || e)
          connections.send(clientId, MSG.TERRAIN_PAINT_BIOME_ACK, { ok: false, error: e?.message || String(e) })
        }
      })()
    },
    [MSG.GRASS_DECAL_STAMP]: (payload, clientId) => {
      const { x, z, radius } = payload || {}
      const strength = Number.isFinite(payload?.strength) ? payload.strength : 1
      if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0 || strength === 0) {
        connections.send(clientId, MSG.GRASS_DECAL_SYNC, { ok: false, error: 'invalid grass decal payload' })
        return
      }
      if (!ctx._grassDecal) ctx._grassDecal = createGrassDecal()
      const { touched, appliedAt } = ctx._grassDecal.markScorched(x, z, radius, strength)
      connections.broadcast(MSG.GRASS_DECAL_SYNC, { ok: true, touched, stamps: [{ x, z, radius, strength, appliedAt }] })
    },
    [MSG.DESTROY_ENTITY]: (payload, clientId) => {
      const { entityId } = payload || {}
      if (entityId && appRuntime.entities.has(entityId)) {
        appRuntime.destroyEntity(entityId)
        ctx.placedModelStorage?.persist(appRuntime)
        connections.broadcast(MSG.DESTROY_ENTITY, { entityId })
        connections.broadcast(MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
      }
    },
    [MSG.REPARENT_ENTITY]: (payload, clientId) => {
      const { entityId, parentId } = payload || {}
      if (entityId && appRuntime.entities.has(entityId)) {
        if (appRuntime.reparent(entityId, parentId || null)) {
          ctx.placedModelStorage?.persist(appRuntime)
          connections.broadcast(MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
        }
      }
    },
    [MSG.DUPLICATE_ENTITY]: (payload, clientId) => {
      const { entityId } = payload || {}
      if (entityId && appRuntime.entities.has(entityId)) {
        const copyId = _clientSuppliedId(payload, appRuntime, 'copyId')
        const copy = appRuntime.duplicateEntity(entityId, undefined, copyId)
        if (copy) {
          ctx.placedModelStorage?.persist(appRuntime)
          connections.send(clientId, MSG.EDITOR_SELECT, { entityId: copy.id })
          connections.broadcast(MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
        }
      }
    },
    [MSG.SET_LABEL]: (payload, clientId) => {
      const { entityId, label } = payload || {}
      if (entityId && appRuntime.entities.has(entityId) && typeof label === 'string') {
        appRuntime.setLabel(entityId, label)
        ctx.placedModelStorage?.persist(appRuntime)
        connections.broadcast(MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
      }
    },
    [MSG.GET_EDITOR_PROPS]: (payload, clientId) => {
      const { entityId } = payload || {}
      if (entityId) {
        const entity = appRuntime.entities.get(entityId)
        const appName = entity?._appName
        const appDef = appName ? appRuntime._appDefs.get(appName) : null
        const serverMod = appDef?.server || appDef
        const editorProps = serverMod?.editorProps || (entity?.custom?.mesh && !appName ? PRIMITIVE_EDITOR_PROPS : [])
        connections.send(clientId, MSG.EDITOR_PROPS, { entityId, editorProps })
      }
    },
    [MSG.EDITOR_PRESENCE]: (payload, clientId) => {
      const { entityId, dragging } = payload || {}
      for (const client of connections.clients.values()) {
        if (client.id === clientId || !client.transport.isOpen) continue
        connections.send(client.id, MSG.EDITOR_PRESENCE, { clientId, entityId: entityId || null, dragging: !!dragging })
      }
    },
    [MSG.EVENT_LOG_QUERY]: (payload, clientId) => {
      connections.send(clientId, MSG.EVENT_LOG_DATA, { events: ctx.eventLog ? ctx.eventLog.query({}).slice(-60) : [] })
    },
    [MSG.CREATE_APP]: (payload, clientId) => {
      const { appName } = payload || {}
      if (!appName || !/^[a-z0-9-]+$/.test(appName)) return
      const template = `export default {\n  server: {\n    setup(ctx) {},\n    onEditorUpdate(ctx, changes) {\n      if (changes.position) ctx.entity.position = changes.position\n      if (changes.rotation) ctx.entity.rotation = changes.rotation\n      if (changes.scale) ctx.entity.scale = changes.scale\n      if (changes.custom) ctx.entity.custom = { ...ctx.entity.custom, ...changes.custom }\n    }\n  },\n  client: {\n    render(ctx) {\n      return { position: ctx.entity.position, rotation: ctx.entity.rotation, scale: ctx.entity.scale, model: ctx.entity.model }\n    }\n  }\n}\n`
      if (isNode && mkdirSync) {
        const appsRoot = resolvePath(process.cwd(), 'apps')
        const appDir = joinPath(appsRoot, appName)
        if (!existsSync(appDir)) {
          mkdirSync(appDir, { recursive: true })
          writeFileSync(joinPath(appDir, 'index.js'), template, 'utf8')
          connections.send(clientId, MSG.SOURCE, { appName, file: 'index.js', source: template })
        }
      } else {
        ctx.appLoader?.loadFromString(appName, template)
        connections.send(clientId, MSG.SOURCE, { appName, file: 'index.js', source: template })
        connections.broadcast(MSG.APP_MODULE, { app: appName, code: template, trusted: ctx.currentWorldDef?.trustedApps?.includes(appName) || undefined })
      }
    },
    [MSG.LIST_FS_TREE]: (payload, clientId) => {
      if (!isNode || !readdirSync) {
        fetch('/apps/apps-fs-manifest.json').then(r => r.ok ? r.json() : null).then(m => {
          const files = m?.files
          if (!Array.isArray(files)) { connections.send(clientId, MSG.FS_TREE, { tree: [], error: 'apps-fs-manifest.json unavailable (dev server without the gh-pages build step, or a Node server -- those use the real-fs branch instead)' }); return }
          const root = []
          for (const rel of files) {
            const parts = rel.split('/').filter(Boolean)
            let level = root
            for (let i = 0; i < parts.length; i++) {
              const isFile = i === parts.length - 1
              const name = parts[i]
              let node = level.find(n => n.name === name)
              if (!node) {
                node = isFile ? { name, type: 'file', size: -1, binary: false } : { name, type: 'dir', children: [] }
                level.push(node)
              }
              if (!isFile) level = node.children
            }
          }
          connections.send(clientId, MSG.FS_TREE, { tree: root })
        }).catch(e => connections.send(clientId, MSG.FS_TREE, { tree: [], error: 'apps-fs-manifest.json fetch failed: ' + e.message }))
        return
      }
      const appsRoot = resolvePath(process.cwd(), 'apps')
      function scan(dir) {
        const out = []
        let entries = []
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
        for (const entry of entries) {
          const full = joinPath(dir, entry.name)
          const real = containedReal(full, appsRoot)
          if (!real) continue
          if (entry.isDirectory()) {
            out.push({ name: entry.name, type: 'dir', children: scan(full) })
          } else {
            let size = -1
            try { size = statSync(full).size } catch {}
            out.push({ name: entry.name, type: 'file', size, binary: !isTextFile(entry.name) })
          }
        }
        return out
      }
      connections.send(clientId, MSG.FS_TREE, { tree: existsSync(appsRoot) ? scan(appsRoot) : [] })
    },
    [MSG.MKDIR]: (payload, clientId) => {
      const { path } = payload || {}
      if (!path) return
      if (!isNode || !mkdirSync) { connections.send(clientId, MSG.FS_OP_RESULT, { op: 'mkdir', path, ok: false, error: 'unavailable in singleplayer' }); return }
      const appsRoot = resolvePath(process.cwd(), 'apps')
      const target = resolvePath(joinPath(appsRoot, path))
      const parentReal = containedReal(dirnamePath(target), appsRoot)
      if (!parentReal || existsSync(target)) { connections.send(clientId, MSG.FS_OP_RESULT, { op: 'mkdir', path, ok: false, error: !parentReal ? 'path escapes apps root' : 'already exists' }); return }
      try {
        mkdirSync(target, { recursive: true })
        connections.send(clientId, MSG.FS_OP_RESULT, { op: 'mkdir', path, ok: true })
        connections.broadcast(MSG.FS_TREE_CHANGED, {})
      } catch (e) {
        connections.send(clientId, MSG.FS_OP_RESULT, { op: 'mkdir', path, ok: false, error: sanitizeFsError(e, path) })
      }
    },
    [MSG.DELETE_FILE]: (payload, clientId) => {
      const { path } = payload || {}
      if (!path) return
      if (!isNode || !unlinkSync) { connections.send(clientId, MSG.FS_OP_RESULT, { op: 'delete', path, ok: false, error: 'unavailable in singleplayer' }); return }
      const appsRoot = resolvePath(process.cwd(), 'apps')
      const target = resolvePath(joinPath(appsRoot, path))
      const real = containedReal(target, appsRoot)
      if (!real || !existsSync(real)) { connections.send(clientId, MSG.FS_OP_RESULT, { op: 'delete', path, ok: false, error: !real ? 'path escapes apps root' : 'not found' }); return }
      const appName = path.split('/')[0]
      const isWholeAppDir = statSync(real).isDirectory() && path.indexOf('/') === -1
      const isAppEntry = path === joinPath(appName, 'index.js') || path === appName + '.js'
      if ((isWholeAppDir || isAppEntry) && ctx.appRuntime) {
        for (const [eid, ent] of ctx.appRuntime.entities) {
          if (ent._appName === appName) ctx.appRuntime.detachApp(eid)
        }
      }
      try {
        if (statSync(real).isDirectory()) { if (rmSync) rmSync(real, { recursive: true, force: true }); else { connections.send(clientId, MSG.FS_OP_RESULT, { op: 'delete', path, ok: false, error: 'recursive delete unsupported' }); return } }
        else unlinkSync(real)
        connections.send(clientId, MSG.FS_OP_RESULT, { op: 'delete', path, ok: true })
        connections.broadcast(MSG.FS_TREE_CHANGED, {})
      } catch (e) {
        connections.send(clientId, MSG.FS_OP_RESULT, { op: 'delete', path, ok: false, error: sanitizeFsError(e, path) })
      }
    },
    [MSG.RENAME_FILE]: (payload, clientId) => {
      const { path, newPath } = payload || {}
      if (!path || !newPath) return
      if (!isNode || !renameSync) { connections.send(clientId, MSG.FS_OP_RESULT, { op: 'rename', path, ok: false, error: 'unavailable in singleplayer' }); return }
      const appsRoot = resolvePath(process.cwd(), 'apps')
      const from = resolvePath(joinPath(appsRoot, path))
      const to = resolvePath(joinPath(appsRoot, newPath))
      const fromReal = containedReal(from, appsRoot)
      const toParentReal = containedReal(dirnamePath(to), appsRoot)
      if (!fromReal || !existsSync(fromReal) || !toParentReal || existsSync(to)) {
        connections.send(clientId, MSG.FS_OP_RESULT, { op: 'rename', path, ok: false, error: !fromReal || !existsSync(fromReal) ? 'source not found or escapes apps root' : (!toParentReal ? 'destination escapes apps root' : 'destination already exists') })
        return
      }
      try {
        renameSync(fromReal, to)
        connections.send(clientId, MSG.FS_OP_RESULT, { op: 'rename', path, newPath, ok: true })
        connections.broadcast(MSG.FS_TREE_CHANGED, {})
      } catch (e) {
        connections.send(clientId, MSG.FS_OP_RESULT, { op: 'rename', path, ok: false, error: sanitizeFsError(e, path) })
      }
    },
    [MSG.EDIT_OP_LOG_SINCE]: (payload, clientId) => {
      const sinceSeq = payload?.sinceSeq
      const { ops, latestSeq } = editOpLog.getOpsSince(sinceSeq)
      connections.send(clientId, MSG.EDIT_OP_LOG, { ops, latestSeq, replay: true })
    },
    [MSG.AGENT_EDIT_PROPOSE]: (payload, clientId) => {
      const { edits, proposedBy } = payload || {}
      if (!Array.isArray(edits) || edits.length === 0) {
        connections.send(clientId, MSG.EDITOR_ERROR, { error: 'no edits in proposal' })
        return
      }
      const proposalId = agentEditServer.propose(edits, proposedBy || 'agent')
      if (!proposalId) {
        connections.send(clientId, MSG.EDITOR_ERROR, { error: 'failed to stage proposal' })
        return
      }
      const proposal = agentEditServer.getByProposalId(proposalId)
      connections.send(clientId, MSG.EDITOR_ERROR, { ok: true, proposalId, edits: proposal })
      connections.broadcast(MSG.AGENT_EDIT_PROPOSE, { proposalId, edits: proposal, proposedBy: proposedBy || 'agent' })
    },
    [MSG.AGENT_EDIT_LIST]: (payload, clientId) => {
      const filterStatus = payload?.status || null
      const proposals = agentEditServer.list(filterStatus)
      connections.send(clientId, MSG.AGENT_EDIT_LIST, { proposals, pendingCount: agentEditServer.pendingCount() })
    },
    [MSG.AGENT_EDIT_APPROVE]: (payload, clientId) => {
      const { id, proposalId, approvedBy } = payload || {}
      let results = []
      if (id) {
        const p = agentEditServer.approve(id, approvedBy)
        if (p) results = [p]
      } else if (proposalId) {
        results = agentEditServer.approveAll(proposalId, approvedBy)
      }
      if (results.length === 0) {
        connections.send(clientId, MSG.EDITOR_ERROR, { error: 'no pending edits found to approve' })
        return
      }
      connections.send(clientId, MSG.AGENT_EDIT_APPROVE, { ok: true, approved: results })
      connections.broadcast(MSG.AGENT_EDIT_APPROVE, { approved: results, approvedBy: approvedBy || 'editor' })
      for (const edit of results) {
        if (isNode && writeFileSync) {
          try {
            const appsRoot = resolvePath(process.cwd(), 'apps')
            const filePath = resolvePath(joinPath(appsRoot, edit.appName, edit.file))
            const real = containedReal(filePath, appsRoot) || containedRealCreateParent(filePath, appsRoot)
            if (real) {
              writeFileSync(real, edit.source, 'utf8')
              editOpLog.record(MSG.SAVE_SOURCE, { appName: edit.appName, file: edit.file, source: edit.source }, clientId, (seq, op) => {
                connections.broadcast(MSG.EDIT_OP_LOG, op)
              })
            }
          } catch (e) {
            console.error(`[agent-edit] failed to write approved edit ${edit.appName}/${edit.file}:`, e?.message || e)
          }
        } else if (edit.file === 'index.js') {
          ctx.appLoader?.loadFromString(edit.appName, edit.source)
        }
      }
      if (proposalId) agentEditServer.removeAll(proposalId)
    },
    [MSG.AGENT_EDIT_REJECT]: (payload, clientId) => {
      const { id, proposalId, rejectedBy } = payload || {}
      let results = []
      if (id) {
        const p = agentEditServer.reject(id, rejectedBy)
        if (p) results = [p]
      } else if (proposalId) {
        results = agentEditServer.rejectAll(proposalId, rejectedBy)
      }
      if (results.length === 0) {
        connections.send(clientId, MSG.EDITOR_ERROR, { error: 'no pending edits found to reject' })
        return
      }
      connections.send(clientId, MSG.AGENT_EDIT_REJECT, { ok: true, rejected: results })
      connections.broadcast(MSG.AGENT_EDIT_REJECT, { rejected: results, rejectedBy: rejectedBy || 'editor' })
      if (proposalId) agentEditServer.removeAll(proposalId)
    },
    [MSG.SAVE_PREFAB]: (payload, clientId) => {
      const { prefabName, entityIds, metadata } = payload || {}

      if (!prefabName || typeof prefabName !== 'string') {
        sendError(clientId, 'SAVE_PREFAB: missing or invalid prefab name')
        return
      }
      if (!PREFAB_NAME_RE.test(prefabName)) {
        sendError(clientId, 'SAVE_PREFAB: prefab name must match /^[a-z0-9-]+$/')
        return
      }

      if (!Array.isArray(entityIds) || entityIds.length === 0) {
        sendError(clientId, 'SAVE_PREFAB: at least one entity required')
        return
      }

      const entities = []
      for (const id of entityIds) {
        const entity = appRuntime.entities.get(id)
        if (!entity) {
          sendError(clientId, `SAVE_PREFAB: entity "${id}" not found`)
          return
        }
        entities.push(serializeEntity(entity))
      }

      prefabLibrary.save(prefabName, entities, metadata || {}).then(() => {
        _persistPrefabs()
        connections.send(clientId, MSG.PREFAB_SAVED, { ok: true, prefabName, entityCount: entities.length })
      }).catch(err => {
        sendError(clientId, `SAVE_PREFAB: ${err.message}`)
      })
    },
    [MSG.PLACE_PREFAB]: (payload, clientId) => {
      const { prefabName, position, rotation, overrides } = payload || {}

      if (!prefabName || typeof prefabName !== 'string') {
        sendError(clientId, 'PLACE_PREFAB: missing or invalid prefab name')
        return
      }
      if (!vecOK(position, 3)) {
        sendError(clientId, 'PLACE_PREFAB: invalid position, must be [x,y,z]')
        return
      }

      const rot = vecOK(rotation, 4) ? rotation : [0, 0, 0, 1]

      prefabSpawner.spawnPrefab(prefabName, position, rot, overrides || {})
        .then(rootId => {
          connections.broadcast(MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
          ctx.placedModelStorage?.persist(appRuntime)
          connections.send(clientId, MSG.PLACE_PREFAB, { ok: true, rootId })
        })
        .catch(err => {
          sendError(clientId, `PLACE_PREFAB: ${err.message}`)
        })
    },
    [MSG.GROUP_ENTITIES]: (payload, clientId) => {
      const { entityIds } = payload || {}

      if (!Array.isArray(entityIds) || entityIds.length === 0) {
        sendError(clientId, 'GROUP_ENTITIES: at least one entity required')
        return
      }

      const group = groupEntities(entityIds)
      if (!group) {
        sendError(clientId, 'GROUP_ENTITIES: no valid entities found')
        return
      }

      connections.send(clientId, MSG.GROUP_ENTITIES, { ok: true, groupId: group.id })
      connections.broadcast(MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
      ctx.placedModelStorage?.persist(appRuntime)
    }
  }

  function handle(type, payload, clientId) {
    const fn = HANDLERS[type]
    if (!fn) return false
    fn(payload, clientId)
    return true
  }

  return { handle, HANDLED_TYPES: new Set(Object.keys(HANDLERS).map(Number)) }
}
