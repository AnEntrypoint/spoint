import { createPlanetFrame, guardedGroundHeight, DEFAULT_PATCH_MAX_LEVEL } from './PlanetFrame.js'
import { createCachedAnchorField } from './ClimateCache.js'
import { createHeightDelta, loadHeightDelta } from './HeightDelta.js'
import { createBiomeOverride, loadBiomeOverride } from './BiomeOverride.js'
import { loadSplineCarveLayer } from './SplineCarve.js'
import { loadCaveCarveLayer } from './CaveSDF.js'
import { createTerrainStreamer } from './HeightfieldStreamer.js'
import { createChartReanchorService } from './ChartReanchorService.js'
import { createTerrainReanchor } from './ChartReanchorTerrain.js'
import { terrainHashVersionOf, terrainCarvesOf, terrainBakeKey, LEGACY_TERRAIN_HASH_VERSION } from '../shared/terrainConfig.js'

let _latestSampler = { key: null, promise: null }
export function planetSamplerOptsOf(tcfg) {
  return { radius: tcfg.radius, hpfTexRes: (tcfg.physics || {}).hpfTexRes, seed: tcfg.seed, reliefScale: tcfg.reliefScale, hashVersion: terrainHashVersionOf(tcfg), carves: terrainCarvesOf(tcfg) }
}
export function loadPlanetSampler(opts = {}) {
  const o = { radius: opts.radius, hpfTexRes: opts.hpfTexRes, seed: opts.seed, reliefScale: opts.reliefScale, hashVersion: terrainHashVersionOf(opts), carves: opts.carves || [] }
  const key = JSON.stringify([o.radius, o.hpfTexRes, o.seed, o.reliefScale, o.hashVersion, o.carves])
  if (_latestSampler.key !== key) {
    const _isNode = typeof process !== 'undefined' && process.versions?.node
    const _samplerSpec = _isNode ? 'mapspinner/height-cpu' : ('/node_modules/' + 'mapspinner/src/height-cpu.js')
    _latestSampler = { key, promise: import(_samplerSpec).then(m => m.createHeightSampler(o)) }
  }
  return _latestSampler.promise
}

function bakedHashVersionOf(artifact) {
  return artifact.hashVersion ?? LEGACY_TERRAIN_HASH_VERSION
}

const _bakeCodeVersionSpec = ['..', 'static', 'BakeCodeVersion.js'].join('/')

async function heightfieldBakeCodeVersion() {
  const _isNode = typeof process !== 'undefined' && process.versions?.node
  if (!_isNode) return null
  const { HEIGHTFIELD_BAKE_CODE_VERSION } = await import(_bakeCodeVersionSpec)
  return HEIGHTFIELD_BAKE_CODE_VERSION
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
    N, extent, center: [cx, cz], codeVersion: artifact.codeVersion,
    covers(x, z) { return Math.abs(x - cx) <= half && Math.abs(z - cz) <= half },
    heightAtLocal(x, z) {
      const fx = (x - cx + half) / step, fz = (z - cz + half) / step
      const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz
      const h00 = at(ix, iz), h10 = at(ix + 1, iz), h01 = at(ix, iz + 1), h11 = at(ix + 1, iz + 1)
      return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
    }
  }
}

function bakedTerrainMismatch(artifact, tcfg, frame) {
  const bakedEpoch = artifact.chartEpoch ?? 0
  const liveEpoch = (frame && Number.isFinite(frame.chartEpoch)) ? frame.chartEpoch : 0
  if (bakedEpoch !== liveEpoch) return `baked at chartEpoch ${bakedEpoch}, world frame is at chartEpoch ${liveEpoch}: the chart was reanchored, so its chart-local heights name different ground`
  if (artifact.terrainKey !== undefined) return artifact.terrainKey === terrainBakeKey(tcfg) ? null : `terrain key ${artifact.terrainKey} != world ${terrainBakeKey(tcfg)}`
  const unit = v => { const l = Math.hypot(...v); return v.map(c => c / l) }
  const sameDir = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === 3 && b.length === 3 && unit(a).every((v, i) => Math.abs(v - unit(b)[i]) < 1e-6)
  if (artifact.radius !== tcfg.radius) return `radius ${artifact.radius} != world ${tcfg.radius}`
  if ((artifact.reliefScale ?? null) !== (tcfg.reliefScale ?? null)) return `reliefScale ${artifact.reliefScale} != world ${tcfg.reliefScale}`
  if (!sameDir(artifact.anchorDir, tcfg.anchorDir || [0, 1, 0])) return `anchorDir ${JSON.stringify(artifact.anchorDir)} != world ${JSON.stringify(tcfg.anchorDir)}`
  return null
}

