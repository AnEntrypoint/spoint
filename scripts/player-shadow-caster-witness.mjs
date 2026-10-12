#!/usr/bin/env node
// Caster-registration instrument for "sillos has a shadow on land but the player didn't appear to
// have one".
//
// Two things are measured in a real accelerated browser, on the repro fixture
// apps/world/_fixtures/sillos-isolated.js:
//   1. REGISTRATION -- enumerate the player's meshes (all of them, so every LOD tier the player has)
//      and print castShadow / receiveShadow / layers, with the land's receiveShadow as the control.
//   2. ON SCREEN -- freeze time of day (the sun drifts and moves every shadow in the frame) and the
//      camera pose, then flip ONLY the player mesh's castShadow bit and capture each arm twice:
//      A1,A2 (shipped, true) -> B1,B2 (false) -> C1 (true again). diff(A2,B2) is the player's shadow
//      contribution; the within-arm pairs diff(A1,A2), diff(B1,B2) and diff(A1,C1) are the frame's
//      own measured noise floor. A shadow that exists in a variable but not on screen is not fixed,
//      so the witness fails when the cross-arm signal does not clear the measured within-arm noise.
//
// GPU witness: it launches a real accelerated headful Chrome through the project's shared browser
// lease (scripts/lib/cdp-browser.mjs) and boots a real WebGPURenderer page. It therefore CANNOT live
// in the gpu-free arm of scripts/check.mjs and is NOT wired into it: it runs only when
// SPOINT_GPU_WITNESS=1, which no CI job sets. Reported verdicts from this witness are local runs.
//
// usage: SPOINT_GPU_WITNESS=1 node scripts/gpulock.mjs run <owner> -- \
//          node scripts/player-shadow-caster-witness.mjs [--gpu=amd] [--out=.gm/pool/player-shadow-r270-70]

import fs from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

if (process.env.SPOINT_GPU_WITNESS !== '1') {
  console.log('player-shadow-caster-witness SKIPPED: SPOINT_GPU_WITNESS!=1 (GPU witness; never in the gpu-free arm of scripts/check.mjs)')
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
const OUT = resolve(ROOT, String(flag('out', '.gm/pool/player-shadow-r270-70')))
const LABEL = String(flag('label', 'before'))
const WORLD = String(flag('world', 'sillos-isolated'))
const SETTLE_MS = Number(flag('settle', '10000'))
const FRAME_MS = Number(flag('frame-ms', '400'))
const TOD_FRACTION = Number(flag('tod', '0.35'))
const CAM_POSE = String(flag('cam', '0.9,0.28,3'))
const FRAMES_PER_ARM = Number(flag('frames', '2'))
const SPREAD_TOL = Number(flag('spread-tol', '4'))
const MIN_REAL_PIXELS = Number(flag('min-real-pixels', '400'))
const DIFF_THRESHOLD = Number(flag('threshold', '8'))
const NOISE_MARGIN = Number(flag('noise-margin', '3'))
const QS = String(flag('qs', 'veg=none&nograss&norocks'))
const PORT = String(flag('port', String(20000 + Math.floor(Math.random() * 20000))))

const { vendorPinArgs } = await import(pathToFileURL(resolve(HERE, 'lib', 'witness-gpu.mjs')).href)
const { gpuArgs, assertGpu } = await import(pathToFileURL(resolve(HERE, 'lib', 'gpu-probe.mjs')).href)
const { chromium } = await import(pathToFileURL(resolve(HERE, 'lib', 'cdp-browser.mjs')).href)
const { decodePng } = await import(pathToFileURL(resolve(HERE, 'tsl-parity', 'png.mjs')).href)

fs.mkdirSync(OUT, { recursive: true })

process.env.WORLD = process.env.WORLD || WORLD
process.env.PORT = PORT
process.env.SPOINT_NO_WATCH = '1'
const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
const server = await boot()
const port = (server && server.port) || Number(PORT)
console.log('[player-shadow] server on http://localhost:' + port + ' world=' + process.env.WORLD)

const LAUNCH_ARGS = [...gpuArgs({ accelerated: true }), ...vendorPinArgs(GPU)]
console.log('[player-shadow] gpu=' + GPU + ' adapterArgs=' + JSON.stringify(LAUNCH_ARGS.filter(a => a.includes('luid'))))

const browser = await chromium.launch({
  root: ROOT,
  owner: 'player-shadow-caster',
  args: LAUNCH_ARGS,
  leaseWaitMs: 240000,
  leaseTtlMs: 20 * 60 * 1000,
})

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

// Returns every drawable under every player root, plus the control rows (land receivers, sun).
const INSTRUMENT = () => {
  const d = window.debug || {}
  const app = window.__app || {}
  const desc = (o) => {
    if (!o) return null
    const g = o.geometry
    return {
      ctr: o.constructor ? o.constructor.name : null,
      name: o.name || '',
      visible: !!o.visible,
      castShadow: !!o.castShadow,
      receiveShadow: !!o.receiveShadow,
      renderOrder: o.renderOrder,
      layerMask: o.layers ? o.layers.mask : null,
      frustumCulled: !!o.frustumCulled,
      verts: g && g.attributes && g.attributes.position ? g.attributes.position.count : null,
      mat: o.material ? (Array.isArray(o.material) ? o.material.map((m) => m && m.type).join('+') : (o.material.type || null)) : null,
      shadowSide: o.material && !Array.isArray(o.material) ? (o.material.shadowSide == null ? null : o.material.shadowSide) : null,
      dyn: !!(o.userData && o.userData.isDynamicShadowCaster),
    }
  }
  const isDrawable = (o) => !!(o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh)
  const localId = (app.client && app.client.playerId != null) ? app.client.playerId : (d.client && d.client.playerId != null ? d.client.playerId : null)
  const players = []
  const pm = d.playerMeshes
  if (pm && pm.forEach) {
    pm.forEach((root, id) => {
      const meshes = []
      try { root.traverse((o) => { if (isDrawable(o)) meshes.push(desc(o)) }) } catch (e) { meshes.push({ error: String(e && e.message) }) }
      players.push({
        id: String(id),
        isLocal: String(id) === String(localId),
        root: desc(root),
        rootChildren: root.children ? root.children.length : null,
        worldPos: root.position ? [+root.position.x.toFixed(2), +root.position.y.toFixed(2), +root.position.z.toFixed(2)] : null,
        meshes,
      })
    })
  }
  let receivers = []
  try { d.scene.traverse((o) => { if (isDrawable(o) && o.receiveShadow) receivers.push(desc(o)) }) } catch (e) { receivers = [{ error: String(e && e.message) }] }
  const sunShadow = d.sun && d.sun.shadow ? { mapSize: [d.sun.shadow.mapSize.x, d.sun.shadow.mapSize.y], needsUpdate: !!d.sun.shadow.needsUpdate, autoUpdate: !!d.sun.shadow.autoUpdate } : null

  // Does the player actually land inside each cascade's shadow camera? A caster outside the shadow
  // frustum, or on a layer the shadow camera does not read, throws no shadow however castShadow reads.
  const casters = []
  const lights = (window.__shadowPipeline && window.__shadowPipeline.lights) || []
  const roots = []
  if (d.playerMeshes && d.playerMeshes.forEach) d.playerMeshes.forEach((r) => roots.push(r))
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i]
    if (!l || !l.shadow) continue
    const sc = l.shadow.camera
    const row = {
      index: i,
      name: l.name || 'sun',
      castShadow: !!l.castShadow,
      shadowCameraLayerMask: sc && sc.layers ? sc.layers.mask : null,
      allocated: !!(l.shadow.map || (l.shadow.mapPass && l.shadow.mapPass.renderTarget)),
      near: sc ? +sc.near.toFixed(2) : null,
      far: sc ? +sc.far.toFixed(2) : null,
      extent: sc ? [sc.left, sc.right, sc.top, sc.bottom].map((v) => +v.toFixed(2)) : null,
    }
    try {
      l.updateMatrixWorld(true)
      if (l.target) l.target.updateMatrixWorld(true)
      sc.updateMatrixWorld(true)
      sc.updateProjectionMatrix()
      row.lightPos = [+l.position.x.toFixed(2), +l.position.y.toFixed(2), +l.position.z.toFixed(2)]
      row.targetPos = l.target ? [+l.target.position.x.toFixed(2), +l.target.position.y.toFixed(2), +l.target.position.z.toFixed(2)] : null
    } catch (_) {}
    row.players = []
    for (const r of roots) {
      try {
        r.updateMatrixWorld(true)
        const V = Object.getPrototypeOf(sc.position).constructor
        const p = new V().setFromMatrixPosition(r.matrixWorld)
        const ndc = p.clone().project(sc)
        row.players.push({
          id: String(r.userData && r.userData.playerId != null ? r.userData.playerId : '?'),
          world: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
          shadowNdc: [+ndc.x.toFixed(3), +ndc.y.toFixed(3), +ndc.z.toFixed(3)],
          insideShadowFrustum: ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1 && ndc.z >= -1 && ndc.z <= 1,
          layerTest: !!(r.layers && sc.layers && (r.layers.mask & sc.layers.mask) !== 0),
        })
      } catch (_) {}
    }
    casters.push(row)
  }

  // What is actually under the player? If the surface under it is not a receiver, the player casts a
  // perfect shadow that no fragment ever samples.
  const underPlayer = []
  try {
    const r0 = roots[0]
    if (r0 && d.scene && d.camera) {
      r0.updateMatrixWorld(true)
      const V = Object.getPrototypeOf(d.camera.position).constructor
      const p = new V().setFromMatrixPosition(r0.matrixWorld)
      d.scene.traverse((o) => {
        if (underPlayer.length >= 24) return
        if (!isDrawable(o)) return
        o.updateMatrixWorld(true)
        const q = new V().setFromMatrixPosition(o.matrixWorld)
        const flat = Math.hypot(q.x - p.x, q.z - p.z)
        const drop = p.y - q.y
        if (flat <= 5 && drop >= -1 && drop <= 6) {
          const dsc = desc(o)
          dsc.flatDistM = +flat.toFixed(2)
          dsc.belowPlayerM = +drop.toFixed(2)
          underPlayer.push(dsc)
        }
      })
      underPlayer.sort((a, b) => a.belowPlayerM - b.belowPlayerM)
    }
  } catch (_) {}

  return {
    localId: String(localId),
    camMode: (d.cam && typeof d.cam.getMode === 'function') ? d.cam.getMode() : null,
    renderer: d.renderer ? { isWebGPURenderer: !!d.renderer.isWebGPURenderer, isWebGLRenderer: !!d.renderer.isWebGLRenderer } : null,
    shadowMapEnabled: d.renderer && d.renderer.shadowMap ? !!d.renderer.shadowMap.enabled : null,
    sunCastShadow: d.sun ? !!d.sun.castShadow : null,
    sunShadow,
    pipeline: (window.__shadowPipeline && window.__shadowPipeline.debug) ? window.__shadowPipeline.debug() : null,
    shadowCameras: casters,
    underPlayer,
    players,
    receiveShadowCount: receivers.length,
    receiveShadowSample: receivers.slice(0, 4),
    playerLod: (window.__playerLOD && window.__playerLOD.stats) ? window.__playerLOD.stats() : null,
    playerVatOff: window.__playerVatOff === true,
    revealedAt: app.revealedAt || null,
  }
}

