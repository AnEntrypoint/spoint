import { createPlanetFrame, DEFAULT_PATCH_MAX_LEVEL } from './PlanetFrame.js'
import { createCachedAnchorField } from './ClimateCache.js'
import { createHeightDelta, loadHeightDelta } from './HeightDelta.js'
import { createBiomeOverride, loadBiomeOverride } from './BiomeOverride.js'
import { loadSplineCarveLayer } from './SplineCarve.js'
import { loadCaveCarveLayer } from './CaveSDF.js'

const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const NON_FINITE_HEIGHT_FALLBACK_M = -1000

let _samplerPromise = null
export function loadPlanetSampler(opts = {}) {
  if (!_samplerPromise) {
    const _isNode = typeof process !== 'undefined' && process.versions?.node
    const _samplerSpec = _isNode ? 'mapspinner/height-cpu' : ('/node_modules/' + 'mapspinner/src/height-cpu.js')
    _samplerPromise = import(_samplerSpec)
      .then(m => m.createHeightSampler({ radius: opts.radius, hpfTexRes: opts.hpfTexRes, seed: opts.seed, reliefScale: opts.reliefScale }))
  }
  return _samplerPromise
}

export function sampleTerrainGrid({ heightFn, extent = 510, resolution = 4, center = [0, 0] }) {
  let N = Math.max(2, Math.round(extent / resolution)); if (N % 2 !== 0) N += 1
  const spacing = extent / (N - 1)
  const cornerX = center[0] - extent / 2, cornerZ = center[1] - extent / 2
  const samples = new Float32Array(N * N)
  const t0 = _now()
  for (let z = 0; z < N; z++) {
    const wz = cornerZ + z * spacing, row = z * N
    for (let x = 0; x < N; x++) {
      let h = heightFn(cornerX + x * spacing, wz)
      if (!Number.isFinite(h)) h = NON_FINITE_HEIGHT_FALLBACK_M
      samples[row + x] = h
    }
  }
  return { samples, N, spacing, extent, center: [center[0], center[1]], corner: [cornerX, cornerZ], sampleMs: _now() - t0 }
}

export async function sampleTerrainGridChunked({ heightFn, N, spacing, cornerX, cornerZ, budgetMs = 2, isAborted = () => false }) {
  const samples = new Float32Array(N * N)
  const t0 = _now()
  let slice = _now()
  for (let z = 0; z < N; z++) {
    const wz = cornerZ + z * spacing, row = z * N
    for (let x = 0; x < N; x++) {
      let h = heightFn(cornerX + x * spacing, wz)
      if (!Number.isFinite(h)) h = NON_FINITE_HEIGHT_FALLBACK_M
      samples[row + x] = h
    }
    if (_now() - slice >= budgetMs) {
      await new Promise(r => setTimeout(r, 0))
      if (isAborted()) return null
      slice = _now()
    }
  }
  return { samples, sampleMs: _now() - t0 }
}

export function installHeightfield(physics, grid) {
  if (!physics || typeof physics.addHeightField !== 'function' || !grid) return null
  const { samples, N, spacing, corner, extent, sampleMs } = grid
  const id = physics.addHeightField(samples, N, [spacing, 1, spacing], [corner[0], 0, corner[1]])
  if (id == null) { console.error('[terrain] heightfield build failed (Jolt rejected the shape)'); return null }
  console.log(`[terrain] planet heightfield N=${N} (${N * N}) extent=${extent}m spacing=${spacing.toFixed(2)}m sample=${(sampleMs || 0).toFixed(1)}ms id=${id}`)
  return { id, N, spacing, corner, extent }
}

