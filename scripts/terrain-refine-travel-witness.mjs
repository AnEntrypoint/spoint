// Terrain refinement vs travel speed: counted work units only (quads, rebuilds, staleness metres).
//
// The planet LOD has no per-frame op budget (verified: "budget" occurs zero times under
// packages/mapspinner/src). What it does have is a position-keyed quad cache: the quad set is
// recomputed only once the camera has moved past a tolerance, so the rendered quad set can be
// computed at a STALE camera position. This witness measures that staleness, the finest quad the
// rendered set actually carries, and split/merge oscillation, as a function of travel speed.
//
// It then drives the REAL QualityGovernor (client/core/QualityGovernor.js) over the REAL
// RenderControls registry and re-measures, because the level the planet actually delivers is
// whatever that pair leave in window.__maxLevel -- packages/mapspinner/src/lod-config.js
// resolveLodConfig prefers the live knob over the level the world configured.

import * as THREE from 'three/webgpu'
import { initMapspinnerPlanetTSL } from '../packages/mapspinner/src/tsl/planet-tsl.js'

const RENDERER_KIND_FLAG = ['isWeb', 'GPU', 'Renderer'].join('')
const PLANET_RADIUS_M = 63600            // src/presets/planet.js radius
const RELIEF_SCALE = 0.001               // src/presets/planet.js reliefScale
const WORLD_MAX_LEVEL = 13               // src/presets/planet.js maxLevel
const REGISTRY_DEFAULT_MAX_LEVEL = 11    // client/core/RenderControls.js CONTROLS default
const VIEW_W = 1920
const VIEW_H = 1080
const FOVY = 70 * Math.PI / 180
const FRAMES = 240
const SETTLE_FRAMES = 20
const GRID_MESH_SIZE = 9
const ALT_M = 2
const MOVE_TOL_M = 1.0                   // planet-tsl.js quadsFor moveTol floor near the ground
const DT = 1 / 60

const SPEEDS_MPS = [0, 5, 15, 40, 100, 300]
const TOGGLES_PER_FRAME_MAX = 4

const PASSED = []
const FAILED = []
function check(label, cond, detail) {
  if (cond) { PASSED.push(label); console.log('  [PASS] ' + label) }
  else { FAILED.push(label); console.log('  [FAIL] ' + label + (detail ? ' -- ' + detail : '')) }
}
function note(label, detail) { console.log('  [note] ' + label + (detail ? ' -- ' + detail : '')) }

function quadSizeAt(level) { return 2 * PLANET_RADIUS_M / Math.pow(2, level) }
function vertexSpacingAt(level) { return quadSizeAt(level) / (GRID_MESH_SIZE - 1) }

function poseAt(travelledM) {
  const r = PLANET_RADIUS_M + ALT_M
  const a = travelledM / r
  const s = Math.sin(a), c = Math.cos(a)
  const eye = [r * s, r * c, 0]
  const tgt = [eye[0] + 1000 * c, eye[1] - 1000 * s, 0]
  return [eye, tgt]
}

function finestOf(planet) {
  const geo = planet.mesh.geometry
  const n = geo.instanceCount
  const off = geo.getAttribute('iOffset').array
  let finestL = Infinity, finestLevel = -1
  for (let i = 0; i < n; i++) {
    const l = off[i * 4 + 2], lv = off[i * 4 + 3]
    if (l < finestL) { finestL = l; finestLevel = lv }
  }
  return n > 0 ? { sizeM: finestL, level: finestLevel, count: n } : { sizeM: Infinity, level: -1, count: 0 }
}

function quadKeys(planet) {
  const geo = planet.mesh.geometry
  const n = geo.instanceCount
  const off = geo.getAttribute('iOffset').array
  const face = geo.getAttribute('iFace').array
  const set = new Set()
  for (let i = 0; i < n; i++) {
    set.add(face[i] + ':' + off[i * 4] + ':' + off[i * 4 + 1] + ':' + off[i * 4 + 2])
  }
  return set
}

