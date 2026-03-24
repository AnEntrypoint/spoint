import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { MeshoptSimplifier } from '/node_modules/meshoptimizer/meshopt_simplifier.js'
import { fetchCached } from './ModelCache.js'
import { get as idbGet, put as idbPut } from './IndexedDBStore.js'
import { getGeometry, storeGeometry, reconstructGeometry, getLodIndex, storeLodIndex } from './GeometryCache.js'

const BVH_DB = 'spawnpoint-bvh-cache', BVH_VER = 1, BVH_STORE = 'bvh'
let _MeshBVH = null
async function _getMeshBVH() { if (_MeshBVH) return _MeshBVH; _MeshBVH = (await import('three-mesh-bvh')).MeshBVH; return _MeshBVH }function _bvhKey(geo) { const pos = geo.attributes.position, idxLen = geo.index ? geo.index.array.byteLength : 0, pb = new Uint8Array(pos.array.buffer, pos.array.byteOffset, Math.min(32, pos.array.byteLength)); let h = 0; for (let i = 0; i < pb.length; i++) h = (Math.imul(31, h) + pb[i]) | 0; return `${pos.count}:${idxLen}:${h}` }
async function _loadBvhFromCache(geo) { try { const data = await idbGet(BVH_DB, BVH_VER, BVH_STORE, _bvhKey(geo)); if (!data) return false; const C = await _getMeshBVH(); geo.boundsTree = C.deserialize(data, geo, { setIndex: true }); return true } catch { return false } }
async function _saveBvhToCache(geo) { try { if (!geo.boundsTree) return; const C = await _getMeshBVH(); await idbPut(BVH_DB, BVH_VER, BVH_STORE, _bvhKey(geo), C.serialize(geo.boundsTree)) } catch { } }

const SKIP_MATS_SET = new Set(['aaatrigger', '{invisible', 'playerclip', 'clip', 'nodraw', 'trigger', 'sky', 'toolsclip', 'toolsplayerclip', 'toolsnodraw', 'toolsskybox', 'toolstrigger'])
const PLACEHOLDER_DIMS = { door: [1.5, 2.5, 0.1], platform: [4, 0.5, 4], trigger: [2, 3, 2], hazard: [2, 2, 2], lootBox: [1, 1.5, 1], pillar: [1, 4, 1] }
const MESH_BUILDERS = { box: (c) => new THREE.BoxGeometry(c.sx||1, c.sy||1, c.sz||1), cylinder: (c) => new THREE.CylinderGeometry(c.r||0.4, c.r||0.4, c.h||0.1, c.seg||16), sphere: (c) => new THREE.SphereGeometry(c.r||0.5, c.seg||16, c.seg||16) }
const LOD_CONFIGS = { vrm: { far: 40, skipBeyond: 80, skipBeyondSq: 6400 }, box: { far: 45, skipBeyond: 90, skipBeyondSq: 8100 }, sphere: { far: 50, skipBeyond: 100, skipBeyondSq: 10000 }, cylinder: { far: 50, skipBeyond: 100, skipBeyondSq: 10000 }, default: { far: 60, skipBeyond: 120, skipBeyondSq: 14400 } }
const MAX_CONCURRENT_LOADS_INITIAL = 2, MAX_CONCURRENT_LOADS_RUNTIME = 1, MAX_GLTF_CACHE = 8
const _ric = typeof requestIdleCallback !== 'undefined' ? requestIdleCallback : (fn) => setTimeout(fn, 16)

