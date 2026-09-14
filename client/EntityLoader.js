import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { MeshoptSimplifier } from '/node_modules/meshoptimizer/meshopt_simplifier.js'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
import { fetchCached } from './ModelCache.js'
import { STRINGS } from './core/strings.js'
import { createStaticInstanceStore } from './core/StaticInstanceStore.js'
import { RenderControls } from './core/RenderControls.js'
import { SKIP_MATS_SET, PLACEHOLDER_DIMS, MESH_BUILDERS, LOD_CONFIGS, MAX_CONCURRENT_LOADS_INITIAL, MAX_CONCURRENT_LOADS_RUNTIME, _forceDoubleSide, _buildSoftbodyGeometry, _rewriteSoftbodyGeometry, _makeLabelSprite, _fluidCapacityFor, _buildFluidMesh, _rewriteFluidMesh, _buildFluidSurfaceMesh, _rewriteFluidSurfaceMesh } from './EntityLoaderMeshBuild.js'

const _primGeoCache = new Map()
const _primMatCache = new Map()
const _isKeyable = v => v === undefined || v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'
function _primGeoKey(t, c) {
  switch (t) {
    case 'cylinder': return `cylinder|${c.r || 0.4}|${c.h || 0.1}|${c.seg || 16}`
    case 'sphere': return `sphere|${c.r || 0.5}|${c.seg || 16}`
    case 'capsule': return `capsule|${c.r || 0.3}|${c.h || 1.8}|${c.cap || 4}|${c.seg || 16}`
    default: return `box|${c.sx || 1}|${c.sy || 1}|${c.sz || 1}`
  }
}
function _sharedPrimitiveGeometry(geoType, c) {
  const t = MESH_BUILDERS[geoType] ? geoType : 'box'
  if (!(_isKeyable(c.sx) && _isKeyable(c.sy) && _isKeyable(c.sz) && _isKeyable(c.r) && _isKeyable(c.h) && _isKeyable(c.seg) && _isKeyable(c.cap))) return MESH_BUILDERS[t](c)
  const key = _primGeoKey(t, c)
  let g = _primGeoCache.get(key)
  if (!g) { g = MESH_BUILDERS[t](c); g.userData._spointShared = true; _primGeoCache.set(key, g) }
  return g
}
function _sharedPrimitiveMaterial(c) {
  const color = c.color ?? 0xff8800, roughness = c.roughness ?? 1, metalness = c.metalness ?? 0, emissive = c.emissive ?? 0x000000, emissiveIntensity = c.emissiveIntensity ?? 0
  if (!(_isKeyable(color) && _isKeyable(roughness) && _isKeyable(metalness) && _isKeyable(emissive) && _isKeyable(emissiveIntensity))) return new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity })
  const key = `${color}|${roughness}|${metalness}|${emissive}|${emissiveIntensity}`
  let m = _primMatCache.get(key)
  if (!m) { m = new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity }); m.userData._spointShared = true; _primMatCache.set(key, m) }
  return m
}
const _n = v => (v == null ? undefined : v)
function _paintRecordFrom(c) { return { color: _n(c.color), emissive: _n(c.emissive), emissiveIntensity: _n(c.emissiveIntensity), roughness: _n(c.roughness), metalness: _n(c.metalness), _wetness: _n(c._wetness) } }
function _disposeOwned(c) {
  if (c.geometry && !(c.geometry.userData && c.geometry.userData._spointShared)) c.geometry.dispose()
  if (c.material) { const ms = Array.isArray(c.material) ? c.material : [c.material]; for (const mm of ms) if (mm && !(mm.userData && mm.userData._spointShared)) mm.dispose() }
}
const _urlLoads = new Map()
const _labelSprites = new Map()

function _extractInteriorTrimesh(model) {
  const verts = [], idxs = []; let off = 0; const _tv = new THREE.Vector3()
  model.traverse(c => {
    if (!c.isMesh || !c.visible) return
    const mn = (c.material?.name || '').toLowerCase()
    if (SKIP_MATS_SET.has(mn)) return
    const pa = c.geometry.attributes.position, gi = c.geometry.index, mat = c.matrixWorld, vc = pa.count
    for (let i = 0; i < vc; i++) { _tv.set(pa.getX(i), pa.getY(i), pa.getZ(i)).applyMatrix4(mat); verts.push(_tv.x, _tv.y, _tv.z) }
    if (gi) for (let i = 0; i < gi.count; i++) idxs.push(gi.getX(i) + off); else for (let i = 0; i < vc; i++) idxs.push(i + off)
    off += vc
  })
  return { verts, idxs }
}

