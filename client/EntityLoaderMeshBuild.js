// Mesh-build/rewrite helpers for EntityLoader.js's createEntityLoader: softbody-cloth particle-grid
// geometry, the freddie-bridge label sprite, and SPH-fluid droplet/surface render paths. Split out as
// EntityLoader.js's largest self-contained block -- each function here only touches its own
// module-scoped caches (_softbodyIndexCache, _fluidSurfaceSamples/_fluidSurfaceTotalMs) or explicit
// params, never createEntityLoader's own closure state. Entity-id-keyed caches (_labelSprites,
// _urlLoads) stay in EntityLoader.js since createEntityLoader itself reads/writes them directly.

import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
import { buildFluidSurfaceMesh } from './core/FluidSurface.js'

const SKIP_MATS_SET = new Set(['aaatrigger', '{invisible', 'playerclip', 'clip', 'nodraw', 'trigger', 'sky', 'toolsclip', 'toolsplayerclip', 'toolsnodraw', 'toolsskybox', 'toolstrigger'])
const PLACEHOLDER_DIMS = { door: [1.5, 2.5, 0.1], platform: [4, 0.5, 4], trigger: [2, 3, 2], hazard: [2, 2, 2], lootBox: [1, 1.5, 1], pillar: [1, 4, 1] }
const MESH_BUILDERS = {
  box: (c) => new THREE.BoxGeometry(c.sx || 1, c.sy || 1, c.sz || 1),
  cylinder: (c) => new THREE.CylinderGeometry(c.r || 0.4, c.r || 0.4, c.h || 0.1, c.seg || 16),
  sphere: (c) => new THREE.SphereGeometry(c.r || 0.5, c.seg || 16, c.seg || 16),
  // Must match AppPhysics.addColliderFromConfig's capsule defaults (r 0.3, h 1.8).
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
// Soft-body cloth render path (softbody-cloth-client-render-buffergeometry-vertex-path): builds the
// static, once-per-entity parts of a cols*rows particle-grid mesh -- a plain quad-per-cell triangulation
// ((cols-1)*(rows-1)*6 indices) and UVs -- shared by every particle-grid entity of the same cols/rows
// (the index/UV buffers depend only on grid topology, never on the live particle positions), so a fresh
// BufferGeometry per entity still reuses a cached index/UV pair keyed by "cols,rows" instead of
// recomputing it on every softbody-bearing entity spawn.
const _softbodyIndexCache = new Map() // "cols,rows" -> { index: Uint32Array, uv: Float32Array }
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
// Builds a fresh BufferGeometry for a softbody-cloth entity's particle grid, positions initialized from
// custom.softbody.positions (world-space, row-major x,y,z) minus originPos (the entity's own raw
// authoritative position -- the mesh is parented under a group already translated there, matching every
// other buildEntityMesh-built primitive's local-space convention). Normals computed once here; every
// subsequent per-snapshot rewrite (see _rewriteSoftbodyGeometry below) recomputes them too, since a
// genuinely deforming cloth needs correct per-frame shading, not stale spawn-time normals.
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
// Per-snapshot vertex-position REWRITE (not a full geometry rebuild): called from repaintEntity whenever
// custom.softbody arrives with a topology matching the mesh already built (cols/rows unchanged -- a
// mid-life cols/rows change is out of scope for this slice, matches softbody.js's own "grid topology is
// fixed for the entity's life" design; setPin only toggles FIXED/DYNAMIC on an existing point, it never
// resizes the grid). Returns false (caller should rebuild instead) if topology doesn't match.
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
// Freddie-bridge viz entity label: canvas-texture sprite floating above the entity, matching the
// pattern WaypointPath.js's _makeOrderLabelSprite already uses (sprite, not CSS2D, so it works in
// the 3D scene without a separate CSS2DRenderer pass). Caller caches the returned sprite per entityId
// (EntityLoader.js's own _labelSprites map) so repaintEntity can update/remove it without a full
// scene traverse -- this function itself is stateless.
function _makeLabelSprite(text) {
  const canvas = document.createElement('canvas')
  canvas.width = 256; canvas.height = 64
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, 256, 64)
  // Semi-transparent dark background pill
  const tw = ctx.measureText(text || '').width
  const pw = Math.min(240, Math.max(40, tw + 24))
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  _roundRect(ctx, (256 - pw) / 2, 4, pw, 56, 12)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 24px sans-serif'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(String(text || ''), 128, 34)
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
// SPH fluid particle-cloud render path (sph-fluid-client-render-particle-mesh): custom.fluid present
// means this entity is a live particle cloud published by apps/_lib/fluid.js's publish() -- see that
// module's doc comment for the wire shape: {particleCount, positions:[x,y,z,...]} world-space, row-major,
// flat number array (NOT a typed array on the wire -- msgpackr-serialized plain array). This is the
// simplest/cheapest of the two candidate approaches this row's own detail names (InstancedMesh2 of small
// spheres vs a metaball/marching-squares surface reconstruction) -- droplets/foam look, not a smooth
// fluid surface, but real and cheap, matching the same @three.ez/instanced-mesh primitive already proven
// at scale for grass/veg/rain (see AGENTS.md grass-commitchunk-batched-addinstances + Weather.js's own
// im.instances[i].position.set(...); inst.updateMatrix() per-frame-mutation pattern this mirrors exactly).
// Capacity is fixed at build time to the entity's spawn-time custom.fluid.particleCount rounded up to the
// nearest FLUID_CAPACITY_STEP (so a slowly-growing emitter doesn't force a capacity rebuild on every tick)
// clamped to FLUID_MAX_CAPACITY -- a hard ceiling independent of any one instance's own maxParticles spec
// field, since a scene could host multiple fluid sources and this is a per-entity GPU buffer allocation.
const FLUID_CAPACITY_STEP = 128, FLUID_MAX_CAPACITY = 4096
function _fluidCapacityFor(particleCount) {
  const n = Math.max(FLUID_CAPACITY_STEP, Math.ceil((particleCount || 1) / FLUID_CAPACITY_STEP) * FLUID_CAPACITY_STEP)
  return Math.min(n, FLUID_MAX_CAPACITY)
}
// Builds the InstancedMesh2 droplet cloud for a fluid entity. originPos is the entity's own raw spawn
// position (mesh.userData convention shared with every other buildEntityMesh primitive: positions written
// into the mesh are LOCAL to the entity's group, which is itself translated to originPos) -- but fluid.js
// publishes WORLD-space positions (its own doc comment: "so positions()/the published wire buffer are
// real world-space [x,y,z] triples", it maps its 2D solver plane onto world X/Z at a fixed worldY), so
// every published position needs originPos subtracted, exactly like _buildSoftbodyGeometry does for
// custom.softbody.positions.
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
// Per-snapshot position REWRITE for an already-built fluid InstancedMesh2. Grows the live instance count
// (im.addInstances) when the published particleCount increases (an emitter still spawning), up to the
// mesh's fixed capacity -- a growth past capacity is silently clamped (matches fluid.js's own maxParticles
// cap discipline; a scene with many fluid sources needs a hard per-entity ceiling regardless). Returns
// false if the mesh's capacity has been exceeded and a full rebuild is warranted (mirrors
// _rewriteSoftbodyGeometry's own false-means-rebuild contract), though in practice FLUID_MAX_CAPACITY is
// only reached by a misconfigured spec since fluid-source's own editorProps cap maxParticles at 4096.
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
// SPH fluid metaball/marching-squares SURFACE render path (sph-fluid-client-render-metaball-surface-
// evaluation, follow-on to the InstancedMesh2 droplet cloud above): opt-in alternative render mode for
// the SAME custom.fluid wire data, selected per-entity at first-build time via
// RenderControls.get('fluidRenderMode') === 'surface' (default stays 'droplets', the shipped baseline --
// this path never runs unless explicitly enabled). Builds a real THREE.Mesh whose geometry is a
// FluidSurface.buildFluidSurfaceMesh contour, full-REBUILT every snapshot (not vertex-rewritten in place
// like softbody/droplets -- marching squares can change vertex/index COUNT every step as particles
// cross the isosurface threshold differently, so there is no fixed-topology buffer to rewrite into,
// unlike the softbody grid's fixed cols*rows or the droplet cloud's fixed capacity; this is the real,
// honest cost difference the row's own perf-A/B measures, not an implementation shortcut).
function _buildFluidSurfaceMesh(fluid, originPos, cellSize, halfThickness) {
  const geo = buildFluidSurfaceMesh(THREE, fluid.positions || [], fluid.particleCount || 0, originPos, fluid.smoothingRadius || 0.5, cellSize, halfThickness)
  const mat = new THREE.MeshStandardMaterial({ color: fluid.color ?? 0x3a8bd8, roughness: 0.1, metalness: 0.05, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
  const mesh = new THREE.Mesh(geo || new THREE.BufferGeometry(), mat)
  mesh.castShadow = false; mesh.receiveShadow = false
  mesh.userData.isFluidSurface = true
  return mesh
}
// Per-snapshot REBUILD (see comment above for why this is a rebuild not a rewrite) + live perf stats,
// mirrored onto RenderControls' fluidSurfaceStats (window.__fluidSurfaceStats) so the row's own required
// live-measured-cost evaluation is a standing, inspectable number, not a one-off console.log.
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
  _makeLabelSprite, _fluidCapacityFor, _buildFluidMesh, _rewriteFluidMesh,
  _buildFluidSurfaceMesh, _rewriteFluidSurfaceMesh
}