export function createEntityLoader(scene, gltfLoader, cam, loadingMgr, patchGLB, isWebGPU) {
  const entityMeshes = new Map(), _animatedEntities = [], _hullMeshes = new Map(), entityParentMap = new Map()
  const entityTargets = new Map(), pendingLoads = new Set(), loadQueue = [], _bvhQueue = [], _lodUpgradeQueue = []
  const _parsedGltfCache = new Map(), _parsedGltfInflight = new Map(), _discoveredModelUrls = new Set()
  let _bvhScheduled = false, _lodUpgradeScheduled = false, _activeLoads = 0
  function _scheduleBvhBuild(meshes) {
    for (const m of meshes) _bvhQueue.push(m)
    if (_bvhScheduled) return
    _bvhScheduled = true
    const run = (dl) => {
      while (_bvhQueue.length > 0 && (!dl || dl.timeRemaining() > 2)) { const geo = _bvhQueue.shift().geometry; _loadBvhFromCache(geo).then(hit => { if (!hit) { geo.computeBoundsTree(); _saveBvhToCache(geo) } }) }
      if (_bvhQueue.length > 0) _ric(run); else _bvhScheduled = false
    }
    _ric(run)
  }
  function _simplifyObject(object, ratio, url, level) {
    object.traverse(child => {
      if (!child.isMesh || !child.geometry) return
      let g = child.geometry
      if (!g.index) try { g = BufferGeometryUtils.mergeVertices(g) } catch { return }
      if (!g.index) return
      const tc = Math.floor(g.index.array.length * ratio / 3) * 3; if (tc <= 0) return
      try { const si = MeshoptSimplifier.simplify(g.index.array, g.attributes.position.array, 3, tc, 1e-2); const ng = g.clone(); ng.setIndex(new THREE.BufferAttribute(si, 1)); child.geometry = ng; if (url != null) storeLodIndex(url, level, si).catch(() => {}) } catch { }
    })
  }
  function _scheduleLodUpgrades() {
    if (_lodUpgradeScheduled || _lodUpgradeQueue.length === 0) return
    _lodUpgradeScheduled = true
    const run = async (dl) => {
      while (_lodUpgradeQueue.length > 0 && (!dl || dl.timeRemaining() > 4)) {
        const { lod, model, cfg, url } = _lodUpgradeQueue.shift()
        if (!lod.parent && lod !== scene) continue
        const far = cfg.far || 50
        try {
          const [ci0, ci1] = url ? await Promise.all([getLodIndex(url, 0), getLodIndex(url, 1)]) : [null, null]
          const l1 = model.clone(), l2 = model.clone()
          if (ci0) l1.traverse(c => { if (c.isMesh && c.geometry?.index) c.geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(ci0.index), 1)) }); else _simplifyObject(l1, 0.5, url, 0)
          if (ci1) l2.traverse(c => { if (c.isMesh && c.geometry?.index) c.geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(ci1.index), 1)) }); else _simplifyObject(l2, 0.15, url, 1)
          lod.addLevel(l1, far); lod.addLevel(l2, far * 2)
        } catch { }
      }
      if (_lodUpgradeQueue.length > 0) _ric(run); else _lodUpgradeScheduled = false
    }
    _ric(run)
  }

  function _generateLODEager(model, name, url) {
    const cfg = LOD_CONFIGS[name] || LOD_CONFIGS.default; if (cfg.noAutoLod) return model
    const lod = new THREE.LOD()
    lod.addLevel(model, 0); lod.position.copy(model.position); lod.quaternion.copy(model.quaternion); lod.scale.copy(model.scale); model.position.set(0, 0, 0); model.quaternion.set(0, 0, 0, 1); model.scale.set(1, 1, 1); lod.updateMatrixWorld(true); lod.userData = model.userData
    _lodUpgradeQueue.push({ lod, model, cfg, url }); return lod
  }

  function createEditorPlaceholder(entityId, templateName, custom) {
    const dims = PLACEHOLDER_DIMS[templateName] || [1, 1, 1], group = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dims), new THREE.MeshStandardMaterial({ color: custom?.color ?? 0xcccccc, roughness: 0.8, metalness: 0.1, transparent: true, opacity: 0.7 }))
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.isPlaceholder = true; mesh.userData.templateName = templateName
    group.add(mesh); group.userData.spin = custom?.spin || 0; group.userData.hover = custom?.hover || 0; return group
  }

  function buildEntityMesh(entityId, custom) {
    const c = custom || {}, geo = (MESH_BUILDERS[c.mesh] || MESH_BUILDERS.box)(c)
    const mat = new THREE.MeshStandardMaterial({ color: c.color ?? 0xff8800, roughness: c.roughness ?? 1, metalness: c.metalness ?? 0, emissive: c.emissive ?? 0x000000, emissiveIntensity: c.emissiveIntensity ?? 0 })
    const group = new THREE.Group(), mesh = new THREE.Mesh(geo, mat)
    if (c.rotX) mesh.rotation.x = c.rotX; if (c.rotZ) mesh.rotation.z = c.rotZ
    mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh)
    if (c.light) group.add(new THREE.PointLight(c.light, c.lightIntensity || 1, c.lightRange || 4))
    if (c.spin) group.userData.spin = c.spin; if (c.hover) group.userData.hover = c.hover; return group
  }

  function rebuildEntityHierarchy(entities) {
    for (const e of entities) entityParentMap.set(e.id, e.parent || null)
    for (const e of entities) { const mesh = entityMeshes.get(e.id); if (!mesh) continue; const pid = entityParentMap.get(e.id); if (pid === null) { if (mesh.parent !== scene) scene.add(mesh) } else { const pm = entityMeshes.get(pid); if (pm && pm !== mesh.parent) pm.add(mesh) } }
  }

  function updateVisibility(camera) {
    const cp = camera.position
    for (const mesh of entityMeshes.values()) {
      const cfg = LOD_CONFIGS[mesh.userData?.mesh] || LOD_CONFIGS.default, dx = mesh.position.x - cp.x, dy = mesh.position.y - cp.y, dz = mesh.position.z - cp.z
      mesh.visible = dx*dx + dy*dy + dz*dz <= cfg.skipBeyondSq
      if (mesh.isLOD && mesh.visible) mesh.update(camera)
    }
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
    if (!_discoveredModelUrls.has(url)) _discoveredModelUrls.add(url)
    try {
      loadingMgr.beginDownload(url)
      let gltf
      const geoHit = await getGeometry(url)
      if (geoHit) {
        const grp = new THREE.Group()
        for (const d of geoHit) { try { const mesh = new THREE.Mesh(reconstructGeometry(d), new THREE.MeshStandardMaterial({ color: d.matColor, roughness: d.matRoughness, metalness: d.matMetalness })); mesh.material.name = d.matName; mesh.name = d.name; mesh.castShadow = d.castShadow; mesh.receiveShadow = d.receiveShadow; mesh.visible = d.visible; mesh.matrixAutoUpdate = d.matrixAutoUpdate; mesh.position.set(...d.position); mesh.quaternion.set(...d.quaternion); mesh.scale.set(...d.scale); grp.add(mesh) } catch { } }
        gltf = { scene: grp }; loadingMgr.completeDownload(url)
      } else if (_parsedGltfCache.has(url)) {
        gltf = _parsedGltfCache.get(url); _parsedGltfCache.delete(url); _parsedGltfCache.set(url, gltf); loadingMgr.completeDownload(url)
      } else if (_parsedGltfInflight.has(url)) {
        gltf = await _parsedGltfInflight.get(url); loadingMgr.completeDownload(url)
      } else {
        const isVRM = url.endsWith('.vrm')
        const cachedMeshes = !isVRM ? await getGeometry(url) : null
        if (cachedMeshes?.length) {
          const g = new THREE.Group()
          for (const d of cachedMeshes) { const geo = reconstructGeometry(d); const mat = new THREE.MeshStandardMaterial({ name: d.matName, color: d.matColor, roughness: d.matRoughness, metalness: d.matMetalness, transparent: d.matTransparent, opacity: d.matOpacity }); const m = new THREE.Mesh(geo, mat); m.name = d.name; m.position.fromArray(d.position); m.quaternion.fromArray(d.quaternion); m.scale.fromArray(d.scale); m.castShadow = d.castShadow; m.receiveShadow = d.receiveShadow; m.visible = d.visible !== false; m.matrixAutoUpdate = !!d.matrixAutoUpdate; g.add(m) }
          gltf = { scene: g, animations: [] }; _parsedGltfCache.set(url, gltf); loadingMgr.completeDownload(url)
          console.log('[geo-cache] hit:', url)
        } else {
          const p = fetchCached(url).then(buf => gltfLoader.parseAsync(patchGLB(buf, url), ''))
          _parsedGltfInflight.set(url, p); gltf = await p; _parsedGltfInflight.delete(url)
          console.log(`[MEM] parsed ${url.split('/').pop()}: ${Math.round(performance.memory?.usedJSHeapSize/1024/1024)||0}MB`)
          if (_parsedGltfCache.size >= MAX_GLTF_CACHE) _parsedGltfCache.delete(_parsedGltfCache.keys().next().value)
          _parsedGltfCache.set(url, gltf); loadingMgr.completeDownload(url)
          if (!isVRM) { const hasImages = (gltf.parser?.json?.images?.length || 0) > 0; if (!hasImages) { const dms = []; gltf.scene.traverse(c => { if (c.isMesh && !c.isSkinnedMesh) dms.push(c) }); if (dms.length) storeGeometry(url, dms).catch(() => {}) } }
        }
      }
            const model = gltf.scene.clone(true); model.userData.url = url
      const mp = entityState.position; model.position.set(mp[0], mp[1], mp[2])
      const mr = entityState.rotation; if (mr) model.quaternion.set(mr[0], mr[1], mr[2], mr[3])
      const msc = entityState.scale; if (msc) model.scale.set(msc[0], msc[1], msc[2])
      const isDynamic = entityState.bodyType === 'dynamic', colliders = [], bvhPending = []
      model.traverse(c => {
        if (!c.isMesh) return
        const mn = (c.material?.name || '').toLowerCase()
        if (SKIP_MATS_SET.has(mn) || SKIP_MATS_SET.has(c.material?.name)) { c.visible = false; return }
        c.castShadow = true; c.receiveShadow = true
        if (!c.isSkinnedMesh && !isDynamic) { c.matrixAutoUpdate = false; bvhPending.push(c); colliders.push(c) }
        if (c.material) { c.material.shadowSide = THREE.DoubleSide; c.material.roughness = 1; c.material.metalness = 0; if (c.material.specularIntensity !== undefined) c.material.specularIntensity = 0 }      })
      if (bvhPending.length > 0) _scheduleBvhBuild(bvhPending)
      model.updateMatrixWorld(true)
      const finalMesh = isDynamic ? model : (entityState.custom?.noAutoLod ? model : _generateLODEager(model, entityState.custom?.mesh, url))
      scene.add(finalMesh); entityMeshes.set(entityId, finalMesh)
      if (model.userData.spin || model.userData.hover) _animatedEntities.push(finalMesh)
      if (isDynamic) { const segs = []; model.traverse(c => { if (!c.isMesh) return; const seg = new THREE.LineSegments(new THREE.WireframeGeometry(c.geometry), new THREE.LineBasicMaterial({ color: 0x00ff00, depthTest: false })); seg.visible = !!window.__showHulls__; c.add(seg); segs.push(seg) }); _hullMeshes.set(entityId, segs) }
      _tagMesh(finalMesh)
      if (!isDynamic) { cam.addEnvironment(colliders); scheduleFitShadow() }
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
    const ai = _animatedEntities.indexOf(m); if (ai >= 0) { _animatedEntities[ai] = _animatedEntities[_animatedEntities.length - 1]; _animatedEntities.pop() }
  }

  return { entityMeshes, _animatedEntities, _hullMeshes, entityTargets, loadEntityModel, removeEntity, rebuildEntityHierarchy, updateVisibility, LOD_CONFIGS, scheduleLodUpgrades: _scheduleLodUpgrades }
}