// Which surfaces in this world are shadow RECEIVERS at all. A caster whose shadow has nowhere to land
// is invisible for a reason that has nothing to do with its castShadow flag, so the receiver list is
// part of the finding, not background.
const RECEIVERS = () => {
  const d = window.debug || {}
  const out = []
  try {
    d.scene.traverse((o) => {
      if (!(o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh)) return
      if (!o.receiveShadow) return
      let w = null
      try {
        o.updateWorldMatrix(true, false)
        w = [+o.matrixWorld.elements[12].toFixed(1), +o.matrixWorld.elements[13].toFixed(1), +o.matrixWorld.elements[14].toFixed(1)]
      } catch (_) {}
      out.push({
        n: o.name || '',
        c: o.isInstancedMesh ? 'InstancedMesh' : o.isBatchedMesh ? 'BatchedMesh' : o.isSkinnedMesh ? 'SkinnedMesh' : 'Mesh',
        v: o.geometry && o.geometry.attributes && o.geometry.attributes.position ? o.geometry.attributes.position.count : null,
        cast: !!o.castShadow,
        w,
      })
    })
  } catch (_) {}
  return out
}

// COUNTS the player's own submissions into the shadow map render, which no amount of reading can
// settle. three's shadow pass calls `object.onBeforeShadow` on exactly the objects it is about to
// draw into the shadow map (ShadowNode.js getShadowRenderObjectFunction, gated on castShadow===true)
// after the shadow camera's layer test and frustum test have already been applied. So a counter that
// stays at zero while castShadow reads true is the player failing to reach the shadow map at all --
// culled, on a layer the shadow camera does not read, or under an invisible parent -- and a counter
// that climbs is proof the player IS in the shadow map, which moves the defect to the receive side.
const HOOK_SHADOW = () => {
  const d = window.debug || {}
  const w = window
  if (!w.__psDraws) w.__psDraws = {}
  const isDrawable = (o) => !!(o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh)
  const hook = (o, tag) => {
    if (o.__psHooked === tag) return
    o.__psHooked = tag
    if (w.__psDraws[tag] === undefined) w.__psDraws[tag] = 0
    const mine = w.__psDraws
    o.onBeforeShadow = function () { mine[tag] = (mine[tag] || 0) + 1 }
  }
  const out = { hooked: [] }
  if (d.playerMeshes && d.playerMeshes.forEach) {
    d.playerMeshes.forEach((root, id) => {
      try {
        root.traverse((o) => {
          if (!isDrawable(o)) return
          const tag = 'player:' + String(id) + ':' + (o.name || o.type)
          hook(o, tag)
          out.hooked.push(tag)
        })
      } catch (_) {}
    })
  }
  // Controls: casters that are not the player. If these climb and the player's does not, the shadow
  // pass is rendering and the player specifically is missing from it.
  let n = 0
  try {
    const playerRoots = []
    if (d.playerMeshes && d.playerMeshes.forEach) d.playerMeshes.forEach((r) => playerRoots.push(r))
    d.scene.traverse((o) => {
      if (n >= 6) return
      if (!isDrawable(o) || !o.castShadow) return
      let p = o, isPlayer = false
      while (p) { if (playerRoots.indexOf(p) >= 0) { isPlayer = true; break } p = p.parent }
      if (isPlayer) return
      const tag = 'control:' + (o.name || o.type) + '#' + n
      hook(o, tag)
      if (!w.__psControls) w.__psControls = []
      w.__psControls.push(o)
      out.hooked.push(tag)
      n++
    })
  } catch (_) {}
  try { if (w.__psProbe) hook(w.__psProbe, 'probe') } catch (_) {}
  return out
}

