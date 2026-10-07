import * as THREE from 'three'
import { createWebGPULodInstancer } from '../client/core/WebGPULodInstancer.js'

const LOD_D = [0, 14, 35], HYS = 0.12, SH = 35, MESH_FAR = 90
const N0 = 2000, SPACING = 3, ADDS = 4, FRAMES = 300

function makeLevels() {
  const base = new THREE.BoxGeometry(6, 12, 6)
  base.translate(0, 6, 0)
  base.computeBoundingSphere()
  const shared = base.boundingSphere.clone()
  const levels = LOD_D.map((d, i) => {
    const g = new THREE.BoxGeometry(6 - i * 1.5, 12 - i * 3, 6 - i * 1.5)
    g.translate(0, 6, 0)
    g.boundingSphere = shared.clone()
    return { geometry: g, material: new THREE.MeshStandardMaterial(), distance: d }
  })
  const sg = new THREE.BoxGeometry(1.5, 3, 1.5)
  sg.translate(0, 6, 0)
  sg.boundingSphere = shared.clone()
  return { levels, shadowGeo: sg, bounds: shared }
}

const { levels, shadowGeo, bounds } = makeLevels()
const scene = new THREE.Scene()
const inst = createWebGPULodInstancer(scene, levels, N0 * 3, { windPhase: 'float', tint: 'vec3' }, {
  hysteresis: HYS, shadowGeometry: shadowGeo, shadowMaterial: levels[0].material, shadowDistance: SH,
})
inst.setMeshFarDistance(MESH_FAR)

const side = Math.ceil(Math.sqrt(N0))
const half = (side - 1) * SPACING * 0.5
const extent = half * 2
const pos = new Map()
inst.addInstances(N0, (p) => {
  const x = (p.id % side) * SPACING - half
  const z = Math.floor(p.id / side) * SPACING - half
  p.position.set(x, 0, z)
  pos.set(p.id, [x, 0, z])
})

const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000)
const fr = new THREE.Frustum()
const ps = new THREE.Matrix4()
function pose(f) {
  cam.position.set(-0.35 * extent + Math.cos(Math.PI / 4) * 7 * (1 / 60) * f, 1.7, -0.35 * extent + Math.sin(Math.PI / 4) * 7 * (1 / 60) * f)
  cam.rotation.set(0, Math.PI / 4 + 0.35 * Math.sin(f * 0.05), 0)
  cam.updateMatrixWorld(true)
  cam.updateProjectionMatrix()
  ps.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
  fr.setFromProjectionMatrix(ps)
}

const tsq = LOD_D.map((d) => { const t = d - d * HYS; return t * t })
const MFSQ = MESH_FAR * MESH_FAR
function tierFor(dsq) {
  if (dsq >= MFSQ) return -1
  for (let i = tsq.length - 1; i > 0; i--) if (dsq >= tsq[i]) return i
  return 0
}
function oracle(id, eye) {
  const p = pos.get(id)
  const dx = p[0] - eye.x, dy = p[1] - eye.y, dz = p[2] - eye.z
  const tier = tierFor(dx * dx + dy * dy + dz * dz)
  let culled = false
  if (tier !== -1) {
    const cx = p[0], cy = p[1] + 6, cz = p[2]
    for (let q = 0; q < 6; q++) {
      const pl = fr.planes[q]
      if (pl.normal.x * cx + pl.normal.y * cy + pl.normal.z * cz + pl.constant < -bounds.radius) { culled = true; break }
    }
  }
  return { tier, culled, dsq: dx * dx + dy * dy + dz * dz }
}

for (let f = 0; f < FRAMES; f++) {
  pose(f)
  inst.addInstances(ADDS, (p) => {
    const h = (p.id * 2654435761 + f * 40503) >>> 0
    const x = ((h % 1009) / 1009 - 0.5) * extent
    const z = (((h >>> 10) % 1013) / 1013 - 0.5) * extent
    p.position.set(x, 0, z)
    pos.set(p.id, [x, 0, z])
  })
  inst.updateLOD(cam.position, fr, true)
}

const ids = [...pos.keys()].slice(0, Math.floor(pos.size * 0.1))
for (const id of ids) { inst.removeInstances(id); pos.delete(id) }
inst.addInstances(ids.length, (p) => {
  const x = 0.2 * extent + (p.id % 40) * SPACING
  const z = 0.2 * extent + Math.floor(p.id / 40) * SPACING
  p.position.set(x, 0, z)
  pos.set(p.id, [x, 0, z])
})

const out = []
for (let f = 0; f < 4; f++) {
  pose(FRAMES + f)
  inst.updateLOD(cam.position, fr, true)
  const got = new Map()
  for (let t = 0; t < inst.tierIds.length; t++) for (const id of inst.tierIds[t]) got.set(id, t)
  const diffs = []
  for (const [id] of pos) {
    const o = oracle(id, cam.position)
    const g = got.has(id) ? got.get(id) : -1
    const want = o.culled ? -1 : o.tier
    if (g !== want) {
      const p = pos.get(id)
      const g0 = inst._debugGrid
      const c = g0.cellOf[id]
      const b = c * 3
      const eye = cam.position
      const gx = Math.max(g0.posMin[b] - eye.x, 0, eye.x - g0.posMax[b])
      const gy = Math.max(g0.posMin[b + 1] - eye.y, 0, eye.y - g0.posMax[b + 1])
      const gz = Math.max(g0.posMin[b + 2] - eye.z, 0, eye.z - g0.posMax[b + 2])
      const fx = Math.max(eye.x - g0.posMin[b], g0.posMax[b] - eye.x)
      const fy = Math.max(eye.y - g0.posMin[b + 1], g0.posMax[b + 1] - eye.y)
      const fz = Math.max(eye.z - g0.posMin[b + 2], g0.posMax[b + 2] - eye.z)
      const dminSq = gx * gx + gy * gy + gz * gz
      const dmaxSq = fx * fx + fy * fy + fz * fz
      diffs.push({
        id, got: g, want, dsq: +o.dsq.toFixed(1), oracleTier: o.tier, culled: o.culled,
        x: +p[0].toFixed(1), z: +p[2].toFixed(1),
        cell: c, cellMode: g0.mode[c], cellTier: g0.tier[c], cellState: g0.state[c], cellMask: g0.mask[c],
        cellMin: [+g0.posMin[b].toFixed(1), +g0.posMin[b + 2].toFixed(1)],
        cellMax: [+g0.posMax[b].toFixed(1), +g0.posMax[b + 2].toFixed(1)],
        dminSq: +dminSq.toFixed(1), dmaxSq: +dmaxSq.toFixed(1),
        tierNear: tierFor(dminSq), tierFar: tierFor(dmaxSq),
        cells: g0.cells, nx: g0.nx, cellSize: +(1 / g0.invCell).toFixed(2),
      })
    }
  }
  out.push({ frame: FRAMES + f, diffCount: diffs.length, diffs: diffs.slice(0, 6), grid: inst.sweepGrid })
}
console.log(JSON.stringify(out, null, 1))
