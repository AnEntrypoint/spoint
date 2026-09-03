// Client visual layer for instanced rocks. Reads the SAME deterministic placement as the server (RockPhysics.js) so the visual rock matches the collided rock. One BatchedMesh holds all 6 SDF rock types, drawn in a single multiDraw call. window.__rocks / window.__rocksProfile.
import * as THREE from 'three'
import { makeRockSDF, marchRockSurface } from '/src/terrain/RockShapes.js'
import { placementsForRockChunk, ROCK } from '/src/terrain/RockPlacement.js'
import { createCachedAnchorField } from '/src/terrain/ClimateCache.js'
import { createBiomeOverride } from '/src/terrain/BiomeOverride.js'
import { dbg } from './debug-log.js'

const _dbgRocks = dbg('rocks')
const _occBoxGeo = new THREE.BoxGeometry(1, 1, 1)   // shared, never-rendered proxy geo for occlusion candidates
const _occBoxMat = new THREE.MeshBasicMaterial()

const DROP_MARGIN = 64
const ROCK_BASE_SEED = 1337   // must match RockPhysics generateRockHullData baseSeed

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _yawQ = new THREE.Quaternion(), _camPos = new THREE.Vector3()
const _m4 = new THREE.Matrix4(), _s = new THREE.Vector3(), _col = new THREE.Color()

// Builds a rock type's geometry from the same SDF the server hull uses (seed parity).
function buildRockGeo(typeIndex, res) {
  const sdf = makeRockSDF(ROCK_BASE_SEED + typeIndex * 7919)
  const { positions, indices } = marchRockSurface(res, sdf)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3))
  g.setIndex(new THREE.BufferAttribute(indices.slice(), 1))
  g.computeVertexNormals()
  g.computeBoundingBox(); g.computeBoundingSphere()
  return g
}

// Procedural surface texture: no UVs, object-local multi-octave value noise (zero asset dependency). Per-instance shade via BatchedMesh setColorAt, not a custom uniform.
function applyRockTexture(material) {
  material.flatShading = false
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec3 vLocalPos;\n' +
      shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLocalPos = position;')
    shader.fragmentShader =
      'varying vec3 vLocalPos;\n' +
      'float rkHash(vec3 p){ p=fract(p*0.3183099+0.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }\n' +
      'float rkNoise(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);\n' +
      ' return mix(mix(mix(rkHash(i+vec3(0.,0.,0.)),rkHash(i+vec3(1.,0.,0.)),f.x),mix(rkHash(i+vec3(0.,1.,0.)),rkHash(i+vec3(1.,1.,0.)),f.x),f.y),\n' +
      '            mix(mix(rkHash(i+vec3(0.,0.,1.)),rkHash(i+vec3(1.,0.,1.)),f.x),mix(rkHash(i+vec3(0.,1.,1.)),rkHash(i+vec3(1.,1.,1.)),f.x),f.y),f.z); }\n' +
      shader.fragmentShader.replace('#include <color_fragment>',
        '#include <color_fragment>\n' +
        '  float rkN = rkNoise(vLocalPos*1.7)*0.6 + rkNoise(vLocalPos*6.5)*0.3 + rkNoise(vLocalPos*23.0)*0.1;\n' +
        '  vec3 rkLo=vec3(0.30,0.28,0.25), rkHi=vec3(0.66,0.62,0.56);\n' +
        '  diffuseColor.rgb *= mix(rkLo,rkHi,clamp(rkN,0.0,1.0))*2.05;')
  }
  material.customProgramCacheKey = () => 'rockproc-batched'
  return material
}

