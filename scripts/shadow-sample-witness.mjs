#!/usr/bin/env node
// Shadow-SAMPLE instrument. Everything upstream of the sample is already established by execution
// elsewhere, so this witness does not re-derive it and never toggles castShadow or receiveShadow:
//   * the avatar IS in the shadow map (152 shadow-pass submissions with castShadow true and 152 with
//     it false -- the flag does not gate inclusion, so any A/B that toggles it is VOID);
//   * the ground under him DOES receive (flipping terrain receiveShadow moves 558778 px frame-wide,
//     99.6% of a 33000 px rect at his feet);
//   * yet nothing darkens at his feet.
// That leaves the sample. This witness reads the sample itself.
//
// Per arm it measures:
//   1. CPU -- every cascade light's shadow camera and shadow.matrix, and the projection of the
//      player's feet point and of his world AABB into that map's [0,1] uv. This is "which map, at
//      what coordinate".
//   2. GPU -- a flat probe quad laid on the ground around the player's feet, whose material is
//      three's OWN shadow node evaluated at the quad's own world position, read out of the frame by
//      screenshot. Because `positionWorld` of the quad IS the ground point, a pixel of the quad IS
//      the shadow value the engine returns there. Two probes: A is a freshly built ShadowNode, B is
//      the cascade fold the pipeline installed on the sun, so a pipeline target whose contents differ
//      from a freshly rendered one is visible instead of being assumed away.
//      The quad is located on screen by projecting its four corners and rasterising that polygon in
//      Node, so no GPU readback is involved (readRenderTargetPixelsAsync on a witness-owned render
//      target raises "Invalid value used as weak map key" on this backend).
//   3. The real frame, sun and camera frozen, pixel-diffed across the same arms.
//
// The arms are: world casters ON with and without the player, then world casters OFF with and
// without the player. The last pair is the one that can see the player's shadow: a fragment whose
// sample is already 0 cannot show a second caster, which is why every earlier A/B run against the
// shipped scene was blind by construction.
//
// usage: SPOINT_GPU_WITNESS=1 node scripts/gpulock.mjs run <owner> -- \
//          node scripts/shadow-sample-witness.mjs [--gpu=amd] [--world=tps-game] [--out=...]

import fs from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

if (process.env.SPOINT_GPU_WITNESS !== '1') {
  console.log('shadow-sample-witness SKIPPED: SPOINT_GPU_WITNESS!=1 (GPU witness; never in the gpu-free arm of scripts/check.mjs)')
  process.exit(0)
}

const argv = process.argv.slice(2)
const ARGS = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq > 0) ARGS.set(a.slice(2, eq), a.slice(eq + 1))
  else ARGS.set(a.slice(2), (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : true)
}
const flag = (n, d) => (ARGS.has(n) ? ARGS.get(n) : d)

const GPU = String(flag('gpu', 'amd'))
const OUT = resolve(ROOT, String(flag('out', '.gm/pool/shadow-sample-r270-74')))
const WORLD = String(flag('world', 'tps-game'))
const SETTLE_MS = Number(flag('settle', '10000'))
const FRAME_MS = Number(flag('frame-ms', '400'))
const TOD_FRACTION = Number(flag('tod', '0.35'))
const CAM_POSE = String(flag('cam', '0.9,0.28,3'))
const EXTENT_M = Number(flag('extent', '2'))
const PORT = String(flag('port', String(20000 + Math.floor(Math.random() * 20000))))

const { vendorPinArgs } = await import(pathToFileURL(resolve(HERE, 'lib', 'witness-gpu.mjs')).href)
const { gpuArgs, assertGpu } = await import(pathToFileURL(resolve(HERE, 'lib', 'gpu-probe.mjs')).href)
const { chromium, DEFAULT_VIEWPORT } = await import(pathToFileURL(resolve(HERE, 'lib', 'cdp-browser.mjs')).href)
const { decodePng } = await import(pathToFileURL(resolve(HERE, 'tsl-parity', 'png.mjs')).href)

fs.mkdirSync(OUT, { recursive: true })
function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

process.env.WORLD = process.env.WORLD || WORLD
process.env.PORT = PORT
process.env.SPOINT_NO_WATCH = '1'
const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
const server = await boot()
const port = (server && server.port) || Number(PORT)
const { locateWorld } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'WorldLocator.js')).href)
const located = await locateWorld({ project: ROOT, sdkRoot: resolve(ROOT, 'src', '..'), name: process.env.WORLD || null })
const worldDefModule = located.path ? ((await import(pathToFileURL(located.path).href + '?t=' + Date.now())).default || {}) : {}
console.log('[shadow-sample] server http://localhost:' + port + ' world=' + process.env.WORLD
  + ' locatedPath=' + (located.path || 'none')
  + ' spawnPoint=' + JSON.stringify(worldDefModule.spawnPoint ?? null)
  + ' scene=' + JSON.stringify(worldDefModule.scene ?? null))

const LAUNCH_ARGS = [...gpuArgs({ accelerated: true }), ...vendorPinArgs(GPU)]
const browser = await chromium.launch({
  root: ROOT, owner: 'shadow-sample-r270-74', args: LAUNCH_ARGS,
  // The accelerated browser is shared with every other GPU lane on this host: a run that gives up
  // before the lease frees has taken no measurement at all (measured: 336 s behind one other lane).
  leaseWaitMs: 900000, leaseTtlMs: 20 * 60 * 1000,
})