// Reads the hook counters back together with proof that the shadow map itself re-rendered: the depth
// texture's `version` bumps on every updateShadow. Without that, a null pixel diff could equally mean
// "the player never reached the shadow map" or "the shadow map was never redrawn after the flip".
const SHADOW_LIVE = () => {
  const d = window.debug || {}
  const lights = (window.__shadowPipeline && window.__shadowPipeline.lights) || []
  const rows = []
  const scan = (obj, prefix, out, depth) => {
    if (!obj || typeof obj !== 'object' || depth > 3) return
    if (typeof obj.version === 'number') out[prefix] = obj.version
    for (const k of ['map', 'mapPass', 'renderTarget', 'depthTexture', 'texture']) {
      if (obj[k] && typeof obj[k] === 'object') scan(obj[k], prefix + '.' + k, out, depth + 1)
    }
  }
  const roots = []
  if (d.playerMeshes && d.playerMeshes.forEach) d.playerMeshes.forEach((r) => roots.push(r))
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i]
    if (!l || !l.shadow) continue
    const s = l.shadow
    const row = {
      index: i, name: l.name || 'sun', autoUpdate: !!s.autoUpdate, needsUpdate: !!s.needsUpdate,
      bias: s.bias, normalBias: s.normalBias, radius: s.radius, intensity: s.intensity,
      mapSize: s.mapSize ? [s.mapSize.x, s.mapSize.y] : null,
      versions: {},
    }
    try { scan(s, 'shadow', row.versions, 0) } catch (_) {}
    const sc = s.camera
    if (sc && roots.length) {
      try {
        l.updateMatrixWorld(true)
        if (l.target) l.target.updateMatrixWorld(true)
        sc.updateMatrixWorld(true)
        sc.updateProjectionMatrix()
        row.near = sc.near
        row.far = sc.far
        row.camWorld = [+sc.matrixWorld.elements[12].toFixed(2), +sc.matrixWorld.elements[13].toFixed(2), +sc.matrixWorld.elements[14].toFixed(2)]
        row.lightWorld = [+l.matrixWorld.elements[12].toFixed(2), +l.matrixWorld.elements[13].toFixed(2), +l.matrixWorld.elements[14].toFixed(2)]
        const V = Object.getPrototypeOf(sc.position).constructor
        row.players = []
        for (const r of roots) {
          r.updateMatrixWorld(true)
          const p = new V().setFromMatrixPosition(r.matrixWorld)
          const ndc = p.clone().project(sc)
          // Depth along the shadow camera's own view axis: a caster past `far` writes no depth at
          // all, and a bias scaled by (far - near) erases any shadow shallower than bias*(far-near).
          const view = p.clone().applyMatrix4(sc.matrixWorldInverse)
          row.players.push({
            world: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
            shadowNdc: [+ndc.x.toFixed(3), +ndc.y.toFixed(3), +ndc.z.toFixed(3)],
            viewDepthM: +(-view.z).toFixed(2),
            inside: ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1 && ndc.z >= -1 && ndc.z <= 1,
          })
        }
      } catch (_) {}
    }
    rows.push(row)
  }
  return { draws: window.__psDraws ? { ...window.__psDraws } : null, lights: rows }
}

