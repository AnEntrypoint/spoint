// ONE copy of the ground near the player.
//
// The server's terrain collider already builds its field from a baked artifact
// (apps/world/tps-game.hf: N=257 over 256 m, a 1.0000 m lattice of the chart-local ground). That
// artifact is a sample buffer, so anything that needs the height of a chart-local (x,z) inside its
// coverage can READ it instead of solving the terrain again -- and a read is a bilinear step at
// 0.075 us where the chart-local solve costs 12.1 us and the raw sampler 3.4 us (measured by
// scripts/shared-lattice-surface-witness.mjs).
//
// This module owns the artifact -> sample-field construction. src/terrain/TerrainPhysics.js is the
// server's reader and keeps its fail-loud behaviour; this module is the reader everything else uses,
// including the browser, so the collider, the rendered near band's CPU mirror and the placement
// sampler are three readers of one buffer rather than three solvers of one function.
//
// Nothing here computes a height: the only height that exists is the one the bake carries.

import { terrainBakeKey, terrainHashVersionOf, LEGACY_TERRAIN_HASH_VERSION } from '../shared/terrainConfig.js'

const _isNode = typeof process !== 'undefined' && !!process.versions && !!process.versions.node
const _codecSpec = _isNode ? 'mapspinner/heightfield-codec' : '/node_modules/mapspinner/src/heightfield-codec.js'

const LATTICE_READ_TIMEOUT_MS = 4000

// A lattice is chart-local, so a re-anchored chart rebases it: the same (x,z) then names different
// ground. The epoch the artifact was baked at rides on the field so a reader can refuse instead of
// answering from a chart it no longer describes.
export function bakedEpochOf(artifact) {
  return artifact.chartEpoch ?? 0
}

export function bakedHashVersionOf(artifact) {
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

// The sample field: a regular grid of chart-local ground heights with bilinear lookup. Every reader
// that wants "how high is the ground at (x,z)" inside the coverage gets this, so no reader can
// disagree with another about the same point.
export function createBakedHeightField(artifact) {
  if (artifact.sectors) artifact = { ...artifact, heights: _dequantizeSectorized(artifact) }
  const { N, extent, center, heights } = artifact
  const step = extent / (N - 1), half = extent / 2
  const cx = (center && center[0]) || 0, cz = (center && center[1]) || 0
  const at = (ix, iz) => { ix = ix < 0 ? 0 : ix > N - 1 ? N - 1 : ix; iz = iz < 0 ? 0 : iz > N - 1 ? N - 1 : iz; const v = heights[iz * N + ix]; return (typeof v === 'number') ? v : 0 }
  return {
    N, extent, center: [cx, cz], codeVersion: artifact.codeVersion,
    stepM: step,
    covers(x, z) { return Math.abs(x - cx) <= half && Math.abs(z - cz) <= half },
    heightAtLocal(x, z) {
      const fx = (x - cx + half) / step, fz = (z - cz + half) / step
      const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz
      const h00 = at(ix, iz), h10 = at(ix + 1, iz), h01 = at(ix, iz + 1), h11 = at(ix + 1, iz + 1)
      return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
    }
  }
}

// A bake is only the ground if it is the SAME ground. A different terrain key, chart epoch, radius,
// anchor direction or relief scale is a different surface, and reading it would move every height
// the readers report -- so it is refused rather than used.
export function bakedTerrainMismatch(artifact, tcfg, frame) {
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

async function readLatticeBytes(url) {
  if (_isNode) {
    const fs = await import('node:fs')
    let raw
    try { raw = fs.readFileSync(String(url).replace(/^\//, '')) }
    catch (e) { if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null; throw e }
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
  }
  // Bounded: this runs on the boot path and a hung asset fetch must never hold up the planet.
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), LATTICE_READ_TIMEOUT_MS) : null
  try {
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
    if (!res.ok) return null
    return await res.arrayBuffer()
  } finally { if (timer) clearTimeout(timer) }
}

// The one copy, resolved from the same artifact the server's collider builds from. Returns null --
// never a guess -- wherever the artifact is absent, unreadable, stale or for other ground, and the
// caller keeps whatever it did before; a lattice that refuses is not a regression.
export async function loadLatticeSurface({ url, tcfg, frame }) {
  if (!url) return null
  try {
    const { decodeHeightfield } = await import(_codecSpec)
    const bytes = await readLatticeBytes(url)
    if (!bytes) return null
    const artifact = decodeHeightfield(bytes)
    if (!artifact || !Number.isInteger(artifact.N) || artifact.N < 2 || !Number.isFinite(artifact.extent)) return null
    const hashVersion = terrainHashVersionOf(tcfg)
    if (bakedHashVersionOf(artifact) !== hashVersion) {
      console.warn(`[terrain] shared lattice: ${url} was baked for terrain hashVersion ${bakedHashVersionOf(artifact)}, this world is ${hashVersion} -> not this ground`)
      return null
    }
    const mismatch = bakedTerrainMismatch(artifact, tcfg, frame)
    if (mismatch) {
      console.warn(`[terrain] shared lattice: ${url}: ${mismatch} -> not this ground`)
      return null
    }
    return { ...createBakedHeightField(artifact), kind: 'bake', chartEpoch: bakedEpochOf(artifact) }
  } catch (e) {
    console.warn(`[terrain] shared lattice: ${url} could not be read, so consumers keep solving the terrain:`, (e && e.message) || e)
    return null
  }
}
