import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
import { createDotMaterialTSL } from './PlayerLODTSL.js'
import { createWebGPUInstancedMesh, isWebGPUInstancingSupported } from './WebGPUInstancing.js'

export const PLAYER_LOD_FULL_COUNT = 30
export const PLAYER_LOD_REDUCED_D = 120
export const PLAYER_LOD_REDUCED_D2 = PLAYER_LOD_REDUCED_D * PLAYER_LOD_REDUCED_D

export const TIER_FULL = 0
export const TIER_REDUCED = 1
export const TIER_DOT = 2

let _idxScratch = new Int32Array(0)
let _d2Scratch = new Float64Array(0)
const _full = new Set(), _reduced = new Set(), _dot = new Set()
const _setOfTier = [_full, _reduced, _dot]
const _tierById = new Map()
const _passById = new Map()
let _pass = 0
const _order = []
const _tiers = { full: _full, reduced: _reduced, dot: _dot, order: _order, tierById: _tierById }

function ensureScratchCapacity(n) {
  if (_idxScratch.length >= n) return
  _idxScratch = new Int32Array(n)
  _d2Scratch = new Float64Array(n)
}

function indexBefore(a, b) {
  const da = _d2Scratch[a], db = _d2Scratch[b]
  return da < db || (da === db && a < b)
}

function siftDown(root, end) {
  let r = root
  for (;;) {
    let child = 2 * r + 1
    if (child >= end) return
    if (child + 1 < end && indexBefore(_idxScratch[child], _idxScratch[child + 1])) child++
    if (!indexBefore(_idxScratch[r], _idxScratch[child])) return
    const t = _idxScratch[r]; _idxScratch[r] = _idxScratch[child]; _idxScratch[child] = t
    r = child
  }
}

function sortIndicesByD2(n) {
  for (let start = (n >> 1) - 1; start >= 0; start--) siftDown(start, n)
  for (let end = n - 1; end > 0; end--) {
    const top = _idxScratch[0]
    _idxScratch[0] = _idxScratch[end]; _idxScratch[end] = top
    siftDown(0, end)
  }
}

function setTier(id, tier) {
  const old = _tierById.get(id)
  if (old !== tier) {
    if (old !== undefined) _setOfTier[old].delete(id)
    _setOfTier[tier].add(id)
    _tierById.set(id, tier)
  }
  _passById.set(id, _pass)
}

function sweepStale(pass, id) {
  if (pass === _pass) return
  const old = _tierById.get(id)
  if (old !== undefined) _setOfTier[old].delete(id)
  _tierById.delete(id)
  _passById.delete(id)
}

export function classifyPlayerTiers(entries, viewerPos, fullCount = PLAYER_LOD_FULL_COUNT, reducedD2 = PLAYER_LOD_REDUCED_D2) {
  const vx = viewerPos.x, vy = viewerPos.y, vz = viewerPos.z
  const n = entries.length
  ensureScratchCapacity(n)
  for (let i = 0; i < n; i++) {
    const e = entries[i]
    const dx = e.x - vx, dy = e.y - vy, dz = e.z - vz
    _idxScratch[i] = i
    _d2Scratch[i] = dx * dx + dy * dy + dz * dz
  }
  sortIndicesByD2(n)
  _pass++
  for (let i = 0; i < n; i++) {
    const srcIdx = _idxScratch[i]
    const e = entries[srcIdx]
    const id = e.id
    const d2 = _d2Scratch[srcIdx]
    e.d2 = d2
    _order[i] = id
    setTier(id, i < fullCount ? TIER_FULL : d2 < reducedD2 ? TIER_REDUCED : TIER_DOT)
  }
  if (_order.length !== n) _order.length = n
  _passById.forEach(sweepStale)
  return _tiers
}

function makeDotGeo(size) {
  const geo = new THREE.PlaneGeometry(size, size)
  geo.rotateX(-Math.PI / 2)
  return geo
}