// Apply one arm and force every cascade to re-render its shadow map.
//   cast-on     : ship state -- the player mesh keeps the castShadow it booted with
//   cast-off    : ONLY the player mesh's castShadow bit flips to false
//   hide-player : the player root is hidden (positive control: the player IS on screen in this view)
//   no-receive    : every receiver drops receiveShadow (positive control: shadows ARE on screen here)
//   all-receive   : EVERY drawable receives (separates "the player never reaches the shadow map"
//                   from "the surface under the player simply is not a receiver")
//   probe-on / probe-off: adds (or hides) a plain Mesh sharing the avatar's own geometry and material
//                   at the avatar's world transform. It differs from the avatar in exactly one way --
//                   it is not skinned -- so if it throws a shadow where the avatar throws none, the
//                   avatar's shadow is lost at the skinned-caster step, not in the shadow pipeline.
//   restore-receive: puts receiveShadow back on the meshes no-receive cleared
const APPLY = (mode) => {
  const d = window.debug || {}
  const out = { mode, touched: 0, receivers: 0, dirty: [] }
  const drawables = (root, fn) => {
    try { root.traverse((o) => { if (o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh) fn(o) }) } catch (_) {}
  }
  // The cube and the probe are shadow-only (layer 30), so the player standing at that spot is the
  // only thing that can still occlude the ground their shadow lands on. Hide it for those arms.
  const _hidePlayer = mode === 'hide-player' || mode === 'cube-on' || mode === 'cube-off' || mode === 'probe-on' || mode === 'probe-off'
  if (!_hidePlayer && d.playerMeshes && d.playerMeshes.forEach) {
    d.playerMeshes.forEach((root) => { root.visible = true })
  }
  if (_hidePlayer) {
    if (d.playerMeshes && d.playerMeshes.forEach) d.playerMeshes.forEach((root) => { root.visible = false; out.touched++ })
  } else if (mode === 'no-receive') {
    const cleared = []
    try { d.scene.traverse((o) => { if ((o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh) && o.receiveShadow) { o.receiveShadow = false; out.receivers++; cleared.push(o) } }) } catch (_) {}
    window.__psClearedReceivers = cleared
  } else if (mode === 'cube-on' || mode === 'cube-off') {
    // A 1.2 m box at the player's feet with castShadow on: the pipeline's own proof that a caster in
    // exactly this place can throw a shadow onto exactly this ground in exactly this view. If the
    // box shows a shadow and the player does not, the loss is in the player's own caster.
    try {
      const w = window
      if (!w.__psCube && d.playerMeshes && d.playerMeshes.size) {
        let Geo = null, Mat = null, Mes = null, Attr = null
        d.scene.traverse((o) => {
          if (!o.isMesh || !o.geometry) return
          if (!Geo) Geo = Object.getPrototypeOf(o.geometry).constructor
          if (!Attr) Attr = Object.getPrototypeOf(o.geometry.attributes.position).constructor
          if (!Mat) Mat = Object.getPrototypeOf(o.material).constructor
          if (!Mes && !o.isSkinnedMesh && !o.isInstancedMesh && !o.isBatchedMesh) Mes = Object.getPrototypeOf(o).constructor
        })
        if (Geo && Mat && Mes && Attr) {
          for (const root of d.playerMeshes.values()) {
            root.updateMatrixWorld(true)
            const V = Object.getPrototypeOf(root.position).constructor
            const p = new V().setFromMatrixPosition(root.matrixWorld)
            const g = new Geo()
            g.setAttribute('position', new Attr(new Float32Array([
              -0.6, -0.6, -0.6, 0.6, -0.6, -0.6, 0.6, 0.6, -0.6, -0.6, 0.6, -0.6,
              -0.6, -0.6, 0.6, 0.6, -0.6, 0.6, 0.6, 0.6, 0.6, -0.6, 0.6, 0.6,
            ]), 3))
            g.setIndex([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0])
            g.computeVertexNormals()
            g.computeBoundingSphere()
            const box = new Mes(g, new Mat({ color: 0x884422, roughness: 1, metalness: 0 }))
            box.name = 'ps-cube-control'
            box.castShadow = true
            box.receiveShadow = false
            box.position.set(p.x, p.y + 0.6, p.z)
            box.updateMatrixWorld(true)
            // MEASURED: putting this box on the app's SHADOW_CASTER_ONLY_LAYER bit alone (30, the bit
            // the shadow camera's mask 0x40000001 carries) takes it OUT of the shadow pass entirely:
            // submissions went 82 -> 0. So a shadow-only caster is not reachable that way here. The
            // box stays on the default layer and the arm toggles castShadow with the box VISIBLE in
            // both arms, so the box's own pixels cancel and only its shadow is measured.
            d.scene.add(box)
            if (!w.__psDraws) w.__psDraws = {}
            w.__psDraws.cube = 0
            const mine = w.__psDraws
            // Read the live map every call: a later hook pass can replace window.__psDraws, and a
            // counter holding the OLD object then increments into something nobody reads (measured:
            // cube submissions silently read 0 for two whole runs because of exactly that).
            box.onBeforeShadow = function () { const dd = w.__psDraws || (w.__psDraws = {}); dd.cube = (dd.cube || 0) + 1 }
            w.__psCube = box
            out.cube = { at: [+p.x.toFixed(2), +(p.y + 0.6).toFixed(2), +p.z.toFixed(2)], layers: box.layers.mask, camLayers: d.camera ? d.camera.layers.mask : null }
            break
          }
        }
      }
      if (w.__psCube) { w.__psCube.visible = true; w.__psCube.castShadow = mode === 'cube-on'; out.touched++ }
    } catch (_) {}
  } else if (mode === 'probe-on' || mode === 'probe-off') {
    try {
      const w = window
      if (!w.__psProbe && mode === 'probe-on' && d.playerMeshes && d.playerMeshes.size) {
        for (const root of d.playerMeshes.values()) {
          let src = null
          root.traverse((o) => { if (!src && o.isSkinnedMesh && o.geometry) src = o })
          if (!src) continue
          root.updateMatrixWorld(true)
          let MeshCtor = null
          d.scene.traverse((o) => { if (!MeshCtor && o.isMesh && !o.isSkinnedMesh && !o.isInstancedMesh && !o.isBatchedMesh) MeshCtor = Object.getPrototypeOf(o).constructor })
          if (!MeshCtor) continue
          const probe = new MeshCtor(src.geometry, src.material)
          probe.castShadow = true
          probe.receiveShadow = false
          probe.name = 'ps-probe-unskinned'
          probe.matrixAutoUpdate = false
          probe.matrix.copy(src.matrixWorld)
          probe.matrixWorld.copy(src.matrixWorld)
          d.scene.add(probe)
          if (!window.__psDraws) window.__psDraws = {}
          window.__psDraws.probe = 0
          const mine = window.__psDraws
          probe.onBeforeShadow = function () { const dd = window.__psDraws || (window.__psDraws = {}); dd.probe = (dd.probe || 0) + 1 }
          window.__psProbe = probe
          out.probe = { verts: src.geometry.attributes.position ? src.geometry.attributes.position.count : null, mat: src.material && src.material.type }
          break
        }
      }
      if (window.__psProbe) { window.__psProbe.visible = true; window.__psProbe.castShadow = mode === 'probe-on'; out.touched++ }
    } catch (_) {}
  } else if (mode === 'restore-receive') {
    for (const o of (window.__psClearedReceivers || [])) { try { o.receiveShadow = true; out.receivers++ } catch (_) {} }
  } else if (mode === 'all-receive') {
    try { d.scene.traverse((o) => { if (o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh) { if (!o.receiveShadow) { o.receiveShadow = true; out.receivers++ } } }) } catch (_) {}
  } else if (mode === 'other-receive') {
    // Every drawable EXCEPT the player's own receives. With the player itself excluded, anything the
    // castShadow toggle changes here is the player's shadow landing on someone else's surface -- not
    // the player's self-shadowing, which the all-receive arm cannot separate out.
    try {
      const mine = new Set()
      if (d.playerMeshes && d.playerMeshes.forEach) d.playerMeshes.forEach((root) => root.traverse((o) => { mine.add(o) }))
      const isD = (o) => !!(o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh)
      d.scene.traverse((o) => { if (isD(o) && !mine.has(o) && !o.receiveShadow) { o.receiveShadow = true; out.receivers++ } })
      for (const o of mine) if (isD(o) && o.receiveShadow) { o.receiveShadow = false; out.receivers-- }
    } catch (_) {}
  } else if (mode === 'world-off' || mode === 'world-on') {
    // Every caster in the scene EXCEPT the player's own, on and off. Population-level control: if
    // removing every other caster changes nothing while removing the receiver changes everything,
    // then what the ground is showing is not any caster's shadow, and the defect is downstream of
    // caster registration entirely.
    try {
      const mine = new Set()
      if (d.playerMeshes && d.playerMeshes.forEach) d.playerMeshes.forEach((root) => root.traverse((o) => { mine.add(o) }))
      const isD = (o) => !!(o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh)
      const on = mode === 'world-on'
      d.scene.traverse((o) => {
        if (!isD(o) || mine.has(o)) return
        if (o === window.__psCube || o === window.__psProbe) return
        if (o.castShadow !== on) { o.castShadow = on; out.touched++ }
      })
    } catch (_) {}
  } else if (mode.startsWith('ctl-')) {
    // The same A/B test run on a caster that is not the player. If a control's shadow shows up in
    // the frame and the player's does not, the difference is in the player's own caster, not in the
    // shadow pipeline's sampling.
    const idx = Number(String(mode).split(':')[1] || 0)
    const o = (window.__psControls || [])[idx]
    if (o) { o.castShadow = mode.startsWith('ctl-on'); out.touched++; out.ctl = { idx, name: o.name || o.type, castShadow: o.castShadow } }
  } else if (mode === 'bias-zero') {
    // bias is applied in the shadow map's own [0,1] depth, so bias * (far - near) metres of depth
    // slack is subtracted from every comparison: a caster whose shadow is shallower than that
    // throws no shadow at all while a taller caster still does.
    const lights = (window.__shadowPipeline && window.__shadowPipeline.lights) || []
    for (const l of lights) { if (l && l.shadow) { l.shadow.bias = 0; l.shadow.normalBias = 0; out.touched++ } }
  } else if (mode === 'auto-on' || mode === 'auto-off') {
    // The app gates shadow-map redraws on caster movement, and on WebGPU the flag it sets
    // (renderer.shadowMap.needsUpdate) has no consumer at all -- light.shadow.needsUpdate does
    // (ShadowNode.js:855). autoUpdate=true takes the gate out of the experiment entirely.
    const on = mode === 'auto-on'
    const lights = (window.__shadowPipeline && window.__shadowPipeline.lights) || []
    for (const l of lights) { if (l && l.shadow) { l.shadow.autoUpdate = on; out.touched++ } }
  } else {
    const on = mode === 'cast-on'
    if (d.playerMeshes && d.playerMeshes.forEach) {
      d.playerMeshes.forEach((root) => {
        root.visible = true
        drawables(root, (o) => { o.castShadow = on; out.touched++ })
      })
    }
  }
  try {
    const lights = (window.__shadowPipeline && window.__shadowPipeline.lights) || []
    for (const l of lights) { if (l && l.shadow) { l.shadow.needsUpdate = true; out.dirty.push(l.name || 'sun') } }
    if (d.renderer && d.renderer.shadowMap) d.renderer.shadowMap.needsUpdate = true
  } catch (_) {}
  return out
}