export function createEntityLoader(scene, gltfLoader, cam, loadingMgr, patchGLB, sceneGraph, modelPool = null, opts = {}) {
  let _onMeshReady = null, _onTrimeshReady = null
  const _useStaticInstanceStore = !!opts.useStaticInstanceStore
  const staticInstanceStore = _useStaticInstanceStore ? createStaticInstanceStore() : null
  const _renderer = opts.renderer || null
  const _fluidMeshes = new Map()
  const entityMeshes = new Map()
  const _animatedEntities = []
  const _vehicleEntities = []
  const _entityMixers = new Map()
  function _setEntityClip(mesh, clipName, { loop = true, fade = 0.25 } = {}) {
    const actions = mesh?.userData?._actions; if (!actions || !clipName) return
    const next = actions.get(clipName); if (!next || mesh.userData._curClip === clipName) return
    const prev = mesh.userData._curClip ? actions.get(mesh.userData._curClip) : null
    next.reset(); next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity); next.enabled = true; next.setEffectiveWeight(1); next.play()
    if (prev && prev !== next) next.crossFadeFrom(prev, fade, false);
    mesh.userData._curClip = clipName
  }
  const _hullMeshes = new Map()
  const _entityColliders = new Map()
  const entityParentMap = new Map()
  const pendingLoads = new Set()
  const loadQueue = []
  const _parsedGltfCache = new Map()
  const _parsedGltfInflight = new Map()
  const _parsedGltfRefCount = new Map()
  const _discoveredModelUrls = new Set()
  const _bvhQueue = []
  const _lodUpgradeQueue = []
  let _bvhScheduled = false, _lodUpgradeScheduled = false, _activeLoads = 0
  const _matCache = new Map()

  const _releaseGltfRef = (url) => {
    const n = (_parsedGltfRefCount.get(url) || 1) - 1
    _parsedGltfRefCount.set(url, n)
    if (n <= 0 && !_parsedGltfInflight.has(url)) { _parsedGltfCache.delete(url); _parsedGltfRefCount.delete(url) }
  }

  let _disposed = false
  const _ric = typeof requestIdleCallback !== 'undefined' ? (fn) => requestIdleCallback(fn, { timeout: 16 }) : (fn) => setTimeout(fn, 16)
  function _scheduleBvhBuild(meshes) {
    for (const m of meshes) _bvhQueue.push(m)
    if (_bvhScheduled) return
    _bvhScheduled = true
    const run = (dl) => {
      while (_bvhQueue.length > 0 && (!dl || dl.timeRemaining() > 2)) {
        const g = _bvhQueue.shift().geometry
        g.computeBoundsTree()
        if (!g.boundingSphere) g.computeBoundingSphere()
      }
      if (_bvhQueue.length > 0) _ric(run); else _bvhScheduled = false
    }
    _ric(run)
  }

  function _simplifyObject(object, ratio) {
    object.traverse(child => {
      if (!child.isMesh || !child.geometry) return
      let indexed = child.geometry
      if (!indexed.index) try { indexed = BufferGeometryUtils.mergeVertices(indexed) } catch (e) { return }
      if (!indexed.index) return
      const targetCount = Math.floor(indexed.index.array.length * ratio / 3) * 3; if (targetCount <= 0) return
      try {
        const si = MeshoptSimplifier.simplify(indexed.index.array, indexed.attributes.position.array, 3, targetCount, 1e-2)
        const ng = indexed.clone(); ng.setIndex(new THREE.BufferAttribute(si, 1)); child.geometry = ng
      } catch (e) { }
    })
  }

  function _scheduleLodUpgrades() {
    if (_lodUpgradeScheduled || _lodUpgradeQueue.length === 0) return
    _lodUpgradeScheduled = true
    const run = (dl) => {
      while (_lodUpgradeQueue.length > 0 && (!dl || dl.timeRemaining() > 8)) {
        const { lod, model, cfg } = _lodUpgradeQueue.shift()
        if (!lod.parent && lod !== scene) continue
        let triCount = 0
        model.traverse(c => { if (c.isMesh && c.geometry?.index) triCount += c.geometry.index.count / 3 })
        if (triCount < 200) continue
        const far = cfg.far || 50
        try { const l1 = model.clone(); _simplifyObject(l1, 0.5); lod.addLevel(l1, far); const l2 = model.clone(); _simplifyObject(l2, 0.15); lod.addLevel(l2, far * 2) } catch (e) { }
      }
      if (_lodUpgradeQueue.length > 0) _ric(run); else _lodUpgradeScheduled = false
    }
    _ric(run)
  }

  function _generateLODEager(model, name) {
    const cfg = LOD_CONFIGS[name] || LOD_CONFIGS.default; if (cfg.noAutoLod) return model
    const lod = new THREE.LOD()
    lod.position.copy(model.position); lod.quaternion.copy(model.quaternion); lod.scale.copy(model.scale); model.position.set(0,0,0); model.quaternion.set(0,0,0,1); model.scale.set(1,1,1); lod.addLevel(model, 0); lod.updateMatrixWorld(true); lod.userData = model.userData
    _lodUpgradeQueue.push({ lod, model, cfg }); return lod
  }

  function createEditorPlaceholder(entityId, templateName, custom) {
    const dims = PLACEHOLDER_DIMS[templateName] || [1, 1, 1], group = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(dims[0], dims[1], dims[2]), new THREE.MeshStandardMaterial({ color: custom?.color ?? 0xcccccc, roughness: 0.8, metalness: 0.1, transparent: true, opacity: 0.7 }))
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.isPlaceholder = true; mesh.userData.templateName = templateName
    group.add(mesh); group.userData.spin = custom?.spin || 0; group.userData.hover = custom?.hover || 0; return group
  }
  function _buildVehicleWheels(group, custom) {
    const wheels = custom.wheels
    if (!Array.isArray(wheels) || wheels.length === 0) return null
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9, metalness: 0.1 })
    const hubs = []
    for (const w of wheels) {
      const r = w.radius ?? 0.35, width = w.width ?? 0.25
      const hub = new THREE.Group()
      const p = w.position || [0, 0, 0]
      hub.position.set(p[0], p[1], p[2])
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, width, 16), wheelMat)
      cyl.rotation.z = Math.PI / 2
      cyl.castShadow = true; cyl.receiveShadow = true
      hub.add(cyl)
      group.add(hub)
      hubs.push({ hub, spinMesh: cyl, radius: r, steer: !!w.steer, angle: 0 })
    }
    group.userData.vehicleWheels = hubs
    return hubs
  }
  function buildEntityMesh(entityId, custom, originPos) {
    const c = custom || {}, geoType = c.mesh || 'box', group = new THREE.Group()
    if (c.softbody && Number.isInteger(c.softbody.cols) && Number.isInteger(c.softbody.rows)) {
      const geo = _buildSoftbodyGeometry(c.softbody, originPos)
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: c.color ?? 0xffffff, roughness: c.roughness ?? 0.9, metalness: c.metalness ?? 0, emissive: c.emissive ?? 0x000000, emissiveIntensity: c.emissiveIntensity ?? 0, side: THREE.DoubleSide }))
      mesh.castShadow = true; mesh.receiveShadow = true
      mesh.userData.isSoftbody = true; mesh.userData._softbodyCols = c.softbody.cols; mesh.userData._softbodyRows = c.softbody.rows
      group.add(mesh)
      return group
    }
    if (c.fluid && Number.isFinite(c.fluid.particleCount)) {
      if (RenderControls.get('fluidRenderMode') === 'surface') {
        const surf = _buildFluidSurfaceMesh(c.fluid, originPos, RenderControls.get('fluidSurfaceCellSize'), RenderControls.get('fluidSurfaceThickness'))
        group.add(surf)
        group.userData.isFluidHost = true
        _fluidMeshes.set(entityId, surf)
        return group
      }
      const im = _buildFluidMesh(c.fluid, originPos, _renderer)
      group.add(im)
      group.userData.isFluidHost = true
      _fluidMeshes.set(entityId, im)
      return group
    }
    const geo = _sharedPrimitiveGeometry(geoType, c)
    const mesh = new THREE.Mesh(geo, _sharedPrimitiveMaterial(c))
    group.userData._paint = _paintRecordFrom(c)
    if (c.rotX) mesh.rotation.x = c.rotX; if (c.rotZ) mesh.rotation.z = c.rotZ
    mesh.castShadow = true; mesh.receiveShadow = true
    mesh.userData.wetness = +(c._wetness) || 0
    group.add(mesh)
    if (c.light) group.add(new THREE.PointLight(c.light, c.lightIntensity || 1, c.lightRange || 4))
    if (c.vehicle && c.wheels) { const hubs = _buildVehicleWheels(group, c); if (hubs) _vehicleEntities.push(group) }
    if (c.spin) group.userData.spin = c.spin; if (c.hover) group.userData.hover = c.hover
    if (c.label) {
      const label = _makeLabelSprite(c.label)
      label.position.set(0, 1.5, 0)
      label.userData._labelText = c.label
      group.add(label)
      _labelSprites.set(entityId, label)
    }
    return group
  }

  function rebuildEntityHierarchy(entities) {
    for (const e of entities) entityParentMap.set(e.id, e.parent || null)
    for (const e of entities) {
      const mesh = entityMeshes.get(e.id); if (!mesh) continue
      const parentId = entityParentMap.get(e.id)
      if (parentId === null) { if (sceneGraph) sceneGraph.setParent(e.id, null); else if (mesh.parent !== scene) scene.add(mesh) }
      else { const pm = entityMeshes.get(parentId); if (pm && pm !== mesh.parent) pm.add(mesh) }
    }
  }

  function updateVisibility(camera) {
    const cp = camera.position
    for (const mesh of entityMeshes.values()) {
      if (mesh.userData.isModelPool) continue
      const ud = mesh.userData, sc = mesh.scale
      if (ud._compileHidden) { mesh.visible = false; continue }
      let sq = ud._skipSq
      if (sq === undefined || sc.x !== ud._svx || sc.y !== ud._svy || sc.z !== ud._svz) {
        const cfg = LOD_CONFIGS[ud?.mesh] || LOD_CONFIGS.default
        const maxSc = sc.x > sc.y ? (sc.x > sc.z ? sc.x : sc.z) : (sc.y > sc.z ? sc.y : sc.z)
        const skip = cfg.skipBeyond * Math.max(1, maxSc)
        sq = ud._skipSq = skip * skip; ud._svx = sc.x; ud._svy = sc.y; ud._svz = sc.z
      }
      const d2 = (mesh.position.x-cp.x)**2 + (mesh.position.y-cp.y)**2 + (mesh.position.z-cp.z)**2
      mesh.visible = d2 <= sq
      if (mesh.isLOD && mesh.visible) mesh.update(camera)
    }
  }

  function _makeTagMesh(entityId, entityState, entityAppMap) {
    return (m) => { m.userData.isEditable = true; m.userData.entityId = entityId; m.userData._appName = entityAppMap.get(entityId) || entityState.app || null; m.userData.custom = entityState.custom || {}; m.userData.isDynamicShadowCaster = entityState.bodyType === 'dynamic'; m.userData.wetness = +(entityState.custom?._wetness) || 0; m.userData.modelUrl = entityState.model || null }
  }

  function _spawnPoolMeshRenderOnly(entityId, entityState, url, entityAppMap, onFirstEntityLoaded, loadingScreenHidden) {
    if (_disposed || entityMeshes.has(entityId)) return
    const _tagMesh = _makeTagMesh(entityId, entityState, entityAppMap)
    const tr = { position: entityState.position, rotation: entityState.rotation, scale: entityState.scale }
    const placeholder = new THREE.Group()
    placeholder.userData.isModelPool = true
    const _interior = !!entityState.custom?._interior
    modelPool.spawn(entityId, url, tr, (root) => {
      _tagMesh(root)
      if (_disposed || !entityMeshes.has(entityId)) return
      root.userData.isModelPool = true
      entityMeshes.set(entityId, root)
      if (_interior) _forceDoubleSide(root)
      const handle = modelPool._entities.get(entityId)?.handle
      if (handle && typeof handle.on === 'function') {
        handle.on('lod-changed', () => {
          if (_disposed || !entityMeshes.has(entityId)) return
          const cur = modelPool._entities.get(entityId)?.root
          if (!cur) return
          cur.userData.isModelPool = true
          if (_interior) _forceDoubleSide(cur)
          _tagMesh(cur); entityMeshes.set(entityId, cur)
        })
      }
      if (loadingScreenHidden && _onMeshReady) _onMeshReady(root)
      else if (root.userData && root.userData._compileHidden) { root.userData._compileHidden = false; root.visible = true }
    })
    entityMeshes.set(entityId, placeholder)
    pendingLoads.delete(entityId); onFirstEntityLoaded(entityId)
  }

  function _scheduleColliderExtraction(entityId, entityState, url, scheduleFitShadow) {
    _ric(async () => {
      if (_disposed || !entityMeshes.has(entityId)) return
      let _refHeld = false
      try {
        let gltf
        if (_parsedGltfCache.has(url)) { gltf = _parsedGltfCache.get(url) }
        else if (_parsedGltfInflight.has(url)) { gltf = await _parsedGltfInflight.get(url) }
        else {
          const p = fetchCached(url).then(buf => gltfLoader.parseAsync(patchGLB(buf, url), ''))
          _parsedGltfInflight.set(url, p)
          try { gltf = await p } finally { _parsedGltfInflight.delete(url) }
          gltf.userData.__sharedGeo = new Map()
          _parsedGltfCache.set(url, gltf)
        }
        if (_disposed || !entityMeshes.has(entityId)) return
        _parsedGltfRefCount.set(url, (_parsedGltfRefCount.get(url) || 0) + 1)
        _refHeld = true
        const _sharedGeo = _parsedGltfCache.get(url)?.userData?.__sharedGeo
        const model = gltf.scene.clone(true)
        if (entityState.custom?.mesh === 'fracturedPiece' && Number.isInteger(entityState.custom?.pieceIndex)) {
          const wantName = `piece_${entityState.custom.pieceIndex}`
          const keep = model.children.find(c => c.name === wantName)
          for (const child of [...model.children]) if (child !== keep) model.remove(child)
        }
        if (_sharedGeo && !_sharedGeo._primed) {
          model.traverse(c => { if (c.isMesh) { const key = c.geometry.uuid || c.geometry.id; _sharedGeo.set(key, c.geometry); c.geometry.userData.__sharedKey = key } })
          _sharedGeo._primed = true
        } else if (_sharedGeo) {
          model.traverse(c => { if (c.isMesh) { const key = c.geometry.userData?.__sharedKey || c.geometry.uuid || c.geometry.id; if (_sharedGeo.has(key)) c.geometry = _sharedGeo.get(key) } })
        }
        const mp = entityState.position; model.position.set(mp[0], mp[1], mp[2])
        const mr = entityState.rotation; if (mr) model.quaternion.set(mr[0], mr[1], mr[2], mr[3])
        const ms = entityState.scale; if (ms) model.scale.set(ms[0], ms[1], ms[2])
        const colliders = []
        model.traverse(c => {
          if (c.isMesh) {
            const mn = (c.material?.name || '').toLowerCase()
            if (SKIP_MATS_SET.has(mn) || SKIP_MATS_SET.has(c.material?.name)) { c.visible = false; return }
            if (!c.isSkinnedMesh) { c.matrixAutoUpdate = false; colliders.push(c) }
          }
        })
        model.updateMatrixWorld(true)
        const _interior = !!entityState.custom?._interior
        if (_onTrimeshReady && _interior) {
          const { verts, idxs } = _extractInteriorTrimesh(model)
          if (verts.length > 0 && idxs.length > 0) _onTrimeshReady(entityId, verts, idxs)
        }
        if (!_disposed && entityMeshes.has(entityId)) {
          cam.addEnvironment(colliders); _entityColliders.set(entityId, colliders); scheduleFitShadow()
        }
        _releaseGltfRef(url)
      } catch (e) {
        console.warn('[gltf] deferred collider extraction failed for', url, '- pool-routed visual already rendered, collider skipped:', e?.message || e)
        if (_refHeld) _releaseGltfRef(url)
      }
    })
  }

  async function _doLoadEntityModel(entityId, entityState, entityAppMap, firstSnapshotEntityPending, onFirstEntityLoaded, scheduleFitShadow, loadingScreenHidden) {
    const isEditorPlaceholder = entityState.custom?.editorPlaceholder === true
    const _tagMesh = _makeTagMesh(entityId, entityState, entityAppMap)
    if (!entityState.model || isEditorPlaceholder) {
      const _c = entityState.custom
      const _deliberatePrimitive = isEditorPlaceholder || (_c && (_c.mesh || _c.template || _c.color != null || _c.light != null || _c.fluid != null))
      const _awaitingModelPath = !entityState.model && !_deliberatePrimitive && (entityState.custom?._interior || entityAppMap.get(entityId) === 'placed-model' || entityState.app === 'placed-model')
      if (_awaitingModelPath) {
        pendingLoads.delete(entityId); return
      }
      const group = isEditorPlaceholder && entityState.custom?.template ? createEditorPlaceholder(entityId, entityState.custom.template, entityState.custom) : buildEntityMesh(entityId, entityState.custom, entityState.position)
      const ep = entityState.position; group.position.set(ep[0], ep[1], ep[2])
      const er = entityState.rotation; if (er) group.quaternion.set(er[0], er[1], er[2], er[3])
      const es = entityState.scale; if (es) group.scale.set(es[0], es[1], es[2])
      if (sceneGraph) sceneGraph.addNode(entityId, group); else scene.add(group); _tagMesh(group); entityMeshes.set(entityId, group)
      if (group.userData.spin || group.userData.hover) _animatedEntities.push(group)
      if (loadingScreenHidden && _onMeshReady) _onMeshReady(group)
      pendingLoads.delete(entityId); onFirstEntityLoaded(entityId); return
    }
    if (loadingMgr.label !== STRINGS.loadingWorld) loadingMgr.setLabel(STRINGS.loadingWorld)
    const url = entityState.model.startsWith('./') ? '/' + entityState.model.slice(2) : entityState.model
    if (!_discoveredModelUrls.has(url)) { _discoveredModelUrls.add(url) }
    const isDynamicEarly = entityState.bodyType === 'dynamic'
    const _poolReadyEarly = modelPool && !isDynamicEarly ? await modelPool.progressiveReady(url) : false
    if (_poolReadyEarly) {
      _spawnPoolMeshRenderOnly(entityId, entityState, url, entityAppMap, onFirstEntityLoaded, loadingScreenHidden)
      _scheduleColliderExtraction(entityId, entityState, url, scheduleFitShadow)
      return
    }
    try {
      loadingMgr.beginDownload(url)
      let gltf
      if (_parsedGltfCache.has(url)) { gltf = _parsedGltfCache.get(url); loadingMgr.completeDownload(url) }
      else if (_parsedGltfInflight.has(url)) { gltf = await _parsedGltfInflight.get(url); loadingMgr.completeDownload(url) }
      else {
        const p = fetchCached(url).then(buf => gltfLoader.parseAsync(patchGLB(buf, url), '')); _parsedGltfInflight.set(url, p)
        try { gltf = await p } finally { _parsedGltfInflight.delete(url) }
        gltf.userData.__sharedGeo = new Map(); _parsedGltfCache.set(url, gltf); loadingMgr.completeDownload(url)
      }
      _parsedGltfRefCount.set(url, (_parsedGltfRefCount.get(url) || 0) + 1)
      const _sharedGeo = _parsedGltfCache.get(url)?.userData?.__sharedGeo
      const model = gltf.scene.clone(true)
      if (entityState.custom?.mesh === 'fracturedPiece' && Number.isInteger(entityState.custom?.pieceIndex)) {
        const wantName = `piece_${entityState.custom.pieceIndex}`
        const keep = model.children.find(c => c.name === wantName)
        for (const child of [...model.children]) if (child !== keep) model.remove(child)
        if (!keep) console.warn(`[gltf] fractured piece node "${wantName}" not found in ${url} (has: ${model.children.map(c => c.name).join(', ')})`)
      }
      if (_sharedGeo && !_sharedGeo._primed) {
        model.traverse(c => { if (c.isMesh) { const key = c.geometry.uuid || c.geometry.id; _sharedGeo.set(key, c.geometry); c.geometry.userData.__sharedKey = key } })
        _sharedGeo._primed = true
      } else if (_sharedGeo) {
        model.traverse(c => { if (c.isMesh) { const key = c.geometry.userData?.__sharedKey || c.geometry.uuid || c.geometry.id; if (_sharedGeo.has(key)) c.geometry = _sharedGeo.get(key) } })
      }
      const mp = entityState.position; model.position.set(mp[0], mp[1], mp[2])
      const mr = entityState.rotation; if (mr) model.quaternion.set(mr[0], mr[1], mr[2], mr[3])
      const ms = entityState.scale; if (ms) model.scale.set(ms[0], ms[1], ms[2])
      const isDynamic = entityState.bodyType === 'dynamic', colliders = [], bvhPending = []
      model.userData.isDynamicShadowCaster = isDynamic
      const _wetness = +(entityState.custom?._wetness) || 0
      model.userData.wetness = _wetness
      const _fracturedColor = entityState.custom?.mesh === 'fracturedPiece' ? entityState.custom : null
      model.traverse(c => {
        if (c.isMesh) {
          const mn = (c.material?.name || '').toLowerCase()
          if (SKIP_MATS_SET.has(mn) || SKIP_MATS_SET.has(c.material?.name)) { c.visible = false; return }
          c.castShadow = true; c.receiveShadow = true
          c.userData.isDynamicShadowCaster = isDynamic
          c.userData.wetness = _wetness
          if (_fracturedColor && c.material) c.material.color.set(_fracturedColor.color ?? 0x8b4513)
          if (!c.isSkinnedMesh && !isDynamic) { c.matrixAutoUpdate = false; bvhPending.push(c); colliders.push(c) }
          if (c.material) {
            if (c.isSkinnedMesh) { c.material.shadowSide = THREE.DoubleSide; return }
            const m = c.material, key = `${m.map?.uuid||''}|${m.normalMap?.uuid||''}|${m.emissiveMap?.uuid||''}|${m.color?.getHex()||0}|${m.emissive?.getHex()||0}|${_fracturedColor ? 'r' + (_fracturedColor.roughness ?? 0.85) : ''}`
            if (_matCache.has(key)) { c.material = _matCache.get(key) } else { m.shadowSide = THREE.DoubleSide; m.roughness = _fracturedColor ? (_fracturedColor.roughness ?? 0.85) : 1; m.metalness = 0; if (m.specularIntensity !== undefined) m.specularIntensity = 0; _matCache.set(key, m) }
          }
        }
      })
      if (bvhPending.length > 0) _scheduleBvhBuild(bvhPending)
      model.updateMatrixWorld(true)
      const _interior = !!entityState.custom?._interior
      if (_onTrimeshReady && _interior) {
        const { verts, idxs } = _extractInteriorTrimesh(model)
        if (verts.length > 0 && idxs.length > 0) _onTrimeshReady(entityId, verts, idxs)
      }
      if (_disposed || !pendingLoads.has(entityId)) {
        pendingLoads.delete(entityId); onFirstEntityLoaded(entityId)
        _releaseGltfRef(url)
        return
      }
      const finalMesh = isDynamic ? model : (entityState.custom?.noAutoLod ? model : _generateLODEager(model, entityState.custom?.mesh))
      if (_interior) _forceDoubleSide(finalMesh)
      if (sceneGraph) sceneGraph.addNode(entityId, finalMesh); else scene.add(finalMesh); entityMeshes.set(entityId, finalMesh)
      if (model.userData.spin || model.userData.hover) _animatedEntities.push(finalMesh)
      if (staticInstanceStore && !isDynamic && !_interior && !model.userData.spin && !model.userData.hover) {
        let _singleMesh = null, _meshCount = 0
        finalMesh.traverse(c => { if (c.isMesh && !c.isSkinnedMesh) { _meshCount++; if (_meshCount === 1) _singleMesh = c } })
        if (_meshCount === 1 && _singleMesh && _singleMesh.geometry) {
          const bucketKey = `${url}|${_singleMesh.geometry.userData?.__sharedKey || _singleMesh.geometry.uuid}`
          staticInstanceStore.addInstance(entityId, bucketKey, _singleMesh.geometry, entityState.position, entityState.rotation, entityState.scale)
        }
      }
      if (gltf.animations && gltf.animations.length && !isDynamic) {
        const mixer = new THREE.AnimationMixer(finalMesh)
        const actions = new Map()
        for (const clip of gltf.animations) actions.set(clip.name, mixer.clipAction(clip))
        finalMesh.userData._mixer = mixer; finalMesh.userData._actions = actions; finalMesh.userData._curClip = null
        _entityMixers.set(entityId, finalMesh)
        _setEntityClip(finalMesh, entityState.custom?._anim || gltf.animations[0].name)
      }
      if (isDynamic) { const segs = []; model.traverse(c => { if (!c.isMesh) return; const seg = new THREE.LineSegments(new THREE.WireframeGeometry(c.geometry), new THREE.LineBasicMaterial({ color: 0x00ff00, depthTest: false })); seg.visible = !!window.__showHulls__; c.add(seg); segs.push(seg) }); _hullMeshes.set(entityId, segs) }
      _tagMesh(finalMesh)
      if (!isDynamic) { cam.addEnvironment(colliders); _entityColliders.set(entityId, colliders); scheduleFitShadow() }
      if (loadingScreenHidden && _onMeshReady) _onMeshReady(finalMesh)
      pendingLoads.delete(entityId); onFirstEntityLoaded(entityId)
      if (loadingScreenHidden) _scheduleLodUpgrades()
      _releaseGltfRef(url)
    } catch (err) {
      console.error('[gltf]', url, err); pendingLoads.delete(entityId); onFirstEntityLoaded(entityId, true); loadingMgr.completeDownload(url)
    }
  }
  function _processLoadQueue(entityAppMap, firstSnapshotEntityPending, onFirstEntityLoaded, scheduleFitShadow, loadingScreenHidden) {
    const limit = loadingScreenHidden ? MAX_CONCURRENT_LOADS_RUNTIME : MAX_CONCURRENT_LOADS_INITIAL
    while (_activeLoads < limit && loadQueue.length > 0) {
      _activeLoads++
      const { entityId, entityState } = loadQueue.shift()
      _doLoadEntityModel(entityId, entityState, entityAppMap, firstSnapshotEntityPending, onFirstEntityLoaded, scheduleFitShadow, loadingScreenHidden).finally(() => { _activeLoads--; _processLoadQueue(entityAppMap, firstSnapshotEntityPending, onFirstEntityLoaded, scheduleFitShadow, loadingScreenHidden) })
    }
  }
  function loadEntityModel(entityId, entityState, entityAppMap, firstSnapshotEntityPending, onFirstEntityLoaded, scheduleFitShadow, loadingScreenHidden) {
    if (entityMeshes.has(entityId) || pendingLoads.has(entityId)) return
    const url = entityState.model
    if (url && _parsedGltfInflight.has(url) && !_parsedGltfCache.has(url)) {
      _parsedGltfInflight.get(url).then(() => { if (entityMeshes.has(entityId)) return; pendingLoads.delete(entityId); loadEntityModel(entityId, entityState, entityAppMap, firstSnapshotEntityPending, onFirstEntityLoaded, scheduleFitShadow, loadingScreenHidden) }).catch(() => {})
      pendingLoads.add(entityId)
      return
    }
    _trackEntity(entityId, 'load')
    pendingLoads.add(entityId); loadQueue.push({ entityId, entityState })
    _processLoadQueue(entityAppMap, firstSnapshotEntityPending, onFirstEntityLoaded, scheduleFitShadow, loadingScreenHidden)
  }
  function removeEntity(id) {
    _trackEntity(id, 'remove')
    { const mm = _entityMixers.get(id); if (mm && mm.userData._mixer) { mm.userData._mixer.stopAllAction(); mm.userData._mixer.uncacheRoot(mm) } _entityMixers.delete(id) }
    if (modelPool && modelPool.has(id)) {
      modelPool.remove(id)
      entityMeshes.delete(id); pendingLoads.delete(id)
      const cols0 = _entityColliders.get(id); if (cols0) { cam.removeEnvironment(cols0); _entityColliders.delete(id) }
      return
    }
    if (staticInstanceStore) staticInstanceStore.removeInstance(id)
    const m = entityMeshes.get(id); if (!m) return
    scene.remove(m); m.traverse(_disposeOwned)
    entityMeshes.delete(id); pendingLoads.delete(id); if (sceneGraph) sceneGraph.removeNode(id); _hullMeshes.delete(id)
    const cols = _entityColliders.get(id); if (cols) { cam.removeEnvironment(cols); _entityColliders.delete(id) }
    const ai = _animatedEntities.indexOf(m); if (ai >= 0) _animatedEntities.splice(ai, 1)
    const vi = _vehicleEntities.indexOf(m); if (vi >= 0) _vehicleEntities.splice(vi, 1)
    _fluidMeshes.delete(id)
  }
  async function prefetchModels(modelUrls, onProgress) {
    const unique = modelUrls.map(u => u.startsWith('./') ? '/' + u.slice(2) : u).filter(u => !_parsedGltfCache.has(u) && !_parsedGltfInflight.has(u))
    let done = 0; const total = unique.length; const BATCH = 4
    for (let i = 0; i < unique.length; i += BATCH) {
      await Promise.all(unique.slice(i, i + BATCH).map(async url => {
        try { if (!_parsedGltfInflight.has(url)) { const p = fetchCached(url).then(buf => gltfLoader.parseAsync(patchGLB(buf, url), '')); _parsedGltfInflight.set(url, p); const gltf = await p; _parsedGltfInflight.delete(url); gltf.userData.__sharedGeo = new Map(); _parsedGltfCache.set(url, gltf) } else await _parsedGltfInflight.get(url) }
        catch (e) { console.warn('[prefetch]', url, e.message) }
        if (onProgress) onProgress(++done, total)
      }))
    }
  }

  const _entityLifecycle = new Map()
  const _trackEntity = (id, action) => {
    if (!_entityLifecycle.has(id)) _entityLifecycle.set(id, { createTs: performance.now(), removeTs: 0, loadCount: 0, meshCount: 0 })
    const e = _entityLifecycle.get(id)
    if (action === 'load') { e.loadCount++; e.meshCount = entityMeshes.get(id)?.children.filter(c => c.isMesh).length || 0 }
    if (action === 'remove') { e.removeTs = performance.now() }
  }
  function getEntityLeakReport() {
    const now = performance.now()
    const active = []
    const leaked = []
    for (const [id, e] of _entityLifecycle) {
      if (entityMeshes.has(id)) active.push({ id, ageMs: +(now - e.createTs).toFixed(0), loadCount: e.loadCount, meshCount: e.meshCount })
      else if (e.removeTs > 0 && now - e.removeTs > 30000) leaked.push({ id, lifeMs: +(e.removeTs - e.createTs).toFixed(0), loadCount: e.loadCount })
    }
    return { active, leaked }
  }

  function dispose() {
    if (_disposed) return
    _disposed = true
    _bvhQueue.length = 0; _bvhScheduled = false
    _lodUpgradeQueue.length = 0; _lodUpgradeScheduled = false
    if (staticInstanceStore) staticInstanceStore.dispose()
  }
  function updateMixers(dt) {
    for (const [id, mesh] of _entityMixers) {
      if (!mesh || !mesh.userData._mixer) { _entityMixers.delete(id); continue }
      const want = mesh.userData.custom?._anim
      if (want && want !== mesh.userData._curClip) _setEntityClip(mesh, want)
      mesh.userData._mixer.update(dt)
    }
  }
  function playClip(entityId, clipName, opts) { const mesh = _entityMixers.get(entityId); if (mesh) _setEntityClip(mesh, clipName, opts) }

  function repaintEntity(entityId, custom, originPos) {
    const mesh = entityMeshes.get(entityId); if (!mesh || !custom) return false
    if (custom.softbody) {
      const softMesh = mesh.userData.isSoftbody ? mesh : mesh.children?.find(c => c.userData.isSoftbody)
      if (softMesh) _rewriteSoftbodyGeometry(softMesh, custom.softbody, originPos)
      mesh.userData.custom = custom
    }
    if (custom.fluid) {
      const surfaceMode = RenderControls.get('fluidRenderMode') === 'surface'
      let im = _fluidMeshes.get(entityId)
      if (!im) {
        const placeholderBox = mesh.children.find(c => c.isMesh && c.geometry?.type === 'BoxGeometry' && !c.userData.isFluid && !c.userData.isFluidSurface)
        if (placeholderBox) { mesh.remove(placeholderBox); _disposeOwned(placeholderBox) }
        im = surfaceMode
          ? _buildFluidSurfaceMesh(custom.fluid, originPos, RenderControls.get('fluidSurfaceCellSize'), RenderControls.get('fluidSurfaceThickness'))
          : _buildFluidMesh(custom.fluid, originPos, _renderer)
        mesh.add(im)
        mesh.userData.isFluidHost = true
        _fluidMeshes.set(entityId, im)
      } else if (im.userData.isFluidSurface) {
        _rewriteFluidSurfaceMesh(im, custom.fluid, originPos, RenderControls.get('fluidSurfaceCellSize'), RenderControls.get('fluidSurfaceThickness'))
      } else {
        _rewriteFluidMesh(im, custom.fluid, originPos)
      }
      mesh.userData.custom = custom
    }
    mesh.userData.custom = custom
    const existingLabel = _labelSprites.get(entityId)
    if (custom.label) {
      if (existingLabel) {
        if (existingLabel.userData._labelText !== custom.label) {
          const canvas = existingLabel.material.map?.image
          if (canvas && canvas.getContext) {
            const ctx = canvas.getContext('2d')
            ctx.clearRect(0, 0, canvas.width, canvas.height)
            const tw = ctx.measureText(custom.label).width
            const pw = Math.min(240, Math.max(40, tw + 24))
            ctx.fillStyle = 'rgba(0,0,0,0.55)'
            _roundRect(ctx, (256 - pw) / 2, 4, pw, 56, 12)
            ctx.fill()
            ctx.fillStyle = '#ffffff'
            ctx.font = 'bold 24px sans-serif'
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
            ctx.fillText(String(custom.label), 128, 34)
            existingLabel.material.map.needsUpdate = true
          }
          existingLabel.userData._labelText = custom.label
        }
      } else {
        const label = _makeLabelSprite(custom.label)
        label.position.set(0, 1.5, 0)
        label.userData._labelText = custom.label
        mesh.add(label)
        _labelSprites.set(entityId, label)
      }
    } else if (existingLabel) {
      mesh.remove(existingLabel)
      existingLabel.material.map?.dispose()
      existingLabel.material.dispose()
      _labelSprites.delete(entityId)
    }
    const rec = mesh.userData._paint
    const pColor = _n(custom.color), pEmissive = _n(custom.emissive), pEI = _n(custom.emissiveIntensity), pRough = _n(custom.roughness), pMetal = _n(custom.metalness), pWet = _n(custom._wetness)
    if (rec && rec.color === pColor && rec.emissive === pEmissive && rec.emissiveIntensity === pEI && rec.roughness === pRough && rec.metalness === pMetal && rec._wetness === pWet) return false
    if (rec) { rec.color = pColor; rec.emissive = pEmissive; rec.emissiveIntensity = pEI; rec.roughness = pRough; rec.metalness = pMetal; rec._wetness = pWet }
    else mesh.userData._paint = { color: pColor, emissive: pEmissive, emissiveIntensity: pEI, roughness: pRough, metalness: pMetal, _wetness: pWet }
    const _wetness = +(custom._wetness) || 0
    mesh.userData.wetness = _wetness
    let touched = false
    mesh.traverse(o => {
      if (o.isMesh) o.userData.wetness = _wetness
      const m = o.material; if (!m || !m.color) return
      const isArr = Array.isArray(m); const mats = isArr ? m : [m]
      for (let i = 0; i < mats.length; i++) {
        let mat = mats[i]
        const willMutate = (custom.color != null && !!mat.color?.set) || (custom.emissive != null && !!mat.emissive?.set) || (custom.emissiveIntensity != null && 'emissiveIntensity' in mat) || (custom.roughness != null && 'roughness' in mat) || (custom.metalness != null && 'metalness' in mat)
        if (!willMutate) continue
        if (mat.userData && mat.userData._spointShared) {
          const own = mat.clone(); own.userData = { ...mat.userData, _spointShared: false }
          if (isArr) m[i] = own; else o.material = own
          mat = own
        }
        if (custom.color != null && mat.color?.set) { mat.color.set(custom.color); touched = true }
        if (custom.emissive != null && mat.emissive?.set) { mat.emissive.set(custom.emissive); touched = true }
        if (custom.emissiveIntensity != null && 'emissiveIntensity' in mat) { mat.emissiveIntensity = custom.emissiveIntensity; touched = true }
        if (custom.roughness != null && 'roughness' in mat) { mat.roughness = custom.roughness; touched = true }
        if (custom.metalness != null && 'metalness' in mat) { mat.metalness = custom.metalness; touched = true }
      }
    })
    return touched
  }

  function mergeCustom(entityId, patch) {
    const mesh = entityMeshes.get(entityId)
    if (!mesh) return null
    mesh.userData.custom = { ...(mesh.userData.custom || {}), ...patch }
    return mesh
  }

  return { entityMeshes, _animatedEntities, _vehicleEntities, _hullMeshes, loadEntityModel, removeEntity, rebuildEntityHierarchy, updateVisibility, updateMixers, playClip, repaintEntity, LOD_CONFIGS, scheduleLodUpgrades: _scheduleLodUpgrades, prefetchModels, getEntityLeakReport, dispose, staticInstanceStore, mergeCustom, set onMeshReady(fn) { _onMeshReady = fn }, set onTrimeshReady(fn) { _onTrimeshReady = fn } }
}
