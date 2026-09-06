// Client visual layer for instanced rocks. Reads the SAME deterministic placement as the server (RockPhysics.js) so the visual rock matches the collided rock. One BatchedMesh holds all 6 SDF rock types, drawn in a single multiDraw call. window.__rocks / window.__rocksProfile.
import * as THREE from 'three'
import { makeRockSDF, marchRockSurface } from '/src/terrain/RockShapes.js'
import { createRockChunkCursor, ROCK } from '/src/terrain/RockPlacement.js'
import { createCachedAnchorField } from '/src/terrain/ClimateCache.js'
import { createBiomeOverride } from '/src/terrain/BiomeOverride.js'
import { dbg } from './debug-log.js'
import { spiralOffsets, chunkKey, resolveCameraPose } from './PlacementScheduler.js'
import { createOcclusionSuperCells } from './OcclusionPolicy.js'

const _dbgRocks = dbg('rocks')

const DROP_MARGIN = 64
const ROCK_BASE_SEED = 1337   // must match RockPhysics generateRockHullData baseSeed

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _yawQ = new THREE.Quaternion()
const _m4 = new THREE.Matrix4(), _s = new THREE.Vector3(), _col = new THREE.Color()
const _now = (typeof performance !== 'undefined') ? () => performance.now() : () => Date.now()

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
  // per-type conservative local-space reach (bounding-sphere centre offset + radius): scaled by an
  // instance's max axis scale it bounds every vertex of that rock, for the exact per-chunk AABBs below
  const geoReach = geos.map(g => g ? (g.boundingSphere.center.length() + g.boundingSphere.radius) : 0)
  let maxVerts = 0, maxIdx = 0
  for (const g of geos) { if (!g) continue; maxVerts += g.attributes.position.count; maxIdx += g.index ? g.index.count : 0 }
  maxVerts += 64; maxIdx += 64

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.0 })
  applyRockTexture(mat)
  const bm = new THREE.BatchedMesh(MAX_INSTANCES, maxVerts, maxIdx, mat)
  bm.frustumCulled = false   // BatchedMesh does its own per-instance culling
  // BatchedMesh defaults sortObjects=true (back-to-front draw-order sort, needed for correct alpha
  // blending) -- rocks are fully opaque, so the per-frame O(n log n) JS sort buys nothing: same pattern
  // Grass.js already declines for its own opaque blades.
  bm.sortObjects = false
  // ---- GPU texture upload hygiene (both parts run inside the onBeforeRender wrapper below) --------
  // (a) Dirty-checks the multiDraw result and rolls the indirect texture version back when unchanged:
  //     BatchedMesh.onBeforeRender otherwise re-uploads it every frame even on a still camera,
  //     ghost-copy-stalling D3D11/ANGLE.
  // (b) PARTIAL matrices/colors upload: BatchedMesh.setMatrixAt/setColorAt flag the WHOLE
  //     MAX_INSTANCES-sized (12000 x 4 px RGBA32F = 768KB) matrices texture (and the colors texture)
  //     `needsUpdate`, so three re-uploads the entire texture on every frame a chunk streamed in or out
  //     -- and budgeted streaming (see streamRing) spreads mutations over MORE frames, not fewer. Every
  //     mutated instance id marks its texture ROW dirty here; before three's own upload check runs the
  //     dirty row runs are pushed with gl.texSubImage2D and the texture version is rolled back to the
  //     version three already holds (same trick as (a)), so three sees nothing to upload. The first
  //     upload (no __webglTexture yet) and any size/context re-init are left to three's full path.
  //     Byte-identical GPU content (the same rows from the same CPU array), only fewer bytes moved.
  const _texRows = { mat: null, col: null }   // per-texture Uint8Array(height) dirty row flags
  function _markRow(which, tex, id, pixelsPerInstance) {
    if (!tex) return
    const h = tex.image.height
    let rows = _texRows[which]
    if (!rows || rows.length !== h) { rows = new Uint8Array(h); _texRows[which] = rows; rows.fill(1) }   // unknown history -> everything dirty once
    rows[Math.floor((id * pixelsPerInstance) / tex.image.width)] = 1
  }
  let _partialUploads = 0, _fullUploads = 0
  function _flushPartial(tex, which, pixelsPerInstance) {
    const rows = _texRows[which]
    if (!tex || !rows) return
    const props = renderer.properties.get(tex)
    const glTex = props && props.__webglTexture
    if (!glTex || props.__version === undefined) { _fullUploads++; return }   // three's own full upload initializes it
    if (props.__version === tex.version) { rows.fill(0); return }             // nothing pending
    if (rows.length !== tex.image.height) return   // let three's full upload handle a resize
    let any = false
    for (let r = 0; r < rows.length; r++) if (rows[r]) { any = true; break }
    if (!any) { _fullUploads++; return }   // version moved without a row we marked -> never roll back; three uploads in full
    const gl = renderer.getContext()
    const { data, width } = tex.image
    const unit = gl.TEXTURE0 + Math.max(0, renderer.capabilities.maxTextures - 1)
    renderer.state.activeTexture(unit)
    renderer.state.bindTexture(gl.TEXTURE_2D, glTex, unit)
    const cFlip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL), cPre = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL), cAlign = gl.getParameter(gl.UNPACK_ALIGNMENT), cConv = gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    for (let r = 0; r < rows.length; r++) {
      if (!rows[r]) continue
      let e = r; while (e + 1 < rows.length && rows[e + 1]) e++
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, width, e - r + 1, gl.RGBA, gl.FLOAT, data, r * width * 4)
      _partialUploads++
      r = e
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, cFlip)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, cPre)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, cAlign)
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, cConv)
    rows.fill(0)
    tex.version = props.__version   // three's setTexture2D now sees no pending change -> no full re-upload
  }
  {
    const origOBR = bm.onBeforeRender
    let prevN = -1
    const prevStarts = new Int32Array(MAX_INSTANCES)
    const prevCounts = new Int32Array(MAX_INSTANCES)
    const prevIndirect = new Uint32Array(MAX_INSTANCES)
    bm.onBeforeRender = function (renderer, sc, camera, geometry, material, group) {
      _flushPartial(this._matricesTexture, 'mat', 4)
      _flushPartial(this._colorsTexture, 'col', 1)
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

  const CH = ROCK.CHUNK
  const loaded = new Map()   // chunkKey(cx,cz) -> { key, cx, cz, ids, aabbMin, aabbMax, occluded, inFrustum }
  // 128m super-cell occlusion candidates -- see OcclusionPolicy.createOcclusionSuperCells. Rocks are a candidate to be culled, never an occluder.
  const occ = createOcclusionSuperCells({ prefix: 'r', cellsPerSide: 4, margin: 2, liftMin: 2, countOf: c => c.ids.length })
  let curSuper = null, totalInstances = 0
  const profile = { totalInstances: 0, visibleInstances: 0, drawCalls: 0, updateMs: 0, loads: 0, unloads: 0, types: ROCK.TYPES, buildErrors: buildErr, batched: true, loadMsMax: 0, loadMsTotal: 0, deferredTicks: 0, chunksCulled: 0, partialUploads: 0, fullUploads: 0 }
  if (typeof window !== 'undefined') window.__rocksProfile = profile   // stable object: mirror once

  function commitChunk(cx, cz, list) {
    const key = chunkKey(cx, cz)
    if (loaded.has(key)) return
    const ids = []
    // Exact per-chunk AABB: the chunk's own 32m footprint UNIONED with every placed rock's real reach
    // (position +- scaled bounding-sphere reach) -- never smaller than the old chunk-footprint box on any
    // axis (the occlusion box therefore only ever hides LESS than before), and a genuinely conservative
    // bound for the chunk-granularity frustum pre-cull in updateVisibility (a rock jittered up to
    // JITTER=3.2m past the chunk edge with a 10m scale reaches well outside its chunk's footprint).
    let minX = cx * CH, maxX = (cx + 1) * CH, minZ = cz * CH, maxZ = cz * CH + CH
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
      _markRow('mat', bm._matricesTexture, id, 4)
      const tint = 0.78 + p.variant * 0.4
      try { bm.setColorAt(id, _col.setScalar(Math.min(1, tint))); _markRow('col', bm._colorsTexture, id, 1) } catch (_) {}
      ids.push(id)
      totalInstances++
      const r = geoReach[p.type] * p.scale * Math.max(1, p.squash)
      if (p.x - r < minX) minX = p.x - r; if (p.x + r > maxX) maxX = p.x + r
      if (p.z - r < minZ) minZ = p.z - r; if (p.z + r > maxZ) maxZ = p.z + r
      if (p.y - r < _minY) _minY = p.y - r
      if (p.y + r > _maxY) _maxY = p.y + r
    }
    // Fall back to a sampled ground height (not a hardcoded guess) when the chunk placed zero rocks,
    // so an empty-but-still-registered cell's box still fronts the real local terrain.
    if (_minY === Infinity) {
      let gh = 0
      try { gh = frame.groundHeightLocal(cx * CH + CH * 0.5, cz * CH + CH * 0.5) } catch (_) {}
      if (!Number.isFinite(gh)) gh = 0
      _minY = gh - 2; _maxY = gh + 2
    }
    const cell = { key, cx, cz, ids, aabbMin: [minX, _minY, minZ], aabbMax: [maxX, _maxY, maxZ], occluded: false, inFrustum: true }
    loaded.set(key, cell)
    occ.add(key, cx, cz, cell)
    _rockLoadFifo.push(cell)
    meshes[0].count = totalInstances
    profile.loads++
    _mutated = true
  }

  // Synchronous full load (prewarm): completes an in-flight cursor for this chunk, else a fresh one -- identical output to the budgeted path.
  function loadChunk(cx, cz) {
    const key = chunkKey(cx, cz)
    if (loaded.has(key)) return
    const t0 = _now()
    let list = null
    if (_inflight && _inflight.key === key) { const f = _inflight; _inflight = null; f.cursor.step(Infinity); list = f.cursor.list }
    else { try { const c = createRockChunkCursor(cx, cz, frame, anchorField, worldSeed); c.step(Infinity); list = c.list } catch (_) { list = null } }
    commitChunk(cx, cz, list)
    const ms = _now() - t0
    profile.loadMsTotal += ms; if (ms > profile.loadMsMax) profile.loadMsMax = ms
  }

  function unloadChunk(cell) {
    if (!loaded.has(cell.key)) return
    for (const id of cell.ids) { try { bm.deleteInstance(id); totalInstances-- } catch (_) {} }
    loaded.delete(cell.key); occ.remove(cell.key); meshes[0].count = totalInstances; profile.unloads++
    _mutated = true
  }

  // ---- streaming ring -------------------------------------------------------------------------------
  // Per-tick wall-clock budget replaces the old unbudgeted "3 chunks per tick": RockPlacement cursors
  // (order/value-identical to placementsForRockChunk) run until the budget is spent, completing as many
  // chunks as fit -- several when patches are resident, a fraction of one when a chunk's taps fall back
  // to the CPU fractal. Same GPU-patch prefetch/deferral as Vegetation.js (see its comment): the next
  // spiral chunk's patch is requested a tick ahead and a chunk whose centre patch is not yet resident
  // waits up to DEFER_MAX_TICKS (order preserved) before being placed from the fractal fallback.
  const LOAD_BUDGET_MS = Number.isFinite(cfg.rockLoadBudgetMs) ? cfg.rockLoadBudgetMs : 3
  let _inflight = null   // { key, cx, cz, cursor, t0 }
  let _ringClean = false, _scanCx = NaN, _scanCz = NaN
  let _rockSpiral = null, _rockSpiralSpan = -1
  let _rockSpiralCursor = 0   // forward-only resume index; reset on chunk-cell change
  const _rockLoadFifo = []   // load-order FIFO of cell records -> O(1) amortized eviction candidate
  const _patchAware = typeof frame._patchPrefetch === 'function' && typeof frame._fractalGroundHeightLocal === 'function'
  const DEFER_MAX_TICKS = 6
  let _deferKey = -1, _deferTicks = 0, _lastPrefetchKey = -1
  function _patchResident(cx, cz) {
    const x = cx * CH + CH * 0.5, z = cz * CH + CH * 0.5
    let hp, hf
    try { hp = frame.groundHeightLocal(x, z); hf = frame._fractalGroundHeightLocal(x, z) } catch (_) { return true }
    return hp !== hf
  }
  function _prefetchAhead(cCx, cCz, px, pz, fromIdx) {
    if (!_patchAware) return
    const end = Math.min(_rockSpiral.length, fromIdx + 96)
    for (let i = fromIdx; i < end; i++) {
      const cx = cCx + _rockSpiral[i][0], cz = cCz + _rockSpiral[i][1]
      const ddx = cx * CH - px, ddz = cz * CH - pz
      if ((ddx * ddx + ddz * ddz) > ringRadiusSq) continue
      const key = chunkKey(cx, cz)
      if (loaded.has(key) || (_inflight && _inflight.key === key)) continue
      if (key === _lastPrefetchKey) return
      _lastPrefetchKey = key
      const x = cx * CH + CH * 0.5, z = cz * CH + CH * 0.5
      try { frame.groundHeightLocal(x, z); frame._patchPrefetch(x, z) } catch (_) {}
      return
    }
  }
  function _finishInflight() {
    const f = _inflight; _inflight = null
    commitChunk(f.cx, f.cz, f.cursor.list)
    const ms = _now() - f.t0
    profile.loadMsTotal += ms; if (ms > profile.loadMsMax) profile.loadMsMax = ms
  }
  function streamRing(px, pz) {
    const cCx = Math.round(px / CH), cCz = Math.round(pz / CH)
    curSuper = [cCx, cCz]
    const deadline = _now() + LOAD_BUDGET_MS
    let didLoad = false
    if (_inflight) {
      if (!_inflight.cursor.step(Math.max(0, deadline - _now()))) { _ringClean = false; return true }
      _finishInflight(); didLoad = true
    }
    if (_ringClean && cCx === _scanCx && cCz === _scanCz) return didLoad
    profile.ringScans = (profile.ringScans || 0) + 1
    const span = Math.ceil(ringRadius / CH)
    if (span !== _rockSpiralSpan) { _rockSpiral = spiralOffsets(span); _rockSpiralSpan = span; _rockSpiralCursor = 0 }
    if (cCx !== _scanCx || cCz !== _scanCz) _rockSpiralCursor = 0
    let deferred = false
    while (totalInstances < MAX_INSTANCES && _now() < deadline) {
      let found = false
      for (; _rockSpiralCursor < _rockSpiral.length; _rockSpiralCursor++) {
        const dx = _rockSpiral[_rockSpiralCursor][0], dz = _rockSpiral[_rockSpiralCursor][1]
        const cx = cCx + dx, cz = cCz + dz
        const ddx = cx * CH - px, ddz = cz * CH - pz
        const key = chunkKey(cx, cz)
        if ((ddx * ddx + ddz * ddz) > ringRadiusSq || loaded.has(key)) continue
        if (_patchAware && !_patchResident(cx, cz)) {
          if (_deferKey !== key) { _deferKey = key; _deferTicks = 0 }
          if (++_deferTicks <= DEFER_MAX_TICKS) { profile.deferredTicks++; deferred = true; try { frame._patchPrefetch(cx * CH + CH * 0.5, cz * CH + CH * 0.5) } catch (_) {} break }
        }
        _deferKey = -1
        _inflight = { key, cx, cz, cursor: createRockChunkCursor(cx, cz, frame, anchorField, worldSeed), t0: _now() }
        _prefetchAhead(cCx, cCz, px, pz, _rockSpiralCursor + 1)
        found = true; break
      }
      if (!found) break
      if (!_inflight.cursor.step(Math.max(0, deadline - _now()))) break
      _finishInflight(); didLoad = true
    }
    let didDrop = false
    while (_rockLoadFifo.length) {
      const cell = _rockLoadFifo[0]
      if (!loaded.has(cell.key)) { _rockLoadFifo.shift(); continue }
      const ddx = cell.cx * CH - px, ddz = cell.cz * CH - pz
      if ((ddx * ddx + ddz * ddz) > dropRadiusSq) {
        _rockLoadFifo.shift(); unloadChunk(cell); didDrop = true
      }
      break
    }
    if (!didDrop && _rockLoadFifo.length) {
      for (const cell of loaded.values()) {
        const ddx = cell.cx * CH - px, ddz = cell.cz * CH - pz
        if ((ddx * ddx + ddz * ddz) > dropRadiusSq) {
          const fi = _rockLoadFifo.indexOf(cell); if (fi >= 0) _rockLoadFifo.splice(fi, 1)
          unloadChunk(cell); didDrop = true; break
        }
      }
    }
    _scanCx = cCx; _scanCz = cCz; _ringClean = !didLoad && !didDrop && !_inflight && !deferred
    return didLoad || didDrop
  }

  let _mutated = false
  const _ownPose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
  const _frustum = new THREE.Frustum(), _projMat = new THREE.Matrix4(), _cullBox = new THREE.Box3()

  // updateStreaming: the ~25Hz placement half (ring scan / eviction / profile). See Vegetation.js.
  function updateStreaming(dt, camera, playerPos, pose) {
    const t0 = _now()
    let px, pz
    if (playerPos && Array.isArray(playerPos.position)) { px = playerPos.position[0]; pz = playerPos.position[2] }
    else if (Array.isArray(playerPos)) { px = playerPos[0]; pz = playerPos[2] }
    else if (playerPos && Number.isFinite(playerPos.x)) { px = playerPos.x; pz = playerPos.z }
    else if (pose) { px = pose.x; pz = pose.z }
    else if (camera) { resolveCameraPose(camera, _ownPose); px = _ownPose.x; pz = _ownPose.z }
    if (Number.isFinite(px) && Number.isFinite(pz)) streamRing(px, pz)
    profile.totalInstances = totalInstances; profile.visibleInstances = bm.instanceCount || totalInstances
    profile.rockDrawCalls = 1
    profile.loadedChunks = loaded.size
    profile.occSuperCells = occ.superCount
    profile.occHiddenSuperCells = occ.hiddenCount
    profile.partialUploads = _partialUploads; profile.fullUploads = _fullUploads
    try { profile.drawCalls = renderer.info.render.calls } catch (_) {}
    profile.updateMs = _now() - t0
  }

  // updateVisibility: the every-frame half.
  // (1) Still-camera cull-freeze: BatchedMesh.onBeforeRender's own early-exit skips its per-instance
  //     getMatrixAt+getBoundingSphereAt+frustum-intersect loop ONLY when _visibilityChanged is false AND
  //     perObjectFrustumCulled is false AND sortObjects is false. sortObjects is already false; toggle
  //     perObjectFrustumCulled off while camera position+rotation are both still and re-arm instantly on
  //     any real movement OR a streaming mutation (a newly streamed-in/dropped rock must re-enter the
  //     frustum-cull pass the same frame it changes).
  // (2) Chunk-granularity frustum PRE-cull (the same pass Grass.js runs): each loaded chunk's exact AABB
  //     (see commitChunk) vs the camera frustum, O(loaded chunks) instead of O(instances); every rock in a
  //     chunk that is entirely outside the frustum is flagged invisible via setVisibleAt so BatchedMesh's
  //     own per-instance loop skips its matrix/sphere test for it. Only re-run when the camera moved
  //     (a still camera's verdict cannot change), and only chunks that CROSSED the boundary are touched.
  //     A rock in a fully-outside chunk is never on screen, so this changes nothing visible.
  let _cullFrozen = false
  let _lastPx = NaN, _lastPz = NaN, _idleFrames = 0
  const IDLE_EPS = 0.05
  let _lastQx = NaN, _lastQy = NaN, _lastQz = NaN, _lastQw = NaN
  const ROT_COS_EPS = 0.999985
  function updateVisibility(camera, pose) {
    if (!pose && camera) pose = resolveCameraPose(camera, _ownPose)
    let cameraStill = false, rotationStill = true
    if (pose) {
      const mdx = pose.x - _lastPx, mdz = pose.z - _lastPz
      cameraStill = Number.isFinite(mdx) && (mdx * mdx + mdz * mdz) < IDLE_EPS * IDLE_EPS
      _idleFrames = cameraStill ? _idleFrames + 1 : 0
      _lastPx = pose.x; _lastPz = pose.z
      if (Number.isFinite(_lastQw)) {
        const dot = pose.qx * _lastQx + pose.qy * _lastQy + pose.qz * _lastQz + pose.qw * _lastQw
        rotationStill = Math.abs(dot) >= ROT_COS_EPS
      } else rotationStill = false
      _lastQx = pose.qx; _lastQy = pose.qy; _lastQz = pose.qz; _lastQw = pose.qw
    }
    const wantFrozen = cameraStill && rotationStill && _idleFrames > 0 && !_mutated
    const mutated = _mutated
    _mutated = false
    if (wantFrozen !== _cullFrozen) { _cullFrozen = wantFrozen; bm.perObjectFrustumCulled = !wantFrozen; profile.cullFrozen = wantFrozen }
    if ((!wantFrozen || mutated) && camera) {
      _projMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      _frustum.setFromProjectionMatrix(_projMat)
      let culledCount = 0
      for (const cell of loaded.values()) {
        _cullBox.min.set(cell.aabbMin[0], cell.aabbMin[1], cell.aabbMin[2])
        _cullBox.max.set(cell.aabbMax[0], cell.aabbMax[1], cell.aabbMax[2])
        const inFrustum = _frustum.intersectsBox(_cullBox)
        if (inFrustum === cell.inFrustum) { if (!inFrustum) culledCount++; continue }
        cell.inFrustum = inFrustum
        if (!inFrustum) culledCount++
        // occlusion and frustum culling are two independent hide-reasons over the same visible bit: an
        // occluded chunk stays hidden while re-entering the frustum (applyOcclusion re-shows it later)
        if (cell.occluded) continue
        for (const id of cell.ids) { try { bm.setVisibleAt(id, inFrustum) } catch (_) {} }
      }
      profile.chunksCulled = culledCount
    }
  }

  function update(dt, camera, playerPos, pose) {
    updateStreaming(dt, camera, playerPos, pose)
    updateVisibility(camera, pose)
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
    loaded.clear(); occ.clear(); _rockLoadFifo.length = 0; _inflight = null; totalInstances = 0; meshes.length = 0
    if (typeof window !== 'undefined' && window.__rocks && window.__rocks._bm === bm) delete window.__rocks
  }

  const _yieldFrame = () => new Promise(r => (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(() => r()) : setTimeout(r, 0))
  async function prewarm(px, pz, budgetMs = 60000) {
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return 0
    const t0 = _now()
    const cCx = Math.round(px / CH), cCz = Math.round(pz / CH)
    const span = Math.ceil(ringRadius / CH)
    if (span !== _rockSpiralSpan) { _rockSpiral = spiralOffsets(span); _rockSpiralSpan = span }
    let n = 0
    for (const [dx, dz] of _rockSpiral) {
      if (totalInstances >= MAX_INSTANCES) break
      if (_now() - t0 > budgetMs) break
      const cx = cCx + dx, cz = cCz + dz
      const ddx = cx * CH - px, ddz = cz * CH - pz
      if ((ddx * ddx + ddz * ddz) > ringRadiusSq || loaded.has(chunkKey(cx, cz))) continue
      loadChunk(cx, cz); n++
      if (n % 8 === 0) await _yieldFrame()
    }
    return n
  }

  function getOcclusionCandidates() { return occ.candidates() }
  // Delta-applied per flipped super-cell (see createOcclusionSuperCells). Combines with the chunk-frustum
  // pre-cull over the same visible bit: a rock is shown only when BOTH in-frustum AND not occluded.
  function _setCellHidden(cell, hide) {
    if (cell.occluded === hide) return
    cell.occluded = hide
    if (!cell.inFrustum) return   // frustum-culled already hides these; don't fight that state
    for (const id of cell.ids) { try { bm.setVisibleAt(id, !hide) } catch (_) {} }
  }
  function applyOcclusion(occludedKeys) { occ.applyOcclusion(occludedKeys, _setCellHidden) }

  // Same rebuild-everything discipline as Vegetation.js's rebuildPlacement: unload every loaded chunk
  // and reset the streamRing scan-cache so the next update() call re-visits every currently-in-range
  // chunk fresh (through the now-repainted anchorField), rather than trusting the idle-camera early exit.
  function rebuildPlacement() { _inflight = null; _deferKey = -1; _lastPrefetchKey = -1; for (const cell of [...loaded.values()]) unloadChunk(cell); _rockLoadFifo.length = 0; curSuper = null; _ringClean = false; _scanCx = NaN; _scanCz = NaN; _rockSpiralCursor = 0 }
  // Applies an authoritative paint-biome stroke (see the matching Vegetation.js repaintBiome) to this
  // client's own override layer, then rebuilds placement so visible rock density/type genuinely changes.
  function repaintBiome(x, z, radius, target, strength) { biomeOverride.applyPaintBrush(x, z, radius, target, strength); rebuildPlacement() }

  const api = { update, updateStreaming, updateVisibility, prewarm, warmShaders, dispose, _meshes: meshes, _bm: bm, get totalInstances() { return totalInstances }, get profile() { return profile }, rebuildPlacement, repaintBiome, biomeOverride, getOcclusionCandidates, applyOcclusion, cfg, renderDistance }
  if (typeof window !== 'undefined') window.__rocks = api
  return api
}