// Freeze everything that would otherwise move between captures: time of day (the sun drifts, which
// moves every shadow in the frame), the camera pose, and the avatar itself -- its idle clip, its bone
// overrides and its spring bones all move the silhouette AND the shadow it throws, which is exactly
// what this witness is trying to measure.
const FREEZE = (opts) => {
  const d = window.debug || {}
  const out = { todPaused: null, fraction: null, camRestored: null, animatorsFrozen: 0, vrmsFrozen: 0 }
  try {
    const api = window.__timeOfDayApi
    if (api) {
      if (Number.isFinite(opts.tod) && typeof api.setFraction === 'function') api.setFraction(opts.tod)
      if (typeof api.setPaused === 'function') { api.setPaused(true); out.todPaused = !!api.isPaused() }
      out.fraction = typeof api.getFraction === 'function' ? api.getFraction() : null
      // `setPaused` alone does NOT hold: setFraction only pins t for LOCAL_OVERRIDE_GRACE_MS, and
      // once that grace lapses the server keeps pushing its own fraction (setFractionFromServer),
      // so t -- and with it the sun direction and every shadow in the frame -- keeps moving. Measured:
      // tod 0.55 -> 0.633 across one run with `paused === true`, sun offset walking ~35 degrees. That
      // walk is the run's whole noise floor. Re-assert the fraction on a timer so the grace never
      // lapses, and stretch the day so any dt that does slip through moves t by nothing.
      if (typeof api.setDayLengthSec === 'function') api.setDayLengthSec(1e9)
      if (Number.isFinite(opts.tod) && typeof api.setFraction === 'function') {
        if (window.__psTodPin) clearInterval(window.__psTodPin)
        window.__psTodPin = setInterval(() => { try { api.setFraction(opts.tod) } catch (_) {} }, 400)
        out.todPinned = true
      }
    }
  } catch (_) {}
  try {
    if (window.__app && window.__app.cam && typeof window.__app.cam.restore === 'function') {
      const [yaw, pitch, zoomIndex] = String(opts.cam).split(',').map(Number)
      window.__app.cam.restore({ yaw, pitch, zoomIndex })
      out.camRestored = true
    }
  } catch (_) {}
  try {
    if (d.playerAnimators && d.playerAnimators.forEach) {
      d.playerAnimators.forEach((anim) => {
        anim.update = () => {}
        anim.applyBoneOverrides = () => {}
        out.animatorsFrozen++
      })
    }
    if (d.playerVrms && d.playerVrms.forEach) {
      d.playerVrms.forEach((vrm) => { if (vrm) { vrm.update = () => {}; out.vrmsFrozen++ } })
    }
  } catch (_) {}
  return out
}

// Where the player is on screen, so the diff's bounding box can be checked against where the shadow
// has to land rather than merely being non-zero somewhere.
const PROJECT_PLAYER = () => {
  const d = window.debug || {}
  const out = []
  const pm = d.playerMeshes
  if (!pm || !pm.forEach || !d.camera) return out
  const v = new (Object.getPrototypeOf(d.camera.position).constructor)()
  pm.forEach((root, id) => {
    v.set(0, 0, 0); root.updateMatrixWorld(); v.setFromMatrixPosition(root.matrixWorld)
    const feet = v.clone()
    v.project(d.camera)
    feet.y -= 0.9; feet.project(d.camera)
    out.push({
      id: String(id),
      world: [+root.position.x.toFixed(2), +root.position.y.toFixed(2), +root.position.z.toFixed(2)],
      headPx: [Math.round((v.x + 1) / 2 * window.innerWidth), Math.round((1 - v.y) / 2 * window.innerHeight)],
      feetPx: [Math.round((feet.x + 1) / 2 * window.innerWidth), Math.round((1 - feet.y) / 2 * window.innerHeight)],
    })
  })
  return out
}

// Proves the frame is otherwise still between captures: camera pose, sun offset, tod fraction.
const FRAME_STATE = () => {
  const d = window.debug || {}
  const cam = d.camera
  const p = window.__shadowPipeline && window.__shadowPipeline.debug ? window.__shadowPipeline.debug() : null
  return {
    camPos: cam ? [+cam.position.x.toFixed(3), +cam.position.y.toFixed(3), +cam.position.z.toFixed(3)] : null,
    camQuat: cam ? [+cam.quaternion.x.toFixed(5), +cam.quaternion.y.toFixed(5), +cam.quaternion.z.toFixed(5), +cam.quaternion.w.toFixed(5)] : null,
    sunOffset: p && p.offset ? p.offset.map((v) => +v.toFixed(3)) : null,
    tod: window.__timeOfDay && Number.isFinite(window.__timeOfDay.t) ? +window.__timeOfDay.t.toFixed(5) : null,
    todPaused: !!(window.__timeOfDay && window.__timeOfDay.paused),
  }
}

function diffStats(a, b, threshold) {
  const n = a.w * a.h
  let sum = 0, count = 0, max = 0
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1
  let sumLower = 0, countLower = 0
  const lowerStart = Math.floor(a.h * 0.5)
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const i = y * a.w + x
      let dmax = 0
      for (let c = 0; c < 3; c++) {
        const dv = Math.abs(a.rgb[i * 3 + c] - b.rgb[i * 3 + c])
        if (dv > dmax) dmax = dv
      }
      sum += dmax
      if (dmax > max) max = dmax
      if (y >= lowerStart) { sumLower += dmax; countLower++ }
      if (dmax >= threshold) {
        count++
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  const box = count ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null
  return {
    meanAbs: +(sum / n).toFixed(3),
    meanAbsLowerHalf: countLower ? +(sumLower / countLower).toFixed(3) : null,
    maxAbs: max,
    changedPixels: count,
    changedFraction: +(count / n).toFixed(5),
    box,
  }
}

// The frame flickers on its own (a few percent of pixels move >= threshold between two captures taken
// with a frozen sun and a frozen camera), so a raw cross-arm pixel count cannot separate the player's
// shadow from that flicker. This compares per pixel instead: a pixel counts as REAL only when it is
// stable within BOTH arms (withinArm spread <= spreadTol) yet differs between the arms by >= threshold.
// The same test run on two arms that both have castShadow=true is the method's own control and must
// return ~0.
// Per pixel MEDIAN across an arm's frames. The min/max spread filter rejects any pixel that moved
// once, which is fine until a single frame drifts (a bake landing, a stream chunk) -- then it
// rejects whole regions and the measurement collapses to ~0 px, which reads exactly like "no
// shadow" and is indistinguishable from the finding. A median over an odd number of frames ignores
// up to half the frames moving, so it survives the drift that invalidated whole runs here.
function medianFrame(frames) {
  const n = frames[0].rgb.length
  const k = frames.length
  const out = new Uint8Array(n)
  const buf = new Uint8Array(k)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < k; j++) buf[j] = frames[j].rgb[i]
    for (let a = 1; a < k; a++) {
      const v = buf[a]
      let b = a - 1
      while (b >= 0 && buf[b] > v) { buf[b + 1] = buf[b]; b-- }
      buf[b + 1] = v
    }
    out[i] = buf[k >> 1]
  }
  return { w: frames[0].w, h: frames[0].h, rgb: out }
}

