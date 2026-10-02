import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHeightSampler } from 'mapspinner/height-cpu'
import { createAnchorField } from 'mapspinner/anchor-field'
import { createPlacementLattice } from '../src/terrain/PlacementLattice.js'
import { chunkKeyAtLocal } from '../src/terrain/PlacementChart.js'
import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { reanchorChartFor, createChartAnchorLattice, chartAnchorCellWorstAngleDeg, chartNeedsReanchor, CHART_ANCHORS_PER_FACE } from '../src/shared/chartAnchor.js'
import { sampleMinimapCell, shadeHeightGrid } from '../src/shared/MinimapBiome.js'
import { dirToLocalXZ, latLonToDir, dirToLatLon, angleFromAnchorDeg } from '../src/shared/relocation.js'
import { elevationAtLocal } from '../src/terrain/PlanetFrame.js'
import { resolveTerrainConfig, terrainHashVersionOf, terrainCarvesOf } from '../src/shared/terrainConfig.js'
import { expandWorldPresets } from '../src/shared/worldPresets.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEG = Math.PI / 180
const RAD = 180 / Math.PI
const MAX_SLOPE_DEG = 45

function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t.startsWith('--')) {
      const k = t.slice(2); const n = argv[i + 1]
      if (n === undefined || n.startsWith('--')) a[k] = true
      else { a[k] = n; i++ }
    } else a._.push(t)
  }
  return a
}

const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const arcM = (radius, a, b) => radius * Math.acos(Math.max(-1, Math.min(1, dot(a, b))))
const forwardOf = (yaw, pitch) => { const cp = Math.cos(pitch); return [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp] }

function slerp(a, b, t) {
  const d = Math.max(-1, Math.min(1, dot(a, b)))
  const th = Math.acos(d)
  if (th < 1e-12) return [...a]
  const s = Math.sin(th)
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s
  return norm([a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb])
}

function worldOf(basis, v) {
  const e = basis.east, u = basis.up, n = basis.north
  return [e[0] * v[0] + u[0] * v[1] + n[0] * v[2], e[1] * v[0] + u[1] * v[1] + n[1] * v[2], e[2] * v[0] + u[2] * v[1] + n[2] * v[2]]
}

function det3(m) {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
}

function perpendicularAxis(d) {
  const ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const e = norm([ref[1] * d[2] - ref[2] * d[1], ref[2] * d[0] - ref[0] * d[2], ref[0] * d[1] - ref[1] * d[0]])
  const n = [e[1] * d[2] - e[2] * d[1], e[2] * d[0] - e[0] * d[2], e[0] * d[1] - e[1] * d[0]]
  return { e, n }
}

function offsetDir(d, e, n, dx, dz, radius) {
  const a = dx / radius, b = dz / radius
  return norm([d[0] + e[0] * a + n[0] * b, d[1] + e[1] * a + n[1] * b, d[2] + e[2] * a + n[2] * b])
}

const AXIS_NAMES = ['x', 'y', 'z']
function cubeDirections() {
  const out = []
  for (let code = 1; code < 27; code++) {
    let rest = code, count = 0
    const dir = [0, 0, 0], parts = []
    for (let a = 0; a < 3; a++) {
      const digit = rest % 3
      rest = (rest - digit) / 3
      if (!digit) continue
      dir[a] = digit === 1 ? 1 : -1
      parts.push((digit === 1 ? 'p' : 'n') + AXIS_NAMES[a])
      count++
    }
    out.push({ kind: count === 1 ? 'face' : count === 2 ? 'edge' : 'corner', name: parts.join('-'), dir: norm(dir) })
  }
  return out
}

function routeParallelFrom(latDeg, lonDeg) {
  const cosL = Math.cos(latDeg * DEG)
  return { lengthM: (r) => 2 * Math.PI * r * cosL, at: (s, r) => [latDeg, lonDeg + (s / (r * cosL)) * RAD] }
}

function routeMeridianFrom(latDeg, lonDeg) {
  return {
    lengthM: (r) => 2 * Math.PI * r,
    at: (s, r) => {
      let u = s / r * RAD
      let lat = latDeg + u
      let lon = lonDeg
      if (lat > 90) { lat = 180 - lat; lon += 180 }
      if (lat < -90) { lat = -180 - lat; lon += 180 }
      return [lat, lon]
    },
  }
}

function routeGreatCircleThrough(inclDeg, latDeg, lonDeg) {
  const si = Math.sin(inclDeg * DEG), ci = Math.cos(inclDeg * DEG)
  const u0 = Math.asin(Math.max(-1, Math.min(1, Math.sin(latDeg * DEG) / si)))
  const node = lonDeg * DEG - Math.atan2(ci * Math.sin(u0), Math.cos(u0))
  return {
    lengthM: (r) => 2 * Math.PI * r,
    at: (s, r) => {
      const u = u0 + s / r
      return [Math.asin(Math.max(-1, Math.min(1, si * Math.sin(u)))) * RAD, (node + Math.atan2(ci * Math.sin(u), Math.cos(u))) * RAD]
    },
  }
}

function routeGreatCircleThroughDir(from, to) {
  const a = norm(from)
  const d = dot(a, norm(to))
  const t = norm([to[0] - a[0] * d, to[1] - a[1] * d, to[2] - a[2] * d])
  return {
    lengthM: (r) => 2 * Math.PI * r,
    atDir: (s, r) => {
      const u = s / r, c = Math.cos(u), si = Math.sin(u)
      return norm([a[0] * c + t[0] * si, a[1] * c + t[1] * si, a[2] * c + t[2] * si])
    },
  }
}