// ---------------------------------------------------------------- in-page helpers

const FREEZE = (opts) => {
  const d = window.debug || {}
  const out = { todPaused: null, fraction: null, animatorsFrozen: 0, vrmsFrozen: 0 }
  try {
    const api = window.__timeOfDayApi
    if (api) {
      if (Number.isFinite(opts.tod) && typeof api.setFraction === 'function') api.setFraction(opts.tod)
      if (typeof api.setPaused === 'function') { api.setPaused(true); out.todPaused = !!api.isPaused() }
      out.fraction = typeof api.getFraction === 'function' ? api.getFraction() : null
      if (typeof api.setDayLengthSec === 'function') api.setDayLengthSec(1e9)
      if (Number.isFinite(opts.tod) && typeof api.setFraction === 'function') {
        if (window.__ssTodPin) clearInterval(window.__ssTodPin)
        window.__ssTodPin = setInterval(() => { try { api.setFraction(opts.tod) } catch (_) {} }, 400)
        out.todPinned = true
      }
    }
  } catch (_) {}
  try {
    if (window.__app && window.__app.cam && typeof window.__app.cam.restore === 'function') {
      const [yaw, pitch, zoomIndex] = String(opts.cam).split(',').map(Number)
      const c = window.__app.cam
      c.restore({ yaw, pitch, zoomIndex })
      const read = (o, names) => {
        for (const n of names) {
          try {
            if (o && typeof o[n] === 'function') { const v = o[n](); if (Number.isFinite(v)) return v }
            else if (o && typeof o[n] === 'number' && Number.isFinite(o[n])) return o[n]
          } catch (_) {}
        }
        return null
      }
      out.camYawRead = read(c, ['getYaw', 'getVRYaw', 'yaw'])
      out.camVerified = Number.isFinite(out.camYawRead) && Math.abs(out.camYawRead - yaw) < 0.02
    }
  } catch (_) {}
  try {
    if (d.playerAnimators && d.playerAnimators.forEach) {
      d.playerAnimators.forEach((anim) => { anim.update = () => {}; anim.applyBoneOverrides = () => {}; out.animatorsFrozen++ })
    }
    if (d.playerVrms && d.playerVrms.forEach) {
      d.playerVrms.forEach((vrm) => { if (vrm) { vrm.update = () => {}; out.vrmsFrozen++ } })
    }
  } catch (_) {}
  return out
}

const RESOLVE = () => {
  const d = window.debug || {}
  const app = window.__app || {}
  const renderer = d.renderer || window.__renderer || (app.engine && app.engine.renderer) || app.renderer || null
  const lights = (window.__shadowPipeline && window.__shadowPipeline.lights) || []
  const roots = []
  if (d.playerMeshes && d.playerMeshes.forEach) d.playerMeshes.forEach((r, id) => roots.push({ root: r, id: String(id) }))
  const localId = (app.client && app.client.playerId != null) ? String(app.client.playerId)
    : (d.client && d.client.playerId != null ? String(d.client.playerId) : null)
  return {
    hasRenderer: !!renderer, hasScene: !!d.scene, hasCamera: !!d.camera,
    rendererType: renderer && renderer.constructor ? renderer.constructor.name : null,
    shadowMapEnabled: renderer ? renderer.shadowMap && renderer.shadowMap.enabled : null,
    shadowMapType: renderer ? renderer.shadowMap && renderer.shadowMap.type : null,
    highPrecision: renderer ? renderer.highPrecision : null,
    reversedDepthBuffer: renderer ? !!renderer.reversedDepthBuffer : null,
    toneMapping: renderer ? renderer.toneMapping : null,
    outputColorSpace: renderer ? renderer.outputColorSpace : null,
    lightCount: lights.length,
    lightNames: lights.map((l) => (l && l.name) || '?'),
    lightIntensities: lights.map((l) => (l ? l.intensity : null)),
    playerRootCount: roots.length, localId,
    localRootName: roots[0] && roots[0].root ? (roots[0].root.name || '(unnamed)') : null,
  }
}