function medianDiff(framesA, framesB, threshold) {
  const a = medianFrame(framesA), b = medianFrame(framesB)
  const w = a.w, h = a.h, n = w * h
  let count = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1
  let cx = 0, cy = 0, sumDelta = 0
  for (let i = 0; i < n; i++) {
    let dmax = 0
    for (let c = 0; c < 3; c++) { const dv = Math.abs(a.rgb[i * 3 + c] - b.rgb[i * 3 + c]); if (dv > dmax) dmax = dv }
    if (dmax < threshold) continue
    count++; sumDelta += dmax
    const x = i % w, y = (i / w) | 0
    cx += x; cy += y
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  const box = count ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null
  return {
    threshold, estimator: 'median',
    realPixels: count,
    realFraction: +(count / n).toFixed(5),
    meanDelta: count ? +(sumDelta / count).toFixed(2) : null,
    centroid: count ? [Math.round(cx / count), Math.round(cy / count)] : null,
    box,
  }
}

function stableDiff(framesA, framesB, threshold, spreadTol) {
  const w = framesA[0].w, h = framesA[0].h, n = w * h
  // Spread is ACROSS FRAMES, per channel. (Comparing max-min across the R/G/B channels instead
  // rejects every pixel that is not near-grey, which silently discards exactly the coloured
  // surfaces a shadow lands on.)
  const spread = (frames) => {
    const mx = new Uint8Array(n * 3)
    const mn = new Uint8Array(n * 3).fill(255)
    for (const f of frames) {
      for (let k = 0; k < n * 3; k++) {
        const v = f.rgb[k]
        if (v > mx[k]) mx[k] = v
        if (v < mn[k]) mn[k] = v
      }
    }
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      let s = 0
      for (let c = 0; c < 3; c++) { const d = mx[i * 3 + c] - mn[i * 3 + c]; if (d > s) s = d }
      out[i] = s
    }
    return out
  }
  const mean = (frames) => {
    const out = new Float32Array(n * 3)
    for (const f of frames) for (let k = 0; k < n * 3; k++) out[k] += f.rgb[k]
    for (let k = 0; k < n * 3; k++) out[k] /= frames.length
    return out
  }
  const sA = spread(framesA), sB = spread(framesB)
  const mA = mean(framesA), mB = mean(framesB)
  let count = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1
  let cx = 0, cy = 0, sumDelta = 0
  for (let i = 0; i < n; i++) {
    if (sA[i] > spreadTol || sB[i] > spreadTol) continue
    let dmax = 0
    for (let c = 0; c < 3; c++) { const dv = Math.abs(mA[i * 3 + c] - mB[i * 3 + c]); if (dv > dmax) dmax = dv }
    if (dmax < threshold) continue
    count++; sumDelta += dmax
    const x = i % w, y = (i / w) | 0
    cx += x; cy += y
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  const box = count ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null
  return {
    threshold, spreadTol,
    realPixels: count,
    realFraction: +(count / n).toFixed(5),
    meanDelta: count ? +(sumDelta / count).toFixed(2) : null,
    centroid: count ? [Math.round(cx / count), Math.round(cy / count)] : null,
    box,
  }
}

// onBeforeShadow counters accumulate, so the reading is the DELTA between two samples.
function drawsDelta(a, b) {
  const da = (a && a.draws) || {}
  const db = (b && b.draws) || {}
  const keys = new Set([...Object.keys(da), ...Object.keys(db)])
  const out = {}
  for (const k of keys) out[k] = (db[k] || 0) - (da[k] || 0)
  return out
}

function versionsDelta(a, b) {
  const la = (a && a.lights) || []
  const lb = (b && b.lights) || []
  const out = []
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    const va = (la[i] && la[i].versions) || {}
    const vb = (lb[i] && lb[i].versions) || {}
    const keys = new Set([...Object.keys(va), ...Object.keys(vb)])
    const row = {}
    let anyBump = false
    for (const k of keys) { row[k] = (vb[k] || 0) - (va[k] || 0); if (row[k] > 0) anyBump = true }
    out.push({ index: i, name: (lb[i] || la[i] || {}).name, autoUpdate: (lb[i] || la[i] || {}).autoUpdate, versionDelta: row, redrew: anyBump })
  }
  return out
}

