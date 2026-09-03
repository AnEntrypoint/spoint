// Server-side Jolt HeightField collider from the planet's CPU height (mapspinner/height-cpu, same terrain.glsl as the renderer). Re-centers on player travel via createTerrainStreamer.
// Dual import specifier (bare in Node, absolute /node_modules/ path in the browser worker) since this SDK is THREE/GL-free but the worker has no bare-specifier resolution.

import { createPlanetFrame, DEFAULT_PATCH_MAX_LEVEL } from './PlanetFrame.js'
import { createCachedAnchorField } from './ClimateCache.js'
import { createHeightDelta, loadHeightDelta } from './HeightDelta.js'
import { createBiomeOverride, loadBiomeOverride } from './BiomeOverride.js'
import { loadSplineCarveLayer } from './SplineCarve.js'
import { loadCaveCarveLayer } from './CaveSDF.js'

const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

let _samplerPromise = null
export function loadPlanetSampler(opts = {}) {
  if (!_samplerPromise) {
    const _isNode = typeof process !== 'undefined' && process.versions?.node
    // Specifier built at runtime -- see src/physics/World.js's getJolt() comment (same fix, same
    // session) for why a bundler-based edge/DO build target needs this: esbuild statically resolves
    // BOTH ternary branches regardless of runtime reachability.
    const _samplerSpec = _isNode ? 'mapspinner/height-cpu' : ('/node_modules/' + 'mapspinner/src/height-cpu.js')
    _samplerPromise = import(_samplerSpec)
      .then(m => m.createHeightSampler({ radius: opts.radius, hpfTexRes: opts.hpfTexRes, seed: opts.seed, reliefScale: opts.reliefScale }))
  }
  return _samplerPromise
}

// Synchronous full-grid sample; ~0.4ms/sample so a 128x128 grid blocks ~7s -- never call on the tick thread, use sampleTerrainGridChunked instead.
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
      if (!Number.isFinite(h)) h = -1000 // never feed NaN to Jolt
      samples[row + x] = h
    }
  }
  return { samples, N, spacing, extent, center: [center[0], center[1]], corner: [cornerX, cornerZ], sampleMs: _now() - t0 }
}