// CPU-side: which map, at what coordinate. sun.shadow.matrix already maps world -> [0,1] uv + z,
// so the uv printed here is literally the texel the sample reads at that world point.
const COORDS = () => {
  const d = window.debug || {}
  const app = window.__app || {}
  const lights = (window.__shadowPipeline && window.__shadowPipeline.lights) || []
  const roots = []
  if (d.playerMeshes && d.playerMeshes.forEach) d.playerMeshes.forEach((r) => roots.push(r))
  const localId = (app.client && app.client.playerId != null) ? String(app.client.playerId)
    : (d.client && d.client.playerId != null ? String(d.client.playerId) : null)
  const V = (d.camera && d.camera.position) ? Object.getPrototypeOf(d.camera.position).constructor : null
  let feet = null, head = null, aabb = null
  const root = roots[0] || null
  if (root && V) {
    root.updateMatrixWorld(true)
    const p = new V().setFromMatrixPosition(root.matrixWorld)
    feet = [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)]
    head = [+p.x.toFixed(3), +(p.y + 1.7).toFixed(3), +p.z.toFixed(3)]
    aabb = []
    for (const dx of [-0.3, 0.3]) for (const dy of [0, 1.7]) for (const dz of [-0.3, 0.3]) aabb.push([+(p.x + dx).toFixed(3), +(p.y + dy).toFixed(3), +(p.z + dz).toFixed(3)])
  }
  const project = (m, p) => {
    const e = m.elements
    const x = e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12]
    const y = e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13]
    const z = e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14]
    const w = e[3] * p[0] + e[7] * p[1] + e[11] * p[2] + e[15]
    return w === 0 ? null : [+(x / w).toFixed(4), +(y / w).toFixed(4), +(z / w).toFixed(4)]
  }
  const rows = []
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i]
    if (!l || !l.shadow) continue
    const s = l.shadow
    l.updateMatrixWorld(true)
    if (l.target) l.target.updateMatrixWorld(true)
    s.camera.updateMatrixWorld(true)
    s.camera.updateProjectionMatrix()
    const row = {
      index: i, name: l.name || 'sun', intensity: l.intensity, castShadow: !!l.castShadow,
      mapSize: s.mapSize ? [s.mapSize.x, s.mapSize.y] : null,
      bias: s.bias, normalBias: s.normalBias, radius: s.radius, autoUpdate: !!s.autoUpdate,
      ortho: [s.camera.left, s.camera.right, s.camera.top, s.camera.bottom].map((v) => +v.toFixed(2)),
      near: +s.camera.near.toFixed(2), far: +s.camera.far.toFixed(2),
      hasCustomShadowNode: !!s.shadowNode,
      camWorld: [+s.camera.matrixWorld.elements[12].toFixed(2), +s.camera.matrixWorld.elements[13].toFixed(2), +s.camera.matrixWorld.elements[14].toFixed(2)],
      targetWorld: l.target ? [+l.target.matrixWorld.elements[12].toFixed(2), +l.target.matrixWorld.elements[13].toFixed(2), +l.target.matrixWorld.elements[14].toFixed(2)] : null,
      // Metres per texel: the avatar's 0.6 m width under this span is how many texels wide his
      // shadow is, against a PCF kernel whose Vogel taps sit up to `radius` texels away.
      texelM: s.mapSize ? +((2 * s.camera.right) / s.mapSize.x).toFixed(4) : null,
      radiusM: s.mapSize ? +(s.radius * (2 * s.camera.right) / s.mapSize.x).toFixed(3) : null,
    }
    if (row.camWorld && row.targetWorld) {
      const dx = row.camWorld[0] - row.targetWorld[0]
      const dy = row.camWorld[1] - row.targetWorld[1]
      const dz = row.camWorld[2] - row.targetWorld[2]
      const horiz = Math.hypot(dx, dz)
      row.sunElevDeg = +(Math.atan2(dy, horiz) * 180 / Math.PI).toFixed(2)
      row.offsetLen = +Math.hypot(dx, dy, dz).toFixed(2)
    }
    if (feet) {
      row.feetUv = project(s.matrix, feet)
      row.headUv = project(s.matrix, head)
      row.feetInside = row.feetUv ? (row.feetUv[0] >= 0 && row.feetUv[0] <= 1 && row.feetUv[1] >= 0 && row.feetUv[1] <= 1 && row.feetUv[2] >= 0 && row.feetUv[2] <= 1) : null
      row.aabbUv = aabb.map((p) => project(s.matrix, p))
      const us = row.aabbUv.filter(Boolean).map((u) => u[0])
      const vs = row.aabbUv.filter(Boolean).map((u) => u[1])
      row.aabbUvSpan = (us.length && vs.length)
        ? [+(Math.max(...us) - Math.min(...us)).toFixed(5), +(Math.max(...vs) - Math.min(...vs)).toFixed(5)]
        : null
      if (row.aabbUvSpan && s.mapSize) row.avatarTexelsWide = +((Math.max(...us) - Math.min(...us)) * s.mapSize.x).toFixed(2)
    }
    rows.push(row)
  }
  return { feet, head, cascades: rows, localId }
}

// The probe. Two flat quads laid on the ground around the player's feet: A samples a freshly built
// ShadowNode, B samples the cascade fold the pipeline installed on the sun. A pixel of either quad
// is the shadow value the engine returns at that ground point, because `positionWorld` of the quad
// IS that ground point and three's shadow node samples at `positionWorld` by default.
const INSTALL_PROBE = async ({ extent }) => {
  const THREE = await import('three/webgpu')
  const TSL = await import('three/tsl')
  const d = window.debug || {}
  if (!d.scene) throw new Error('no window.debug.scene')
  const lights = (window.__shadowPipeline && window.__shadowPipeline.lights) || []
  const sun = lights.find((l) => l && l.isDirectionalLight && l.castShadow) || lights[0] || null
  if (!sun) throw new Error('no shadow-casting directional light in window.__shadowPipeline.lights')

  const geo = new THREE.PlaneGeometry(extent, extent, 1, 1)
  geo.rotateX(-Math.PI / 2)
  const mk = (node, name) => {
    const m = new THREE.MeshBasicNodeMaterial()
    m.name = name
    m.toneMapped = false
    m.fog = false
    m.side = THREE.DoubleSide
    m.depthTest = false
    m.depthWrite = false
    m.colorNode = TSL.vec3(node)
    return m
  }
  const fold = sun.shadow.shadowNode || null
  const qa = new THREE.Mesh(geo, mk(TSL.shadow(sun), 'ss-probe-a'))
  let qb = null
  if (fold) { try { qb = new THREE.Mesh(geo, mk(TSL.nodeObject(fold), 'ss-probe-b')) } catch (e) { qb = null } }
  const quads = []
  for (const q of [qa, qb]) {
    if (!q) continue
    q.castShadow = false
    q.receiveShadow = false
    q.frustumCulled = false
    q.renderOrder = 9999
    q.matrixAutoUpdate = false
    q.visible = false
    d.scene.add(q)
    quads.push(q)
  }
  window.__ss = {
    installed: true, extent, quadCount: quads.length,
    sunName: sun.name || 'sun', hasFold: !!fold,
    place(cx, y, cz) { for (const q of quads) { q.position.set(cx, y, cz); q.updateMatrix(); q.updateMatrixWorld(true) } },
    show(which) { qa.visible = which === 'A'; if (qb) qb.visible = which === 'B' },
    hide() { for (const q of quads) q.visible = false },
    corners() {
      const h = extent / 2, c = []
      for (const dx of [-h, h]) for (const dz of [-h, h]) c.push([+(qa.position.x + dx).toFixed(3), +qa.position.y.toFixed(3), +(qa.position.z + dz).toFixed(3)])
      return c
    },
    centre() { return [+qa.position.x.toFixed(3), +qa.position.y.toFixed(3), +qa.position.z.toFixed(3)] },
    dispose() { for (const q of quads) { d.scene.remove(q); try { q.material.dispose() } catch (_) {} } try { geo.dispose() } catch (_) {} },
  }
  return { installed: true, extent, quadCount: quads.length, sunName: sun.name || 'sun', hasFold: !!fold, foldUsed: !!qb }
}