let exitCode = 1
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || (e && e.message) || e)))
  const url = `http://localhost:${port}/?v=${Date.now()}` + (QS ? '&' + QS.replace(/^[?&]/, '') : '')
  console.log('[player-shadow] ' + url)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

  const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: GPU })
  console.log('[player-shadow] gpu ' + JSON.stringify({ rasterizer: gpu.rasterizer, renderer: gpu.renderer, vendor: gpu.adapter }))

  const t0 = Date.now()
  let ready = false
  while (Date.now() - t0 < 180000) {
    const r = await page.evaluate(() => ({
      revealedAt: (window.__app && window.__app.revealedAt) || 0,
      players: window.debug && window.debug.playerMeshes ? window.debug.playerMeshes.size : 0,
      hasVrm: !!(window.debug && window.debug.playerMeshes && [...window.debug.playerMeshes.values()].some((m) => m && m.children && m.children.length > 0)),
    })).catch(() => null)
    if (r && r.revealedAt && r.players > 0 && r.hasVrm) { ready = true; break }
    await wait(500)
  }
  if (!ready) throw new Error('page never reached revealedAt with a populated player mesh')
  console.log('[player-shadow] ready in ' + (Date.now() - t0) + 'ms')
  await wait(SETTLE_MS)

  const frozen = await page.evaluate(FREEZE, { tod: TOD_FRACTION, cam: CAM_POSE })
  console.log('[player-shadow] frozen ' + JSON.stringify(frozen))
  await wait(1500)

  // The world keeps changing long after "ready": with the sun unpaused the whole frame drifts, and a
  // progressive environment bake repaints it once more ~20 s in. An arm that straddles either is not
  // a measurement of anything, so refuse to start until consecutive captures agree -- AFTER the
  // freeze, because before it there is nothing to agree about.
  {
    const tq = Date.now()
    let prev = null, quiet = 0, i = 0, settled = false
    while (Date.now() - tq < 120000) {
      const buf = await page.screenshot({ path: resolve(OUT, `shot-${LABEL}-quiet${i++}.png`) })
      const im = decodePng(buf.toString('base64'))
      if (prev) {
        const s = diffStats(prev, im, 8)
        if (s.changedFraction < 0.03 && s.meanAbs < 2.5) { if (++quiet >= 3) { settled = true; break } } else quiet = 0
      }
      prev = im
      await wait(900)
    }
    console.log('[player-shadow] frame quiet after ' + (Date.now() - tq) + 'ms settled=' + settled + ' captures=' + i)
    if (!settled) throw new Error('the frame never settled: no pair of captures agreed within the noise floor')
  }

  // Arm A used to be the first frame drawn after the freeze, and it drifted (one run's three A
  // frames differed by 5% of the PNG size): the quiet window ends, and then something lands anyway.
  // Apply the baseline state and let it settle before the first measured arm.
  await page.evaluate(APPLY, 'cast-on')
  await wait(4000)

  const snap = await page.evaluate(INSTRUMENT)
  fs.writeFileSync(resolve(OUT, 'instrument-' + LABEL + '.json'), JSON.stringify(snap, null, 2))
  console.log('[player-shadow] instrument:' + JSON.stringify({
    localId: snap.localId,
    camMode: snap.camMode,
    renderer: snap.renderer,
    shadowMapEnabled: snap.shadowMapEnabled,
    sunCastShadow: snap.sunCastShadow,
    pipeline: snap.pipeline,
    players: snap.players.map((p) => ({ id: p.id, isLocal: p.isLocal, meshes: p.meshes })),
    receiveShadowCount: snap.receiveShadowCount,
    playerLod: snap.playerLod,
    shadowCameras: snap.shadowCameras,
    underPlayer: snap.underPlayer,
  }, null, 2))

  const hooked = await page.evaluate(HOOK_SHADOW)
  console.log('[player-shadow] shadow hooks: ' + JSON.stringify(hooked))
  // Build the two control casters NOW, hidden, so that no arm's frames straddle their first
  // appearance: a mesh added mid-arm shows up one frame late and its own arrival would otherwise
  // register as within-arm instability and be thrown away by the spread gate.
  await page.evaluate(APPLY, 'cube-off')
  await page.evaluate(APPLY, 'probe-off')
  await wait(FRAME_MS * 2)
  await wait(FRAME_MS)
  const live0 = await page.evaluate(SHADOW_LIVE)
  console.log('[player-shadow] live@boot ' + JSON.stringify(live0))
  const receivers = await page.evaluate(RECEIVERS)
  console.log('[player-shadow] shadow receivers (' + receivers.length + '): ' + JSON.stringify(receivers))

  // Paired captures per arm: the within-arm spread IS the noise floor, so the cross-arm diff has
  // something measured to beat rather than a guessed margin. D and E are positive controls -- without
  // them a null result on A vs B would be indistinguishable from a broken measurement.
  const shots = {}
  const seq = []
  for (let k = 1; k <= FRAMES_PER_ARM; k++) seq.push([`A${k}`, 'cast-on'])
  for (let k = 1; k <= FRAMES_PER_ARM; k++) seq.push([`B${k}`, 'cast-off'])
  for (let k = 1; k <= FRAMES_PER_ARM; k++) seq.push([`C${k}`, 'cast-on'])
  seq.push(['D1', 'hide-player'])
  // CUBE: a 1.2 m box at the player's own feet, castShadow on, added to the live scene. It is the
  // pipeline's own proof that a caster in exactly this place can throw a shadow onto exactly this
  // ground in exactly this view. If the box throws a shadow and the player does not, the loss is in
  // the player's own caster; if the box throws nothing either, it is not a caster-registration bug.
  // It runs with the player HIDDEN so that nothing standing at that spot can occlude the box's own
  // shadow -- a shadow hidden behind the caster is exactly the failure this has to rule out.
  for (let k = 1; k <= FRAMES_PER_ARM; k++) seq.push([`CU${k}`, 'cube-on'])
  for (let k = 1; k <= FRAMES_PER_ARM; k++) seq.push([`CV${k}`, 'cube-off'])
  // Back to the player, for the receive-side positive control.
  seq.push(['R1', 'cast-on'])
  seq.push(['E1', 'no-receive'])
  seq.push(['E2', 'restore-receive'])
  // PROBE: the avatar's own geometry and material at the avatar's own world matrix, un-skinned. Same
  // place, same size, same material: skinning is the only variable.
  for (let k = 1; k <= FRAMES_PER_ARM; k++) seq.push([`PR${k}`, 'probe-on'])
  for (let k = 1; k <= FRAMES_PER_ARM; k++) seq.push([`PS${k}`, 'probe-off'])
  for (let k = 1; k <= FRAMES_PER_ARM; k++) seq.push([`WX${k}`, 'world-off'])
  for (let k = 1; k <= FRAMES_PER_ARM; k++) seq.push([`WY${k}`, 'world-on'])
  for (let k = 1; k <= FRAMES_PER_ARM; k++) seq.push([`WZ${k}`, 'world-off'])
  const tSeq = Date.now()
  for (const [name, mode] of seq) {
    const applied = await page.evaluate(APPLY, mode)
    await wait(FRAME_MS)
    const buf = await page.screenshot({ path: resolve(OUT, `shot-${LABEL}-${name}.png`) })
    const state = await page.evaluate(FRAME_STATE)
    const live = await page.evaluate(SHADOW_LIVE)
    shots[name] = { mode, ...applied, bytes: buf.length, atMs: Date.now() - tSeq, ...state, live }
    console.log(`[player-shadow] ${name}: ${mode} t=${Date.now() - tSeq}ms bytes=${buf.length} touched=${applied.touched} receivers=${applied.receivers}`)
  }
  await page.evaluate(APPLY, 'cast-on')

  const playerScreen = await page.evaluate(PROJECT_PLAYER)
  console.log('[player-shadow] playerScreen=' + JSON.stringify(playerScreen))

  const readPng = (name) => decodePng(fs.readFileSync(resolve(OUT, `shot-${LABEL}-${name}.png`)).toString('base64'))
  // Drop the first frame of every arm: APPLY lands one frame late (a new mesh, a flipped flag), so
  // frame 1 of an arm can still show the PREVIOUS arm's state. Averaging it in is the one thing that
  // has silently invalidated arms here.
  const arm = (p) => { const out = []; for (let k = 1; k <= FRAMES_PER_ARM; k++) out.push(readPng(`${p}${k}`)); return out.length > 2 ? out.slice(1) : out }
  const A = arm('A'), B = arm('B'), C = arm('C')
  const D = readPng('D1'), E = readPng('E1')
  const CU = arm('CU'), CV = arm('CV')
  const PR = arm('PR'), PS = arm('PS')
  const WX = arm('WX'), WY = arm('WY'), WZ = arm('WZ')
  const signal = stableDiff(A, B, DIFF_THRESHOLD, SPREAD_TOL)
  const control = stableDiff(A, C, DIFF_THRESHOLD, SPREAD_TOL)
  const posPlayer = stableDiff(A, [D], DIFF_THRESHOLD, SPREAD_TOL)
  const posShadow = stableDiff(A, [E], DIFF_THRESHOLD, SPREAD_TOL)
  const cubeSignal = stableDiff(CU, CV, DIFF_THRESHOLD, SPREAD_TOL)
  const probeSignal = stableDiff(PR, PS, DIFF_THRESHOLD, SPREAD_TOL)
  const worldOff = stableDiff(WX, WY, DIFF_THRESHOLD, SPREAD_TOL)
  const worldOffAgain = stableDiff(WZ, WY, DIFF_THRESHOLD, SPREAD_TOL)
  // Per-pixel median across each arm's frames: the estimator that survives one drifting frame.
  const medSignal = medianDiff(A, B, DIFF_THRESHOLD)
  const medControl = medianDiff(A, C, DIFF_THRESHOLD)
  const medHide = medianDiff(A, [D], DIFF_THRESHOLD)
  const medRecv = medianDiff(A, [E], DIFF_THRESHOLD)
  const medWorld = medianDiff(WX, WY, DIFF_THRESHOLD)
  const medWorldAgain = medianDiff(WZ, WY, DIFF_THRESHOLD)
  const medCube = medianDiff(CU, CV, DIFF_THRESHOLD)
  const drawsA = drawsDelta(shots.A1.live, shots.A2.live)
  const drawsB = drawsDelta(shots.B1.live, shots.B2.live)
  const drawsC = drawsDelta(shots.C1.live, shots.C2.live)
  const redrewA = versionsDelta(shots.A1.live, shots.A2.live)
  const drawsCU = drawsDelta(shots.CU1.live, shots.CU2.live)
  const drawsCV = drawsDelta(shots.CV1.live, shots.CV2.live)
  const drawsPR = drawsDelta(shots.PR1.live, shots.PR2.live)
  const drawsPS = drawsDelta(shots.PS1.live, shots.PS2.live)
  const rawSignal = diffStats(A[A.length - 1], B[B.length - 1], DIFF_THRESHOLD)
  const rawNoiseA = diffStats(A[0], A[A.length - 1], DIFF_THRESHOLD)
  const report = {
    label: LABEL,
    todFraction: TOD_FRACTION,
    frozen,
    framesPerArm: FRAMES_PER_ARM,
    threshold: DIFF_THRESHOLD,
    spreadTol: SPREAD_TOL,
    noiseMargin: NOISE_MARGIN,
    minRealPixels: MIN_REAL_PIXELS,
    playerScreen,
    signal_A_vs_B_nocast: signal,
    control_A_vs_C_restored: control,
    positive_hidePlayer_A_vs_D: posPlayer,
    positive_noReceive_A_vs_E: posShadow,
                    cube_CU_on_vs_CV_off: cubeSignal,
            worldCasters_WX_off_vs_WY_on: worldOff,
    worldCasters_WZ_off_vs_WY_on: worldOffAgain,
    median: { A_vs_B_nocast: medSignal, A_vs_C_control: medControl, A_vs_D_hidden: medHide, A_vs_E_norecv: medRecv, world_WX_vs_WY: medWorld, world_WZ_vs_WY: medWorldAgain, cube_CU_vs_CV: medCube },
    unskinnedProbe_PR_on_vs_PS_off: probeSignal,
    cube: shots.CU1.cube || null,
    probe: shots.PR1.probe || null,
            shadowPassDraws: { castOn_A: drawsA, castOff_B: drawsB, castOn_C: drawsC, cube_on: drawsCU, cube_off: drawsCV, probe_on: drawsPR, probe_off: drawsPS },
    shadowMapRedrew: { arm_A: redrewA },
    shadowTuning: (shots.A1.live.lights || []).map((l) => ({ name: l.name, bias: l.bias, normalBias: l.normalBias, radius: l.radius, intensity: l.intensity, near: l.near, far: l.far, camWorld: l.camWorld, lightWorld: l.lightWorld, players: l.players })),
    raw_A_last_vs_B_last: rawSignal,
    raw_noise_within_A: rawNoiseA,
        shots,
  }
  fs.writeFileSync(resolve(OUT, 'diff-' + LABEL + '.json'), JSON.stringify(report, null, 2))
  console.log('[player-shadow] signal          A(cast)   vs B(no cast) : ' + JSON.stringify(signal))
  console.log('[player-shadow] control         A(cast)   vs C(cast)    : ' + JSON.stringify(control))
  console.log('[player-shadow] POSITIVE player A         vs D(hidden)  : ' + JSON.stringify(posPlayer))
  console.log('[player-shadow] POSITIVE shadow A         vs E(no recv) : ' + JSON.stringify(posShadow))
                  console.log('[player-shadow] WORLD      WY(all on) vs WX(all off): ' + JSON.stringify(worldOff))
  console.log('[player-shadow] WORLD      WY(all on) vs WZ(all off): ' + JSON.stringify(worldOffAgain))
  console.log('[player-shadow] CUBE        CU(on)    vs CV(off)     : ' + JSON.stringify(cubeSignal) + ' at=' + JSON.stringify(shots.CU1.cube || null))
  console.log('[player-shadow] unskinned   PR(on)    vs PS(off)     : ' + JSON.stringify(probeSignal) + ' mesh=' + JSON.stringify(shots.PR1.probe || null))
  console.log('[player-shadow] MEDIAN signal  A(cast) vs B(no cast) : ' + JSON.stringify(medSignal))
  console.log('[player-shadow] MEDIAN control A(cast) vs C(cast)   : ' + JSON.stringify(medControl))
  console.log('[player-shadow] MEDIAN hide    A vs D(hidden)       : ' + JSON.stringify(medHide))
  console.log('[player-shadow] MEDIAN norecv  A vs E(no recv)      : ' + JSON.stringify(medRecv))
  console.log('[player-shadow] MEDIAN world   WX(off) vs WY(on)    : ' + JSON.stringify(medWorld))
  console.log('[player-shadow] MEDIAN world   WZ(off) vs WY(on)    : ' + JSON.stringify(medWorldAgain))
  console.log('[player-shadow] MEDIAN cube    CU(on)  vs CV(off)   : ' + JSON.stringify(medCube))
      console.log('[player-shadow] shadow tuning: ' + JSON.stringify((shots.A1.live.lights || []).map((l) => ({ name: l.name, bias: l.bias, normalBias: l.normalBias, radius: l.radius, intensity: l.intensity, near: l.near, far: l.far, camWorld: l.camWorld, lightWorld: l.lightWorld, players: l.players }))))
  console.log('[player-shadow] shadow-pass submissions per arm (delta over ~' + FRAME_MS + 'ms):')
  console.log('[player-shadow]   cast-on  A  ' + JSON.stringify(drawsA))
  console.log('[player-shadow]   cast-off B  ' + JSON.stringify(drawsB))
  console.log('[player-shadow]   cast-on  C  ' + JSON.stringify(drawsC))
              console.log('[player-shadow]   cube on  ' + JSON.stringify(drawsCU))
  console.log('[player-shadow]   cube off ' + JSON.stringify(drawsCV))
  console.log('[player-shadow]   probe on ' + JSON.stringify(drawsPR))
  console.log('[player-shadow]   probe off ' + JSON.stringify(drawsPS))
  console.log('[player-shadow] shadow map redrew in arm A: ' + JSON.stringify(redrewA))
    console.log('[player-shadow] fresh shadow-camera NDC: ' + JSON.stringify((shots.A1.live.lights || []).map((l) => ({ n: l.name, p: l.players }))))
  console.log('[player-shadow] raw within-arm noise A: ' + JSON.stringify(rawNoiseA) )

  const playersWithNoCaster = snap.players.filter((p) => p.meshes.length > 0 && p.meshes.every((m) => !m.castShadow))
  const registrationOk = playersWithNoCaster.length === 0 && snap.sunCastShadow === true
  const onScreen = signal.realPixels >= MIN_REAL_PIXELS && signal.realPixels > control.realPixels * NOISE_MARGIN
  // A null signal only means something if the same instrument can see the player and can see shadows.
  const methodLive = posPlayer.realPixels >= MIN_REAL_PIXELS && posShadow.realPixels >= MIN_REAL_PIXELS
  console.log('[player-shadow] registrationOk=' + registrationOk + ' players=' + snap.players.length + ' zeroCasterPlayers=' + playersWithNoCaster.length)
  console.log('[player-shadow] onScreenShadow=' + onScreen + ' realPixels=' + signal.realPixels + ' controlPixels=' + control.realPixels)
  console.log('[player-shadow] methodLive=' + methodLive + ' hidePlayerPixels=' + posPlayer.realPixels + ' noReceivePixels=' + posShadow.realPixels)
  // A/B/A: arm A and arm C are the SAME state, so any difference between them is drift the world
  // imposed during the run, not a shadow. A control that moved invalidates every other number.
  const runValid = control.realPixels <= 400
  console.log('[player-shadow] runValid=' + runValid + ' controlPixels=' + control.realPixels + ' (A and C are the same state; >400 px means the frame drifted and nothing below is a measurement)')
  const sumTag = (d, prefix) => Object.keys(d || {}).filter((k) => k.startsWith(prefix)).reduce((s, k) => s + d[k], 0)
  const inShadowMapCastOn = sumTag(drawsA, 'player:') + sumTag(drawsC, 'player:')
  const inShadowMapCastOff = sumTag(drawsB, 'player:')
  const controlsInShadowMap = sumTag(drawsA, 'control:') + sumTag(drawsC, 'control:')
  const cubeInShadowMap = sumTag(drawsCU, 'cube')
  const probeInShadowMap = sumTag(drawsPR, 'probe')
  console.log('[player-shadow] shadow-pass submissions  player(cast on)=' + inShadowMapCastOn + ' player(cast off)=' + inShadowMapCastOff + ' controls=' + controlsInShadowMap + ' cube=' + cubeInShadowMap + ' probe=' + probeInShadowMap)
  console.log('[player-shadow] DECISION cubePx=' + cubeSignal.realPixels + ' probePx=' + probeSignal.realPixels)
  if (!methodLive) console.log('[player-shadow] INCONCLUSIVE: the instrument could not see the player or could not see any shadow in this view')
  if (errors.length) console.log('[player-shadow] page errors: ' + JSON.stringify(errors.slice(0, 6)))
  console.log('RESULT: ' + (registrationOk && onScreen ? 'PASS' : 'FAIL'))
  exitCode = registrationOk && onScreen ? 0 : 1
} catch (e) {
  console.error('[player-shadow] FAIL ' + (e && e.message))
  console.log('RESULT: FAIL')
  exitCode = 1
} finally {
  try { await browser.close() } catch (_) {}
  try { if (server && server.stop) await server.stop() } catch (_) {}
}

process.exit(exitCode)