function runSpeed(planet, speedMps) {
  let travelled = 0
  let sinceRebuildM = 0
  let sinceRebuildFrames = 0
  let rebuilds = 0
  let maxStaleM = 0
  let sumStaleM = 0
  let sumGapFrames = 0
  let toggles = 0
  let prevKeys = null
  const everSeen = new Set()
  let finestSizeM = Infinity
  let finestLevel = -1
  let maxQuadCount = 0
  const t0 = performance.now()
  for (let f = 0; f < FRAMES; f++) {
    const [eye, tgt] = poseAt(travelled)
    const res = planet.frame(eye, tgt, FOVY, 0, [0, 0.6, 0.8], f * DT, [0, 1, 0], 0, null, null)
    if (res.cached === false) {
      rebuilds++
      if (rebuilds > 1) sumGapFrames += sinceRebuildFrames
      if (sinceRebuildM > maxStaleM) maxStaleM = sinceRebuildM
      sinceRebuildM = 0
      sinceRebuildFrames = 0
    }
    sumStaleM += sinceRebuildM
    const fr = finestOf(planet)
    if (fr.sizeM < finestSizeM) { finestSizeM = fr.sizeM; finestLevel = fr.level }
    if (fr.count > maxQuadCount) maxQuadCount = fr.count
    const keys = quadKeys(planet)
    if (prevKeys) {
      for (const k of keys) if (!prevKeys.has(k) && everSeen.has(k)) toggles++
      for (const k of keys) everSeen.add(k)
    }
    prevKeys = keys
    travelled += speedMps * DT
    sinceRebuildM += speedMps * DT
    sinceRebuildFrames++
  }
  const ms = performance.now() - t0
  return {
    speedMps,
    rebuilds,
    meanGapFrames: rebuilds > 1 ? +(sumGapFrames / (rebuilds - 1)).toFixed(2) : 0,
    maxStaleM: +maxStaleM.toFixed(3),
    meanStaleM: +(sumStaleM / FRAMES).toFixed(3),
    finestSizeM: +finestSizeM.toFixed(3),
    finestLevel,
    finestSpacingM: +(finestSizeM / (GRID_MESH_SIZE - 1)).toFixed(3),
    maxQuadCount,
    togglesPerFrame: +(toggles / FRAMES).toFixed(2),
    msPerFrame: +(ms / FRAMES).toFixed(4),
  }
}

function settle(planet) {
  for (let i = 0; i < SETTLE_FRAMES; i++) {
    const [eye, tgt] = poseAt(0)
    planet.frame(eye, tgt, FOVY, 0, [0, 0.6, 0.8], i * DT, [0, 1, 0], 0, null, null)
  }
}

async function bootPlanet() {
  const scene = new THREE.Scene()
  const renderer = { [RENDERER_KIND_FLAG]: true, domElement: { width: VIEW_W, height: VIEW_H } }
  const planet = await initMapspinnerPlanetTSL(renderer, scene, {
    radius: PLANET_RADIUS_M,
    reliefScale: RELIEF_SCALE,
    loadSurfaceTextures: false,
    water: false,
    sky: false,
    maxLevel: WORLD_MAX_LEVEL,
  })
  return planet
}