export async function loadBakedHeightField(url, hashVersion, tcfg, frame) {
  if (!url) return null
  const artifact = await readBakedHeightField(url)
  if (!artifact) return null
  const bakedVersion = bakedHashVersionOf(artifact)
  if (bakedVersion !== hashVersion) {
    console.warn(`[terrain] ignoring baked heightfield ${url}: baked with terrain hashVersion ${bakedVersion}, world uses ${hashVersion} -> exact CPU height`)
    return null
  }
  const bakeCode = await heightfieldBakeCodeVersion()
  const unverifiable = bakeCode === null
  if (unverifiable ? !artifact.codeVersion : artifact.codeVersion !== bakeCode) {
    const why = unverifiable
      ? 'it carries no height code version and this runtime has no filesystem to rehash the bake sources into one'
      : `baked with height code version ${artifact.codeVersion ?? '(none)'}, this tree bakes ${bakeCode}: the height-generation code changed under it`
    console.warn(`[terrain] ignoring baked heightfield ${url}: ${why} -> exact CPU height`)
    return null
  }
  const mismatch = bakedTerrainMismatch(artifact, tcfg, frame)
  if (mismatch) {
    console.warn(`[terrain] ignoring baked heightfield ${url}: ${mismatch} -> exact CPU height`)
    return null
  }
  const field = createBakedHeightField(artifact)
  field.codeVersionVerified = bakeCode !== null
  return field
}

