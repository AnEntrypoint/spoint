import { createPlanetFrame, DEFAULT_PATCH_MAX_LEVEL } from './PlanetFrame.js'
import { createCachedAnchorField } from './ClimateCache.js'
import { createHeightDelta, loadHeightDelta } from './HeightDelta.js'
import { createBiomeOverride, loadBiomeOverride } from './BiomeOverride.js'
import { loadSplineCarveLayer } from './SplineCarve.js'
import { loadCaveCarveLayer } from './CaveSDF.js'
import { createTerrainStreamer } from './HeightfieldStreamer.js'
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

function bakedTerrainMismatch(artifact, tcfg) {
  if (artifact.terrainKey !== undefined) return artifact.terrainKey === terrainBakeKey(tcfg) ? null : `terrain key ${artifact.terrainKey} != world ${terrainBakeKey(tcfg)}`
  const unit = v => { const l = Math.hypot(...v); return v.map(c => c / l) }
  const sameDir = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === 3 && b.length === 3 && unit(a).every((v, i) => Math.abs(v - unit(b)[i]) < 1e-6)
  if (artifact.radius !== tcfg.radius) return `radius ${artifact.radius} != world ${tcfg.radius}`
  if ((artifact.reliefScale ?? null) !== (tcfg.reliefScale ?? null)) return `reliefScale ${artifact.reliefScale} != world ${tcfg.reliefScale}`
  if (!sameDir(artifact.anchorDir, tcfg.anchorDir || [0, 1, 0])) return `anchorDir ${JSON.stringify(artifact.anchorDir)} != world ${JSON.stringify(tcfg.anchorDir)}`
  return null
}

async function loadBakedHeightField(url, hashVersion, tcfg) {
  if (!url) return null
  const artifact = await readBakedHeightField(url)
  if (!artifact) return null
  const bakedVersion = bakedHashVersionOf(artifact)
  if (bakedVersion !== hashVersion) {
    console.warn(`[terrain] ignoring baked heightfield ${url}: baked with terrain hashVersion ${bakedVersion}, world uses ${hashVersion} -> exact CPU height`)
    return null
  }
  const mismatch = bakedTerrainMismatch(artifact, tcfg)
  if (mismatch) {
    console.warn(`[terrain] ignoring baked heightfield ${url}: ${mismatch} -> exact CPU height`)
    return null
  }
  return createBakedHeightField(artifact)
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
  const gpuPatch = (tcfg.gpuPatchCollider !== false && hashVersion === LEGACY_TERRAIN_HASH_VERSION)
    ? await createGpuPatchHeightFn({ frame, tcfg, offsetY }).catch(() => null)
    : null
  const baked = gpuPatch ? null : await loadBakedHeightField(tcfg.bakedHeightfield, hashVersion, tcfg).catch(() => null)
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
  const streamer = createTerrainStreamer({ physics, getCenters, heightFn, extent: tphys.extent || 510, resolution: gridRes })
  await streamer.start(tcfg.center || [0, 0])
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
  physics._terrainStreamer = streamer
  return streamer
}