// Yields to the event loop whenever a burst exceeds budgetMs so the build never blocks the tick by more than that; isAborted() lets caller cancel mid-build.
export async function sampleTerrainGridChunked({ heightFn, N, spacing, cornerX, cornerZ, budgetMs = 2, isAborted = () => false }) {
  const samples = new Float32Array(N * N)
  const t0 = _now()
  let slice = _now()
  for (let z = 0; z < N; z++) {
    const wz = cornerZ + z * spacing, row = z * N
    for (let x = 0; x < N; x++) {
      let h = heightFn(cornerX + x * spacing, wz)
      if (!Number.isFinite(h)) h = -1000 // never feed NaN to Jolt
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

// Re-centers on tracked local-XZ as players travel; chunked rebuild yields to the tick, atomic body swap so the player never outruns the field.
export function createTerrainStreamer(opts = {}) {
  const physics = opts.physics, getCenter = typeof opts.getCenter === 'function' ? opts.getCenter : () => null
  const heightFn = opts.heightFn
  const extent = Number.isFinite(opts.extent) && opts.extent > 0 ? opts.extent : 510
  const resolution = Number.isFinite(opts.resolution) && opts.resolution > 0 ? opts.resolution : 4
  const rebuildAt = Number.isFinite(opts.rebuildAt) ? opts.rebuildAt : 0.4
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 300
  // 2ms keeps the build well under the 64/128TPS tick budget so gameplay timing never hitches.
  const budgetMs = Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? opts.budgetMs : 2
  let N = Math.max(2, Math.round(extent / resolution)); if (N % 2 !== 0) N += 1
  const spacing = extent / (N - 1)
  let curCenter = null, curBodyId = null, rebuilding = false, disposed = false, _timer = null, rebuildCount = 0

  // gridN/gridSpacing default to full-res; pass a coarser gridN for a fast stop-gap field (replaced by full-res via atomic swap).
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
      // coarse-first: low-res field installs fast so the player has ground immediately, then atomic-swap to full-res.
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

// Dequantizes a sector-bounded artifact to a flat Float32Array of N*N local heights (each node's int maps to its own sector's [min,max] range).
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

// Returns null on any failure -> caller falls back to the live CPU sampler.
async function loadBakedHeightField(url) {
  if (!url) return null
  try {
    const _isNode = typeof process !== 'undefined' && process.versions?.node
    if (/\.hf$/i.test(url)) {
      // Specifier built at runtime -- see World.js's getJolt() comment (same fix, same session).
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

// Whole-planet live GPU-patch heightFn, exact and nothing persisted. Collider must sample at >= the finest visual vertex spacing or collision outcomes get coarser than what's rendered.
async function createGpuPatchHeightFn({ frame, tcfg, offsetY }) {
  const _isNode = typeof process !== 'undefined' && process.versions?.node
  // Specifier built at runtime -- see World.js's getJolt() comment (same fix, same session).
  const _patchBakerSpec = _isNode ? 'mapspinner/patch-baker' : ('/node_modules/' + 'mapspinner/src/patch-baker.js')
  const { createPatchBaker, createPatchHeightFn } = await import(_patchBakerSpec)
  const baker = await createPatchBaker({ radius: tcfg.radius, reliefScale: tcfg.reliefScale, seed: tcfg.seed }).catch(() => null)
  if (!baker) return null
  // Shared with the client placement frame so collider + veg/grass/rock derive height from the identical GPU bake -> byte-identical placement parity.
  // maxLevel fallback (DEFAULT_PATCH_MAX_LEVEL) must match TerrainBackdrop.js's client-side call -- see PlanetFrame.js.
  // fallbackFn MUST be captured as the frame's CPU fractal BEFORE setupTerrainStreaming (below) reassigns
  // frame.groundHeightLocal to this same gpuPatch.heightFn -- mirrors TerrainBackdrop.js's client-side
  // "must capture the fractal fn BEFORE it's overwritten" comment (live RangeError repro'd there
  // 2026-07-02; the identical bug was live-reproduced server-side this session, see
  // terrain-height-cpu-parity-oracle-gpu-sole-path AGENTS.md entry, before this fallbackFn was added: a
  // lazily-re-read frame.groundHeightLocal recurses infinitely once heightFn is reassigned to it).
  const fractalGHL = frame.groundHeightLocal
  return createPatchHeightFn({ baker, frame, maxLevel: Number.isFinite(tcfg.maxLevel) ? tcfg.maxLevel : DEFAULT_PATCH_MAX_LEVEL, offsetY, fallbackFn: fractalGHL })
}

// Gated by worldDef.terrain; non-fatal on error. Returns the streamer (or null).
// heightDeltaJSON (optional): a previously-serialized src/terrain/HeightDelta.js toJSON() payload
// (sculpt-brush strokes) to replay so the collider reflects prior in-editor sculpting immediately on
// (re)build -- kept strictly separate from tcfg/seed (never merged into it) so seeds stay shareable.
// biomeOverrideJSON (optional): a previously-serialized src/terrain/BiomeOverride.js toJSON() payload
// (paint-biome strokes), same replay discipline as heightDeltaJSON.
export async function setupTerrainStreaming({ physics, playerManager, worldDef, terrain, heightDeltaJSON, biomeOverrideJSON, splineCarveJSON, caveCarveJSON }) {
  // accepts either the terrain app's merged tcfg directly, or legacy worldDef.terrain.
  const tcfg = terrain || (worldDef && worldDef.terrain) || null
  if (!tcfg || tcfg.enabled === false || !physics || typeof physics.addHeightField !== 'function') return null
  const tphys = tcfg.physics || {}
  const sampler = await loadPlanetSampler({ radius: tcfg.radius, hpfTexRes: tphys.hpfTexRes, seed: tcfg.seed, reliefScale: tcfg.reliefScale })
  const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
  // shared sector-cached climate field: same wrap the client uses, so client species == server collider species.
  const cachedAnchorField = createCachedAnchorField(sampler.anchorField, frame)
  // Paint-biome brush override layer (src/terrain/BiomeOverride.js): wraps cachedAnchorField.climateAtLocal
  // additively, the base anchorField itself is never called with altered args or mutated -- same
  // discipline as heightDelta.wrapHeightFn above. Wrapped BEFORE being handed to the trunk/rock collider
  // streamers below so a painted biome changes which species/how-dense a server collider places, not
  // just a cosmetic client-only readout.
  const biomeOverride = loadBiomeOverride(biomeOverrideJSON)
  const splineCarve = loadSplineCarveLayer(splineCarveJSON, (x, z) => frame.groundHeightLocal(x, z))
  const paintedAnchorField = splineCarve.wrapClimateField(biomeOverride.wrapClimateField(cachedAnchorField))
  const offsetY = tcfg.offsetY || 0
  // preferred: live GPU patch baker (whole-planet, exact, nothing stored); falls back to baked .hf, then live CPU sampler.
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
  // GPU-SOLE-PATH (terrain-height-cpu-parity-oracle-gpu-sole-path): mirror TerrainBackdrop.js's client-side
  // override -- when a GPU patch baker is available (singleplayer/host worker, real OffscreenCanvas WebGL2),
  // point frame.groundHeightLocal itself at the GPU patch lookup, not just the collider's own baseHeightFn.
  // VegPlacement.js/RockPlacement.js/GrassPlacement.js (via VegPhysics.js/RockPhysics.js trunk/rock collider
  // streamers, called a few lines below with this SAME frame object) call frame.groundHeightLocal directly,
  // so leaving it un-overridden meant server-side veg/rock/grass placement silently kept using the CPU
  // fractal (height-cpu.js, ~0.4ms/sample) even on a run where the terrain collider itself was GPU-patch-
  // driven -- height-cpu.js was a second live-generation path, not a pure parity oracle, exactly the
  // condition this row exists to close. gpuPatch.heightFn already falls back to frame.groundHeightLocal
  // (the CPU fractal, patch-baker.js's own fallbackFn default) on a transient bake-miss/init-fail, so this
  // override is loss-free: GPU-available -> GPU is the live path everywhere; GPU-unavailable (dedicated
  // no-GPU Node server, tcfg.gpuPatchCollider:false) -> frame.groundHeightLocal stays the CPU fractal,
  // its only remaining legitimate live role (see height-parity.mjs for the oracle/CI-check side).
  if (gpuPatch) frame.groundHeightLocal = (x, z) => gpuPatch.heightFn(x, z)
  // Sculpt-brush delta-override layer (src/terrain/HeightDelta.js): wraps baseHeightFn additively, the
  // base procedural fn itself is never called with altered args or mutated -- the seed-derived shape
  // stays byte-identical, sculpting is purely an on-top layer. heightDeltaJSON (if any) replays prior
  // strokes so a rebuild (reseed/streamer restart) keeps existing sculpting intact.
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
  // Per-player centers (terrain-collider-worker-ring-lru-hysteresis): the sparse trunk/rock collider
  // streamers below ring EACH connected player individually, not the population-averaged getCenter()
  // above -- with players spread across the map, the averaged point can sit far from EVERY real player,
  // leaving a radius-64 ring around it covering none of them (a starved player has zero nearby sparse
  // colliders in that band). The whole-planet TERRAIN heightfield streamer (createTerrainStreamer just
  // below) is NOT switched to this: it re-centers one large extent-wide field, a different re-centering
  // concern than sparse per-object colliders, and multi-field-per-player terrain streaming is its own,
  // separately-scoped follow-up (see biome-system-erosion-rivers-caves-terrain-holes-adjacent terrain
  // rows) -- not silently folded into this collider-cooking-policy row.
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
  // Jolt grid spacing must be <= finest visual vertex spacing or the grid downsamples the GPU patch.
  let gridRes = tphys.resolution
  if (gpuPatch && Number.isFinite(gpuPatch.spacing)) {
    gridRes = Math.min(tphys.resolution || gpuPatch.spacing, gpuPatch.spacing)
    if (gridRes !== tphys.resolution) console.log(`[terrain] collider grid resolution -> ${gridRes.toFixed(2)}m (clamped to finest display LOD spacing; was ${tphys.resolution})`)
  }
  const streamer = createTerrainStreamer({ physics, getCenter, heightFn, extent: tphys.extent || 510, resolution: gridRes })
  await streamer.start()
  physics.setTerrainHeightSource(heightFn, frame, 0) // groundHeightLocal already folds offsetY in

  let trunkStreamer = null
  const vcfg = tcfg.vegetation || null
  if (vcfg && vcfg.colliders) {
    try {
      const { createTrunkColliderStreamer } = await import('./VegPhysics.js')
      trunkStreamer = createTrunkColliderStreamer({
        // paintedAnchorField (not the raw cachedAnchorField): a paint-biome stroke must change which
        // species/how-dense a trunk collider places, not just the client-visual read.
        // getCenters (not getCenter): worker ring around EACH connected player, not the population average.
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
        // getCenters (not getCenter): worker ring around EACH connected player, not the population average.
        physics, getCenters, frame, anchorField: paintedAnchorField, worldSeed: tcfg.seed | 0,
        radius: vcfg.rockColliderRadius || 32, cap: vcfg.rockColliderCap || 128, byteBudget: vcfg.rockColliderByteBudget,
      })
      await rockStreamer.start()
    } catch (e) { console.error('[rocks] collider streamer failed:', e?.message || e) }
  }
  streamer._rockStreamer = rockStreamer
  // Paint-biome brush override layer (src/terrain/BiomeOverride.js), exposed so a caller (EditorHandlers.js's
  // TERRAIN_PAINT_BIOME handler) can apply a stroke then re-cook whichever collider streamers exist,
  // mirroring heightDelta/resculpt below. Unlike a height sculpt, a biome paint doesn't need the TERRAIN
  // streamer's own heightfield rebuilt (climate never affects height) -- only the trunk/rock collider
  // streamers, whose chunk-placement cache must also be cleared (see ColliderStreamer.js's
  // clearChunkCache header) since it memoizes classify() output for world lifetime and would otherwise
  // keep serving pre-paint species/density for already-visited territory.
  streamer.biomeOverride = biomeOverride
  streamer.splineCarve = splineCarve
  streamer.caveCarve = caveCarve
  streamer.repaintBiome = async function repaintBiome() {
    // Re-cook the FULL current multi-player ring (not just one point) so every connected player's
    // territory picks up the repaint, matching this row's "around each player" streaming policy.
    if (trunkStreamer) { trunkStreamer.clearChunkCache(); await trunkStreamer._rebuildMulti((trunkStreamer.centers && trunkStreamer.centers.length) ? trunkStreamer.centers : getCenters(), true) }
    if (rockStreamer) { rockStreamer.clearChunkCache(); await rockStreamer._rebuildMulti((rockStreamer.centers && rockStreamer.centers.length) ? rockStreamer.centers : getCenters(), true) }
  }
  // Exposed so a caller (src/sdk/EditorHandlers.js's TERRAIN_SCULPT handler) can apply a brush stroke
  // and re-cook the collider around the current center WITHOUT the full reseed teardown/rebuild --
  // heightFn already closes over heightDelta via wrapHeightFn, so mutating the delta then calling
  // streamer._rebuild(cx, cz) (createTerrainStreamer's existing re-center rebuild, reused verbatim)
  // picks up the new stroke on the very next cook.
  streamer.heightDelta = heightDelta
  // Exposed (UNWRAPPED, i.e. never includes the sculpt delta) so the flatten brush (EditorHandlers.js)
  // can sample the base terrain's own height at each touched cell -- applyFlattenBrush needs this to
  // compute a per-cell delta that cancels the base's slope, which the composed heightFn alone can't
  // provide (it would recursively include whatever delta is already there).
  streamer.baseHeightFn = baseHeightFn
  streamer.resculpt = async function resculpt() {
    const c = streamer.center || (getCenter ? getCenter() : null) || tcfg.center || [0, 0]
    await streamer._rebuild(c[0], c[1])
  }
  physics._terrainStreamer = streamer
  return streamer
}