// three calls `object.onBeforeShadow` on every object it actually DRAWS into a shadow map
// (ShadowNode.js, inside the render-object function that already tested object.castShadow), so a tap
// here counts inclusion instead of inferring it from a submission count. The cascade is identified by
// comparing the shadow camera handed to the callback against __shadowPipeline's cascade cameras, and
// an object is the player's when it sits under one of window.debug.playerMeshes' roots.
const INSTALL_TAP = async () => {
  const THREE = await import('three/webgpu')
  const d = window.debug || {}
  const roots = []
  if (d.playerMeshes && d.playerMeshes.forEach) d.playerMeshes.forEach((r) => roots.push(r))
  const isPlayer = (o) => { let n = o; while (n) { for (const r of roots) if (n === r) return true; n = n.parent } return false }
  const lights = (window.__shadowPipeline && window.__shadowPipeline.lights) || []
  const P = THREE.Object3D.prototype
  const orig = P.onBeforeShadow
  const mk = () => ({ total: 0, perCascade: {}, player: 0, playerNames: {}, terrain: 0, other: 0, otherTop: {} })
  const tap = mk()
  window.__ssTap = tap
  P.onBeforeShadow = function (renderer, object, camera, shadowCamera, geometry, depthMaterial, group) {
    try {
      tap.total++
      let idx = -1
      for (let i = 0; i < lights.length; i++) if (lights[i] && lights[i].shadow && lights[i].shadow.camera === shadowCamera) { idx = i; break }
      tap.perCascade[idx] = (tap.perCascade[idx] || 0) + 1
      if (isPlayer(object)) { tap.player++; const n = object.name || '(unnamed)'; tap.playerNames[n] = (tap.playerNames[n] || 0) + 1 }
      else if (object.name === 'mapspinner-terrain-tsl') tap.terrain++
      else { tap.other++; const n = object.name || object.type; tap.otherTop[n] = (tap.otherTop[n] || 0) + 1 }
    } catch (_) {}
    if (orig) return orig.call(this, renderer, object, camera, shadowCamera, geometry, depthMaterial, group)
  }
  window.__ssTapReset = () => { const t = mk(); window.__ssTap.total = t.total; window.__ssTap.perCascade = t.perCascade; window.__ssTap.player = t.player; window.__ssTap.playerNames = t.playerNames; window.__ssTap.terrain = t.terrain; window.__ssTap.other = t.other; window.__ssTap.otherTop = t.otherTop; return true }
  window.__ssTapRead = () => { const t = window.__ssTap; return { total: t.total, perCascade: { ...t.perCascade }, player: t.player, playerNames: { ...t.playerNames }, terrain: t.terrain, other: t.other, otherTop: { ...t.otherTop } } }
  return { installed: true, hadOriginal: !!orig, playerRoots: roots.length, cascadeCameras: lights.length }
}

// Arms. 'world-off' parks every caster that is not the player, so the ground at his feet is in sun
// and a second caster has something it could change. 'hide-player' removes the player root.
const APPLY = (mode) => {
  const d = window.debug || {}
  const out = { mode, touched: 0, playerHidden: false }
  const roots = []
  if (d.playerMeshes && d.playerMeshes.forEach) d.playerMeshes.forEach((r) => roots.push(r))
  const isPlayer = (o) => roots.some((r) => { let n = o; while (n) { if (n === r) return true; n = n.parent } return false })
  if (mode === 'hide-player') { for (const r of roots) { r.visible = false } out.playerHidden = true; return out }
  if (mode === 'show-player') { for (const r of roots) { r.visible = true } return out }
  if (mode === 'world-off' || mode === 'world-on') {
    const off = mode === 'world-off'
    if (!window.__ssWorldCasters) {
      window.__ssWorldCasters = []
      try {
        d.scene.traverse((o) => {
          if (!(o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh)) return
          if (isPlayer(o)) return
          if (o.name === 'mapspinner-terrain-tsl') return
          if (o.name && String(o.name).startsWith('ss-probe')) return
          window.__ssWorldCasters.push(o)
        })
      } catch (_) {}
    }
    for (const o of window.__ssWorldCasters) {
      if (off) { if (o.castShadow) { o.userData.__ssWas = true; o.castShadow = false; out.touched++ } }
      else if (o.userData && o.userData.__ssWas) { o.castShadow = true; delete o.userData.__ssWas; out.touched++ }
    }
    out.worldCasters = window.__ssWorldCasters.length
  }
  // Force every cascade to redraw: the counters are NOT a redraw witness on WebGPU (they never
  // bumped even for a change that demonstrably moved the frame), so force it and never read it.
  const lights = (window.__shadowPipeline && window.__shadowPipeline.lights) || []
  for (const l of lights) { if (l && l.shadow) { l.shadow.needsUpdate = true; l.shadow.autoUpdate = true } }
  if (d.renderer && d.renderer.shadowMap) d.renderer.shadowMap.needsUpdate = true
  return out
}

