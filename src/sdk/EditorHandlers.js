import { MSG } from '../protocol/MessageTypes.js'
import { vecOK } from '../shared/vecGuard.js'
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
  // ServerAPI.js is Node-only (statically imports 'node:http' + 'ws' at its own top level) -- a plain
  // top-level `import { bakeMinimapIfMissing } from './ServerAPI.js'` here pulls that whole module graph
  // in regardless of whether the function is ever called, which is fatal in the browser-Worker context
  // this file is ALSO loaded into (singleplayer's WorkerEntry.js -> ServerHandlers.js -> EditorHandlers.js,
  // no fs/http/ws there): the browser cannot resolve a bare `node:` specifier at all, so the whole Worker's
  // static import graph fails to evaluate with a fully-opaque, unattributable `error` event (no message/
  // filename/lineno -- confirmed live via a Worker-import bisection: every prior static import in this
  // chain loads cleanly, only adding this one import reproduces the crash) -- silently breaking EVERY
  // singleplayer boot, not just TERRAIN_SCULPT_ACK delivery (found live while investigating
  // terrain-sculpt-ack-broadcast-not-reaching-client: the ack was never swallowed downstream as the row's
  // candidate theories suspected, singleplayer's whole Worker was never completing WORKER_READY->INIT at
  // all). Deferred behind the same isNode guard this file already uses for node:fs/node:path -- ONLY
  // reachable (dynamically imported) on the real server, matching bakeMinimapIfMissing's only 2 call sites
  // below (both inside `if (isNode)`-reachable code paths: boot-time bake and terrain-reseed re-bake).
  // Specifier built at runtime, not a bare literal import() -- a bundler-based edge/DO build target
  // (esbuild via wrangler) statically resolves and bundles the ENTIRE ServerAPI.js graph (node:http,
  // ws, draco3d/draco3dgltf, sharp, @gltf-transform/core, ...) the instant it sees ANY reachable
  // import('./ServerAPI.js') syntax, regardless of whether `isNode` is runtime-false and this branch
  // never actually executes -- live-reproduced via a real `wrangler deploy --dry-run` build failing on
  // draco3d's own unconditional top-level require('fs')/require('path') (no browser/edge fallback in
  // that package at all), even though process.versions.node is genuinely undefined in the edge target
  // this file is ALSO loaded into (workerd without nodejs_compat) so `isNode` is correctly false and
  // this whole `if` block is dead code there -- esbuild cannot know that statically. Same fix class as
  // World.js's getJolt()/msgpack.js/game-fsm.js/TerrainPhysics.js this session: build the specifier
  // string via a function call so esbuild's constant-folding can't resolve it back to a literal
  // (a plain string-concat literal, e.g. 'Server'+'API.js', WAS still folded and still broke the
  // build -- confirmed live; a wrapping function call is what actually defeats it).
  const _serverApiPath = (() => './' + 'ServerAPI' + '.js')()
  _bakeMinimapIfMissing = (await import(_serverApiPath)).bakeMinimapIfMissing
}
const readdirSync = _fs?.readdirSync, existsSync = _fs?.existsSync
const readFileSync = _fs?.readFileSync, writeFileSync = _fs?.writeFileSync
const statSync = _fs?.statSync, mkdirSync = _fs?.mkdirSync
const realpathSync = _fs?.realpathSync
const unlinkSync = _fs?.unlinkSync, renameSync = _fs?.renameSync, rmSync = _fs?.rmSync

const resolvePath = _path?.resolve || (() => ''), joinPath = _path?.join || (() => ''), dirnamePath = _path?.dirname || (() => ''), pathSep = _path?.sep || '/'


// Client-supplied entity id for PLACE_APP/PLACE_MODEL/DUPLICATE (undo-history re-creation under the
// original id). Returns the id only when it is a well-formed, collision-free string; any other case
// returns null so the caller falls back to its own generated id. Never errors the placement.
function _clientSuppliedId(payload, appRuntime, key = 'entityId') {
  const id = payload?.[key]
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
  if (appRuntime.entities.has(id)) return null
  return id
}


// realpath-based containment check: a symlink inside rootDir could otherwise point outside it and let an editor client read/write arbitrary server files
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

// Same guarantee as containedReal (every existing ancestor realpath-verified, so a symlink anywhere
// on the path can't escape rootDir) but tolerates a target whose containing directory does not exist
// YET -- containedReal's one-level-up fallback only covers a missing leaf FILE, not a missing leaf
// DIRECTORY (a brand-new app's first file, e.g. apps/newapp/index.js when apps/newapp/ doesn't exist
// yet, has neither the file nor its parent realpath-able) -- found live via a direct WebSocket probe:
// SAVE_SOURCE on a not-yet-existing app returned the misleading "path escapes apps root" for a
// perfectly legitimate new-app-first-file request. Walks up from filePath until it finds the deepest
// EXISTING ancestor, realpath-verifies that ancestor is contained, then mkdirSync(recursive:true)s the
// missing suffix (already guaranteed traversal-free: filePath was resolvePath/joinPath-composed from
// rootDir, never from a raw client string with '..' segments left in it) before returning the final
// path for the caller to write. Returns null if even the deepest existing ancestor escapes rootDir.
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
      if (parent === existingAncestor) return null // hit filesystem root without finding an existing ancestor
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