export async function createRocks(opts = {}) {
  const { renderer, scene, frame } = opts
  // Client-visual paint-biome sync (terrain-paint-biome-client-visual-sync) -- see the matching comment
  // in Vegetation.js's createVegetation for the full rationale; same wrap ordering as
  // src/terrain/TerrainPhysics.js's cachedAnchorField/paintedAnchorField pair.
  const biomeOverride = createBiomeOverride()
  const anchorField = biomeOverride.wrapClimateField(createCachedAnchorField(opts.anchorField, frame))
  const cfg = opts.cfg || {}
  const worldSeed = (opts.worldSeed ?? cfg.seed ?? 0) | 0
  if (!renderer || !scene || !frame) throw new Error('createRocks: renderer/scene/frame required')

  const renderDistance = Number.isFinite(cfg.rockRenderDistance) ? cfg.rockRenderDistance : (cfg.renderDistance || 320)
  const ringRadius = renderDistance + 40
  const dropRadius = ringRadius + DROP_MARGIN
  const ringRadiusSq = ringRadius * ringRadius
  const dropRadiusSq = dropRadius * dropRadius
  const MAX_INSTANCES = Number.isFinite(cfg.rockMaxInstances) ? cfg.rockMaxInstances : 12000

  const geos = []
  let buildErr = 0
  for (let t = 0; t < ROCK.TYPES; t++) {
    try { geos.push(buildRockGeo(t, 16)) } catch (e) { buildErr++; geos.push(null); console.error('[rocks] geo build failed:', t, e?.message || e) }
  }
  let maxVerts = 0, maxIdx = 0
  for (const g of geos) { if (!g) continue; maxVerts += g.attributes.position.count; maxIdx += g.index ? g.index.count : 0 }
  maxVerts += 64; maxIdx += 64

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.0 })
  applyRockTexture(mat)
  const bm = new THREE.BatchedMesh(MAX_INSTANCES, maxVerts, maxIdx, mat)
  bm.frustumCulled = false   // BatchedMesh does its own per-instance culling
  // BatchedMesh defaults sortObjects=true (back-to-front draw-order sort, needed for correct alpha
  // blending) -- rocks are fully opaque, so the per-frame O(n log n) JS sort (getMatrixAt +
  // getBoundingSphereAt + applyMatrix4 + depth-key dot product per instance, then Array.sort, up to
  // MAX_INSTANCES=12000) buys nothing: same pattern Grass.js already declines for its own opaque blades.
  bm.sortObjects = false
  // Dirty-checks the multiDraw result and rolls the indirect texture version back when unchanged: BatchedMesh.onBeforeRender otherwise re-uploads it every frame even on a still camera, ghost-copy-stalling D3D11/ANGLE.
  {
    const origOBR = bm.onBeforeRender
    let prevN = -1
    const prevStarts = new Int32Array(MAX_INSTANCES)
    const prevCounts = new Int32Array(MAX_INSTANCES)
    const prevIndirect = new Uint32Array(MAX_INSTANCES)
    bm.onBeforeRender = function (renderer, sc, camera, geometry, material, group) {
      const tex = this._indirectTexture
      const vBefore = tex ? tex.version : 0
      origOBR.call(this, renderer, sc, camera, geometry, material, group)
      if (!tex) return
      const n = this._multiDrawCount
      const starts = this._multiDrawStarts, counts = this._multiDrawCounts, ind = tex.image.data
      let same = n === prevN
      if (same) for (let i = 0; i < n; i++) {
        if (starts[i] !== prevStarts[i] || counts[i] !== prevCounts[i] || ind[i] !== prevIndirect[i]) { same = false; break }
      }
      if (same) { tex.version = vBefore; return }
      prevN = n
      for (let i = 0; i < n; i++) { prevStarts[i] = starts[i]; prevCounts[i] = counts[i]; prevIndirect[i] = ind[i] }
    }
  }
  const geomIds = []
  for (let t = 0; t < ROCK.TYPES; t++) {
    if (!geos[t]) { geomIds.push(-1); continue }
    try { geomIds.push(bm.addGeometry(geos[t])) } catch (e) { buildErr++; geomIds.push(-1); console.error('[rocks] addGeometry failed:', t, e?.message || e) }
  }
  scene.add(bm)
  bm.updateMatrix(); bm.matrixAutoUpdate = false
  // Opaque draw-order band (perf only, zero visual effect -- depth test still enforces correct
  // occlusion regardless of draw order): groups this subsystem's draws adjacently in THREE's opaque
  // render list instead of interleaving with rocks/grass/terrain purely by camera distance, cutting
  // GL program/texture-unit rebind churn between dissimilar shader families. Bands: rocks=1, grass=2,
  // vegetation branch/leaf=3, shared impostor=4 (see Grass.js/Vegetation.js/VegImpostorTier.js).
  bm.renderOrder = 1
  const meshes = [{ im: bm, count: 0 }]

  const loaded = new Map()
  let _occCands = null   // cached getOcclusionCandidates(); nulled on any loaded-set change
  let curSuper = null, totalInstances = 0
  const profile = { totalInstances: 0, visibleInstances: 0, drawCalls: 0, updateMs: 0, loads: 0, unloads: 0, types: ROCK.TYPES, buildErrors: buildErr, batched: true }

  function loadChunk(cx, cz) {
    const key = cx + ',' + cz
    if (loaded.has(key)) return
    const ids = []
    let list; try { list = placementsForRockChunk(cx, cz, frame, anchorField, worldSeed) } catch (_) { list = null }
    // Real placed-rock extent (not a guessed fixed window): the occlusion query box for this chunk
    // must bracket the ACTUAL ground elevation the rocks sit on, or a chunk on a dune/slope taller
    // than a fixed [-4,8] guess puts the box entirely behind the nearer terrain -- self-occlusion at
    // close range/steep angles (same defect class as terrain-occlusion-selfocclusion-envelope, never
    // generalized to this shared streaming-gltf OcclusionQueryTier path). Track real min/max Y (+ each
    // rock's own vertical extent, scale*squash) across every placed rock so the box always fronts them.
    let _minY = Infinity, _maxY = -Infinity
    if (list) for (let i = 0; i < list.length; i++) {
      if (totalInstances >= MAX_INSTANCES) break
      const p = list[i]
      const gid = geomIds[p.type]
      if (gid < 0) continue
      _q.set(p.tiltQuat[0], p.tiltQuat[1], p.tiltQuat[2], p.tiltQuat[3])
      _yawQ.setFromAxisAngle(_v.set(0, 1, 0), p.yaw)
      _q.multiply(_yawQ)
      _s.set(p.scale, p.scale * p.squash, p.scale)
      _m4.compose(_v.set(p.x, p.y, p.z), _q, _s)
      let id = -1
      try { id = bm.addInstance(gid); bm.setMatrixAt(id, _m4) } catch (_) { continue }
      if (id < 0) continue
      const tint = 0.78 + p.variant * 0.4
      try { bm.setColorAt(id, _col.setScalar(Math.min(1, tint))) } catch (_) {}
      ids.push(id)
      totalInstances++
      const halfH = p.scale * p.squash
      if (p.y - halfH < _minY) _minY = p.y - halfH
      if (p.y + halfH > _maxY) _maxY = p.y + halfH
    }
    // Fall back to a sampled ground height (not a hardcoded guess) when the chunk placed zero rocks,
    // so an empty-but-still-registered cell's box still fronts the real local terrain.
    if (_minY === Infinity) {
      let gh = 0
      try { gh = frame.groundHeightLocal(cx * CH + CH * 0.5, cz * CH + CH * 0.5) } catch (_) {}
      if (!Number.isFinite(gh)) gh = 0
      _minY = gh - 2; _maxY = gh + 2
    }
    const _aabbMin = [cx * CH, _minY, cz * CH], _aabbMax = [(cx + 1) * CH, _maxY, cz * CH + CH]
    loaded.set(key, { ids, aabbMin: _aabbMin, aabbMax: _aabbMax, occluded: false })
    _occCands = null
    _rockLoadFifo.push(key)
    meshes[0].count = totalInstances
    profile.loads++
  }

  function unloadChunk(key) {
    const cell = loaded.get(key); if (!cell) return
    for (const id of cell.ids) { try { bm.deleteInstance(id); totalInstances-- } catch (_) {} }
    loaded.delete(key); _occCands = null; meshes[0].count = totalInstances; profile.unloads++
  }

  const CH = ROCK.CHUNK
  const LOADS_PER_FRAME = 3
  let _ringClean = false, _scanCx = NaN, _scanCz = NaN
  let _rockSpiral = null, _rockSpiralSpan = -1
  let _rockSpiralCursor = 0   // forward-only resume index; reset on chunk-cell change
  const _rockLoadFifo = []   // load-order FIFO -> O(1) amortized eviction candidate
  function _rockSpiralOffsets(span) {
    // must be bounded/terminating (a prior manual spiral never terminated and OOM'd the tab)
    const out = []
    for (let dz = -span; dz <= span; dz++) for (let dx = -span; dx <= span; dx++) if (Math.hypot(dx, dz) <= span) out.push([dx, dz])
    out.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]))
    return out
  }
  function streamRing(px, pz) {
    const cCx = Math.round(px / CH), cCz = Math.round(pz / CH)
    curSuper = [cCx, cCz]
    if (_ringClean && cCx === _scanCx && cCz === _scanCz) return
    profile.ringScans = (profile.ringScans || 0) + 1
    const span = Math.ceil(ringRadius / CH)
    if (span !== _rockSpiralSpan) { _rockSpiral = _rockSpiralOffsets(span); _rockSpiralSpan = span; _rockSpiralCursor = 0 }
    if (cCx !== _scanCx || cCz !== _scanCz) _rockSpiralCursor = 0
    let didLoad = false
    for (let n = 0; n < LOADS_PER_FRAME && totalInstances < MAX_INSTANCES; n++) {
      let found = false
      for (; _rockSpiralCursor < _rockSpiral.length; _rockSpiralCursor++) {
        const dx = _rockSpiral[_rockSpiralCursor][0], dz = _rockSpiral[_rockSpiralCursor][1]
        const cx = cCx + dx, cz = cCz + dz
        const ddx = cx * CH - px, ddz = cz * CH - pz
        if ((ddx * ddx + ddz * ddz) > ringRadiusSq || loaded.has(cx + ',' + cz)) continue
        loadChunk(cx, cz); didLoad = true; found = true; break
      }
      if (!found) break
    }
    let didDrop = false
    while (_rockLoadFifo.length) {
      const key = _rockLoadFifo[0]
      if (!loaded.has(key)) { _rockLoadFifo.shift(); continue }
      const ci = key.indexOf(','); const kx = +key.slice(0, ci), kz = +key.slice(ci + 1)
      const ddx = kx * CH - px, ddz = kz * CH - pz
      if ((ddx * ddx + ddz * ddz) > dropRadiusSq) {
        _rockLoadFifo.shift(); unloadChunk(key); didDrop = true
      }
      break
    }
    if (!didDrop && _rockLoadFifo.length) {
      for (const key of loaded.keys()) {
        const ci = key.indexOf(','); const kx = +key.slice(0, ci), kz = +key.slice(ci + 1)
        const ddx = kx * CH - px, ddz = kz * CH - pz
        if ((ddx * ddx + ddz * ddz) > dropRadiusSq) {
          const fi = _rockLoadFifo.indexOf(key); if (fi >= 0) _rockLoadFifo.splice(fi, 1)
          unloadChunk(key); didDrop = true; break
        }
      }
    }
    _scanCx = cCx; _scanCz = cCz; _ringClean = !didLoad && !didDrop
  }

  // Still-camera cull-freeze (ported from Grass.js/Vegetation.js): BatchedMesh.onBeforeRender's own
  // early-exit (node_modules/three/src/objects/BatchedMesh.js:1507) skips its per-instance
  // getMatrixAt+getBoundingSphereAt+frustum-intersect loop ONLY when _visibilityChanged is false AND
  // perObjectFrustumCulled is false AND sortObjects is false. sortObjects is already false (see the
  // comment above bm.sortObjects=false) but perObjectFrustumCulled defaults true and was never toggled
  // here, so that O(instances) loop (up to MAX_INSTANCES=12000) ran EVERY frame unconditionally, camera
  // moving or not -- unlike Vegetation.js/Grass.js's own InstancedMesh2 autoUpdate freeze, rocks had no
  // equivalent gate at all. Toggle perObjectFrustumCulled off while camera position+rotation are both
  // still (same IDLE_EPS/ROT_COS_EPS thresholds Grass.js uses) and re-arm instantly on any real movement
  // OR a streaming mutation (a newly streamed-in/dropped rock must re-enter the frustum-cull pass the
  // same frame it changes, or it would keep its stale visibility/culled state for the rest of the freeze
  // window -- same _streamMutated gap class documented in Vegetation.js/Grass.js).
  let _cullFrozen = false
  let _lastPx = NaN, _lastPz = NaN, _idleFrames = 0
  const IDLE_EPS = 0.05
  let _lastQx = NaN, _lastQy = NaN, _lastQz = NaN, _lastQw = NaN
  const ROT_COS_EPS = 0.999985
  const _cullQ = new THREE.Quaternion()

  function update(dt, camera, playerPos) {
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0
    let px, pz
    if (playerPos && Array.isArray(playerPos.position)) { px = playerPos.position[0]; pz = playerPos.position[2] }
    else if (Array.isArray(playerPos)) { px = playerPos[0]; pz = playerPos[2] }
    else if (playerPos && Number.isFinite(playerPos.x)) { px = playerPos.x; pz = playerPos.z }
    else if (camera) { camera.getWorldPosition(_camPos); px = _camPos.x; pz = _camPos.z }
    let cameraStill = false, _streamMutated = false
    if (Number.isFinite(px) && Number.isFinite(pz)) {
      const mdx = px - _lastPx, mdz = pz - _lastPz
      cameraStill = Number.isFinite(mdx) && (mdx * mdx + mdz * mdz) < IDLE_EPS * IDLE_EPS
      _idleFrames = cameraStill ? _idleFrames + 1 : 0
      _lastPx = px; _lastPz = pz
      const _beforeLoaded = loaded.size
      streamRing(px, pz)
      _streamMutated = loaded.size !== _beforeLoaded
    }
    let rotationStill = true
    if (camera) {
      camera.getWorldQuaternion(_cullQ)
      if (Number.isFinite(_lastQw)) {
        const dot = _cullQ.x * _lastQx + _cullQ.y * _lastQy + _cullQ.z * _lastQz + _cullQ.w * _lastQw
        rotationStill = Math.abs(dot) >= ROT_COS_EPS
      } else rotationStill = false
      _lastQx = _cullQ.x; _lastQy = _cullQ.y; _lastQz = _cullQ.z; _lastQw = _cullQ.w
    }
    const wantFrozen = cameraStill && rotationStill && _idleFrames > 0 && !_streamMutated
    if (wantFrozen !== _cullFrozen) { _cullFrozen = wantFrozen; bm.perObjectFrustumCulled = !wantFrozen; profile.cullFrozen = wantFrozen }
    profile.totalInstances = totalInstances; profile.visibleInstances = bm.instanceCount || totalInstances
    try { profile.drawCalls = renderer.info.render.calls } catch (_) {}
    profile.rockDrawCalls = 1
    profile.updateMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0
    if (typeof window !== 'undefined') window.__rocksProfile = profile
  }

  function warmShaders(camera) {
    if (!camera) return 0
    try { renderer.render(scene, camera); renderer.render(scene, camera) } catch (_) {}
    return 1
  }

  function dispose() {
    try { scene.remove(bm) } catch (e) { _dbgRocks('scene.remove(bm) failed on dispose:', e?.message || e) }
    try { bm.dispose && bm.dispose() } catch (e) { _dbgRocks('BatchedMesh dispose failed:', e?.message || e) }
    try { mat.dispose() } catch (e) { _dbgRocks('material dispose failed:', e?.message || e) }
    for (const g of geos) { try { g && g.dispose() } catch (e) { _dbgRocks('rock geometry dispose failed:', e?.message || e) } }
    loaded.clear(); _occCands = null; totalInstances = 0; meshes.length = 0
    if (typeof window !== 'undefined' && window.__rocks && window.__rocks._bm === bm) delete window.__rocks
  }

  const _yieldFrame = () => new Promise(r => (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(() => r()) : setTimeout(r, 0))
  async function prewarm(px, pz, budgetMs = 60000) {
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return 0
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0
    const cCx = Math.round(px / CH), cCz = Math.round(pz / CH)
    const span = Math.ceil(ringRadius / CH)
    if (span !== _rockSpiralSpan) { _rockSpiral = _rockSpiralOffsets(span); _rockSpiralSpan = span }
    let n = 0
    for (const [dx, dz] of _rockSpiral) {
      if (totalInstances >= MAX_INSTANCES) break
      if (((typeof performance !== 'undefined') ? performance.now() : 0) - t0 > budgetMs) break
      const cx = cCx + dx, cz = cCz + dz
      const ddx = cx * CH - px, ddz = cz * CH - pz
      if ((ddx * ddx + ddz * ddz) > ringRadiusSq || loaded.has(cx + ',' + cz)) continue
      loadChunk(cx, cz); n++
      if (n % 8 === 0) await _yieldFrame()
    }
    return n
  }

  // Same contract as Vegetation.js's getOcclusionCandidates/applyOcclusion -- rocks are a candidate to be culled, never an occluder.
  function getOcclusionCandidates() {
    if (_occCands) return _occCands
    const out = []
    for (const [key, cell] of loaded) {
      if (!cell._occProxy) {
        const root = new THREE.Object3D()
        // must have a real (unit-box) mesh child: OcclusionQueryTier's Box3.setFromObject walks geometry not transforms, so a bare Object3D yields an empty box and the candidate never queries
        const perProxyOccBoxGeo = _occBoxGeo.clone()
        const boxMesh = new THREE.Mesh(perProxyOccBoxGeo, _occBoxMat)
        boxMesh.visible = false
        boxMesh.raycast = () => {}
        root.add(boxMesh)
        // margin+lift: a box flush with the exact ground-anchored AABB false-occludes at steep downward
        // viewing angles / close range (the "rocks disappear on approach" defect -- live-witnessed:
        // clearing the occluded set un-hid a rock at 5m/8m-elevated camera that a flush box wrongly
        // culled). aabbMin/aabbMax now bracket the REAL placed-rock elevation extent (see loadChunk), so
        // LIFT only needs to cover half the box's own height (proportional, mirrors TerrainOcclusion.js's
        // lift=maxElev*0.5) instead of a flat constant that's inadequate once rocks scale past a few metres.
        const rawH = cell.aabbMax[1] - cell.aabbMin[1]
        const MARGIN = 2, LIFT = Math.max(2, rawH * 0.5)
        const size = [cell.aabbMax[0] - cell.aabbMin[0] + MARGIN * 2, rawH + MARGIN * 2, cell.aabbMax[2] - cell.aabbMin[2] + MARGIN * 2]
        root.position.set((cell.aabbMin[0] + cell.aabbMax[0]) / 2, (cell.aabbMin[1] + cell.aabbMax[1]) / 2 + LIFT, (cell.aabbMin[2] + cell.aabbMax[2]) / 2)
        root.scale.set(Math.max(size[0], 1e-3), Math.max(size[1], 1e-3), Math.max(size[2], 1e-3))
        root.updateMatrixWorld(true)
        cell._occProxy = { root, key }
      }
      // instanceCount refreshed every call so SceneOcclusion.js's shared anomaly guard can weight the
      // occluded-fraction check by real instance density, not raw chunk count (same fix as Vegetation.js).
      cell._occProxy.instanceCount = cell.ids.length
      out.push(cell._occProxy)
    }
    _occCands = out
    return out
  }
  function applyOcclusion(occludedKeys) {
    for (const [key, cell] of loaded) {
      const shouldHide = occludedKeys.has(key)
      if (shouldHide === cell.occluded) continue
      cell.occluded = shouldHide
      for (const id of cell.ids) { try { bm.setVisibleAt(id, !shouldHide) } catch (_) {} }
    }
  }

  // Same rebuild-everything discipline as Vegetation.js's rebuildPlacement: unload every loaded chunk
  // and reset the streamRing scan-cache so the next update() call re-visits every currently-in-range
  // chunk fresh (through the now-repainted anchorField), rather than trusting the idle-camera early exit.
  function rebuildPlacement() { for (const key of [...loaded.keys()]) unloadChunk(key); curSuper = null; _ringClean = false; _scanCx = NaN; _scanCz = NaN }
  // Applies an authoritative paint-biome stroke (see the matching Vegetation.js repaintBiome) to this
  // client's own override layer, then rebuilds placement so visible rock density/type genuinely changes.
  function repaintBiome(x, z, radius, target, strength) { biomeOverride.applyPaintBrush(x, z, radius, target, strength); rebuildPlacement() }

  const api = { update, prewarm, warmShaders, dispose, _meshes: meshes, _bm: bm, get totalInstances() { return totalInstances }, get profile() { return profile }, rebuildPlacement, repaintBiome, biomeOverride, getOcclusionCandidates, applyOcclusion, cfg, renderDistance }
  if (typeof window !== 'undefined') window.__rocks = api
  return api
}