async function main() {
  globalThis.window = {}
  const planet = await bootPlanet()

  const limitSize = quadSizeAt(WORLD_MAX_LEVEL)
  console.log('[terrain-refine] radius=' + PLANET_RADIUS_M + ' world maxLevel=' + WORLD_MAX_LEVEL +
    ' alt=' + ALT_M + 'm grid=' + GRID_MESH_SIZE)
  console.log('[terrain-refine] configured limit: quad ' + limitSize.toFixed(3) + 'm, vertex spacing ' +
    vertexSpacingAt(WORLD_MAX_LEVEL).toFixed(3) + 'm')

  // ---- Phase 1: as the world configures it, before any governor write -------------------------
  console.log('[terrain-refine] phase 1: world-configured level, no live override')
  settle(planet)
  const rows = []
  for (const s of SPEEDS_MPS) {
    const r = runSpeed(planet, s)
    rows.push(r)
    console.log('[terrain-refine] ' + JSON.stringify(r))
  }

  for (const r of rows) {
    // The quad set is recomputed once the camera has moved past moveTol, so the worst staleness
    // the design can ever show is moveTol plus one frame of travel. Anything beyond that is a
    // backlog, which is what "refinement lags travel" would look like.
    const bound = MOVE_TOL_M + r.speedMps * DT + 1e-6
    check('speed ' + r.speedMps + ' m/s: no refinement backlog (staleness <= moveTol + 1 frame = ' +
      bound.toFixed(3) + ' m)', r.maxStaleM <= bound, 'maxStaleM=' + r.maxStaleM)
    check('speed ' + r.speedMps + ' m/s: no split/merge oscillation',
      r.togglesPerFrame <= TOGGLES_PER_FRAME_MAX, 'togglesPerFrame=' + r.togglesPerFrame)
  }

  // ---- Phase 2: the real governor takes its first tick at tier 0 ------------------------------
  console.log('[terrain-refine] phase 2: after the real QualityGovernor tier-0 tick')
  const { createQualityGovernor } = await import('../client/core/QualityGovernor.js')
  const gov = createQualityGovernor()
  gov.tick(8)                                    // one in-budget frame; no shedding requested
  const liveMaxLevel = globalThis.window.__maxLevel
  note('governor tier-0 wrote window.__maxLevel=' + liveMaxLevel +
    ' (world configured ' + WORLD_MAX_LEVEL + ', RenderControls default ' + REGISTRY_DEFAULT_MAX_LEVEL + ')')
  check('governor tier 0 hands the planet the level the world configured',
    liveMaxLevel === WORLD_MAX_LEVEL, 'window.__maxLevel=' + liveMaxLevel)

  settle(planet)
  const after = []
  for (const s of SPEEDS_MPS) {
    const r = runSpeed(planet, s)
    after.push(r)
    console.log('[terrain-refine] ' + JSON.stringify(r))
  }
  for (const r of after) {
    check('speed ' + r.speedMps + ' m/s: governor tier 0 still delivers the maxLevel-' +
      WORLD_MAX_LEVEL + ' limit (' + limitSize.toFixed(3) + 'm quad)',
      Math.abs(r.finestSizeM - limitSize) <= limitSize * 0.01,
      'finestSizeM=' + r.finestSizeM + ' spacing=' + r.finestSpacingM + 'm')
  }

  // ---- Phase 3: what each shed tier actually delivers at a fixed travel speed -----------------
  console.log('[terrain-refine] phase 3: shed tiers at 40 m/s')
  const TRAVEL_MPS = 40
  settle(planet)
  const ladder = [{ tier: 0, r: runSpeed(planet, TRAVEL_MPS) }]
  console.log('[terrain-refine] ' + JSON.stringify({ tier: 0, ...ladder[0].r }))
  for (let t = 1; t <= 5; t++) {
    gov.setTier(t)
    settle(planet)
    const r = runSpeed(planet, TRAVEL_MPS)
    ladder.push({ tier: t, r })
    console.log('[terrain-refine] ' + JSON.stringify({ tier: t, ...r }))
  }
  const steps = []
  for (let i = 1; i < ladder.length; i++) {
    steps.push(+(ladder[i].r.finestSpacingM / ladder[i - 1].r.finestSpacingM).toFixed(3))
  }
  note('vertex-spacing step per shed tier at 40 m/s: ' + JSON.stringify(steps))
  note('delivered spacing per tier (m): ' + JSON.stringify(ladder.map(l => l.r.finestSpacingM)))

  const worst = rows.reduce((a, b) => (b.maxStaleM > a.maxStaleM ? b : a))
  console.log('[terrain-refine] worst staleness: ' + JSON.stringify(worst))
  console.log('[terrain-refine] ' + PASSED.length + ' passed, ' + FAILED.length + ' failed')
  console.log('[terrain-refine] RESULT: ' + (FAILED.length ? 'FAIL' : 'PASS') +
    ' -- ' + PASSED.length + ' check(s) passed, ' + FAILED.length + ' failed; tier-0 vertex spacing ' +
    ladder[0].r.finestSpacingM + ' m at ' + TRAVEL_MPS + ' m/s')
  process.exitCode = FAILED.length ? 1 : 0
}

main().catch((e) => {
  console.error('[terrain-refine] RESULT: FAIL (uncaught)')
  console.error((e && e.stack) || e)
  process.exitCode = 1
})