async function loadWorld(worldName) {
  const mod = await import(pathToFileURL(path.join(REPO_ROOT, 'apps', 'world', `${worldName}.js`)).href)
  const worldDef = expandWorldPresets(mod.default || mod)
  return resolveTerrainConfig(worldDef)
}

export function createChartWalker({ frame, sampler, anchorField, lattice, anchorLattice, radius, mode, reanchorAngleDeg, minimapRes, minimapExtent, expectedStepM = 1000 }) {
  const heightAt = (x, z) => frame.groundHeightLocal(x, z)
  const cell = [0, 0, 0, 0]
  const carried = { local: [0, 0, 0], vel: [7, 0, 0], yaw: Math.PI / 2, pitch: 0 }
  const probeFrame = createPlanetFrame({ sampler, anchorDir: [...frame.up], offsetY: frame.offsetY, reliefScale: frame.reliefScale })
  let anchorChanges = 0
  let continuousAnchorChanges = 0
  const events = []
  let lastDir = null

  function maybeReanchor(dir) {
    if (mode !== 'reanchor') return false
    const p = carried.local, v = carried.vel
    const yawBefore = carried.yaw
    const pitchBefore = carried.pitch
    const approachM = lastDir ? arcM(radius, lastDir, dir) : Infinity
    const dirBefore = frame.localToDir(p[0], p[2], p[1])
    const speedBefore = Math.hypot(v[0], v[1], v[2])
    const shift = reanchorChartFor({ frame, lattice: anchorLattice, dir, thresholdDeg: reanchorAngleDeg })
    if (!shift) return false
    const stepAngleDeg = 360 * expectedStepM / (2 * Math.PI * radius)
    const continuous = approachM <= 2 * expectedStepM && shift.angleBeforeDeg <= reanchorAngleDeg + stepAngleDeg
    anchorChanges++
    const t = shift.transfer
    const worldVelBefore = worldOf(shift.from, v)
    const p2 = t.point(p, [0, 0, 0])
    const v2 = t.vec(v, [0, 0, 0])
    const dirAfter = frame.localToDir(p2[0], p2[2], p2[1])
    const worldVelAfter = worldOf(shift.to, v2)
    const groundAtP2 = frame.groundHeightLocal(p2[0], p2[2])
    const elevBefore = elevationAtLocal(shift.from, p[0], p[1], p[2])
    const elevAfter = elevationAtLocal(frame, p2[0], p2[1], p2[2])
    const yaw2 = t.look(yawBefore, pitchBefore)
    const forwardBefore = worldOf(shift.from, forwardOf(yawBefore, pitchBefore))
    const forwardAfter = worldOf(shift.to, forwardOf(yaw2.yaw, yaw2.pitch))
    const forwardYawOnly = worldOf(shift.to, forwardOf(yaw2.yaw, 0))
    const ev = {
      anchorKey: anchorLattice.chunkKeyOfDir(dir[0], dir[1], dir[2]),
      anchorDir: shift.anchorDir.map(x => +x.toFixed(6)),
      angleBeforeDeg: +shift.angleBeforeDeg.toFixed(3),
      angleAfterDeg: +shift.angleAfterDeg.toFixed(3),
      continuous,
      approachM: +approachM.toFixed(2),
      dirJumpM: +arcM(radius, dirBefore, dirAfter).toFixed(6),
      elevationJumpM: +(Number.isFinite(elevBefore) && Number.isFinite(elevAfter) ? Math.abs(elevAfter - elevBefore) : NaN).toFixed(6),
      groundResidualM: +Math.abs(groundAtP2 - p2[1]).toFixed(6),
      speedBefore: +speedBefore.toFixed(6),
      speedAfter: +Math.hypot(v2[0], v2[1], v2[2]).toFixed(6),
      worldVelJumpMps: +Math.hypot(worldVelAfter[0] - worldVelBefore[0], worldVelAfter[1] - worldVelBefore[1], worldVelAfter[2] - worldVelBefore[2]).toFixed(6),
      yawBefore: +yawBefore.toFixed(6),
      yawAfter: +yaw2.yaw.toFixed(6),
      pitchBefore: +pitchBefore.toFixed(6),
      pitchAfter: +yaw2.pitch.toFixed(6),
      worldForwardJumpDeg: +(arcM(1, forwardBefore, forwardAfter) * RAD).toFixed(9),
      yawOnlyForwardJumpDeg: +(arcM(1, forwardBefore, forwardYawOnly) * RAD).toFixed(9),
      tiltRad: +t.tiltRad.toFixed(6),
      det: +det3(t.m).toFixed(9),
    }
    carried.local = p2
    carried.vel = v2
    carried.yaw = yaw2.yaw
    carried.pitch = yaw2.pitch
    lastDir = dir
    if (continuous) continuousAnchorChanges++
    events.push(ev)
    return true
  }

  function tiltAt(x, z) {
    return tiltOf(frame, x, z)
  }

  function tiltOf(f, x, z) {
    const d = 0.5
    const gx = (f.groundHeightLocal(x + d, z) - f.groundHeightLocal(x - d, z)) / (2 * d)
    const gz = (f.groundHeightLocal(x, z + d) - f.groundHeightLocal(x, z - d)) / (2 * d)
    if (!Number.isFinite(gx) || !Number.isFinite(gz)) return null
    return Math.atan(Math.hypot(gx, gz)) * RAD
  }

  function terrainTiltAt(dir) {
    probeFrame.reanchor(dir)
    return tiltOf(probeFrame, 0, 0)
  }

  function minimapGrid(dir, frameOverride = null) {
    const f = frameOverride || frame
    const heightAtF = (x, z) => f.groundHeightLocal(x, z)
    const N = minimapRes
    const { e, n } = perpendicularAxis(dir)
    const half = minimapExtent / 2, step = minimapExtent / N
    const heights = new Float32Array(N * N)
    const rgbFlat = new Uint8Array(N * N * 3)
    const land = new Uint8Array(N * N)
    const shaded = new Uint8Array(N * N * 3)
    let finite = 0
    for (let iz = 0; iz < N; iz++) {
      const oz = -half + (iz + 0.5) * step
      for (let ix = 0; ix < N; ix++) {
        const ox = -half + (ix + 0.5) * step
        const d = offsetDir(dir, e, n, ox, oz, radius)
        const xz = dirToLocalXZ(f, d, heightAtF)
        const idx = iz * N + ix
        if (!xz) { heights[idx] = NaN; land[idx] = 0; continue }
        const h = sampleMinimapCell(f, anchorField, xz[0], xz[1], cell)
        if (Number.isFinite(h)) finite++
        heights[idx] = h
        land[idx] = cell[3]
        const o = idx * 3
        rgbFlat[o] = cell[0]; rgbFlat[o + 1] = cell[1]; rgbFlat[o + 2] = cell[2]
      }
    }
    shadeHeightGrid(heights, N, N, step, land, rgbFlat, shaded, 3, 3)
    const finiteMask = new Uint8Array(N * N)
    for (let i = 0; i < N * N; i++) finiteMask[i] = Number.isFinite(heights[i]) ? 1 : 0
    return { rgb: shaded, rawRgb: rgbFlat, heights, land, finiteMask, finite, total: N * N }
  }

  function sample(dir, prev) {
    maybeReanchor(dir)
    const angleDeg = angleFromAnchorDeg(frame, dir)
    const xz = dirToLocalXZ(frame, dir, heightAt)
    if (!xz) { lastDir = dir; return { ok: false, dir, angleDeg, reason: 'beyond local chart' } }
    const [x, z] = xz
    const groundY = frame.groundHeightLocal(x, z)
    if (Number.isFinite(groundY)) {
      carried.local = [x, groundY, z]
      if (prev && prev.ok && prev.dir) {
        const tan = norm([dir[0] - prev.dir[0], dir[1] - prev.dir[1], dir[2] - prev.dir[2]])
        carried.vel = [dot(tan, frame.east) * 7, dot(tan, frame.up) * 7, dot(tan, frame.north) * 7]
        const vl = Math.hypot(carried.vel[0], carried.vel[1], carried.vel[2]) || 1
        carried.yaw = Math.atan2(carried.vel[0], carried.vel[2])
        carried.pitch = Math.asin(Math.max(-1, Math.min(1, carried.vel[1] / vl)))
      }
    }
    const tilt = tiltAt(x, z)
    const terrainTilt = terrainTiltAt(dir)
    const chunkKey = chunkKeyAtLocal(lattice, frame, x, z)
    const ring = lattice.ringAroundDir(dir[0], dir[1], dir[2], 320)
    let ringMaxOffsetM = 0
    for (const c of ring) {
      const cd = [0, 0, 0]
      lattice.chunkCentreDir(c.key, cd)
      ringMaxOffsetM = Math.max(ringMaxOffsetM, arcM(radius, dir, cd))
    }
    const out = {
      ok: true,
      dir: [...dir],
      latLon: dirToLatLon(dir),
      angleDeg: +angleDeg.toFixed(4),
      local: [+x.toFixed(4), +z.toFixed(4)],
      groundY: +groundY.toFixed(4),
      tiltDeg: tilt == null ? null : +tilt.toFixed(3),
      walkable: tilt != null ? tilt < MAX_SLOPE_DEG : false,
      tiltTerrainDeg: terrainTilt == null ? null : +terrainTilt.toFixed(3),
      walkableTerrain: terrainTilt != null ? terrainTilt < MAX_SLOPE_DEG : false,
      chartExcessDeg: tilt != null && terrainTilt != null ? +(tilt - terrainTilt).toFixed(3) : null,
      chunkKey,
      chunkCount: ring.length,
      ringMaxOffsetM: +ringMaxOffsetM.toFixed(2),
    }
    if (prev && prev.ok) {
      out.stepM = +arcM(radius, prev.dir, dir).toFixed(4)
      out.dGroundM = +Math.abs(groundY - prev.groundY).toFixed(4)
    }
    lastDir = dir
    return out
  }

  return {
    sample,
    minimapGrid,
    tiltAt,
    terrainTiltAt,
    needsReanchor(dir) { return mode === 'reanchor' && !!anchorLattice && chartNeedsReanchor(frame, dir, reanchorAngleDeg) },
    resetAnchorEvents() { const out = events.slice(); events.length = 0; return out },
    resetCarry() { carried.local = [0, 0, 0]; carried.vel = [7, 0, 0]; carried.yaw = Math.PI / 2; carried.pitch = 0; lastDir = null },
    takeContinuousCount() { const n = continuousAnchorChanges; continuousAnchorChanges = 0; return n },
    get anchorChanges() { return anchorChanges },
    get continuousAnchorChanges() { return continuousAnchorChanges },
    get events() { return events },
    get anchorDir() { return [...frame.up] },
  }
}

