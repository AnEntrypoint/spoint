import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { MeshoptSimplifier } from '/node_modules/meshoptimizer/meshopt_simplifier.js'
import { fetchCached } from './ModelCache.js'

const SKIP_MATS_SET = new Set(['aaatrigger', '{invisible', 'playerclip', 'clip', 'nodraw', 'trigger', 'sky', 'toolsclip', 'toolsplayerclip', 'toolsnodraw', 'toolsskybox', 'toolstrigger'])
const PLACEHOLDER_DIMS = { door: [1.5, 2.5, 0.1], platform: [4, 0.5, 4], trigger: [2, 3, 2], hazard: [2, 2, 2], lootBox: [1, 1.5, 1], pillar: [1, 4, 1] }
const MESH_BUILDERS = {
  box: (c) => new THREE.BoxGeometry(c.sx || 1, c.sy || 1, c.sz || 1),
  cylinder: (c) => new THREE.CylinderGeometry(c.r || 0.4, c.r || 0.4, c.h || 0.1, c.seg || 16),
  sphere: (c) => new THREE.SphereGeometry(c.r || 0.5, c.seg || 16, c.seg || 16)
}
const LOD_CONFIGS = { vrm: { far: 40, skipBeyond: 80 }, box: { far: 45, skipBeyond: 90 }, sphere: { far: 50, skipBeyond: 100 }, cylinder: { far: 50, skipBeyond: 100 }, default: { far: 60, skipBeyond: 120 } }
const MAX_CONCURRENT_LOADS_INITIAL = 8, MAX_CONCURRENT_LOADS_RUNTIME = 3