const CAM_MATS = () => {
  const d = window.debug || {}
  const c = d.camera
  if (!c) return null
  c.updateMatrixWorld(true)
  // World position from matrixWorld, never from .position: a camera parented to a rig has a
  // .position that is not its world position, and every ray below is cast in world space.
  return {
    pos: [+c.matrixWorld.elements[12].toFixed(4), +c.matrixWorld.elements[13].toFixed(4), +c.matrixWorld.elements[14].toFixed(4)],
    mw: Array.from(c.matrixWorld.elements),
    mwi: Array.from(c.matrixWorldInverse.elements),
    pmi: Array.from(c.projectionMatrixInverse.elements),
    pm: Array.from(c.projectionMatrix.elements),
  }
}

// ---------------------------------------------------------------- node-side geometry

const mul4 = (m, v) => { // three Matrix4.elements is column-major
  const o = [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) o[i] = m[i] * v[0] + m[4 + i] * v[1] + m[8 + i] * v[2] + m[12 + i] * v[3]
  return o
}
const projectPx = (cam, p, w, h) => {
  const v = mul4(cam.mwi, [p[0], p[1], p[2], 1])
  const c = mul4(cam.pm, [v[0], v[1], v[2], 1])
  if (c[3] <= 0) return null
  return [(c[0] / c[3] * 0.5 + 0.5) * w, (1 - (c[1] / c[3] * 0.5 + 0.5)) * h]
}
const inPoly = (poly, x, y) => {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}
// Screen pixel -> the ground point the probe quad's fragment at that pixel actually sampled.
const pixelToGround = (cam, x, y, w, h, planeY) => {
  const ndcx = (x + 0.5) / w * 2 - 1
  const ndcy = 1 - (y + 0.5) / h * 2
  const e = mul4(cam.pmi, [ndcx, ndcy, 1, 1])
  const view = [e[0] / e[3], e[1] / e[3], e[2] / e[3]]
  const wp = mul4(cam.mw, [view[0], view[1], view[2], 1])
  const d = [wp[0] - cam.pos[0], wp[1] - cam.pos[1], wp[2] - cam.pos[2]]
  if (Math.abs(d[1]) < 1e-9) return null
  const t = (planeY - cam.pos[1]) / d[1]
  if (!(t > 0)) return null
  return [cam.pos[0] + d[0] * t, planeY, cam.pos[2] + d[2] * t]
}
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

// Reads the probe out of a screenshot. A pixel is a probe sample when the ray through it meets the
// ground plane inside the quad's world rectangle: the quad draws with depthTest off, so it wins
// every pixel whose ground point lies in that rectangle. Membership is decided in WORLD space, not
// by projecting the quad's corners -- a TPS camera sits inside the quad's footprint, so some corner
// is always behind the near plane and a screen-space polygon of the corners is degenerate.
function readProbe(im, cam, centre, extent, planeY, corners) {
  const w = im.w, h = im.h, half = extent / 2
  const vals = [], pts = []
  let neutral = 0, groundHits = 0, groundInRect = 0, nearestM = null
  for (let i = 0; i < w * h; i++) {
    const r = im.rgb[i * 3], g = im.rgb[i * 3 + 1], b = im.rgb[i * 3 + 2]
    if (Math.max(r, g, b) - Math.min(r, g, b) <= 6) neutral++
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gp = pixelToGround(cam, x, y, w, h, planeY)
      if (!gp) continue
      groundHits++
      const dx = Math.abs(gp[0] - centre[0]), dz = Math.abs(gp[2] - centre[2])
      const far = Math.max(dx, dz)
      if (nearestM === null || far < nearestM) nearestM = far
      if (dx > half || dz > half) continue
      groundInRect++
      const i = y * w + x
      vals.push(srgbToLinear(im.rgb[i * 3] / 255))
      pts.push([x, y])
    }
  }
  // Second membership test: the quad's own outline projected to screen. The camera stands OUTSIDE a
  // small quad, so all four corners are in front of it and the polygon is not degenerate. It needs
  // neither the ground plane nor a camera-relative ray, so a readout that came back empty cannot be
  // blamed on either without this count saying so too.
  let polyPixels = 0, method = vals.length ? 'ground' : 'none'
  const poly = corners ? corners.map((c) => projectPx(cam, c, w, h)).filter(Boolean) : null
  if (poly && poly.length === 4 && !vals.length) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!inPoly(poly, x + 0.5, y + 0.5)) continue
        polyPixels++
        const i = y * w + x
        vals.push(srgbToLinear(im.rgb[i * 3] / 255))
        pts.push([x, y])
      }
    }
    if (polyPixels) method = 'poly'
  }
  return {
    vals, pts, neutralFrac: +(neutral / (w * h)).toFixed(4),
    groundHits, groundInRect, polyPixels, method,
    nearestM: nearestM === null ? null : +nearestM.toFixed(2),
  }
}