export function createTerrainStreamer(opts = {}) {
  const physics = opts.physics, getCenter = typeof opts.getCenter === 'function' ? opts.getCenter : () => null
  const heightFn = opts.heightFn
  const extent = Number.isFinite(opts.extent) && opts.extent > 0 ? opts.extent : 510
  const resolution = Number.isFinite(opts.resolution) && opts.resolution > 0 ? opts.resolution : 4
  const rebuildAt = Number.isFinite(opts.rebuildAt) ? opts.rebuildAt : 0.4
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 300
  const budgetMs = Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? opts.budgetMs : 2
  let N = Math.max(2, Math.round(extent / resolution)); if (N % 2 !== 0) N += 1
  const spacing = extent / (N - 1)
  let curCenter = null, curBodyId = null, rebuilding = false, disposed = false, _timer = null, rebuildCount = 0

  async function _buildAt(cx, cz, gridN, gridSpacing) {
    const useN = Number.isFinite(gridN) && gridN >= 2 ? gridN : N
    const useSpacing = Number.isFinite(gridSpacing) && gridSpacing > 0 ? gridSpacing : (useN === N ? spacing : extent / (useN - 1))
    const cornerX = cx - extent / 2, cornerZ = cz - extent / 2
    const t0 = _now()
    const g = await sampleTerrainGridChunked({ heightFn, N: useN, spacing: useSpacing, cornerX, cornerZ, budgetMs, isAborted: () => disposed })
    if (!g || disposed) return null
    const newId = physics.addHeightField(g.samples, useN, [useSpacing, 1, useSpacing], [cornerX, 0, cornerZ])
    if (newId == null) { console.error('[terrain] streamer: Jolt rejected field'); return null }
    return { newId, cornerX, cornerZ, wallMs: _now() - t0, sampleMs: g.sampleMs, N: useN }
  }

  async function _rebuild(cx, cz) {
    if (rebuilding || disposed || !heightFn) return
    rebuilding = true
    try {
      const r = await _buildAt(cx, cz)
      if (!r || disposed) return
      const oldId = curBodyId
      curBodyId = r.newId; curCenter = [cx, cz]; physics.setTerrainBodyId(r.newId); rebuildCount++
      if (oldId != null && oldId !== r.newId) physics.removeBody(oldId)
      console.log(`[terrain] planet heightfield re-centered #${rebuildCount} at (${cx.toFixed(0)},${cz.toFixed(0)}) N=${N} ${r.wallMs.toFixed(0)}ms(sample ${r.sampleMs.toFixed(0)}ms) id=${r.newId}`)
    } catch (e) { console.error('[terrain] streamer rebuild error:', e?.message || e) }
    finally { rebuilding = false }
  }
  function _check() {
    if (disposed) return
    try {
      const c = getCenter()
      if (Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) && curCenter && !rebuilding) {
        if (Math.hypot(c[0] - curCenter[0], c[1] - curCenter[1]) > extent * rebuildAt) _rebuild(c[0], c[1])
      }
    } catch (_) {}
    _timer = setTimeout(_check, intervalMs)
  }
  async function start(initialGrid) {
    if (disposed) return
    if (initialGrid) {
      const r = installHeightfield(physics, initialGrid)
      if (r) { curBodyId = r.id; curCenter = initialGrid.center || [0, 0] }
    } else {
      const center = curCenter || [0, 0]
      const coarseN = (N >= 32) ? (Math.max(8, Math.round(N / 4) + (Math.round(N / 4) % 2)) ) : 0
      if (coarseN && coarseN < N) {
        const cr = await _buildAt(center[0], center[1], coarseN)
        if (cr && !disposed) {
          curBodyId = cr.newId; curCenter = center; physics.setTerrainBodyId(cr.newId)
          console.log(`[terrain] planet heightfield COARSE N=${coarseN} extent=${extent}m built ${cr.wallMs.toFixed(0)}ms(sample ${cr.sampleMs.toFixed(0)}ms) id=${cr.newId} -> refining to N=${N}`)
        }
      }
      const r = await _buildAt(center[0], center[1])
      if (r && !disposed) {
        const oldId = curBodyId
        curBodyId = r.newId; curCenter = center; physics.setTerrainBodyId(r.newId)
        if (oldId != null && oldId !== r.newId) physics.removeBody(oldId)
        console.log(`[terrain] planet heightfield N=${N} extent=${extent}m spacing=${spacing.toFixed(2)}m built ${r.wallMs.toFixed(0)}ms(sample ${r.sampleMs.toFixed(0)}ms) id=${r.newId}`)
      }
    }
    _timer = setTimeout(_check, intervalMs)
  }
  return { start, stop() { disposed = true; if (_timer) clearTimeout(_timer) }, get center() { return curCenter }, get bodyId() { return curBodyId }, get rebuildCount() { return rebuildCount }, _rebuild }
}