export function createEntityLoader(scene, gltfLoader, cam, loadingMgr, patchGLB) {
  let _onMeshReady = null
  const entityMeshes = new Map()
  const _animatedEntities = []
  const _hullMeshes = new Map()
  const entityParentMap = new Map()
  const entityTargets = new Map()
  const pendingLoads = new Set()
  const loadQueue = []
  const _parsedGltfCache = new Map()
  const _parsedGltfInflight = new Map()
  const _discoveredModelUrls = new Set()
  const _bvhQueue = []
  const _lodUpgradeQueue = []
  let _bvhScheduled = false, _lodUpgradeScheduled = false, _activeLoads = 0

  function _scheduleBvhBuild(meshes) {
    for (const m of meshes) _bvhQueue.push(m)
    if (_bvhScheduled) return
    _bvhScheduled = true
    const run = (dl) => {
      while (_bvhQueue.length > 0 && (!dl || dl.timeRemaining() > 2)) _bvhQueue.shift().geometry.computeBoundsTree()
      if (_bvhQueue.length > 0) { (typeof requestIdleCallback !== 'undefined' ? (fn) => requestIdleCallback(fn, { timeout: 16 }) : (fn) => setTimeout(fn, 16))(run) } else _bvhScheduled = false
    }
    ;(typeof requestIdleCallback !== 'undefined' ? (fn) => requestIdleCallback(fn, { timeout: 16 }) : (fn) => setTimeout(fn, 16))(run)
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
      while (_lodUpgradeQueue.length > 0 && (!dl || dl.timeRemaining() > 4)) {
        const { lod, model, cfg } = _lodUpgradeQueue.shift()
        if (!lod.parent && lod !== scene) continue
        const far = cfg.far || 50
        try { const l1 = model.clone(); _simplifyObject(l1, 0.5); lod.addLevel(l1, far); const l2 = model.clone(); _simplifyObject(l2, 0.15); lod.addLevel(l2, far * 2) } catch (e) { }
      }
      if (_lodUpgradeQueue.length > 0) { (typeof requestIdleCallback !== 'undefined' ? (fn) => requestIdleCallback(fn, { timeout: 16 }) : (fn) => setTimeout(fn, 16))(run) } else _lodUpgradeScheduled = false
    }
    ;(typeof requestIdleCallback !== 'undefined' ? (fn) => requestIdleCallback(fn, { timeout: 16 }) : (fn) => setTimeout(fn, 16))(run)
  }

  function _generateLODEager(model, name) {
    const cfg = LOD_CONFIGS[name] || LOD_CONFIGS.default; if (cfg.noAutoLod) return model
    const lod = new THREE.LOD()
    lod.addLevel(model, 0); lod.position.copy(model.position); lod.quaternion.copy(model.quaternion); lod.scale.copy(model.scale); lod.updateMatrixWorld(true); lod.userData = model.userData
    _lodUpgradeQueue.push({ lod, model, cfg }); return lod
  }

  function createEditorPlaceholder(entityId, templateName, custom) {
    const dims = PLACEHOLDER_DIMS[templateName] || [1, 1, 1], group = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(dims[0], dims[1], dims[2]), new THREE.MeshStandardMaterial({ color: custom?.color ?? 0xcccccc, roughness: 0.8, metalness: 0.1, transparent: true, opacity: 0.7 }))
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.isPlaceholder = true; mesh.userData.templateName = templateName
    group.add(mesh); group.userData.spin = custom?.spin || 0; group.userData.hover = custom?.hover || 0; return group
  }
  function buildEntityMesh(entityId, custom) {
    const c = custom || {}, geoType = c.mesh || 'box', group = new THREE.Group()
    const geo = MESH_BUILDERS[geoType] ? MESH_BUILDERS[geoType](c) : MESH_BUILDERS.box(c)
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: c.color ?? 0xff8800, roughness: c.roughness ?? 1, metalness: c.metalness ?? 0, emissive: c.emissive ?? 0x000000, emissiveIntensity: c.emissiveIntensity ?? 0 }))
    if (c.rotX) mesh.rotation.x = c.rotX; if (c.rotZ) mesh.rotation.z = c.rotZ
    mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh)
    if (c.light) group.add(new THREE.PointLight(c.light, c.lightIntensity || 1, c.lightRange || 4))
    if (c.spin) group.userData.spin = c.spin; if (c.hover) group.userData.hover = c.hover; return group
  }

  function rebuildEntityHierarchy(entities) {
    for (const e of entities) entityParentMap.set(e.id, e.parent || null)
    for (const e of entities) {
      const mesh = entityMeshes.get(e.id); if (!mesh) continue
      const parentId = entityParentMap.get(e.id)
      if (parentId === null) { if (mesh.parent !== scene) scene.add(mesh) }
      else { const pm = entityMeshes.get(parentId); if (pm && pm !== mesh.parent) pm.add(mesh) }
    }
  }

  function updateVisibility(camera) {
    const cp = camera.position; for (const mesh of entityMeshes.values()) { const cfg = LOD_CONFIGS[mesh.userData?.mesh] || LOD_CONFIGS.default; const d2 = (mesh.position.x-cp.x)**2 + (mesh.position.y-cp.y)**2 + (mesh.position.z-cp.z)**2; mesh.visible = d2 <= cfg.skipBeyond * cfg.skipBeyond; if (mesh.isLOD && mesh.visible) mesh.update(camera) }
  }

  async function _doLoadEntityModel(entityId, entityState, entityAppMap, firstSnapshotEntityPending, onFirstEntityLoaded, scheduleFitShadow, loadingScreenHidden) {
    const isEditorPlaceholder = entityState.custom?.editorPlaceholder === true
    const _tagMesh = (m) => { m.userData.isEditable = true; m.userData._appName = entityAppMap.get(entityId) || entityState.app || null }
    if (!entityState.model || isEditorPlaceholder) {
      const group = isEditorPlaceholder && entityState.custom?.template ? createEditorPlaceholder(entityId, entityState.custom.template, entityState.custom) : buildEntityMesh(entityId, entityState.custom)
      const ep = entityState.position; group.position.set(ep[0], ep[1], ep[2])
      const er = entityState.rotation; if (er) group.quaternion.set(er[0], er[1], er[2], er[3])
      const es = entityState.scale; if (es) group.scale.set(es[0], es[1], es[2])
      scene.add(group); _tagMesh(group); entityMeshes.set(entityId, group)
      if (group.userData.spin || group.userData.hover) _animatedEntities.push(group)
      pendingLoads.delete(entityId); onFirstEntityLoaded(entityId); return
    }
    if (loadingMgr.label !== 'Loading world...') loadingMgr.setLabel('Loading world...')
    const url = entityState.model.startsWith('./') ? '/' + entityState.model.slice(2) : entityState.model
    if (!_discoveredModelUrls.has(url)) { _discoveredModelUrls.add(url) }
    try {
      loadingMgr.beginDownload(url)
      let gltf
      if (_parsedGltfCache.has(url)) { gltf = _parsedGltfCache.get(url); loadingMgr.completeDownload(url) }
      else if (_parsedGltfInflight.has(url)) { gltf = await _parsedGltfInflight.get(url); loadingMgr.completeDownload(url) }
      else { const p = fetchCached(url).then(buf => gltfLoader.parseAsync(patchGLB(buf, url), '')); _parsedGltfInflight.set(url, p); gltf = await p; _parsedGltfInflight.delete(url); _parsedGltfCache.set(url, gltf); loadingMgr.completeDownload(url) }
      const model = gltf.scene.clone(true)
      const mp = entityState.position; model.position.set(mp[0], mp[1], mp[2])
      const mr = entityState.rotation; if (mr) model.quaternion.set(mr[0], mr[1], mr[2], mr[3])
      const ms = entityState.scale; if (ms) model.scale.set(ms[0], ms[1], ms[2])
      const isDynamic = entityState.bodyType === 'dynamic', colliders = [], bvhPending = []
      model.traverse(c => {
        if (c.isMesh) {
          const mn = (c.material?.name || '').toLowerCase()
          if (SKIP_MATS_SET.has(mn) || SKIP_MATS_SET.has(c.material?.name)) { c.visible = false; return }
          c.castShadow = true; c.receiveShadow = true
          if (!c.isSkinnedMesh && !isDynamic) { c.matrixAutoUpdate = false; bvhPending.push(c); colliders.push(c) }
          if (c.material) { c.material.shadowSide = THREE.DoubleSide; c.material.roughness = 1; c.material.metalness = 0; if (c.material.specularIntensity !== undefined) c.material.specularIntensity = 0 }
        }
      })
      if (bvhPending.length > 0) _scheduleBvhBuild(bvhPending)
      model.updateMatrixWorld(true)
      const finalMesh = isDynamic ? model : (entityState.custom?.noAutoLod ? model : _generateLODEager(model, entityState.custom?.mesh))
      scene.add(finalMesh); entityMeshes.set(entityId, finalMesh)
      if (model.userData.spin || model.userData.hover) _animatedEntities.push(model)
      if (isDynamic) {
        const segs = []
        model.traverse(c => { if (!c.isMesh) return; const seg = new THREE.LineSegments(new THREE.WireframeGeometry(c.geometry), new THREE.LineBasicMaterial({ color: 0x00ff00, depthTest: false })); seg.visible = !!window.__showHulls__; c.add(seg); segs.push(seg) })
        _hullMeshes.set(entityId, segs)
      }
      _tagMesh(finalMesh)
      if (!isDynamic) { cam.addEnvironment(colliders); scheduleFitShadow() }
      if (loadingScreenHidden && _onMeshReady) _onMeshReady(finalMesh)
      pendingLoads.delete(entityId); onFirstEntityLoaded(entityId)
      if (loadingScreenHidden) _scheduleLodUpgrades()
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
    pendingLoads.add(entityId); loadQueue.push({ entityId, entityState })
    _processLoadQueue(entityAppMap, firstSnapshotEntityPending, onFirstEntityLoaded, scheduleFitShadow, loadingScreenHidden)
  }

  function removeEntity(id) {
    const m = entityMeshes.get(id); if (!m) return
    scene.remove(m); m.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose() })
    entityMeshes.delete(id); entityTargets.delete(id); pendingLoads.delete(id); _hullMeshes.delete(id)
    const ai = _animatedEntities.indexOf(m); if (ai >= 0) _animatedEntities.splice(ai, 1)
  }

  async function prefetchModels(modelUrls, onProgress) {
    const unique = modelUrls.map(u => u.startsWith('./') ? '/' + u.slice(2) : u).filter(u => !_parsedGltfCache.has(u) && !_parsedGltfInflight.has(u))
    let done = 0; const total = unique.length
    await Promise.all(unique.map(async url => {
      try { if (!_parsedGltfInflight.has(url)) { const p = fetchCached(url).then(buf => gltfLoader.parseAsync(patchGLB(buf, url), '')); _parsedGltfInflight.set(url, p); const gltf = await p; _parsedGltfInflight.delete(url); _parsedGltfCache.set(url, gltf) } else await _parsedGltfInflight.get(url) }
      catch (e) { console.warn('[prefetch]', url, e.message) }
      if (onProgress) onProgress(++done, total)
    }))
  }

  return { entityMeshes, _animatedEntities, _hullMeshes, entityTargets, loadEntityModel, removeEntity, rebuildEntityHierarchy, updateVisibility, LOD_CONFIGS, scheduleLodUpgrades: _scheduleLodUpgrades, prefetchModels, set onMeshReady(fn) { _onMeshReady = fn } }
}
