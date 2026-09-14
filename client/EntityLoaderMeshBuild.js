import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
import { buildFluidSurfaceMesh } from './core/FluidSurface.js'

const SKIP_MATS_SET = new Set(['aaatrigger', '{invisible', 'playerclip', 'clip', 'nodraw', 'trigger', 'sky', 'toolsclip', 'toolsplayerclip', 'toolsnodraw', 'toolsskybox', 'toolstrigger'])
const PLACEHOLDER_DIMS = { door: [1.5, 2.5, 0.1], platform: [4, 0.5, 4], trigger: [2, 3, 2], hazard: [2, 2, 2], lootBox: [1, 1.5, 1], pillar: [1, 4, 1] }
const MESH_BUILDERS = {
  box: (c) => new THREE.BoxGeometry(c.sx || 1, c.sy || 1, c.sz || 1),
  cylinder: (c) => new THREE.CylinderGeometry(c.r || 0.4, c.r || 0.4, c.h || 0.1, c.seg || 16),
  sphere: (c) => new THREE.SphereGeometry(c.r || 0.5, c.seg || 16, c.seg || 16),
  capsule: (c) => new THREE.CapsuleGeometry(c.r || 0.3, c.h || 1.8, c.cap || 4, c.seg || 16)
}
const LOD_CONFIGS = { vrm: { far: 40, skipBeyond: 80 }, box: { far: 45, skipBeyond: 90 }, sphere: { far: 50, skipBeyond: 100 }, cylinder: { far: 50, skipBeyond: 100 }, capsule: { far: 50, skipBeyond: 100 }, default: { far: 60, skipBeyond: 120 } }
const MAX_CONCURRENT_LOADS_INITIAL = 4, MAX_CONCURRENT_LOADS_RUNTIME = 6
const _urlLoads = new Map()
function _forceDoubleSide(obj) {
  if (!obj) return
  obj.traverse(c => {
    if (!c.isMesh) return
    const mats = Array.isArray(c.material) ? c.material : [c.material]
    for (const m of mats) { if (m && m.side !== THREE.DoubleSide) { m.side = THREE.DoubleSide; m.needsUpdate = true } }
  })
}
const _softbodyIndexCache = new Map()
function _softbodyGridTopology(cols, rows) {
  const key = `${cols},${rows}`
  let t = _softbodyIndexCache.get(key)
  if (t) return t
  const uv = new Float32Array(cols * rows * 2)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col
      uv[i * 2] = cols > 1 ? col / (cols - 1) : 0
      uv[i * 2 + 1] = rows > 1 ? 1 - row / (rows - 1) : 0
    }
  }
  const quadCells = Math.max(0, cols - 1) * Math.max(0, rows - 1)
  const index = new Uint32Array(quadCells * 6)
  let w = 0
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const a = row * cols + col, b = a + 1, c = a + cols, d = c + 1
      index[w++] = a; index[w++] = c; index[w++] = b
      index[w++] = b; index[w++] = c; index[w++] = d
    }
  }
  t = { index, uv }
  _softbodyIndexCache.set(key, t)
  return t
}
function _buildSoftbodyGeometry(sb, originPos) {
  const { cols, rows, positions } = sb
  const { index, uv } = _softbodyGridTopology(cols, rows)
  const count = cols * rows
  const pos = new Float32Array(count * 3)
  const ox = originPos?.[0] || 0, oy = originPos?.[1] || 0, oz = originPos?.[2] || 0
  for (let i = 0; i < count; i++) {
    const i3 = i * 3
    pos[i3] = (positions[i3] ?? 0) - ox
    pos[i3 + 1] = (positions[i3 + 1] ?? 0) - oy
    pos[i3 + 2] = (positions[i3 + 2] ?? 0) - oz
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setIndex(new THREE.BufferAttribute(index, 1))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}
function _rewriteSoftbodyGeometry(mesh, sb, originPos) {
  const geo = mesh.geometry, attr = geo?.attributes?.position
  const count = sb.cols * sb.rows
  if (!attr || attr.count !== count) return false
  const arr = attr.array, positions = sb.positions
  const ox = originPos?.[0] || 0, oy = originPos?.[1] || 0, oz = originPos?.[2] || 0
  for (let i = 0; i < count; i++) {
    const i3 = i * 3
    arr[i3] = (positions[i3] ?? 0) - ox
    arr[i3 + 1] = (positions[i3 + 1] ?? 0) - oy
    arr[i3 + 2] = (positions[i3 + 2] ?? 0) - oz
  }
  attr.needsUpdate = true
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return true
}
const LABEL_CANVAS_W = 256, LABEL_CANVAS_H = 64
function _paintLabel(canvas, text) {
  const label = String(text || '')
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, LABEL_CANVAS_W, LABEL_CANVAS_H)
  ctx.font = 'bold 24px sans-serif'
  const pillWidth = Math.min(240, Math.max(40, ctx.measureText(label).width + 24))
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  _roundRect(ctx, (LABEL_CANVAS_W - pillWidth) / 2, 4, pillWidth, 56, 12)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(label, LABEL_CANVAS_W / 2, 34)
}
function _makeLabelSprite(text) {
  const canvas = document.createElement('canvas')
  canvas.width = LABEL_CANVAS_W; canvas.height = LABEL_CANVAS_H
  _paintLabel(canvas, text)
  const tex = new THREE.CanvasTexture(canvas)
  tex.minFilter = THREE.LinearFilter
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, opacity: 0.9 })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(2, 0.5, 1)
  sprite.renderOrder = 999
  return sprite
}
function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}
const FLUID_CAPACITY_STEP = 128, FLUID_MAX_CAPACITY = 4096
function _fluidCapacityFor(particleCount) {
  const n = Math.max(FLUID_CAPACITY_STEP, Math.ceil((particleCount || 1) / FLUID_CAPACITY_STEP) * FLUID_CAPACITY_STEP)
  return Math.min(n, FLUID_MAX_CAPACITY)
}
function _buildFluidMesh(fluid, originPos, renderer) {
  const capacity = _fluidCapacityFor(fluid.particleCount)
  const radius = fluid.particleRadius || 0.08
  const geo = new THREE.SphereGeometry(radius, 8, 6)
  const mat = new THREE.MeshStandardMaterial({ color: fluid.color ?? 0x3a8bd8, roughness: 0.15, metalness: 0.05, transparent: true, opacity: 0.85 })
  const im = new InstancedMesh2(geo, mat, { capacity, renderer, createEntities: true })
  im.castShadow = false; im.receiveShadow = false
  const ox = originPos?.[0] || 0, oy = originPos?.[1] || 0, oz = originPos?.[2] || 0
  const positions = fluid.positions || []
  const count = Math.min(fluid.particleCount || 0, capacity)
  if (count > 0) {
    im.addInstances(count, (entity, id) => {
      const i3 = id * 3
      entity.position.set((positions[i3] ?? 0) - ox, (positions[i3 + 1] ?? 0) - oy, (positions[i3 + 2] ?? 0) - oz)
      entity.updateMatrix()
    })
  }
  im.userData.isFluid = true
  im.userData._fluidCapacity = capacity
  im.userData._fluidCount = count
  im.userData._fluidOrigin = [ox, oy, oz]
  return im
}
function _rewriteFluidMesh(im, fluid, originPos) {
  if (!im || !im.userData.isFluid) return false
  const capacity = im.userData._fluidCapacity
  const positions = fluid.positions || []
  const wantCount = Math.min(fluid.particleCount || 0, capacity)
  const haveCount = im.userData._fluidCount || 0
  const ox = originPos?.[0] || 0, oy = originPos?.[1] || 0, oz = originPos?.[2] || 0
  im.userData._fluidOrigin = [ox, oy, oz]
  if (wantCount > haveCount) {
    im.addInstances(wantCount - haveCount, (entity, id) => {
      const i3 = id * 3
      entity.position.set((positions[i3] ?? 0) - ox, (positions[i3 + 1] ?? 0) - oy, (positions[i3 + 2] ?? 0) - oz)
      entity.updateMatrix()
    })
    im.userData._fluidCount = wantCount
  }
  const n = Math.min(wantCount, im.userData._fluidCount || 0)
  for (let id = 0; id < n; id++) {
    const i3 = id * 3
    const inst = im.instances[id]; if (!inst) continue
    inst.position.set((positions[i3] ?? 0) - ox, (positions[i3 + 1] ?? 0) - oy, (positions[i3 + 2] ?? 0) - oz)
    inst.updateMatrix()
  }
  return true
}
function _buildFluidSurfaceMesh(fluid, originPos, cellSize, halfThickness) {
  const geo = buildFluidSurfaceMesh(THREE, fluid.positions || [], fluid.particleCount || 0, originPos, fluid.smoothingRadius || 0.5, cellSize, halfThickness)
  const mat = new THREE.MeshStandardMaterial({ color: fluid.color ?? 0x3a8bd8, roughness: 0.1, metalness: 0.05, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
  const mesh = new THREE.Mesh(geo || new THREE.BufferGeometry(), mat)
  mesh.castShadow = false; mesh.receiveShadow = false
  mesh.userData.isFluidSurface = true
  return mesh
}
let _fluidSurfaceSamples = 0, _fluidSurfaceTotalMs = 0
function _rewriteFluidSurfaceMesh(mesh, fluid, originPos, cellSize, halfThickness) {
  if (!mesh || !mesh.userData.isFluidSurface) return false
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const geo = buildFluidSurfaceMesh(THREE, fluid.positions || [], fluid.particleCount || 0, originPos, fluid.smoothingRadius || 0.5, cellSize, halfThickness)
  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const ms = t1 - t0
  if (geo) {
    const old = mesh.geometry
    mesh.geometry = geo
    if (old) old.dispose()
  }
  _fluidSurfaceSamples++
  _fluidSurfaceTotalMs += ms
  if (typeof window !== 'undefined') {
    window.__fluidSurfaceStats = { lastMs: ms, avgMs: _fluidSurfaceTotalMs / _fluidSurfaceSamples, samples: _fluidSurfaceSamples, particleCount: fluid.particleCount || 0 }
  }
  return true
}

export {
  SKIP_MATS_SET, PLACEHOLDER_DIMS, MESH_BUILDERS, LOD_CONFIGS,
  MAX_CONCURRENT_LOADS_INITIAL, MAX_CONCURRENT_LOADS_RUNTIME,
  _forceDoubleSide, _buildSoftbodyGeometry, _rewriteSoftbodyGeometry,
  _makeLabelSprite, _paintLabel, _fluidCapacityFor, _buildFluidMesh, _rewriteFluidMesh,
  _buildFluidSurfaceMesh, _rewriteFluidSurfaceMesh
}
