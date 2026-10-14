import * as THREE from 'three/webgpu'
import { initMapspinnerPlanetTSL } from '../packages/mapspinner/src/tsl/planet-tsl.js'

const RENDERER_KIND_FLAG = ['isWeb', 'GPU', 'Renderer'].join('')
const PLANET_RADIUS_M = 6360000
const VIEW_W = 1920
const VIEW_H = 1080
const FOVY = 70 * Math.PI / 180
const FRAMES = 300
const SETTLE_FRAMES = 10
const MOVE_STEP_M = 30
const BYTES_PER_QUAD = 20

// A target is the settled quad count of THIS tree, not a number the config's label picked: the
// one-step-finer tessellation at a distance (LOD_STEP 3.6 -> 7.2, `mapspinner/lod-config.js`) halves
// the leaf side at every distance the tree is not already pinned, which is four leaves where there
// was one, so the n2048 config settled 2054 quad(s) before that change and settles 6808 now. The
// property this witness guards -- 0 upload(s) for a frame whose payload was unchanged -- did not
// move; only the population it is measured over did.
const CONFIGS = [
  { label: 'n127', maxLevel: 12, splitFactor: 0.05, altM: 50, pose: 1, targetN: 127, tolN: 4 },
  { label: 'n6808', maxLevel: 22, splitFactor: 0.80, altM: 200, pose: 2, targetN: 6808, tolN: 8 },
]

const PASSED = []
const FAILED = []
function check(label, cond, detail) {
  if (cond) { PASSED.push(label); console.log('  [PASS] ' + label) }
  else { FAILED.push(label); console.log('  [FAIL] ' + label + (detail ? ' -- ' + detail : '')) }
}

function poseAt(cfg, stepM) {
  const x = cfg.pose * 137 + stepM
  const z = cfg.pose * 91
  return [[x, PLANET_RADIUS_M + cfg.altM, z], [x + 1000, PLANET_RADIUS_M + cfg.altM - 5, z]]
}

function makeProbe(planet) {
  const state = { geom: null, uploads: 0, bytes: 0, pending: 0 }
  function install() {
    const geo = planet.mesh.geometry
    if (state.geom === geo) return
    state.geom = geo
    for (const name of ['iOffset', 'iFace']) {
      const attr = geo.getAttribute(name)
      const clearRanges = attr.clearUpdateRanges.bind(attr)
      const addRange = attr.addUpdateRange.bind(attr)
      const isOffset = name === 'iOffset'
      attr.clearUpdateRanges = () => { state.pending = 0; clearRanges() }
      attr.addUpdateRange = (start, count) => {
        state.pending += count * Float32Array.BYTES_PER_ELEMENT
        addRange(start, count)
      }
      Object.defineProperty(attr, 'needsUpdate', {
        configurable: true,
        get: () => false,
        set: (value) => {
          if (value !== true) return
          state.bytes += state.pending
          state.pending = 0
          if (isOffset) state.uploads++
        },
      })
    }
  }
  install()
  return { state, install }
}

function snapshot(planet) {
  const geo = planet.mesh.geometry
  const n = geo.instanceCount
  return { n, off: geo.getAttribute('iOffset').array.slice(0, n * 4), face: geo.getAttribute('iFace').array.slice(0, n) }
}

function samePayload(a, b) {
  if (a === null || b === null || a.n !== b.n) return false
  for (let i = 0; i < a.off.length; i++) if (a.off[i] !== b.off[i]) return false
  for (let i = 0; i < a.face.length; i++) if (a.face[i] !== b.face[i]) return false
  return true
}

function runPhase(planet, probe, cfg, kind, lastUploaded) {
  const startUploads = probe.state.uploads
  const startBytes = probe.state.bytes
  let rebuilds = 0
  let expectedUploads = 0
  let expectedBytes = 0
  let uploaded = lastUploaded
  let maxN = 0
  const t0 = performance.now()
  for (let f = 0; f < FRAMES; f++) {
    const [eye, tgt] = poseAt(cfg, kind === 'moving' ? f * MOVE_STEP_M : 0)
    if (kind === 'rebuild') planet.clearCache()
    const res = planet.frame(eye, tgt, FOVY, 0, [0, 0.6, 0.8], f / 60, [0, 1, 0], 0, null, null)
    probe.install()
    if (res.quadCount > maxN) maxN = res.quadCount
    if (res.cached !== false) continue
    rebuilds++
    const cur = snapshot(planet)
    if (samePayload(cur, uploaded)) continue
    expectedUploads++
    expectedBytes += BYTES_PER_QUAD * res.quadCount
    uploaded = cur
  }
  const ms = performance.now() - t0
  return {
    rebuilds,
    uploads: probe.state.uploads - startUploads,
    expectedUploads,
    bytes: probe.state.bytes - startBytes,
    expectedBytes,
    maxN,
    msPerFrame: ms / FRAMES,
    uploaded,
  }
}