function _dequantizeSectorized(artifact) {
  const { N, sectors, sectorMin, sectorMax, q } = artifact
  const Sn = sectors.nodesPerSector, gridS = sectors.gridS, qmax = sectors.qmax
  const out = new Float32Array(N * N)
  for (let iz = 0; iz < N; iz++) {
    const sz = Math.min((iz / Sn) | 0, gridS - 1)
    for (let ix = 0; ix < N; ix++) {
      const sx = Math.min((ix / Sn) | 0, gridS - 1)
      const si = sz * gridS + sx
      const lo = sectorMin[si], hi = sectorMax[si], qv = q[iz * N + ix]
      out[iz * N + ix] = (hi > lo) ? lo + (qv / qmax) * (hi - lo) : lo
    }
  }
  return out
}

export function createBakedHeightField(artifact) {
  if (artifact.sectors) artifact = { ...artifact, heights: _dequantizeSectorized(artifact) }
  const { N, extent, center, heights } = artifact
  const step = extent / (N - 1), half = extent / 2
  const cx = (center && center[0]) || 0, cz = (center && center[1]) || 0
  const at = (ix, iz) => { ix = ix < 0 ? 0 : ix > N - 1 ? N - 1 : ix; iz = iz < 0 ? 0 : iz > N - 1 ? N - 1 : iz; const v = heights[iz * N + ix]; return (typeof v === 'number') ? v : 0 }
  return {
    N, extent, center: [cx, cz],
    covers(x, z) { return Math.abs(x - cx) <= half && Math.abs(z - cz) <= half },
    heightAtLocal(x, z) {
      const fx = (x - cx + half) / step, fz = (z - cz + half) / step
      const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz
      const h00 = at(ix, iz), h10 = at(ix + 1, iz), h01 = at(ix, iz + 1), h11 = at(ix + 1, iz + 1)
      return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
    }
  }
}