// In-memory prefab registry, best-effort mirrored to data/prefabs.json when a real filesystem is available
// (Node server), inert (memory-only, cleared on restart) under the Worker/singleplayer runtime -- mirrors
// ctx.placedModelStorage's own Node-vs-Worker split rather than depending on it directly, so this stays
// self-contained in the file EditorHandlers.js owns.
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

  // Collaborative edit op log: records every editor operation and broadcasts it to
  // all other connected editors so they can replay it locally.
  const editOpLog = createEditOpLog()

  // Agent edit staging: agent-proposed edits stored server-side, pending approval/rejection.
  const agentEditServer = createAgentEditServer()

  // Prefab system: library for saving/loading entity groups, spawner for instantiating them into worlds
  const prefabLibrary = new PrefabLibrary(isNode ? process.cwd() : '.')
  const prefabSpawner = createPrefabSpawner(appRuntime, prefabLibrary)
  const PREFAB_NAME_RE = /^[a-z0-9-]+$/

  const COLLIDER_TYPES = new Set(['box', 'sphere', 'capsule', 'convex', 'trimesh', 'none'])

  // Shared inspector props for a placed primitive (box/sphere/capsule/cylinder). A primitive has no app module,
  // so these are the only editorProps it gets -- colour tint + a collider picker (as its own prop, since the
  // inspector's built-in colliderField is gated to models). Both write custom.<key>; _collider triggers a
  // server-side collider rebuild via syncEntityCollider on the next EDITOR_UPDATE.
  const PRIMITIVE_EDITOR_PROPS = [
    { key: 'color', type: 'color', label: 'Color', default: '#cccccc' },
    { key: '_collider', type: 'select', label: 'Collider', options: ['box', 'sphere', 'capsule', 'convex', 'none'], default: 'box' },
    // Material-authored wetness mask (ssr-material-wetness-mask-authoring PRD row): a flat box
    // primitive scaled thin+wide is the natural puddle/wet-road authoring shape, so this common prop
    // set gets it directly (not gated to placed-model). 0 = dry, 1 = fully wet; consumed client-side
    // by SSR.js via EntityLoader's userData.wetness tag (see EntityLoader.js repaintEntity/_tagMesh).
    { key: '_wetness', type: 'range', label: 'Wetness', min: 0, max: 1, step: 0.05, default: 0 },
  ]

  // dynamic bodies must be teleported (position set + velocity zeroed), not merely repositioned, or physics.step overwrites the write next tick
  function syncEntityCollider(entity, changes) {
    if (!ctx.physics || entity._physicsBodyId === undefined) return
    const isDynamic = entity.bodyType === 'dynamic'
    const colliderChanged = changes.custom && Object.prototype.hasOwnProperty.call(changes.custom, '_collider')
    const scaleChanged = !!changes.scale
    // must check before the isDynamic branch below or a collider-type pick on a dynamic entity is silently dropped
    if (colliderChanged || scaleChanged) { rebuildEntityCollider(entity); return }
    if (isDynamic) {
      if (changes.position) ctx.physics.setBodyPosition(entity._physicsBodyId, entity.position)
      if (changes.position || changes.rotation) ctx.physics.setBodyVelocity(entity._physicsBodyId, [0, 0, 0])
      return
    }
    if (changes.position || changes.rotation) ctx.physics._repositionBody?.(entity._physicsBodyId, entity.position, entity.rotation)
  }

  // falls back to a box on an invalid/unbuildable collider type so an entity is never left silently colliderless
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

  // Single ack path for a rejected/malformed editor mutation, so the client's toast('...','error') has something
  // to route from instead of the change being silently dropped (the vecOK/url guards below already existed;
  // this only makes their failure visible over the wire).
  function sendError(clientId, message, detail) {
    if (clientId == null) return
    connections.send(clientId, MSG.EDITOR_ERROR, { message, ...(detail || {}) })
  }

  // Spawns one empty/parent-only entity (no model, no app -- a plain transform node, the same shape
  // serializeWorld already keeps per its "parent-only entities" comment) at the centroid of the given
  // entity ids' WORLD positions, then reparents each id under it via the existing reparent() primitive
  // (world-transform-preserving, per AppRuntime.reparent). Returns the new group entity, or null if no
  // valid member entities were found.
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
          // dropped rather than applied if malformed, to avoid NaN-poisoning the broadcast snapshot -- now also
          // acked back to the requesting client so the failure is visible instead of a silent no-op.
          if (changes.position) { if (vecOK(changes.position, 3)) entity.position = changes.position; else sendError(clientId, 'EDITOR_UPDATE: malformed position, ignored', { entityId, field: 'position' }) }
          if (changes.rotation) { if (vecOK(changes.rotation, 4)) entity.rotation = changes.rotation; else sendError(clientId, 'EDITOR_UPDATE: malformed rotation, ignored', { entityId, field: 'rotation' }) }
          if (changes.scale) { if (vecOK(changes.scale, 3)) entity.scale = changes.scale; else sendError(clientId, 'EDITOR_UPDATE: malformed scale, ignored', { entityId, field: 'scale' }) }
          if (changes.custom) entity.custom = { ...entity.custom, ...changes.custom }
          // A live edit to custom._interactable must re-register/unregister the entity in the interactable set.
          if (changes.custom && Object.prototype.hasOwnProperty.call(changes.custom, '_interactable')) appRuntime._hydrateInteractable?.(entityId, entity)
          if (changes.bodyType) appRuntime.changeBodyType(entityId, changes.bodyType)
          // must run after changeBodyType, which synthesizes a box _bodyDef that would otherwise clobber a same-message collider-type pick
          syncEntityCollider(entity, changes)
          appRuntime.fireEvent(entityId, 'onEditorUpdate', changes)
          // Broadcast the edit op to all other connected editors for collaborative replay
          editOpLog.record(MSG.EDITOR_UPDATE, { entityId, changes }, clientId, (seq, op) => {
            connections.broadcast(MSG.EDIT_OP_LOG, op)
          })
          // A custom edit is a config edit: ctx.config overlays entity.custom, so fire onConfigChange so
          // apps re-derive setup-time state live -- editorProps now take effect without hand-rolled plumbing.
          if (changes.custom) appRuntime.contexts?.get(entityId)?._fireConfigChange?.()
          ctx.placedModelStorage?.persist(appRuntime)
          // A custom-field edit can change what a client-side SCENE_GRAPH consumer needs to show (e.g. the
          // Waypoint Timeline panel's order re-sort, SceneHierarchy's classify() reading node.custom.mesh) --
          // every other entity-mutating handler in this file (PLACE_MODEL/PLACE_APP/DESTROY_ENTITY/etc, below)
          // already re-broadcasts SCENE_GRAPH after its edit; EDITOR_UPDATE was the one silent exception, so a
          // custom-field-only edit (position/rotation/scale gizmo drags already visually move the mesh directly
          // client-side and don't need this) left every OTHER connected client's cached scene graph stale.
          if (changes.custom) connections.broadcast(MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
        }
      }
    },
    [MSG.PLACE_MODEL]: (payload, clientId) => {
      const { url, position } = payload || {}
      if (url && typeof url === 'string') {
        // Optional client-supplied id lets the editor's undo history re-create an entity under its
        // ORIGINAL id (undo-of-delete replays this exact spawn). Validated + collision-checked; any
        // rejection silently falls back to a fresh generated id rather than erroring the placement.
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
      // synthetic appName like 'box-static' is not a real app def; spawns a plain always-static primitive entity instead
      const PRIMITIVE = { 'box-static': 'box', 'sphere-static': 'sphere', 'capsule-static': 'capsule', 'cylinder-static': 'cylinder' }
      if (appName && PRIMITIVE[appName]) {
        const meshKind = PRIMITIVE[appName]
        // Optional client-supplied id (undo-history re-creation under the original id) -- see PLACE_MODEL.
        const id = _clientSuppliedId(payload, appRuntime) || appName + '-' + Math.random().toString(36).slice(2, 8)
        const pos = vecOK(position, 3) ? position : [0, 1, 0]
        // scale is a top-level spawnEntity field (entity.scale, what the client renderer/EntityLoader
        // actually reads -- see spawnEntity's own config.scale handling), NOT a custom.* field like
        // color/mesh -- pulled out of config here so a caller (e.g. ProcgenPanel's Place-into-World,
        // which generates differently-sized cells/segments) can size a placed primitive on creation
        // instead of only via a follow-up numeric-scale gizmo drag. Same vecOK guard EDITOR_UPDATE's
        // own scale-change path already uses; a malformed/absent scale silently falls back to
        // spawnEntity's own [1,1,1] default rather than erroring the whole placement.
        const { scale, ...customConfig } = config || {}
        const spawnCfg = { position: pos, bodyType: 'static', custom: { mesh: meshKind, ...customConfig } }
        if (vecOK(scale, 3)) spawnCfg.scale = scale
        appRuntime.spawnEntity(id, spawnCfg)
        // A placed primitive previously shipped editorProps:[] -- zero inspector props, so a maker couldn't even
        // set its colour. Give every primitive a shared prop set: a colour tint and a collider picker (its own
        // prop, since the inspector's colliderField is model-gated). Both flow through the custom.<key> path the
        // inspector already writes (custom._collider rebuilds the body via syncEntityCollider).
        connections.send(clientId, MSG.EDITOR_SELECT, { entityId: id, editorProps: PRIMITIVE_EDITOR_PROPS })
        connections.broadcast(MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
        ctx.placedModelStorage?.persist(appRuntime)
        return
      }
      if (appName && appRuntime._appDefs.has(appName)) {
        // Optional client-supplied id (undo-history re-creation under the original id) -- see PLACE_MODEL.
        const id = _clientSuppliedId(payload, appRuntime) || appName + '-' + Math.random().toString(36).slice(2, 8)
        const pos = vecOK(position, 3) ? position : [0, 0, 0]
        const appDef = appRuntime._appDefs.get(appName)
        const appServerDef = appDef?.server || appDef
        const editorProps = appServerDef?.editorProps || appDef?.editorProps || []
        // Seed each editorProp's declared default into the spawn CONFIG (which becomes entity._config, the base
        // layer ctx.config reads under the custom overlay). A freshly-placed app then runs with its declared
        // defaults instead of undefined, without needing the maker to touch every field first. Seeding _config
        // (not custom) is deliberate: many apps reassign ctx.entity.custom={...} wholesale in setup, which would
        // wipe a custom seed -- _config survives, and a later editorProps edit writes custom.<key> to override it.
        const seeded = { ...(config || {}) }
        for (const f of editorProps) if (f && f.key && f.default !== undefined && seeded[f.key] === undefined) seeded[f.key] = f.default
        // spawnEntity's bodyType defaults to 'static' with no per-app override path, which silently drops every
        // position write from an app whose entity needs to actually move (e.g. combat-bot's steering/wander --
        // SnapshotEncoder never encodes a 'static' entity's per-tick position at all). An app declares its
        // required body type via appDef.bodyType (server or top-level, matching editorProps' own dual-location
        // convention above); default stays 'static' for every existing app that never declares one, so this is
        // additive-only and changes zero behavior for anything that doesn't opt in.
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
      // A DECLARED description (appDef.description or appDef.server.description) is the authoritative
      // maker-facing blurb and works in EVERY runtime -- including the singleplayer BrowserServer (Worker,
      // no fs), which previously always shipped description:'' so its Add menu had zero descriptions.
      const declaredDesc = (appDef) => {
        const serverMod = appDef?.server || appDef
        return (typeof appDef?.description === 'string' && appDef.description)
            || (typeof serverMod?.description === 'string' && serverMod.description) || ''
      }
      // Static channel-usage scrape for the HookFlow wire channel-picker (editor-node-graph-wire-channel-picker-
      // multi-target): the runtime EventBus (src/apps/EventBus.js) is a flat global bus with zero subscription
      // registry to introspect live -- ctx.bus.on(channel) call sites only exist as source text, so "what
      // channels does this app listen on / emit" is answered by regexing the app's own index.js for
      // `bus.on('literal'`/`bus.once('literal'` (listens) and `bus.emit('literal'` (emits), literal-string-only
      // by construction (a template-literal or variable channel arg is real but not statically discoverable --
      // an honest gap, not silently misreported: those calls just don't match and are omitted, never guessed).
      // Node-only (needs readFileSync on the real apps/ tree), matching the description-scrape's existing
      // Node-vs-Worker split below -- the non-Node/singleplayer-BrowserServer branch ships empty arrays for
      // both, an honest degrade rather than a fabricated list.
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
            // declared wins; else fall back to scraping the file's first // comment (Node-only).
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
          // Singleplayer, non-index file: apps/*.js are real static files the gh-pages build already
          // deploys (BrowserServer.connect() fetches app sources the same way) -- fetch the exact
          // requested path instead of always returning appLoader's cached CLIENT module for index.js,
          // which silently showed the wrong content for any non-index file opened from the fs tree.
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
          // containedReal requires the target (or its immediate parent) to already exist; a brand-new
          // app's first file has neither, so fall back to containedRealCreateParent which walks up to
          // the deepest existing ancestor, verifies THAT is contained, then mkdirs the missing chain.
          const real = containedReal(filePath, appsRoot) || containedRealCreateParent(filePath, appsRoot)
          if (real) {
            // Conflict guard: if the caller loaded the file at baseMtimeMs and disk now carries a
            // later mtime, someone else (an agent process writing directly, or another browser tab)
            // changed it since -- refuse the stale-base overwrite instead of silently clobbering it.
            let onDiskMtime = null
            try { onDiskMtime = existsSync(real) ? statSync(real).mtimeMs : null } catch {}
            if (baseMtimeMs != null && onDiskMtime != null && onDiskMtime > baseMtimeMs) {
              connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source: null, conflict: true, error: 'file changed on disk since last load', mtimeMs: onDiskMtime, diskSource: readFileSync(real, 'utf8') })
              return
            }
            // Adversarial VERIFY sweep found writeFileSync here had no try/catch: any throw (disk full,
            // permission denied, an OS-specific path edge case) left the client with NO reply at all --
            // the exact silent-hang symptom class this session's Inspector-range bug already produced,
            // now guarded against for a different root cause on this specific write.
            try {
              writeFileSync(real, source, 'utf8')
              const mtimeMs = statSync(real).mtimeMs
              connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source, mtimeMs })
              // Broadcast the edit op to all other connected editors for collaborative replay
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
          // Singleplayer has no real fs to persist to; this hot-loads the edit into the live
          // session (existing behavior for index.js, unchanged) but it is NOT a disk write --
          // reloading the page loses it, same as any other in-memory-only singleplayer state.
          ctx.appLoader?.loadFromString(appName, source)
          connections.send(clientId, MSG.SOURCE, { appName, file: 'index.js', source })
          connections.broadcast(MSG.APP_MODULE, { app: appName, code: source, trusted: ctx.currentWorldDef?.trustedApps?.includes(appName) || undefined })
          // Broadcast the edit op to all other connected editors for collaborative replay
          editOpLog.record(MSG.SAVE_SOURCE, { appName, file: 'index.js', source }, clientId, (seq, op) => {
            connections.broadcast(MSG.EDIT_OP_LOG, op)
          })
        } else {
          // A non-index file (helper module) has no live hot-load path at all in singleplayer
          // (only appLoader.loadFromString(appName, ...) exists, and it always targets index.js) --
          // report the real constraint instead of silently pretending the edit was saved.
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
        // must include the path separator or a prefix-sibling dir (apps/world-evil/x) passes startsWith(worldsRoot)
        if (filePath !== worldsRoot && !filePath.startsWith(worldsRoot + pathSep)) { connections.send(clientId, MSG.WORLD_SAVED, { ok: false, error: 'path escapes apps/world' }); return }
        // requires explicit overwrite:true so re-typing an existing world name doesn't silently destroy it
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
    // seed changes require a full re-derivation of sampler/frame/heightFn (no live-mutate path); broadcasts to all clients so render doesn't desync from collision
    [MSG.TERRAIN_RESEED]: (payload, clientId) => {
      const seed = Number.isFinite(payload?.seed) ? (payload.seed | 0) : null
      if (seed === null) { connections.send(clientId, MSG.TERRAIN_CONFIG, { ok: false, error: 'invalid seed' }); return }
      const terrainEnt = [...appRuntime.entities.values()].find(e => e._appName === 'terrain' || e.app === 'terrain')
      const wd = ctx.currentWorldDef
      const wdEnt = wd && Array.isArray(wd.entities) ? wd.entities.find(e => e.app === 'terrain') : null
      const baseCfg = (wdEnt && wdEnt.config) || (wd && wd.terrain) || (terrainEnt && terrainEnt.custom) || {}
      const newCfg = { ...baseCfg, seed }
      if (wdEnt) wdEnt.config = newCfg
      else if (wd) wd.terrain = newCfg
      ;(async () => {
        try {
          if (ctx._terrainStreamer?.stop) ctx._terrainStreamer.stop()
          if (ctx._terrainStreamer?._trunkStreamer?.stop) ctx._terrainStreamer._trunkStreamer.stop()
          if (ctx._terrainStreamer?._rockStreamer?.stop) ctx._terrainStreamer._rockStreamer.stop()
          const { setupTerrainStreaming } = await import('../terrain/TerrainPhysics.js')
          ctx._terrainStreamer = await setupTerrainStreaming({ physics: ctx.physics, playerManager: ctx.playerManager, terrain: newCfg })
          // Recompute _minimap (same shape ServerAPI.js/WorkerEntry.js compute at boot) so the
          // TERRAIN_CONFIG broadcast carries the NEW seed's base path -- without this, every connected
          // client's onTerrainConfig has no way to learn the minimap artifact moved (worldId/process.env
          // are server-only), so the HUD/editor minimap stays pinned to the pre-reseed image forever.
          const worldId = wd?.name || (typeof process !== 'undefined' && process.env?.WORLD) || 'world'
          const newMinimap = Number.isFinite(newCfg.seed) ? { base: `/apps/world/${worldId}.${newCfg.seed | 0}.minimap`, center: newCfg.center || [0, 0], extent: Number.isFinite(newCfg.minimapExtent) ? newCfg.minimapExtent : Math.min(newCfg.radius * 0.25, 16384) } : null
          if (wd) wd._minimap = newMinimap
          connections.broadcast(MSG.TERRAIN_CONFIG, { ok: true, config: newCfg, minimap: newMinimap })
          // Re-bake the top-down minimap for the NEW seed so the HUD/editor minimap (once wired, see PRD row
          // minimap-hud-editor-ui-integration) never shows the OLD planet shape after a live reseed. Same
          // fire-and-forget discipline as the boot-time bake in loadWorld() above -- never awaited/blocking this
          // handler's response, since the full CPU height+climate grid sample takes several seconds (see
          // bakeMinimapIfMissing's own comment). force:true because a reseed can in principle land back on a
          // seed matching a stale on-disk bake (e.g. re-entering a previously-used seed); without force that
          // stale file would be silently reused instead of freshly derived from the current (possibly-changed)
          // radius/anchorDir/reliefScale in newCfg. Uses the SAME worldId derivation ServerAPI.js's boot-time
          // bake uses (worldDef.name || process.env.WORLD || 'world') so the reseed writes the exact filename a
          // consumer already resolved from the boot-time bake, not a differently-named sibling artifact.
          // isNode-gated (see this file's top-of-file comment): a browser Worker singleplayer session has
          // no writable minimap-artifact disk path to bake to, and even a dynamic import() of ServerAPI.js
          // there would still fail to resolve its top-level 'ws'/'node:http' specifiers -- lazy-import only
          // ever runs on the real server.
          if (isNode && newCfg.enabled !== false && Number.isFinite(newCfg.seed)) {
            _bakeMinimapIfMissing?.(worldId, newCfg, { force: true }).catch(e => console.error('[minimap] reseed re-bake failed:', e?.message || e))
          }
        } catch (e) {
          console.error('[terrain] reseed failed:', e?.message || e)
          connections.send(clientId, MSG.TERRAIN_CONFIG, { ok: false, error: e?.message || String(e) })
        }
      })()
    },
    // Terrain sculpting brush (raise + lower + smooth + flatten, src/terrain/HeightDelta.js). Applies a
    // stroke to the live streamer's shared delta-override store, then re-cooks the collider around the
    // current center (streamer.resculpt(), a lightweight re-bake reusing the existing heightFn closure
    // -- NOT the full reseed teardown/rebuild TERRAIN_RESEED above uses, since the base sampler/frame/
    // baker are unchanged by a sculpt). Acks with cellCount/strokeCount so the editor UI can confirm
    // the stamp landed without a full heightfield read-back of its own.
    // 'lower' is a negative-strength raise (same cosine falloff, same applyRaiseBrush) -- the client
    // always sends a positive `strength` (a magnitude, e.g. from a UI number input), so 'lower' negates
    // it here rather than trusting the client to send a signed value. 'smooth' and 'flatten' have a
    // DIFFERENT strength contract than raise/lower: a [0,1] blend factor (0=no change, 1=fully applied),
    // not a metres magnitude -- clamped here defensively even though HeightDelta's smooth/flatten apply
    // fns already clamp internally, so a malformed/malicious payload can't request an out-of-contract
    // value that would only be caught deep in the delta layer. 'flatten' additionally has NO required
    // strength (defaults to 1, fully flattened) since "how flat" is optional, unlike raise/lower/smooth
    // where a zero/missing strength is a true no-op stroke and rejected outright.
    [MSG.TERRAIN_SCULPT]: (payload, clientId) => {
      const { brush, x, z, radius } = payload || {}
      let { strength } = payload || {}
      const validBrush = brush === 'raise' || brush === 'lower' || brush === 'smooth' || brush === 'flatten'
      if (brush === 'flatten' && !Number.isFinite(strength)) strength = 1 // flatten strength is optional; default to fully-flattened
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
      // deltaBefore/deltaAfter: the sculpt layer's own contribution at the brush center (not the full
      // base+delta height for raise/lower/smooth, since baseHeightFn wasn't previously exposed off
      // streamer) -- lets a caller (editor UI, or a live witness) confirm the stroke's real numeric
      // effect without a separate heightfield read-back message. Sampled at the exact (x,z) the brush
      // was centered on, so a 'raise' shows a positive delta increase and 'lower' a negative one,
      // directly readable from this ack alone.
      const deltaBefore = streamer.heightDelta.deltaAt(x, z)
      let touched = 0, targetHeight
      if (brush === 'smooth') {
        ;({ touched } = streamer.heightDelta.applySmoothBrush(x, z, radius, Math.min(1, Math.abs(strength))))
      } else if (brush === 'flatten') {
        // Target elevation = the COMPOSED surface (base + any existing delta) at the brush center --
        // the surface the user actually clicked on -- sampled once here so every touched cell converges
        // toward that one flat plane rather than each cell flattening toward its own local height.
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
          connections.broadcast(MSG.TERRAIN_SCULPT_ACK, ack) // broadcast: every client's own collider-adjacent placement queries should reflect the sculpt too
        } catch (e) {
          console.error('[terrain] sculpt resculpt failed:', e?.message || e)
          connections.send(clientId, MSG.TERRAIN_SCULPT_ACK, { ok: false, error: e?.message || String(e) })
        }
      })()
    },
    // Paint-biome brush (src/terrain/BiomeOverride.js) -- fourth/final slice of the sculpt-brush epic.
    // Applies a stroke to the live streamer's shared biome-override store, then re-cooks the trunk/rock
    // collider streamers' chunk caches (streamer.repaintBiome(), NOT streamer.resculpt() -- climate never
    // affects height, so the TERRAIN heightfield itself needs no rebuild here, only whichever veg/rock
    // collider streamers exist and cache classify() output keyed off the now-changed anchorField).
    [MSG.TERRAIN_PAINT_BIOME]: (payload, clientId) => {
      const { biome, x, z, radius } = payload || {}
      let { strength } = payload || {}
      const preset = BIOME_PRESETS[biome]
      if (!Number.isFinite(strength)) strength = 1 // optional, same default-to-fully-applied contract as flatten
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
          connections.broadcast(MSG.TERRAIN_PAINT_BIOME_ACK, ack) // broadcast: every client's own collider-adjacent placement queries should reflect the paint too
        } catch (e) {
          console.error('[terrain] paint-biome repaint failed:', e?.message || e)
          connections.send(clientId, MSG.TERRAIN_PAINT_BIOME_ACK, { ok: false, error: e?.message || String(e) })
        }
      })()
    },
    // Server-authoritative grass decal stamp (src/terrain/GrassDecal.js) -- multiplayer follow-up to the
    // client-only/in-memory grass decal regrowth system (see MSG.GRASS_DECAL_STAMP/_SYNC's own comment).
    // ctx._grassDecal is lazily created here on first use (not at terrain-streamer boot like heightDelta
    // above): decals are a pure visual-only world-state layer with no collider/physics dependency, so
    // there is no reason to gate their existence on the terrain streamer having successfully started, and
    // lazy-init means zero boot-path changes across the 3 independent boot sequences (server.js/
    // ServerAPI.js real multiplayer, WorkerEntry.js singleplayer-in-Worker) that each construct ctx
    // separately. `strength`/`radius` sent by the client are the same optional/positive-magnitude
    // contract GrassDecal.markScorched already validates internally, but a bad payload is still rejected
    // HERE first (mirrors TERRAIN_SCULPT's own defensive-validate-before-mutate discipline above) so a
    // malformed/malicious payload never even reaches the store as a wasted mutation + wasted broadcast.
    [MSG.GRASS_DECAL_STAMP]: (payload, clientId) => {
      const { x, z, radius } = payload || {}
      const strength = Number.isFinite(payload?.strength) ? payload.strength : 1
      if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0 || strength === 0) {
        connections.send(clientId, MSG.GRASS_DECAL_SYNC, { ok: false, error: 'invalid grass decal payload' })
        return
      }
      if (!ctx._grassDecal) ctx._grassDecal = createGrassDecal()
      // markScorched returns the exact appliedAt (real wall-clock ms) its internal now() stamped this
      // stroke with -- threaded straight into the broadcast so every client seeds its own local store
      // (via _seedStamp) with an IDENTICAL decay-clock start, not a slightly-different one re-derived from
      // each client's own receive-time clock (which would desync the regrowth curve client-to-client).
      const { touched, appliedAt } = ctx._grassDecal.markScorched(x, z, radius, strength)
      // broadcast (not send-to-sender-only): every OTHER connected client must see this player's stamp
      // too, same "everyone's world-state view must match" rationale as TERRAIN_SCULPT_ACK's broadcast.
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
        // parentId null/undefined -> reparent to root. reparent() rejects cycles.
        if (appRuntime.reparent(entityId, parentId || null)) {
          ctx.placedModelStorage?.persist(appRuntime)
          connections.broadcast(MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
        }
      }
    },
    [MSG.DUPLICATE_ENTITY]: (payload, clientId) => {
      const { entityId } = payload || {}
      if (entityId && appRuntime.entities.has(entityId)) {
        // Optional client-supplied copyId keeps a duplicate's id stable across undo/redo (undo destroys
        // the copy; redo re-duplicates into the SAME id so later history entries still reference it).
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
    // One-key "group selected under new empty parent": spawns a transform-only entity at the selection's
    [MSG.GET_EDITOR_PROPS]: (payload, clientId) => {
      const { entityId } = payload || {}
      if (entityId) {
        const entity = appRuntime.entities.get(entityId)
        const appName = entity?._appName
        const appDef = appName ? appRuntime._appDefs.get(appName) : null
        const serverMod = appDef?.server || appDef
        // A placed primitive (custom.mesh set, no app) gets the shared primitive prop set, so re-selecting it
        // later still surfaces colour + collider -- not the empty list an app-less entity would otherwise yield.
        const editorProps = serverMod?.editorProps || (entity?.custom?.mesh && !appName ? PRIMITIVE_EDITOR_PROPS : [])
        connections.send(clientId, MSG.EDITOR_PROPS, { entityId, editorProps })
      }
    },
    // Multi-user presence: relay a human editor's own selection/drag state to every OTHER connected editor
    // (never echoed back to the sender -- that client already has its own local selection UI). entityId:null
    // means "cleared" (deselected, or dragging ended) -- the client-side presence renderer treats a null the
    // same as a PLAYER_LEAVE for that clientId: remove the indicator. clientId doubles as the presence identity
    // (no server-side player-name registry exists to key on instead; a short id is enough to distinguish "someone
    // else" and is already how PLAYER_LEAVE identifies a departed peer).
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
        // Singleplayer (Worker, no real fs -- readdirSync/directory enumeration is genuinely
        // impossible here): the gh-pages build step already copies every apps/*.js file into the
        // deployed dist/ (BrowserServer.connect() fetches app sources from there), so the FILES
        // themselves are real and fetchable -- only directory ENUMERATION is missing. The build also
        // writes dist/apps/apps-fs-manifest.json (a flat sorted file-path list) precisely to cover
        // that gap; fetch it and build the same {name,type,children,size,binary} tree shape
        // LIST_FS_TREE's real-fs branch produces, so EditorFsBrowse.js needs no singleplayer-specific
        // code path at all.
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
      // containedReal requires the path to already exist to realpath it; a not-yet-created dir is checked via its parent instead.
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
      // Deleting apps/<name>(/index.js) while entities are live under it: tear each down first so no
      // dangling app reference survives the disk delete (mirrors HotReloadQueue's own teardown-then-reattach).
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
        // Real fs rename is atomic for both files and directories -- no read-all/write-all/delete-all
        // IDB-style workaround needed (that shape only exists because thebird's flat-keyed IndexedDB
        // store has no native rename op).
        renameSync(fromReal, to)
        connections.send(clientId, MSG.FS_OP_RESULT, { op: 'rename', path, newPath, ok: true })
        connections.broadcast(MSG.FS_TREE_CHANGED, {})
      } catch (e) {
        connections.send(clientId, MSG.FS_OP_RESULT, { op: 'rename', path, ok: false, error: sanitizeFsError(e, path) })
      }
    },
    // Collaborative edit op log replay: a late-joining editor requests all ops since a given seq.
    [MSG.EDIT_OP_LOG_SINCE]: (payload, clientId) => {
      const sinceSeq = payload?.sinceSeq
      const { ops, latestSeq } = editOpLog.getOpsSince(sinceSeq)
      connections.send(clientId, MSG.EDIT_OP_LOG, { ops, latestSeq, replay: true })
    },
    // Agent edit staging: an agent proposes a set of edits.
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
      // Broadcast the proposal to all other connected editors for ghost-preview rendering
      connections.broadcast(MSG.AGENT_EDIT_PROPOSE, { proposalId, edits: proposal, proposedBy: proposedBy || 'agent' })
    },
    // Agent edit staging: list all proposals (optionally filtered by status).
    [MSG.AGENT_EDIT_LIST]: (payload, clientId) => {
      const filterStatus = payload?.status || null
      const proposals = agentEditServer.list(filterStatus)
      connections.send(clientId, MSG.AGENT_EDIT_LIST, { proposals, pendingCount: agentEditServer.pendingCount() })
    },
    // Agent edit staging: approve one specific edit or all edits in a proposal.
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
      // Broadcast the approval to all other editors
      connections.broadcast(MSG.AGENT_EDIT_APPROVE, { approved: results, approvedBy: approvedBy || 'editor' })
      // Apply approved edits to the real source files (Node-only; singleplayer is a no-op)
      for (const edit of results) {
        if (isNode && writeFileSync) {
          try {
            const appsRoot = resolvePath(process.cwd(), 'apps')
            const filePath = resolvePath(joinPath(appsRoot, edit.appName, edit.file))
            const real = containedReal(filePath, appsRoot) || containedRealCreateParent(filePath, appsRoot)
            if (real) {
              writeFileSync(real, edit.source, 'utf8')
              // Broadcast the op to all other editors for collaborative replay
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
      // Remove approved edits from staging
      if (proposalId) agentEditServer.removeAll(proposalId)
    },
    // Agent edit staging: reject one specific edit or all edits in a proposal.
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
      // Broadcast the rejection to all other editors
      connections.broadcast(MSG.AGENT_EDIT_REJECT, { rejected: results, rejectedBy: rejectedBy || 'editor' })
      // Remove rejected edits from staging
      if (proposalId) agentEditServer.removeAll(proposalId)
    },
    // Save selected entities as a reusable prefab
    [MSG.SAVE_PREFAB]: (payload, clientId) => {
      const { prefabName, entityIds, metadata } = payload || {}

      // Validate prefab name
      if (!prefabName || typeof prefabName !== 'string') {
        sendError(clientId, 'SAVE_PREFAB: missing or invalid prefab name')
        return
      }
      if (!PREFAB_NAME_RE.test(prefabName)) {
        sendError(clientId, 'SAVE_PREFAB: prefab name must match /^[a-z0-9-]+$/')
        return
      }

      // Validate entity list
      if (!Array.isArray(entityIds) || entityIds.length === 0) {
        sendError(clientId, 'SAVE_PREFAB: at least one entity required')
        return
      }

      // Gather entities to save
      const entities = []
      for (const id of entityIds) {
        const entity = appRuntime.entities.get(id)
        if (!entity) {
          sendError(clientId, `SAVE_PREFAB: entity "${id}" not found`)
          return
        }
        entities.push(serializeEntity(entity))
      }

      // Save to prefab library (async, but we don't await here to avoid blocking the handler)
      prefabLibrary.save(prefabName, entities, metadata || {}).then(() => {
        _persistPrefabs()
        connections.send(clientId, MSG.PREFAB_SAVED, { ok: true, prefabName, entityCount: entities.length })
      }).catch(err => {
        sendError(clientId, `SAVE_PREFAB: ${err.message}`)
      })
    },
    // Spawn entities from a saved prefab into the world at a given position
    [MSG.PLACE_PREFAB]: (payload, clientId) => {
      const { prefabName, position, rotation, overrides } = payload || {}

      // Validate inputs
      if (!prefabName || typeof prefabName !== 'string') {
        sendError(clientId, 'PLACE_PREFAB: missing or invalid prefab name')
        return
      }
      if (!vecOK(position, 3)) {
        sendError(clientId, 'PLACE_PREFAB: invalid position, must be [x,y,z]')
        return
      }

      const rot = vecOK(rotation, 4) ? rotation : [0, 0, 0, 1]

      // Spawn prefab asynchronously (don't await to avoid blocking the message handler)
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
    // Group multiple entities under a new parent entity
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