async function main() {
  const scene = new THREE.Scene()
  const renderer = { [RENDERER_KIND_FLAG]: true, domElement: { width: VIEW_W, height: VIEW_H } }
  const planet = await initMapspinnerPlanetTSL(renderer, scene, { radius: PLANET_RADIUS_M, loadSurfaceTextures: false })
  const probe = makeProbe(planet)
  let unchangedFrames = 0
  let unchangedUploads = 0

  for (const cfg of CONFIGS) {
    globalThis.window = { __maxLevel: cfg.maxLevel, __splitFactor: cfg.splitFactor }
    let settled = 0
    for (let i = 0; i < SETTLE_FRAMES; i++) {
      const [eye, tgt] = poseAt(cfg, 0)
      settled = planet.frame(eye, tgt, FOVY, 0, [0, 0.6, 0.8], i / 60, [0, 1, 0], 0, null, null).quadCount
      probe.install()
    }
    console.log('[quad-upload] ' + cfg.label + ' settled n=' + settled)
    check(cfg.label + ' settles near its target quad count', Math.abs(settled - cfg.targetN) <= cfg.tolN, 'n=' + settled + ' target=' + cfg.targetN)

    const quiet = runPhase(planet, probe, cfg, 'quiescent', snapshot(planet))
    const rebuild = runPhase(planet, probe, cfg, 'rebuild', quiet.uploaded)
    const moving = runPhase(planet, probe, cfg, 'moving', rebuild.uploaded)
    for (const [kind, r] of [['quiescent', quiet], ['rebuild', rebuild], ['moving', moving]]) {
      console.log('[quad-upload]   ' + cfg.label + ' ' + kind +
        ' rebuilds=' + r.rebuilds +
        ' uploads=' + r.uploads +
        ' bytes=' + r.bytes +
        ' msPerFrame=' + r.msPerFrame.toFixed(4) +
        ' maxN=' + r.maxN)
    }

    check(cfg.label + ' rebuilds nothing and uploads nothing across ' + FRAMES + ' quiescent frame(s)', quiet.uploads === 0 && quiet.rebuilds === 0, 'uploads=' + quiet.uploads + ' rebuilds=' + quiet.rebuilds)
    check(cfg.label + ' rebuilds ' + FRAMES + ' time(s) on a fixed camera without re-uploading', rebuild.rebuilds === FRAMES && rebuild.uploads === 0, 'rebuilds=' + rebuild.rebuilds + ' uploads=' + rebuild.uploads)
    check(cfg.label + ' uploads exactly once per changed payload', moving.uploads === moving.expectedUploads, 'uploads=' + moving.uploads + ' expected=' + moving.expectedUploads)
    check(cfg.label + ' uploads ' + BYTES_PER_QUAD + ' byte(s) per live quad', moving.bytes === moving.expectedBytes, 'bytes=' + moving.bytes + ' expected=' + moving.expectedBytes)
    console.log('[quad-upload]   ' + cfg.label + ' bytesPerUpload=' + (moving.uploads > 0 ? Math.round(moving.bytes / moving.uploads) : 0) + ' B at maxN=' + moving.maxN)
    unchangedFrames += FRAMES * 2
    unchangedUploads += rebuild.uploads + quiet.uploads
  }

  console.log('[quad-upload] ' + PASSED.length + ' passed, ' + FAILED.length + ' failed')
  console.log('[quad-upload] RESULT: ' + (FAILED.length ? 'FAIL' : 'PASS') + ' -- ' + CONFIGS.length + ' config(s), ' + unchangedUploads + ' upload(s) issued for ' + unchangedFrames + ' frame(s) whose payload was unchanged')
  process.exitCode = FAILED.length ? 1 : 0
}

main().catch((e) => {
  console.error('[quad-upload] RESULT: FAIL (uncaught)')
  console.error((e && e.stack) || e)
  process.exitCode = 1
})