async function loadBakedHeightField(url) {
  if (!url) return null
  try {
    const _isNode = typeof process !== 'undefined' && process.versions?.node
    if (/\.hf$/i.test(url)) {
      const _hfSpec = _isNode ? 'mapspinner/heightfield-codec' : ('/node_modules/' + 'mapspinner/src/heightfield-codec.js')
      const { decodeHeightfield } = await import(_hfSpec)
      let buf
      if (_isNode) { const fs = await import('node:fs'); buf = fs.readFileSync(url.replace(/^\//, '')); buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
      else { const r = await fetch(url); if (!r.ok) return null; buf = await r.arrayBuffer() }
      const dec = decodeHeightfield(buf)
      if (!dec) return null
      return createBakedHeightField(dec)
    }
    let json
    if (_isNode) { const fs = await import('node:fs'); json = JSON.parse(fs.readFileSync(url.replace(/^\//, ''), 'utf8')) }
    else { const r = await fetch(url); if (!r.ok) return null; json = await r.json() }
    if (!json || !json.N || !(Array.isArray(json.heights) || (json.sectors && Array.isArray(json.q)))) return null
    return createBakedHeightField(json)
  } catch (_) { return null }
}

async function createGpuPatchHeightFn({ frame, tcfg, offsetY }) {
  const _isNode = typeof process !== 'undefined' && process.versions?.node
  const _patchBakerSpec = _isNode ? 'mapspinner/patch-baker' : ('/node_modules/' + 'mapspinner/src/patch-baker.js')
  const { createPatchBaker, createPatchHeightFn } = await import(_patchBakerSpec)
  const baker = await createPatchBaker({ radius: tcfg.radius, reliefScale: tcfg.reliefScale, seed: tcfg.seed }).catch(() => null)
  if (!baker) return null
  const fractalGHL = frame.groundHeightLocal
  return createPatchHeightFn({ baker, frame, maxLevel: Number.isFinite(tcfg.maxLevel) ? tcfg.maxLevel : DEFAULT_PATCH_MAX_LEVEL, offsetY, fallbackFn: fractalGHL })
}

export async function setupTerrainStreaming({ physics, playerManager, worldDef, terrain, heightDeltaJSON, biomeOverrideJSON, splineCarveJSON, caveCarveJSON }) {
  const tcfg = terrain || (worldDef && worldDef.terrain) || null
  if (!tcfg || tcfg.enabled === false || !physics || typeof physics.addHeightField !== 'function') return null
  const tphys = tcfg.physics || {}
  const sampler = await loadPlanetSampler({ radius: tcfg.radius, hpfTexRes: tphys.hpfTexRes, seed: tcfg.seed, reliefScale: tcfg.reliefScale })
  const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
  const cachedAnchorField = createCachedAnchorField(sampler.anchorField, frame)
  const biomeOverride = loadBiomeOverride(biomeOverrideJSON)
  const splineCarve = loadSplineCarveLayer(splineCarveJSON, (x, z) => frame.groundHeightLocal(x, z))
  const paintedAnchorField = splineCarve.wrapClimateField(biomeOverride.wrapClimateField(cachedAnchorField))
  const offsetY = tcfg.offsetY || 0
  const gpuPatch = (tcfg.gpuPatchCollider !== false)
    ? await createGpuPatchHeightFn({ frame, tcfg, offsetY }).catch(() => null)
    : null
  const baked = gpuPatch ? null : await loadBakedHeightField(tcfg.bakedHeightfield).catch(() => null)
  const baseHeightFn = gpuPatch
    ? gpuPatch.heightFn
    : baked
      ? ((x, z) => baked.covers(x, z) ? baked.heightAtLocal(x, z) + offsetY : frame.groundHeightLocal(x, z))
      : ((x, z) => frame.groundHeightLocal(x, z))
  if (gpuPatch) { console.log(`[terrain] collider using LIVE GPU PATCH bake (whole-planet, exact, nothing stored): ${gpuPatch.spacing.toFixed(2)}m collider spacing == finest display LOD (maxLevel ${gpuPatch.maxLevel}, ${gpuPatch.patchSpan.toFixed(0)}m patches, ${gpuPatch.res} samples)`); physics._terrainHeightSource = 'gpu-patch' }
  else if (baked) { console.log(`[terrain] collider using BAKED GPU heightfield (N=${baked.N}, extent=${baked.extent}m) -- exact match to the rendered surface`); physics._terrainHeightSource = 'baked' }
  else physics._terrainHeightSource = 'cpu'
  if (gpuPatch) frame.groundHeightLocal = (x, z) => gpuPatch.heightFn(x, z)
  const heightDelta = loadHeightDelta(heightDeltaJSON, baseHeightFn)
  const caveCarve = loadCaveCarveLayer(caveCarveJSON || (Array.isArray(tcfg.caveCarve) ? { version: 2, volumes: tcfg.caveCarve } : null))
  const heightFn = caveCarve.wrapHeightFn(splineCarve.wrapHeightFn(heightDelta.wrapHeightFn(baseHeightFn)))
  const getCenter = () => {
    let sx = 0, sz = 0, n = 0
    const players = playerManager && playerManager.players
    if (players && typeof players.values === 'function') {
      for (const p of players.values()) { const pos = p?.state?.position; if (pos && Number.isFinite(pos[0]) && Number.isFinite(pos[2])) { sx += pos[0]; sz += pos[2]; n++ } }
    }
    return n ? [sx / n, sz / n] : (tcfg.center || [0, 0])
  }
  const getCenters = () => {
    const out = []
    const players = playerManager && playerManager.players
    if (players && typeof players.values === 'function') {
      for (const p of players.values()) {
        const pos = p?.state?.position
        if (pos && Number.isFinite(pos[0]) && Number.isFinite(pos[2])) out.push([pos[0], pos[2]])
      }
    }
    return out.length ? out : [tcfg.center || [0, 0]]
  }
  let gridRes = tphys.resolution
  if (gpuPatch && Number.isFinite(gpuPatch.spacing)) {
    gridRes = Math.min(tphys.resolution || gpuPatch.spacing, gpuPatch.spacing)
    if (gridRes !== tphys.resolution) console.log(`[terrain] collider grid resolution -> ${gridRes.toFixed(2)}m (clamped to finest display LOD spacing; was ${tphys.resolution})`)
  }
  const streamer = createTerrainStreamer({ physics, getCenter, heightFn, extent: tphys.extent || 510, resolution: gridRes })
  await streamer.start()
  const offsetYNotFoldedIntoHeightFn = 0
  physics.setTerrainHeightSource(heightFn, frame, offsetYNotFoldedIntoHeightFn)

  let trunkStreamer = null
  const vcfg = tcfg.vegetation || null
  if (vcfg && vcfg.colliders) {
    try {
      const { createTrunkColliderStreamer } = await import('./VegPhysics.js')
      trunkStreamer = createTrunkColliderStreamer({
        physics, getCenters, frame, anchorField: paintedAnchorField, worldSeed: tcfg.seed | 0,
        radius: vcfg.colliderRadius || 64, cap: vcfg.colliderCap || 384, byteBudget: vcfg.colliderByteBudget,
      })
      await trunkStreamer.start()
    } catch (e) { console.error('[veg] trunk collider streamer failed:', e?.message || e) }
  }
  streamer._trunkStreamer = trunkStreamer
  let rockStreamer = null
  if (vcfg && vcfg.rockColliders) {
    try {
      const { createRockColliderStreamer } = await import('./RockPhysics.js')
      rockStreamer = createRockColliderStreamer({
        physics, getCenters, frame, anchorField: paintedAnchorField, worldSeed: tcfg.seed | 0,
        radius: vcfg.rockColliderRadius || 32, cap: vcfg.rockColliderCap || 128, byteBudget: vcfg.rockColliderByteBudget,
      })
      await rockStreamer.start()
    } catch (e) { console.error('[rocks] collider streamer failed:', e?.message || e) }
  }
  streamer._rockStreamer = rockStreamer
  streamer.biomeOverride = biomeOverride
  streamer.splineCarve = splineCarve
  streamer.caveCarve = caveCarve
  streamer.repaintBiome = async function repaintBiome() {
    if (trunkStreamer) { trunkStreamer.clearChunkCache(); await trunkStreamer._rebuildMulti((trunkStreamer.centers && trunkStreamer.centers.length) ? trunkStreamer.centers : getCenters(), true) }
    if (rockStreamer) { rockStreamer.clearChunkCache(); await rockStreamer._rebuildMulti((rockStreamer.centers && rockStreamer.centers.length) ? rockStreamer.centers : getCenters(), true) }
  }
  streamer.heightDelta = heightDelta
  streamer.baseHeightFn = baseHeightFn
  streamer.resculpt = async function resculpt() {
    const c = streamer.center || (getCenter ? getCenter() : null) || tcfg.center || [0, 0]
    await streamer._rebuild(c[0], c[1])
  }
  physics._terrainStreamer = streamer
  return streamer
}