function makeDotMaterial() {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.85, depthWrite: false })
  mat.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        vec3 worldPos = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 toCam = normalize(cameraPosition - worldPos);
        vec3 up = vec3(0.0, 1.0, 0.0);
        vec3 right = normalize(cross(toCam, up));
        vec3 camUp = cross(right, toCam);
        transformed = right * position.x + camUp * position.z;
      }`
    )
  }
  return mat
}

function createCrowdDotRendererWebGL(scene, opts) {
  const dotCellM = opts.dotCellM || 25
  const dotSize = opts.dotSize || 1.4
  const capacity = opts.capacity || 512
  const geo = makeDotGeo(dotSize)
  const mat = makeDotMaterial()

  const im = new InstancedMesh2(geo, mat, { capacity, renderer: opts.renderer })
  im.frustumCulled = false
  im.matrixAutoUpdate = false
  im.renderOrder = 3
  scene.add(im)
  im.updateMatrix()

  let activeCount = 0

  function ensureCapacity(n) {
    if (n <= im.capacity) return
    im.resizeBuffers(Math.max(n, im.capacity * 2))
  }

  let curDots = null, curBuckets = false, curViewerY = 0, curGround = null, curIndex = 0

  function placeDot(entity) {
    let x, z, y, scale
    if (curBuckets) {
      const bucket = curDots[curIndex]
      x = (bucket[0] + 0.5) * dotCellM; z = (bucket[1] + 0.5) * dotCellM
      y = curGround ? curGround(x, z) : curViewerY
      scale = dotSize * Math.min(3, 0.6 + Math.sqrt(bucket[2]) * 0.35)
    } else {
      const p = curDots[curIndex]
      x = p.x; z = p.z; y = curGround ? curGround(x, z) : p.y
      scale = dotSize
    }
    curIndex++
    entity.position.set(x, y + 0.05, z)
    entity.scale.set(scale, scale, scale)
  }

  function update(dots, viewerY, groundHeightFn) {
    if (!dots || dots.length === 0) {
      if (activeCount > 0) { im.clearInstances(); activeCount = 0 }
      return
    }
    const isBuckets = Array.isArray(dots[0])
    ensureCapacity(dots.length)
    im.clearInstances()
    curDots = dots; curBuckets = isBuckets; curViewerY = viewerY; curGround = groundHeightFn; curIndex = 0
    im.addInstances(dots.length, placeDot)
    curDots = null; curGround = null
    activeCount = dots.length
  }

  function dispose() { scene.remove(im); geo.dispose(); mat.dispose() }

  return { instancedMesh: im, update, dispose, get count() { return activeCount } }
}

function createCrowdDotRendererWebGPU(scene, opts) {
  const dotCellM = opts.dotCellM || 25
  const dotSize = opts.dotSize || 1.4
  let capacity = opts.capacity || 512
  const geo = makeDotGeo(dotSize)
  const _m4 = new THREE.Matrix4()
  const _dotPos = new THREE.Vector3(), _dotScale = new THREE.Vector3(), _dotQuat = new THREE.Quaternion()

  let inst = buildInstance(capacity)
  let activeCount = 0

  function buildInstance(cap) {
    const mat = createDotMaterialTSL()
    const rec = createWebGPUInstancedMesh(geo, mat, cap)
    rec.mesh.renderOrder = 3
    scene.add(rec.mesh)
    return rec
  }

  function ensureCapacity(n) {
    if (n <= capacity) return
    capacity = Math.max(n, capacity * 2)
    scene.remove(inst.mesh)
    inst.dispose()
    inst = buildInstance(capacity)
  }

  function update(dots, viewerY, groundHeightFn) {
    if (!dots || dots.length === 0) {
      if (activeCount > 0) { inst.clear(); activeCount = 0 }
      return
    }
    const isBuckets = Array.isArray(dots[0])
    ensureCapacity(dots.length)
    inst.clear()
    for (let i = 0; i < dots.length; i++) {
      let x, z, y, scale
      if (isBuckets) {
        const bucket = dots[i]
        x = (bucket[0] + 0.5) * dotCellM; z = (bucket[1] + 0.5) * dotCellM
        y = groundHeightFn ? groundHeightFn(x, z) : viewerY
        scale = dotSize * Math.min(3, 0.6 + Math.sqrt(bucket[2]) * 0.35)
      } else {
        const p = dots[i]
        x = p.x; z = p.z; y = groundHeightFn ? groundHeightFn(x, z) : p.y
        scale = dotSize
      }
      const id = inst.acquireId()
      if (id < 0) break
      _dotPos.set(x, y + 0.05, z)
      _dotScale.set(scale, scale, scale)
      _m4.compose(_dotPos, _dotQuat, _dotScale)
      inst.setMatrixAt(id, _m4)
    }
    activeCount = dots.length
  }

  function dispose() { scene.remove(inst.mesh); geo.dispose(); inst.dispose() }

  return { instancedMesh: inst.mesh, update, dispose, get count() { return activeCount } }
}

export function createCrowdDotRenderer(scene, opts = {}) {
  if (isWebGPUInstancingSupported(opts.renderer)) return createCrowdDotRendererWebGPU(scene, opts)
  return createCrowdDotRendererWebGL(scene, opts)
}

const _dotFallbackScratch = []

export function installPlayerLOD(scene, opts = {}) {
  const dots = createCrowdDotRenderer(scene, opts)
  let lastTiers = { full: new Set(), reduced: new Set(), dot: new Set(), order: [] }
  let _fullCountOverride = null

  function tick(remoteEntries, viewerPos, serverDots, groundHeightFn) {
    const fullCount = _fullCountOverride ?? PLAYER_LOD_FULL_COUNT
    const tiers = classifyPlayerTiers(remoteEntries, viewerPos, fullCount)
    lastTiers = tiers
    if (serverDots && serverDots.length) {
      dots.update(serverDots, viewerPos.y, groundHeightFn)
    } else if (tiers.dot.size > 0) {
      _dotFallbackScratch.length = 0
      for (let i = 0; i < remoteEntries.length; i++) {
        const e = remoteEntries[i]
        if (tiers.dot.has(e.id)) _dotFallbackScratch.push(e)
      }
      dots.update(_dotFallbackScratch, viewerPos.y, groundHeightFn)
    } else {
      dots.update(null)
    }
    return tiers
  }

  function getTiers() { return lastTiers }
  function tierOf(id) { const t = lastTiers.tierById ? lastTiers.tierById.get(id) : undefined; return t !== undefined ? t : (lastTiers.full.has(id) ? TIER_FULL : lastTiers.reduced.has(id) ? TIER_REDUCED : TIER_DOT) }
  function setFullCountOverride(n) { _fullCountOverride = n }

  return { tick, getTiers, tierOf, dots, setFullCountOverride, dispose: () => dots.dispose() }
}

export function installPlayerLODDebug(playerLOD) {
  if (typeof window === 'undefined') return
  window.__playerLOD = {
    stats() {
      const t = playerLOD.getTiers()
      return { full: t.full.size, reduced: t.reduced.size, dot: t.dot.size, dotInstances: playerLOD.dots.count }
    },
    tierOf: id => playerLOD.tierOf(id),
    setFullCount: n => playerLOD.setFullCountOverride(n),
    debugTiers() {
      const t = playerLOD.getTiers()
      return { full: [...t.full], reduced: [...t.reduced], dot: [...t.dot], order: t.order }
    }
  }
}