async function readBakedHeightField(url) {
  try {
    const _isNode = typeof process !== 'undefined' && process.versions?.node
    if (/\.hf$/i.test(url)) {
      const _hfSpec = _isNode ? 'mapspinner/heightfield-codec' : ('/node_modules/' + 'mapspinner/src/heightfield-codec.js')
      const { decodeHeightfield } = await import(_hfSpec)
      let buf
      if (_isNode) { const fs = await import('node:fs'); buf = fs.readFileSync(url.replace(/^\//, '')); buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
      else { const r = await fetch(url); if (!r.ok) return null; buf = await r.arrayBuffer() }
      return decodeHeightfield(buf)
    }
    let json
    if (_isNode) { const fs = await import('node:fs'); json = JSON.parse(fs.readFileSync(url.replace(/^\//, ''), 'utf8')) }
    else { const r = await fetch(url); if (!r.ok) return null; json = await r.json() }
    if (!json || !json.N || !(Array.isArray(json.heights) || (json.sectors && Array.isArray(json.q)))) return null
    return json
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

export const AIRBORNE_GROUND_REUSE_SAFETY = 8
export const AIRBORNE_GROUND_RELEASE_MIN_M = 1
export const AIRBORNE_GROUND_RELEASE_TICKS = 3
export const AIRBORNE_GROUND_RELEASE_HZ = 60
const AIRBORNE_GROUND_MIN_DESCENT_MPS = 0.5

export function createAirborneGroundReuse({ heightFn, frame, playerManager }) {
  const cache = new WeakMap()
  const state = { served: 0, exact: 0, reused: 0, groundedServed: 0, groundedExact: 0, maxReuseM: 0, sumReuseM: 0, maxReuseRatio: 0, limitMinM: Infinity, limitMaxM: 0, verifySamples: 0, maxServedVsExactM: 0, sumServedVsExactM: 0, verifyExactSolves: 0, minAboveM: Infinity, maxRatioToDerived: 0 }
  let enabled = true
  let verifyReuse = false
  let distanceOverrideM = null

  function playerAt(x, z) {
    const map = playerManager && playerManager.players
    if (!map || typeof map.values !== 'function') return null
    for (const p of map.values()) {
      const s = p && p.state
      if (!s || !s.position) continue
      if (s.position[0] === x && s.position[2] === z) return p
    }
    return null
  }

  function releaseClearanceM(st) {
    const descent = Number.isFinite(st.velocity[1]) ? Math.abs(st.velocity[1]) : 0
    return Math.max(AIRBORNE_GROUND_RELEASE_MIN_M, descent * AIRBORNE_GROUND_RELEASE_TICKS / AIRBORNE_GROUND_RELEASE_HZ)
  }

  function derivedReuseM(st, groundY) {
    const above = st.position[1] - groundY
    if (!Number.isFinite(above) || above <= 0) return 0
    const descent = Math.max(Math.abs(st.velocity[1]), AIRBORNE_GROUND_MIN_DESCENT_MPS)
    const horizontal = Math.hypot(st.velocity[0], st.velocity[2])
    return horizontal * (above / descent) / AIRBORNE_GROUND_REUSE_SAFETY
  }

  function solve(x, z) {
    state.exact++
    return heightFn(x, z)
  }

  function heightAt(x, z) {
    state.served++
    const p = enabled ? playerAt(x, z) : null
    if (!p) return solve(x, z)
    if (p.state.onGround) { state.groundedServed++; state.groundedExact++; return solve(x, z) }
    const entry = cache.get(p)
    if (entry && entry.epoch === frame.chartEpoch && Number.isFinite(entry.y)) {
      const above = p.state.position[1] - entry.y
      const derivedLimit = derivedReuseM(p.state, entry.y)
      const limit = distanceOverrideM === null ? derivedLimit : distanceOverrideM
      const moved = Math.hypot(x - entry.x, z - entry.z)
      const clearance = distanceOverrideM === null ? releaseClearanceM(p.state) : 0
      if (moved <= limit && above > clearance) {
        state.reused++
        state.sumReuseM += moved
        const ratioToDerived = derivedLimit > 0 ? moved / derivedLimit : (moved > 0 ? Infinity : 0)
        if (ratioToDerived > state.maxRatioToDerived) state.maxRatioToDerived = ratioToDerived
        if (moved > state.maxReuseM) state.maxReuseM = moved
        const ratio = limit > 0 ? moved / limit : (moved > 0 ? Infinity : 0)
        if (ratio > state.maxReuseRatio) state.maxReuseRatio = ratio
        if (limit < state.limitMinM) state.limitMinM = limit
        if (limit > state.limitMaxM) state.limitMaxM = limit
        if (Number.isFinite(above) && above < state.minAboveM) state.minAboveM = above
        if (verifyReuse) {
          const exactY = heightFn(x, z)
          state.verifyExactSolves++
          state.verifySamples++
          const delta = Math.abs(entry.y - exactY)
          state.sumServedVsExactM += delta
          if (delta > state.maxServedVsExactM) state.maxServedVsExactM = delta
        }
        return entry.y
      }
    }
    const y = solve(x, z)
    cache.set(p, { x, z, y, epoch: frame.chartEpoch })
    return y
  }

  return {
    heightAt,
    stats: () => ({ ...state }),
    resetStats() { state.served = 0; state.exact = 0; state.reused = 0; state.groundedServed = 0; state.groundedExact = 0; state.maxReuseM = 0; state.sumReuseM = 0; state.maxReuseRatio = 0; state.limitMinM = Infinity; state.limitMaxM = 0; state.verifySamples = 0; state.maxServedVsExactM = 0; state.sumServedVsExactM = 0; state.verifyExactSolves = 0; state.minAboveM = Infinity; state.maxRatioToDerived = 0 },
    setEnabled(v) { enabled = !!v },
    setVerifyReuse(v) { verifyReuse = !!v },
    setDistanceOverrideM(v) { distanceOverrideM = v },
  }
}

export function stopTerrainStreaming(physics, streamer) {
  if (!streamer) return
  const failures = []
  const stopOne = (target, what) => {
    if (!target || typeof target.stop !== 'function') return
    try { target.stop() } catch (e) { failures.push(new Error(`[terrain] ${what} stop() failed: ${e?.message || e}`, { cause: e })) }
  }
  stopOne(streamer._trunkStreamer, 'trunk collider streamer')
  stopOne(streamer._rockStreamer, 'rock collider streamer')
  stopOne(streamer, 'heightfield streamer')
  if (physics) {
    if (typeof physics.setTerrainHeightSource === 'function') physics.setTerrainHeightSource(null, null, 0)
    if (typeof physics.setTerrainBodyId === 'function') physics.setTerrainBodyId(null)
    if (physics._terrainStreamer === streamer) physics._terrainStreamer = null
  }
  if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, '[terrain] stopping terrain streaming failed')
}

export async function setupTerrainStreaming({ physics, playerManager, worldDef = null, terrain = null, heightDeltaJSON = null, biomeOverrideJSON = null, splineCarveJSON = null, caveCarveJSON = null }) {
  const tcfg = terrain || (worldDef && worldDef.terrain) || null
  if (!tcfg || tcfg.enabled === false || !physics || typeof physics.addHeightField !== 'function') return null
  const tphys = tcfg.physics || {}
  const hashVersion = terrainHashVersionOf(tcfg)
  const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
  const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
  const cachedAnchorField = createCachedAnchorField(sampler.anchorField, frame)
  const biomeOverride = loadBiomeOverride(biomeOverrideJSON)
  const splineCarve = loadSplineCarveLayer(splineCarveJSON, (x, z) => frame.groundHeightLocal(x, z))
  const paintedAnchorField = splineCarve.wrapClimateField(biomeOverride.wrapClimateField(cachedAnchorField))
  const offsetY = tcfg.offsetY || 0
  const gpuPatchOptedOut = tcfg.gpuPatchCollider === false
  const gpuPatchLegacyOnly = hashVersion !== LEGACY_TERRAIN_HASH_VERSION
  const gpuPatch = (gpuPatchOptedOut || gpuPatchLegacyOnly)
    ? null
    : await createGpuPatchHeightFn({ frame, tcfg, offsetY }).catch(() => null)
  const gpuPatchUnavailable = gpuPatchOptedOut
    ? 'gpuPatchCollider is false in the world config'
    : gpuPatchLegacyOnly
      ? `the GLSL patch baker draws only hashVersion ${LEGACY_TERRAIN_HASH_VERSION} and this world resolves to hashVersion ${hashVersion}, which carries an integer hash and a carve term the legacy GLSL terrain has no code for`
      : (gpuPatch ? null : 'the GPU patch bake produced no height function')
  const baked = gpuPatch ? null : await loadBakedHeightField(tcfg.bakedHeightfield, hashVersion, tcfg, frame).catch(() => null)
  const bakedAnchorDir = baked ? frame.anchorDir : null
  const bakedFrameIsCurrent = () => frame.up[0] === bakedAnchorDir[0] && frame.up[1] === bakedAnchorDir[1] && frame.up[2] === bakedAnchorDir[2]
  const baseHeightFn = gpuPatch
    ? gpuPatch.heightFn
    : baked
      ? ((x, z, yGuess) => bakedFrameIsCurrent() && baked.covers(x, z) ? baked.heightAtLocal(x, z) + offsetY : frame.groundHeightLocal(x, z, yGuess))
      : ((x, z, yGuess) => frame.groundHeightLocal(x, z, yGuess))
  const bakedSpacingM = baked ? baked.extent / (baked.N - 1) : 0
  if (gpuPatch) { console.log(`[terrain] collider using LIVE GPU PATCH bake (whole-planet, exact, nothing stored): ${gpuPatch.spacing.toFixed(2)}m collider spacing == finest display LOD (maxLevel ${gpuPatch.maxLevel}, ${gpuPatch.patchSpan.toFixed(0)}m patches, ${gpuPatch.res} samples)`); physics._terrainHeightSource = 'gpu-patch' }
  else if (baked) { console.log(`[terrain] collider using BAKED heightfield (hashVersion ${hashVersion}, N=${baked.N}, extent=${baked.extent}m, spacing ${(bakedSpacingM * 100).toFixed(0)}cm, height code ${baked.codeVersion ?? '(none)'}${baked.codeVersionVerified ? '' : ' unverified: this runtime has no filesystem to rehash the bake sources with'}) instead of the GPU patch bake: ${gpuPatchUnavailable}`); physics._terrainHeightSource = 'baked' }
  else { console.log(`[terrain] collider using EXACT CPU height (no baked artifact covers the spawn): ${gpuPatchUnavailable}`); physics._terrainHeightSource = 'cpu' }
  if (hashVersion === LEGACY_TERRAIN_HASH_VERSION && physics._terrainHeightSource === 'cpu') console.error(`[terrain] world resolves to terrain hashVersion 1 (legacy float hash) and no baked or GPU-patch collider covers it, so colliders come from the CPU sampler, which cannot agree with any GPU terrain at hashVersion 1: measured 1.28 m mean / 2.84 m max apart over 256 m on both the legacy GLSL and the TSL boot, the two GPU boots agreeing to 7 mm with each other, because the v1 hash is a fract/dot float hash whose value is set by float precision (hashVersion 2's integer hash is bit-exact and measures 0.001 m mean / 0.005 m max). The ground this server simulates and the ground clients draw disagree by that much; set terrain.hashVersion 2, bake a hashVersion 1 heightfield, or boot the legacy GLSL renderer, whose GPU patch bake is the one v1 collider that matches what it draws`)
  if (gpuPatch) { frame.groundHeightLocal = (x, z) => gpuPatch.heightFn(x, z); if (hashVersion === LEGACY_TERRAIN_HASH_VERSION) frame.cpuHeightDivergentFromGround = true }
  const heightDelta = loadHeightDelta(heightDeltaJSON, baseHeightFn)
  const caveCarve = loadCaveCarveLayer(caveCarveJSON || (Array.isArray(tcfg.caveCarve) ? { version: 2, volumes: tcfg.caveCarve } : null))
  const heightFn = caveCarve.wrapHeightFn(splineCarve.wrapHeightFn(heightDelta.wrapHeightFn(baseHeightFn)))
  const outOfChartLimitM = frame.radius - (tphys.extent || 510)
  let outOfChartWarned = 0
  const getCenters = () => {
    const out = []
    const players = playerManager && playerManager.players
    if (players && typeof players.values === 'function') {
      for (const p of players.values()) {
        const pos = p?.state?.position
        if (!pos || !Number.isFinite(pos[0]) || !Number.isFinite(pos[2])) continue
        if (Math.hypot(pos[0], pos[2]) >= outOfChartLimitM) {
          if (outOfChartWarned++ === 0) console.warn(`[terrain] player at chart-local (${pos[0].toFixed(0)}, ${pos[2].toFixed(0)}), ${Math.hypot(pos[0], pos[2]).toFixed(0)} m from the chart anchor, is beyond the chart radius ${frame.radius} m: no terrain collider, vegetation or rocks are built for it (a flat chart has no ground there; enable chartReanchor or per-cluster charts)`)
          continue
        }
        out.push([pos[0], pos[2]])
      }
    }
    return out.length ? out : [tcfg.center || [0, 0]]
  }
  let gridRes = tphys.resolution
  if (gpuPatch && Number.isFinite(gpuPatch.spacing)) {
    gridRes = Math.min(tphys.resolution || gpuPatch.spacing, gpuPatch.spacing)
    if (gridRes !== tphys.resolution) console.log(`[terrain] collider grid resolution -> ${gridRes.toFixed(2)}m (clamped to finest display LOD spacing; was ${tphys.resolution})`)
  }
  const streamer = createTerrainStreamer({ physics, getCenters, heightFn, extent: tphys.extent || 510, resolution: gridRes, maxFields: tphys.maxFields, getEpoch: () => frame.chartEpoch })
  physics._terrainStreamer = streamer
  try {
    await streamer.start(tcfg.center || [0, 0])
    const offsetYNotFoldedIntoHeightFn = 0
    const groundReuse = createAirborneGroundReuse({ heightFn: guardedGroundHeight('server physics terrain height', heightFn, NaN), frame, playerManager })
    physics.groundSolveReuse = groundReuse
    physics.setTerrainHeightSource(groundReuse.heightAt, frame, offsetYNotFoldedIntoHeightFn)

    let trunkStreamer = null
    let rockStreamer = null
    const vcfg = tcfg.vegetation || null
    if (vcfg && vcfg.colliders) {
      try {
        const { createTrunkColliderStreamer } = await import('./VegPhysics.js')
        trunkStreamer = createTrunkColliderStreamer({
          physics, getCenters, frame, anchorField: paintedAnchorField, worldSeed: tcfg.seed | 0,
          radius: vcfg.colliderRadius || 64, cap: vcfg.colliderCap || 384, byteBudget: vcfg.colliderByteBudget, maxCenters: vcfg.colliderMaxCenters,
        })
        streamer._trunkStreamer = trunkStreamer
        await trunkStreamer.start()
      } catch (e) { throw new Error(`[veg] trunk collider streamer failed: ${e?.message || e}`, { cause: e }) }
    }
    if (vcfg && vcfg.rockColliders) {
      try {
        const { createRockColliderStreamer } = await import('./RockPhysics.js')
        rockStreamer = createRockColliderStreamer({
          physics, getCenters, frame, anchorField: paintedAnchorField, worldSeed: tcfg.seed | 0,
          radius: vcfg.rockColliderRadius || 32, cap: vcfg.rockColliderCap || 128, byteBudget: vcfg.rockColliderByteBudget, maxCenters: vcfg.colliderMaxCenters,
        })
        streamer._rockStreamer = rockStreamer
        await rockStreamer.start()
      } catch (e) { throw new Error(`[rocks] rock collider streamer failed: ${e?.message || e}`, { cause: e }) }
    }
    streamer.biomeOverride = biomeOverride
    streamer.splineCarve = splineCarve
    streamer.caveCarve = caveCarve
    streamer.repaintBiome = async function repaintBiome() {
      if (trunkStreamer) { trunkStreamer.clearChunkCache(); await trunkStreamer._rebuildMulti((trunkStreamer.centers && trunkStreamer.centers.length) ? trunkStreamer.centers : getCenters(), true) }
      if (rockStreamer) { rockStreamer.clearChunkCache(); await rockStreamer._rebuildMulti((rockStreamer.centers && rockStreamer.centers.length) ? rockStreamer.centers : getCenters(), true) }
    }
    streamer.heightDelta = heightDelta
    streamer.chartReanchor = tcfg.chartReanchor?.enabled === true
      ? createChartReanchorService({
        frame, radius: tcfg.radius, anchorsPerFace: tcfg.chartReanchor.anchorsPerFace, hysteresisDeg: tcfg.chartReanchor.hysteresisDeg,
        playerDirs: () => getCenters().map(([x, z]) => frame.localToDir(x, z)),
      })
      : null
    if (streamer.chartReanchor) {
      const terrainReanchor = createTerrainReanchor({
        frame, sampler, offsetY, reliefScale: tcfg.reliefScale, physics, heightStreamer: streamer,
        colliderStreamers: [trunkStreamer, rockStreamer].filter(Boolean),
        getPlayers: getCenters,
        blockers: [
          () => physics._terrainHeightSource === 'gpu-patch' ? 'gpu-patch-height-function-is-bound-to-the-live-frame' : null,
          () => heightDelta.cellCount > 0 ? 'height-delta-cells-are-chart-local' : null,
          () => biomeOverride.cellCount > 0 ? 'biome-override-cells-are-chart-local' : null,
          () => splineCarve.cellCount > 0 ? 'spline-carve-cells-are-chart-local' : null,
          () => caveCarve.volumeCount > 0 ? 'cave-volumes-are-chart-local' : null,
        ],
      })
      streamer.chartReanchor.addTerrainMigrator({ gate: terrainReanchor.gate, migrate: terrainReanchor.migrate })
      streamer.terrainReanchor = terrainReanchor
    }
    streamer.baseHeightFn = baseHeightFn
  } catch (e) {
    try { stopTerrainStreaming(physics, streamer) }
    catch (teardownErr) { console.error('[terrain] tearing down the terrain after a failed setup failed:', teardownErr?.message || teardownErr) }
    throw e
  }
  return streamer
}
