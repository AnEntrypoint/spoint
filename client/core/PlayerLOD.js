import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'

export const PLAYER_LOD_FULL_COUNT = 30
export const PLAYER_LOD_REDUCED_D = 120
export const PLAYER_LOD_REDUCED_D2 = PLAYER_LOD_REDUCED_D * PLAYER_LOD_REDUCED_D

export const TIER_FULL = 0
export const TIER_REDUCED = 1
export const TIER_DOT = 2

let _idxScratch = new Int32Array(0)
let _d2Scratch = new Float64Array(0)
const _full = new Set(), _reduced = new Set(), _dot = new Set()
const _tierById = new Map()
const _order = []

function ensureScratchCapacity(n) {
  if (_idxScratch.length >= n) return
  _idxScratch = new Int32Array(n)
  _d2Scratch = new Float64Array(n)
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
  const idxView = _idxScratch.subarray(0, n)
  idxView.sort(_byD2)
  _full.clear(); _reduced.clear(); _dot.clear(); _order.length = 0; _tierById.clear()
  for (let i = 0; i < n; i++) {
    const srcIdx = idxView[i]
    const e = entries[srcIdx]
    const id = e.id
    const d2 = _d2Scratch[srcIdx]
    e.d2 = d2
    _order.push(id)
    if (i < fullCount) { _full.add(id); _tierById.set(id, TIER_FULL) }
    else if (d2 < reducedD2) { _reduced.add(id); _tierById.set(id, TIER_REDUCED) }
    else { _dot.add(id); _tierById.set(id, TIER_DOT) }
  }
  return { full: _full, reduced: _reduced, dot: _dot, order: _order, tierById: _tierById }
}
function _byD2(a, b) { return _d2Scratch[a] - _d2Scratch[b] }

export function tierForRankAndDistance(rank, d2, fullCount = PLAYER_LOD_FULL_COUNT, reducedD2 = PLAYER_LOD_REDUCED_D2) {
  if (rank < fullCount) return TIER_FULL
  if (d2 < reducedD2) return TIER_REDUCED
  return TIER_DOT
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
        vec3 right = normalize(cross(up, toCam));
        vec3 camUp = cross(toCam, right);
        float sx = length(instanceMatrix[0].xyz);
        transformed = right * position.x * sx + camUp * position.z * sx;
      }`
    )
  }
  return mat
}

export function createCrowdDotRenderer(scene, opts = {}) {
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
  const _pos = new THREE.Vector3(), _quat = new THREE.Quaternion(), _scaleVec = new THREE.Vector3()

  function ensureCapacity(n) {
    if (n <= im.capacity) return
    im.resizeBuffers(Math.max(n, im.capacity * 2))
  }

  function update(dots, viewerY, groundHeightFn) {
    if (!dots || dots.length === 0) {
      if (activeCount > 0) { im.clearInstances(); activeCount = 0 }
      return
    }
    const isBuckets = Array.isArray(dots[0])
    ensureCapacity(dots.length)
    im.clearInstances()
    let i = 0
    im.addInstances(dots.length, (entity) => {
      let x, z, y, scale
      if (isBuckets) {
        const [cx, cz, count] = dots[i]
        x = (cx + 0.5) * dotCellM; z = (cz + 0.5) * dotCellM
        y = groundHeightFn ? groundHeightFn(x, z) : viewerY
        scale = dotSize * Math.min(3, 0.6 + Math.sqrt(count) * 0.35)
      } else {
        const p = dots[i]
        x = p.x; z = p.z; y = groundHeightFn ? groundHeightFn(x, z) : p.y
        scale = dotSize
      }
      i++
      entity.position.set(x, y + 0.05, z)
      entity.scale.set(scale, scale, scale)
    })
    activeCount = dots.length
  }

  function dispose() { scene.remove(im); geo.dispose(); mat.dispose() }

  return { instancedMesh: im, update, dispose, get count() { return activeCount } }
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