const stats = (arr) => {
  if (!arr || !arr.length) return null
  let sum = 0, min = 1e9, max = -1e9, dark = 0, lit = 0
  for (const v of arr) { sum += v; if (v < min) min = v; if (v > max) max = v; if (v < 0.5) dark++; if (v > 0.95) lit++ }
  const s = [...arr].sort((a, b) => a - b)
  return { n: arr.length, mean: +(sum / arr.length).toFixed(4), median: +s[s.length >> 1].toFixed(4), min: +min.toFixed(4), max: +max.toFixed(4), darkFrac: +(dark / arr.length).toFixed(4), litFrac: +(lit / arr.length).toFixed(4) }
}
const diffPng = (a, b, threshold = 8) => {
  const n = Math.min(a.w * a.h, b.w * b.h)
  let count = 0, sum = 0
  for (let i = 0; i < n; i++) {
    let dmax = 0
    for (let c = 0; c < 3; c++) { const dv = Math.abs(a.rgb[i * 3 + c] - b.rgb[i * 3 + c]); if (dv > dmax) dmax = dv }
    if (dmax < threshold) continue
    count++; sum += dmax
  }
  return { pixels: count, frac: +(count / n).toFixed(5), meanDelta: count ? +(sum / count).toFixed(2) : null }
}
// The feet rect: the same window the earlier lane read, so this run's pixel numbers can be compared
// with theirs instead of only with each other. 220x150 px centred on the player's projected feet.
const FEET_RECT = [220, 150]
function diffRect(a, b, rect, threshold = 8) {
  const [x0, y0, w, h] = rect
  let count = 0, sum = 0
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= a.w || y >= a.h) continue
      const i = y * a.w + x
      let dmax = 0
      for (let c = 0; c < 3; c++) { const dv = Math.abs(a.rgb[i * 3 + c] - b.rgb[i * 3 + c]); if (dv > dmax) dmax = dv }
      if (dmax < threshold) continue
      count++; sum += dmax
    }
  }
  return { pixels: count, of: w * h, frac: +(count / (w * h)).toFixed(4), meanDelta: count ? +(sum / count).toFixed(2) : null }
}
// Two probe readings over the same pixel set: the player's signature in the SAMPLE.
function diffProbe(a, b) {
  if (!a || !b || !a.vals.length || a.vals.length !== b.vals.length) return null
  const d = []
  let count = 0, sum = 0, cx = 0, cy = 0, strongest = 1, sx = 0, sy = 0
  for (let i = 0; i < a.vals.length; i++) {
    const dv = a.vals[i] - b.vals[i]
    d.push(dv)
    if (Math.abs(dv) >= 0.02) { count++; sum += Math.abs(dv); cx += a.pts[i][0]; cy += a.pts[i][1] }
    if (dv < strongest) { strongest = dv; sx = a.pts[i][0]; sy = a.pts[i][1] }
  }
  return {
    n: a.vals.length, changed: count, changedFrac: +(count / a.vals.length).toFixed(4),
    meanDelta: count ? +(sum / count).toFixed(4) : null,
    centroidPx: count ? [Math.round(cx / count), Math.round(cy / count)] : null,
    mostDarkenedPx: strongest < -0.02 ? [sx, sy] : null,
    mostDarkenedBy: strongest < -0.02 ? +(-strongest).toFixed(4) : null,
  }
}