function pixelDiff(a, b, maskA = null, maskB = null) {
  let maxAbs = 0, sum = 0, differing = 0, compared = 0
  for (let i = 0; i < a.length; i++) {
    const cell = (i / 3) | 0
    if (maskA && !maskA[cell]) continue
    if (maskB && !maskB[cell]) continue
    compared++
    const d = Math.abs(a[i] - b[i])
    if (d > 0) differing++
    if (d > maxAbs) maxAbs = d
    sum += d
  }
  return { maxAbs, meanAbs: compared ? +(sum / compared).toFixed(4) : 0, differingChannels: differing, comparedChannels: compared, channels: a.length }
}

function gridFieldDelta(a, b) {
  let maxHeightM = 0
  let landFlips = 0
  let compared = 0
  let over1mCells = 0
  let worstCell = null
  for (let i = 0; i < a.heights.length; i++) {
    if (!a.finiteMask[i] || !b.finiteMask[i]) continue
    compared++
    const d = Math.abs(a.heights[i] - b.heights[i])
    if (d > maxHeightM) { maxHeightM = d; worstCell = i }
    if (d > 1) over1mCells++
    if (a.land[i] !== b.land[i]) landFlips++
  }
  return { maxHeightM: +maxHeightM.toFixed(6), landFlips, comparedCells: compared, totalCells: a.heights.length, over1mCells, worstCell }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const worldName = String(args.world || 'tps-game')
  const stepM = Number(args.step || 5000)
  const fineStepM = Number(args.fine || 0.25)
  const seamWindowM = Number(args.seamWindow || 1500)
  const mode = String(args.mode || 'fixed')
  const reanchorAngleDeg = Number(args.reanchorAngle ?? 28)
  const anchorsPerFace = Number(args.anchorsPerFace || 3)
  const minimapRes = Number(args.minimapRes || 24)
  const minimapExtent = Number(args.minimapExtent || 384)
  const gridStride = Number(args.gridStride || 200)
  const chunkM = Number(args.chunkM || 128)
  const verbose = !!args.verbose

  const tcfg = await loadWorld(worldName)
  const radius = tcfg.radius
  const seed = tcfg.seed | 0
  const hashVersion = terrainHashVersionOf(tcfg)
  const sampler = await createHeightSampler({ radius, seed, reliefScale: tcfg.reliefScale, hashVersion, carves: terrainCarvesOf(tcfg) })
  const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
  const anchorField = sampler.anchorField || createAnchorField({ seed })
  const lattice = createPlacementLattice(radius, chunkM, 16)
  const anchorLattice = createChartAnchorLattice(radius, anchorsPerFace)

  const walker = createChartWalker({
    frame, sampler, anchorField, lattice, anchorLattice, radius, mode, reanchorAngleDeg, minimapRes, minimapExtent,
    expectedStepM: Math.max(stepM, fineStepM),
  })

  const aLat = dirToLatLon([...frame.up]).lat
  const aLon = dirToLatLon([...frame.up]).lon
  const routes = [
    { name: 'ew-equator', kind: 'east-west', route: routeParallelFrom(0, aLon) },
    { name: `ew-anchor-lat-${aLat.toFixed(0)}`, kind: 'east-west', route: routeParallelFrom(aLat, aLon) },
    { name: 'ew-anchor-lat-plus-30', kind: 'east-west', route: routeParallelFrom(Math.min(85, aLat + 30), aLon) },
    { name: 'ns-over-both-poles', kind: 'north-south', route: routeMeridianFrom(aLat, aLon) },
    { name: 'ns-over-both-poles-antipode', kind: 'north-south', route: routeMeridianFrom(-aLat, aLon + 180) },
    { name: 'diag-incl-45', kind: 'diagonal', route: routeGreatCircleThrough(45, aLat, aLon) },
    { name: 'diag-incl-110', kind: 'diagonal', route: routeGreatCircleThrough(110, aLat, aLon) },
    { name: 'diag-incl-160', kind: 'diagonal', route: routeGreatCircleThrough(160, aLat, aLon) },
  ]
  for (const c of cubeDirections()) {
    if (c.kind !== 'corner') continue
    routes.push({ name: `corner-${c.name}`, kind: 'corner', route: routeGreatCircleThroughDir([...frame.up], c.dir) })
  }

  const report = {
    world: worldName, mode, radius, seed, stepM, fineStepM, seamWindowM,
    reanchorAngleDeg, anchorsPerFace, maxSlopeDeg: MAX_SLOPE_DEG, gridStride, minimapRes, minimapExtent,
    homeAnchorDir: [...frame.up],
    anchorLattice: anchorLattice ? { chunksPerFace: anchorLattice.chunksPerFace, anchors: anchorLattice.chunksPerFace ** 2 * 6 } : null,
    anchorCellWorstAngleDeg: anchorLattice ? +chartAnchorCellWorstAngleDeg(anchorLattice).toFixed(3) : null,
    routes: [], crossings: [], poles: [], minimap: [],
  }

  for (const r of routes) {
    const total = r.route.lengthM(radius)
    const n = Math.max(2, Math.round(total / stepM))
    const ds = total / n
    const samples = []
    let prev = null
    let firstDir = null
    let unreachableAt = null
    const anchorChangeIndices = []
    walker.resetAnchorEvents()
    walker.resetCarry()
    const t0 = Date.now()
    for (let i = 0; i <= n; i++) {
      let dir, lat, lon
      if (r.route.atDir) {
        dir = r.route.atDir(i * ds, radius)
        const ll = dirToLatLon(dir)
        lat = ll.lat; lon = ll.lon
      } else {
        const ll = r.route.at(i * ds, radius)
        lat = ll[0]; lon = ll[1]
        dir = latLonToDir(lat, lon)
      }
      if (!firstDir) firstDir = dir
      const anchorBefore = [...walker.anchorDir]
      let seamGrid = null
      if (walker.needsReanchor(dir)) seamGrid = { at: i, before: walker.minimapGrid(dir) }
      const s = walker.sample(dir, prev)
      const anchorAfter = [...walker.anchorDir]
      if (anchorAfter.some((v, k) => v !== anchorBefore[k])) anchorChangeIndices.push(i)
      if (seamGrid) {
        seamGrid.after = walker.minimapGrid(dir)
        const truthFrame = createPlanetFrame({ sampler, anchorDir: dir, offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
        seamGrid.truth = walker.minimapGrid(dir, truthFrame)
        seamGrid.beforeVsTruth = pixelDiff(seamGrid.truth.rgb, seamGrid.before.rgb, seamGrid.truth.finiteMask, seamGrid.before.finiteMask)
        seamGrid.afterVsTruth = pixelDiff(seamGrid.truth.rgb, seamGrid.after.rgb, seamGrid.truth.finiteMask, seamGrid.after.finiteMask)
        seamGrid.seam = pixelDiff(seamGrid.before.rgb, seamGrid.after.rgb, seamGrid.before.finiteMask, seamGrid.after.finiteMask)
        seamGrid.rawSeam = pixelDiff(seamGrid.before.rawRgb, seamGrid.after.rawRgb, seamGrid.before.finiteMask, seamGrid.after.finiteMask)
        seamGrid.fieldBeforeTruth = gridFieldDelta(seamGrid.truth, seamGrid.before)
        seamGrid.fieldAfterTruth = gridFieldDelta(seamGrid.truth, seamGrid.after)
        seamGrid.fieldSeam = gridFieldDelta(seamGrid.before, seamGrid.after)
        report.minimap.push({
          at: `${r.name}/${i}`,
          route: r.name,
          centreTiltDeg: s.ok ? s.tiltDeg : null,
          centreTerrainTiltDeg: s.ok ? s.tiltTerrainDeg : null,
          centreAngleFromAnchorDeg: s.ok ? s.angleDeg : null,
          finiteBefore: `${seamGrid.before.finite}/${seamGrid.before.total}`,
          finiteAfter: `${seamGrid.after.finite}/${seamGrid.after.total}`,
          finiteTruth: `${seamGrid.truth.finite}/${seamGrid.truth.total}`,
          beforeVsTruth: seamGrid.beforeVsTruth,
          afterVsTruth: seamGrid.afterVsTruth,
          seam: seamGrid.seam,
          rawSeam: seamGrid.rawSeam,
          fieldSeam: seamGrid.fieldSeam,
          fieldBeforeTruth: seamGrid.fieldBeforeTruth,
          fieldAfterTruth: seamGrid.fieldAfterTruth,
        })
      }
      samples.push(s)
      if (!s.ok && unreachableAt === null) {
        unreachableAt = { i, arcM: +(i * ds).toFixed(1), angleDeg: +s.angleDeg.toFixed(2), lat: +lat.toFixed(3), lon: +lon.toFixed(3) }
        break
      }
      prev = s
    }
    const routeEvents = walker.resetAnchorEvents()
    const ok = samples.filter(s => s.ok)
    const steps = ok.slice(1).map(s => s.stepM)
    const tilts = ok.map(s => s.tiltDeg).filter(v => v != null)
    const terrainTilts = ok.map(s => s.tiltTerrainDeg).filter(v => v != null)
    const excess = ok.map(s => s.chartExcessDeg).filter(v => v != null)
    const closureM = ok.length > 1 ? arcM(radius, firstDir, ok[ok.length - 1].dir) : null
    report.routes.push({
      name: r.name,
      kind: r.kind,
      routeLengthM: Math.round(total),
      samples: samples.length,
      sampledOk: ok.length,
      sampledFailed: samples.length - ok.length,
      unreachableAt,
      maxStepM: steps.length ? +Math.max(...steps).toFixed(4) : null,
      minStepM: steps.length ? +Math.min(...steps).toFixed(4) : null,
      expectedStepM: +ds.toFixed(4),
      maxStepErrorM: steps.length ? +Math.max(...steps.map(v => Math.abs(v - ds))).toFixed(4) : null,
      maxTiltDeg: tilts.length ? +Math.max(...tilts).toFixed(3) : null,
      unwalkableSamples: ok.filter(s => s.walkable === false).length,
      maxTerrainTiltDeg: terrainTilts.length ? +Math.max(...terrainTilts).toFixed(3) : null,
      unwalkableTerrainSamples: ok.filter(s => s.walkableTerrain === false).length,
      maxChartExcessDeg: excess.length ? +Math.max(...excess).toFixed(3) : null,
      anchorChangeIndices,
      minSamplesBetweenAnchorChanges: anchorChangeIndices.length > 1
        ? Math.min(...anchorChangeIndices.slice(1).map((v, k) => v - anchorChangeIndices[k]))
        : null,
      maxChunkOffsetM: ok.length ? +Math.max(...ok.map(s => s.ringMaxOffsetM)).toFixed(2) : null,
      minChunkCount: ok.length ? Math.min(...ok.map(s => s.chunkCount)) : null,
      anchorChanges: routeEvents.length,
      continuousAnchorChanges: routeEvents.filter(e => e.continuous).length,
      maxAnchorAngleDeg: routeEvents.length ? +Math.max(...routeEvents.map(e => e.angleBeforeDeg)).toFixed(3) : null,
      maxReanchorDirJumpM: routeEvents.filter(e => e.continuous).length ? +Math.max(...routeEvents.filter(e => e.continuous).map(e => e.dirJumpM)).toFixed(6) : null,
      maxReanchorVelJumpMps: routeEvents.filter(e => e.continuous).length ? +Math.max(...routeEvents.filter(e => e.continuous).map(e => e.worldVelJumpMps)).toFixed(6) : null,
      maxReanchorGroundResidualM: routeEvents.filter(e => e.continuous).length ? +Math.max(...routeEvents.filter(e => e.continuous).map(e => e.groundResidualM)).toFixed(6) : null,
      maxWorldForwardJumpDeg: routeEvents.length ? +Math.max(...routeEvents.map(e => e.worldForwardJumpDeg)).toFixed(9) : null,
      maxYawOnlyForwardJumpDeg: routeEvents.length ? +Math.max(...routeEvents.map(e => e.yawOnlyForwardJumpDeg)).toFixed(6) : null,
      maxInducedPitchDeg: routeEvents.length ? +Math.max(...routeEvents.map(e => Math.abs(e.pitchAfter - e.pitchBefore) * RAD)).toFixed(6) : null,
      loopClosureM: closureM == null ? null : +closureM.toFixed(4),
      ms: Date.now() - t0,
    })
    if (verbose) report.routes[report.routes.length - 1].raw = samples
  }

  const poles = [
    { name: 'pole-north', dir: [0, 1, 0] },
    { name: 'pole-south', dir: [0, -1, 0] },
  ]
  for (const p of poles) {
    const d = norm(p.dir)
    walker.resetAnchorEvents()
    walker.resetCarry()
    const before = walker.sample(d, null)
    const { e, n } = perpendicularAxis(d)
    const ring = []
    for (let k = 0; k < 8; k++) {
      const a = 2 * Math.PI * k / 8
      ring.push(walker.sample(offsetDir(d, e, n, Math.cos(a) * 50, Math.sin(a) * 50, radius), null))
    }
    report.poles.push({
      name: p.name,
      reachable: before.ok,
      angleFromAnchorDeg: +angleFromAnchorDeg(frame, d).toFixed(3),
      groundY: before.ok ? before.groundY : null,
      tiltDeg: before.tiltDeg ?? null,
      ringReachable: ring.filter(s => s.ok).length,
      ringLocalRadiusM: ring.filter(s => s.ok).map(s => +Math.hypot(s.local[0], s.local[1]).toFixed(2)),
      ringHeadingSpreadDeg: (() => {
        const heads = ring.filter(s => s.ok).map(s => Math.atan2(s.local[0], s.local[1]) * RAD)
        if (heads.length < 2) return null
        let spread = 0
        for (let i = 0; i < heads.length; i++) for (let j = i + 1; j < heads.length; j++) spread = Math.max(spread, Math.abs(heads[i] - heads[j]))
        return +spread.toFixed(2)
      })(),
    })
  }

  const crossings = cubeDirections().filter(c => c.kind !== 'face')
  for (const c of crossings) {
    const d = norm(c.dir)
    const { e, n } = perpendicularAxis(d)
    const axes = [[1, 0], [0, 1], [0.7071, 0.7071]]
    for (let ai = 0; ai < axes.length; ai++) {
      const [ax, az] = axes[ai]
      const n2 = Math.round(2 * seamWindowM / fineStepM) + 1
      const truthFrame = createPlanetFrame({ sampler, anchorDir: d, offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
      const refGrid = walker.minimapGrid(d, truthFrame)
      walker.resetAnchorEvents()
      walker.resetCarry()
      let prev = null
      let maxStepErr = 0
      let maxTilt = 0
      let maxTerrainTilt = 0
      let failed = 0
      let maxGroundJumpM = 0
      let minAnchorAngle = Infinity
      let maxAnchorAngle = 0
      let gridPrev = walker.minimapGrid(d)
      let gridAnchor = [...walker.anchorDir]
      let gridsTaken = 1
      let maxConsecutiveDiff = 0
      let maxVsTruthDiff = 0
      let seamDiff = null
      let anchorChanged = false
      for (let i = 0; i < n2; i++) {
        const t = -seamWindowM + i * fineStepM
        const dir = offsetDir(d, e, n, ax * t, az * t, radius)
        const s = walker.sample(dir, prev)
        if (!s.ok) { failed++; break }
        if (prev && prev.ok) {
          maxStepErr = Math.max(maxStepErr, Math.abs(s.stepM - fineStepM))
          maxGroundJumpM = Math.max(maxGroundJumpM, s.dGroundM)
        }
        if (s.tiltDeg != null) maxTilt = Math.max(maxTilt, s.tiltDeg)
        if (s.tiltTerrainDeg != null) maxTerrainTilt = Math.max(maxTerrainTilt, s.tiltTerrainDeg)
        if (i > 2) { minAnchorAngle = Math.min(minAnchorAngle, s.angleDeg); maxAnchorAngle = Math.max(maxAnchorAngle, s.angleDeg) }
        const now = walker.anchorDir
        const changed = now.some((v, k) => v !== gridAnchor[k])
        if (i > 0 && (changed || i % gridStride === 0)) {
          const g = walker.minimapGrid(d)
          const cd = pixelDiff(gridPrev.rgb, g.rgb, gridPrev.finiteMask, g.finiteMask)
          const td = pixelDiff(refGrid.rgb, g.rgb, refGrid.finiteMask, g.finiteMask)
          if (cd.maxAbs > maxConsecutiveDiff) maxConsecutiveDiff = cd.maxAbs
          if (td.maxAbs > maxVsTruthDiff) maxVsTruthDiff = td.maxAbs
          if (changed) {
            anchorChanged = true
            seamDiff = { step: i, maxAbs: cd.maxAbs, meanAbs: cd.meanAbs, differingChannels: cd.differingChannels, comparedChannels: cd.comparedChannels }
          }
          gridPrev = g
          gridAnchor = [...now]
          gridsTaken++
        }
        prev = s
      }
      report.crossings.push({
        name: c.name, kind: c.kind, axis: ai,
        angleFromAnchorDeg: +angleFromAnchorDeg(frame, d).toFixed(3),
        fineStepM, windowM: seamWindowM, samples: n2,
        failedSamples: failed,
        maxStepErrorM: +maxStepErr.toFixed(4),
        maxGroundJumpPerStepM: +maxGroundJumpM.toFixed(4),
        maxTiltDeg: +maxTilt.toFixed(3),
        maxTerrainTiltDeg: +maxTerrainTilt.toFixed(3),
        chartAngleAfterReanchorDeg: +(maxAnchorAngle === 0 ? 0 : maxAnchorAngle).toFixed(3),
        chartAngleMinDeg: +(minAnchorAngle === Infinity ? 0 : minAnchorAngle).toFixed(3),
        walkable: maxTilt < MAX_SLOPE_DEG,
        anchorChanged,
      })
      report.minimap.push({
        at: `${c.name}/ax${ai}`, anchorChanged, grids: gridsTaken,
        maxConsecutiveDiff, maxVsTruthDiff,
        seamDiff,
        refFiniteCells: `${refGrid.finite}/${refGrid.total}`,
      })
    }
  }

  const centreDirs = cubeDirections().filter(c => c.kind === 'face')
  for (const c of centreDirs) {
    const d = norm(c.dir)
    const s = walker.sample(d, null)
    const g = walker.minimapGrid(d)
    const g2 = walker.minimapGrid(d)
    report.minimap.push({ at: c.name, repeatSameChart: true, ...pixelDiff(g.rgb, g2.rgb), finiteCells: `${g.finite}/${g.total}` })
    if (!s.ok) report.minimap[report.minimap.length - 1].unreachable = true
  }

  report.anchorChangesTotal = walker.anchorChanges
  report.anchorEvents = walker.events.filter(e => e.continuous).slice(-30)
  report.finalAnchorDir = [...frame.up]
  const evs = walker.events
  const cevs = evs.filter(e => e.continuous)
  const agg = (arr, f) => arr.length ? +Math.max(...arr.map(f)).toFixed(6) : null
  report.reanchorSummary = {
    count: evs.length,
    continuousCount: cevs.length,
    teleportCount: evs.length - cevs.length,
    maxAngleBeforeDeg: agg(cevs, e => e.angleBeforeDeg) ?? agg(evs, e => e.angleBeforeDeg),
    maxAngleAfterDeg: agg(cevs, e => e.angleAfterDeg) ?? agg(evs, e => e.angleAfterDeg),
    maxDirJumpM: agg(cevs, e => e.dirJumpM),
    maxGroundResidualM: agg(cevs, e => e.groundResidualM),
    maxWorldVelJumpMps: agg(cevs, e => e.worldVelJumpMps),
    maxSpeedErrMps: agg(cevs, e => Math.abs(e.speedAfter - e.speedBefore)),
    maxDetErr: agg(evs, e => Math.abs(e.det - 1)),
    maxTiltRadPerShiftDeg: agg(cevs, e => e.tiltRad * RAD),
  }
  const ct = report.crossings.filter(c => c.failedSamples === 0).map(c => c.maxTiltDeg).sort((x, y) => x - y)
  report.crossingTiltSummary = {
    total: report.crossings.length,
    succeeded: report.crossings.filter(c => c.failedSamples === 0).length,
    walkable: report.crossings.filter(c => c.walkable && c.failedSamples === 0).length,
    maxTiltDeg: +Math.max(...report.crossings.map(c => c.maxTiltDeg)).toFixed(3),
    medianTiltDeg: ct.length ? +ct[ct.length >> 1].toFixed(3) : null,
    maxTiltDegSucceeded: ct.length ? +ct[ct.length - 1].toFixed(3) : null,
    edgeMaxTiltDeg: +Math.max(...report.crossings.filter(c => c.kind === 'edge').map(c => c.maxTiltDeg)).toFixed(3),
    cornerMaxTiltDeg: +Math.max(...report.crossings.filter(c => c.kind === 'corner').map(c => c.maxTiltDeg)).toFixed(3),
    maxTerrainTiltDeg: +Math.max(...report.crossings.map(c => c.maxTerrainTiltDeg)).toFixed(3),
    edgeWalkable: report.crossings.filter(c => c.kind === 'edge' && c.walkable && c.failedSamples === 0).length,
    cornerWalkable: report.crossings.filter(c => c.kind === 'corner' && c.walkable && c.failedSamples === 0).length,
  }

  const cornerRoutes = report.routes.filter(r => r.kind === 'corner')
  const done = (r) => r.unreachableAt === null && r.sampledFailed === 0
  const maxOf = (arr, f) => arr.length ? +Math.max(...arr.map(f)).toFixed(3) : null
  const maxRaw = (arr, f) => { const v = arr.map(f).filter(x => x != null); return v.length ? Math.max(...v) : null }
  report.routeSummary = {
    total: report.routes.length,
    completed: report.routes.filter(done).length,
    maxLoopClosureM: maxOf(report.routes.filter(done), r => r.loopClosureM),
    maxTiltDeg: maxOf(report.routes, r => r.maxTiltDeg),
    maxTerrainTiltDeg: maxOf(report.routes, r => r.maxTerrainTiltDeg),
    maxChartExcessDeg: maxOf(report.routes, r => r.maxChartExcessDeg),
    maxReanchorDirJumpM: maxOf(report.routes, r => r.maxReanchorDirJumpM),
    maxReanchorVelJumpMps: maxOf(report.routes, r => r.maxReanchorVelJumpMps),
    maxWorldForwardJumpDeg: maxRaw(report.routes, r => r.maxWorldForwardJumpDeg),
    maxYawOnlyForwardJumpDeg: maxRaw(report.routes, r => r.maxYawOnlyForwardJumpDeg),
    maxInducedPitchDeg: maxRaw(report.routes, r => r.maxInducedPitchDeg),
    minChunkCount: Math.min(...report.routes.filter(r => r.minChunkCount != null).map(r => r.minChunkCount)),
    maxChunkOffsetM: maxOf(report.routes, r => r.maxChunkOffsetM),
    cornerRoutes: cornerRoutes.length,
    cornerCompleted: cornerRoutes.filter(done).length,
    cornerMaxTiltDeg: maxOf(cornerRoutes, r => r.maxTiltDeg),
    cornerMaxTerrainTiltDeg: maxOf(cornerRoutes, r => r.maxTerrainTiltDeg),
    cornerMaxChartExcessDeg: maxOf(cornerRoutes, r => r.maxChartExcessDeg),
    cornerMaxDirJumpM: maxOf(cornerRoutes, r => r.maxReanchorDirJumpM),
    cornerAnchorChanges: cornerRoutes.reduce((a, r) => a + r.anchorChanges, 0),
    cornerMinSamplesBetweenAnchorChanges: (() => {
      const gaps = cornerRoutes.map(r => r.minSamplesBetweenAnchorChanges).filter(v => v != null)
      return gaps.length ? Math.min(...gaps) : null
    })(),
  }

  const seamDiffs = report.minimap.filter(m => m.seamDiff).map(m => m.seamDiff)
  const routeSeams = report.minimap.filter(m => m.seam)
  const repeatDiffs = report.minimap.filter(m => m.repeatSameChart)
  report.minimapSummary = {
    crossingWindows: report.minimap.filter(m => m.grids).length,
    maxConsecutiveDiff: Math.max(0, ...report.minimap.filter(m => m.grids).map(m => m.maxConsecutiveDiff)),
    maxVsTruthDiff: Math.max(0, ...report.minimap.filter(m => m.grids).map(m => m.maxVsTruthDiff)),
    seamWindows: seamDiffs.length,
    maxSeamDiff: seamDiffs.length ? Math.max(...seamDiffs.map(s => s.maxAbs)) : 0,
    meanSeamDiff: seamDiffs.length ? +(seamDiffs.reduce((a, s) => a + s.meanAbs, 0) / seamDiffs.length).toFixed(4) : 0,
    repeatSameChartWindows: repeatDiffs.length,
    maxRepeatSameChartDiff: Math.max(0, ...repeatDiffs.map(m => m.maxAbs)),
    emptyTruthWindows: report.minimap.filter(m => m.refFiniteCells && m.refFiniteCells.startsWith('0/')).length,
    routeSeamWindows: routeSeams.length,
    maxRouteSeamDiff: routeSeams.length ? Math.max(...routeSeams.map(m => m.seam.maxAbs)) : 0,
    meanRouteSeamDiff: routeSeams.length ? +(routeSeams.reduce((a, m) => a + m.seam.meanAbs, 0) / routeSeams.length).toFixed(4) : 0,
    maxRouteVsTruthBefore: routeSeams.length ? Math.max(...routeSeams.map(m => m.beforeVsTruth.maxAbs)) : 0,
    maxRouteVsTruthAfter: routeSeams.length ? Math.max(...routeSeams.map(m => m.afterVsTruth.maxAbs)) : 0,
    maxRawSeamDiff: routeSeams.length ? Math.max(...routeSeams.map(m => m.rawSeam.maxAbs)) : 0,
    maxSeamHeightDiffM: routeSeams.length ? Math.max(...routeSeams.map(m => m.fieldSeam.maxHeightM)) : 0,
    maxTruthHeightDiffM: routeSeams.length ? Math.max(...routeSeams.map(m => Math.max(m.fieldBeforeTruth.maxHeightM, m.fieldAfterTruth.maxHeightM))) : 0,
    seamLandFlips: routeSeams.reduce((a, m) => a + m.fieldSeam.landFlips, 0),
    seamComparedCells: routeSeams.reduce((a, m) => a + m.fieldSeam.comparedCells, 0),
    routeSeamComparedChannels: routeSeams.length ? Math.min(...routeSeams.map(m => m.seam.comparedChannels)) : 0,
  }

  console.log(JSON.stringify(report, null, 2))
  if (args.json) { fs.writeFileSync(path.resolve(REPO_ROOT, args.json), JSON.stringify(report, null, 2)); console.error(`[circumnavigate] wrote ${args.json}`) }
}

const _entryArg = process.argv[1]
if (_entryArg && (import.meta.url === `file://${_entryArg}` || import.meta.url === `file:///${_entryArg.replace(/\\/g, '/')}`)) {
  main().catch(e => { console.error('[circumnavigate] failed:', e?.stack || e?.message || e); process.exit(1) })
}