let exitCode = 1
const report = { world: process.env.WORLD, tod: TOD_FRACTION, cam: CAM_POSE, extent: EXTENT_M, arms: {}, coords: null, resolve: null, probe: null }
try {
  const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || (e && e.message) || e)))
  const url = 'http://localhost:' + port + '/?v=' + Date.now() + '&veg=none&nograss&norocks'
  console.log('[shadow-sample] ' + url)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })
  const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: GPU })
  console.log('[shadow-sample] gpu ' + JSON.stringify({ rasterizer: gpu.rasterizer, renderer: gpu.renderer, vendor: gpu.adapter }))

  const t0 = Date.now()
  let ready = false, lastR = null
  while (Date.now() - t0 < 180000) {
    const r = await page.evaluate(() => ({
      revealedAt: (window.__app && window.__app.revealedAt) || 0,
      players: window.debug && window.debug.playerMeshes ? window.debug.playerMeshes.size : 0,
      hasVrm: !!(window.debug && window.debug.playerMeshes && [...window.debug.playerMeshes.values()].some((m) => m && m.children && m.children.length > 0)),
    })).catch(() => null)
    lastR = r
    if (r && r.revealedAt && r.players > 0 && r.hasVrm) { ready = true; break }
    await wait(500)
  }
  if (!ready) throw new Error('page never became ready: last=' + JSON.stringify(lastR) + ' after ' + (Date.now() - t0) + 'ms')
  console.log('[shadow-sample] ready in ' + (Date.now() - t0) + 'ms')
  await wait(SETTLE_MS)

  report.resolve = await page.evaluate(RESOLVE)
  console.log('[shadow-sample] resolve ' + JSON.stringify(report.resolve))

  const frozen = await page.evaluate(FREEZE, { tod: TOD_FRACTION, cam: CAM_POSE })
  report.frozen = frozen
  console.log('[shadow-sample] frozen ' + JSON.stringify(frozen))
  await wait(2000)

  // Quiet window, ADVISORY: the probe is read offscreen-equivalent (a quad in the live scene) and
  // recentres on the player inside each arm, so it does not need a still frame. The frame diffs are
  // reported with the measured noise beside them and are not claimed as a result when it is not quiet.
  {
    const tq = Date.now()
    let prev = null, quiet = 0, i = 0, settled = false, lastNoise = null
    while (Date.now() - tq < 45000) {
      const shot = await page.screenshot(i < 4 ? { path: resolve(OUT, 'shot-quiet' + i + '.png') } : {})
      const im = decodePng(shot.toString('base64'))
      i++
      if (prev) {
        const s = diffPng(prev, im, 8)
        lastNoise = s
        if (s.frac < 0.03 && s.meanDelta !== null && s.meanDelta < 3.0) { if (++quiet >= 3) { settled = true; break } } else quiet = 0
      }
      prev = im
      await wait(900)
    }
    report.quiet = { settled, captures: i, ms: Date.now() - tq, lastNoise }
    console.log('[shadow-sample] quiet ' + JSON.stringify(report.quiet))
    if (!settled) console.log('[shadow-sample] frame NOT quiet: frame pixel diffs are advisory only')
  }

  report.probe = await page.evaluate(INSTALL_PROBE, { extent: EXTENT_M })
  console.log('[shadow-sample] probe ' + JSON.stringify(report.probe))
  if (!report.probe || !report.probe.installed) throw new Error('probe did not install')

  report.tap = await page.evaluate(INSTALL_TAP)
  console.log('[shadow-sample] tap ' + JSON.stringify(report.tap))
  if (!report.tap || !report.tap.installed) throw new Error('shadow-pass tap did not install')

  const coords = await page.evaluate(COORDS)
  report.coords = coords
  console.log('[shadow-sample] feet=' + JSON.stringify(coords.feet) + ' head=' + JSON.stringify(coords.head))
  for (const c of coords.cascades) {
    console.log('[shadow-sample] cascade#' + c.index + ' ' + JSON.stringify({
      name: c.name, intensity: +Number(c.intensity).toFixed(3), mapSize: c.mapSize, ortho: c.ortho,
      near: c.near, far: c.far, camWorld: c.camWorld, targetWorld: c.targetWorld,
      sunElevDeg: c.sunElevDeg, texelM: c.texelM, radiusM: c.radiusM,
      bias: c.bias, normalBias: c.normalBias, radius: c.radius,
      feetUv: c.feetUv, feetInside: c.feetInside, headUv: c.headUv,
      aabbUvSpan: c.aabbUvSpan, avatarTexelsWide: c.avatarTexelsWide,
    }))
  }
  if (!coords.feet) throw new Error('no feet point: the local player root was not resolvable')

  const playerPos = () => page.evaluate(() => {
    const d = window.debug || {}
    let root = null
    if (d.playerMeshes && d.playerMeshes.forEach) d.playerMeshes.forEach((r) => { if (!root) root = r })
    if (!root) return null
    root.updateMatrixWorld(true)
    const V = Object.getPrototypeOf(root.position).constructor
    const p = new V().setFromMatrixPosition(root.matrixWorld)
    return [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)]
  })

  const ARMS = [
    ['base', ['show-player', 'world-on']],
    ['noplayer', ['hide-player']],
    ['sunlit-no', ['world-off']],
    ['sunlit-pl', ['show-player']],
    ['restore', ['world-on']],
  ]
  for (const [name, modes] of ARMS) {
    const applied = []
    for (const m of modes) applied.push(await page.evaluate(APPLY, m))
    await page.evaluate(() => window.__ssTapReset && window.__ssTapReset())
    await wait(FRAME_MS * 3)
    const p = await playerPos()
    const cam = await page.evaluate(CAM_MATS)
    const planeY = p[1] + 0.02
    await page.evaluate(([x, y, z]) => window.__ss.place(x, y, z), [p[0], planeY, p[2]])
    const corners = await page.evaluate(() => window.__ss.corners())
    const out = { player: p, planeY: +planeY.toFixed(3), applied, probe: {}, cam, corners }
    const fp = projectPx(cam, p, 1280, 720)
    out.feetPx = fp ? [Math.round(fp[0]), Math.round(fp[1])] : null
    out.feetRect = fp ? [Math.max(0, Math.round(fp[0]) - (FEET_RECT[0] >> 1)), Math.max(0, Math.round(fp[1]) - (FEET_RECT[1] >> 1)), FEET_RECT[0], FEET_RECT[1]] : null
    for (const which of ['A', 'B']) {
      await page.evaluate((w) => window.__ss.show(w), which)
      await wait(FRAME_MS)
      const shot = await page.screenshot({ path: resolve(OUT, 'probe-' + name + '-' + which + '.png') })
      const im = decodePng(shot.toString('base64'))
      const rd = readProbe(im, cam, p, EXTENT_M, planeY, corners)
      out.probe[which] = rd && rd.vals.length ? stats(rd.vals) : null
      out.probe[which + 'Pixels'] = rd ? rd.vals.length : 0
      out.probe[which + 'NeutralFrac'] = rd ? rd.neutralFrac : null
      out.probe[which + 'Method'] = rd ? rd.method : null
      out.probe[which + 'GroundHits'] = rd ? rd.groundHits : null
      out.probe[which + 'GroundInRect'] = rd ? rd.groundInRect : null
      out.probe[which + 'PolyPixels'] = rd ? rd.polyPixels : null
      out.probe[which + 'NearestM'] = rd ? rd.nearestM : null
      if (rd && rd.vals.length) {
        fs.writeFileSync(resolve(OUT, 'probe-' + name + '-' + which + '.json'), JSON.stringify({ box: rd.box, poly: rd.poly, vals: rd.vals, pts: rd.pts }))
        // Where the sample is darkest, in world metres relative to the player's feet.
        let bi = 0
        for (let i = 0; i < rd.vals.length; i++) if (rd.vals[i] < rd.vals[bi]) bi = i
        const g = pixelToGround(cam, rd.pts[bi][0], rd.pts[bi][1], im.w, im.h, planeY)
        out.probe[which].darkestVal = +rd.vals[bi].toFixed(4)
        out.probe[which].darkestRelM = g ? [+(g[0] - p[0]).toFixed(2), +(g[2] - p[2]).toFixed(2)] : null
        let li = 0
        for (let i = 0; i < rd.vals.length; i++) if (rd.vals[i] > rd.vals[li]) li = i
        const gl = pixelToGround(cam, rd.pts[li][0], rd.pts[li][1], im.w, im.h, planeY)
        out.probe[which].lightestVal = +rd.vals[li].toFixed(4)
        out.probe[which].lightestRelM = gl ? [+(gl[0] - p[0]).toFixed(2), +(gl[2] - p[2]).toFixed(2)] : null
      }
      await page.evaluate(() => window.__ss.hide())
    }
    // A frame shot with the probe hidden, for the frame-level diff.
    await wait(FRAME_MS)
    const shot = await page.screenshot({ path: resolve(OUT, 'shot-' + name + '.png') })
    out.image = decodePng(shot.toString('base64'))
    out.tap = await page.evaluate(() => window.__ssTapRead && window.__ssTapRead())
    report.arms[name] = out
    console.log('[shadow-sample] arm ' + name + ' player=' + JSON.stringify(p)
      + ' A=' + JSON.stringify(out.probe.A) + ' B=' + JSON.stringify(out.probe.B)
      + ' tap=' + JSON.stringify(out.tap)
      + ' read=' + JSON.stringify({ A: out.probe.AMethod, B: out.probe.BMethod })
      + ' ground=' + JSON.stringify({ hits: out.probe.AGroundHits, inRect: out.probe.AGroundInRect, poly: out.probe.APolyPixels, nearestM: out.probe.ANearestM }))
  }

  const load = (name, which) => {
    try { return JSON.parse(fs.readFileSync(resolve(OUT, 'probe-' + name + '-' + which + '.json'), 'utf8')) } catch (_) { return null }
  }
  // 'noplayer' vs 'sunlit-no' is the pair that can only move by the WORLD casters: the player root is
  // hidden in both arms, so it is the control that says the sample responds to a caster that does
  // darken, measured beside the player's own two pairs.
  const pairs = [['base', 'noplayer'], ['sunlit-pl', 'sunlit-no'], ['noplayer', 'sunlit-no']]
  report.probeDiffs = {}
  for (const [a, b] of pairs) {
    const row = {}
    for (const which of ['A', 'B']) {
      const ga = load(a, which), gb = load(b, which)
      if (!ga || !gb) continue
      const d = diffProbe({ vals: ga.vals, pts: ga.pts }, { vals: gb.vals, pts: gb.pts })
      if (d && d.centroidPx) {
        const cam = report.arms[a] && report.arms[a].cam ? report.arms[a].cam : null
        d.centroidRelM = null
      }
      row[which] = d
    }
    report.probeDiffs[a + '-vs-' + b] = row
    console.log('[shadow-sample] probeDiff ' + a + '-vs-' + b + ' ' + JSON.stringify(row))
  }
  report.frameDiffs = {}
  for (const [a, b] of pairs) {
    const s = diffPng(report.arms[a].image, report.arms[b].image, 8)
    const rect = report.arms[a].feetRect || report.arms[b].feetRect
    const r = rect ? diffRect(report.arms[a].image, report.arms[b].image, rect, 8) : null
    report.frameDiffs[a + '-vs-' + b] = { frame: s, feetRect: r, rect }
    console.log('[shadow-sample] frameDiff ' + a + '-vs-' + b + ' frame=' + JSON.stringify(s) + ' feetRect=' + JSON.stringify(r))
  }

  report.errors = errors.slice(0, 10)
  exitCode = 0
} catch (e) {
  report.fatal = String((e && e.stack) || (e && e.message) || e)
  console.log('[shadow-sample] FATAL ' + report.fatal)
} finally {
  const lean = { ...report }
  for (const k of Object.keys(lean.arms || {})) if (lean.arms[k] && lean.arms[k].image) delete lean.arms[k].image
  fs.writeFileSync(resolve(OUT, 'shadow-sample-report.json'), JSON.stringify(lean, null, 2))
  console.log('[shadow-sample] report ' + resolve(OUT, 'shadow-sample-report.json'))
  try { await browser.close() } catch (_) {}
  try { if (server && server.stop) await server.stop() } catch (_) {}
  process.exit(exitCode)
}
