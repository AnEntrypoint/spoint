import * as THREE from 'three'

const CLUMP_TEX_SIZE = 256
const CLUMP_BLADES = 22
const CLUMP_SEED = 0x2f6e2b1
const BLADE_STEPS = 14

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function paintBlade(ctx, size, baseX, height, lean, curve, halfWidth, shade) {
  const left = [], right = []
  for (let s = 0; s <= BLADE_STEPS; s++) {
    const v = s / BLADE_STEPS
    const cx = baseX + (lean * v + curve * v * v) * size
    const y = size - v * height * size
    const w = halfWidth * size * Math.pow(1 - v, 0.85) * (0.55 + 0.45 * Math.sin(Math.min(1, v * 3 + 0.35) * Math.PI * 0.5))
    left.push([cx - w, y]); right.push([cx + w, y])
  }
  const grey = Math.round(255 * shade)
  ctx.fillStyle = `rgb(${grey},${grey},${grey})`
  ctx.beginPath()
  ctx.moveTo(left[0][0], left[0][1])
  for (let i = 1; i < left.length; i++) ctx.lineTo(left[i][0], left[i][1])
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1])
  ctx.closePath()
  ctx.fill()
}

export function makeClumpAlphaTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = CLUMP_TEX_SIZE
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, CLUMP_TEX_SIZE, CLUMP_TEX_SIZE)
  const rand = mulberry32(CLUMP_SEED)
  const blades = []
  for (let i = 0; i < CLUMP_BLADES; i++) {
    const t = (i + rand() * 0.6) / CLUMP_BLADES
    const baseX = 0.1 + 0.8 * t
    const outward = (baseX - 0.5) * 2
    blades.push({
      baseX,
      height: 0.5 + 0.48 * (1 - Math.abs(outward) * 0.55) * (0.65 + 0.35 * rand()),
      lean: outward * (0.12 + 0.2 * rand()) + (rand() - 0.5) * 0.06,
      curve: (rand() - 0.5) * 0.22 + outward * 0.1,
      halfWidth: 0.03 + 0.022 * rand(),
      shade: 0.62 + 0.38 * rand()
    })
  }
  blades.sort((a, b) => a.height - b.height)
  for (const b of blades) paintBlade(ctx, CLUMP_TEX_SIZE, b.baseX, b.height, b.lean, b.curve, b.halfWidth, b.shade)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.NoColorSpace
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

export function makeClumpGeo(segments, cards) {
  const N = Number.isFinite(segments) && segments >= 1 ? segments | 0 : 3
  const C = Number.isFinite(cards) && cards >= 1 ? cards | 0 : 3
  const pos = [], uv = [], idx = []
  let vi = 0
  for (let c = 0; c < C; c++) {
    const a = (c / C) * Math.PI
    const cx = Math.cos(a), cz = Math.sin(a)
    for (let s = 0; s <= N; s++) {
      const v = s / N
      for (const u of [-0.5, 0.5]) {
        pos.push(cx * u, v, cz * u)
        uv.push(u + 0.5, v)
      }
    }
    for (let s = 0; s < N; s++) {
      const r0 = vi + s * 2, r1 = r0 + 2
      idx.push(r0, r0 + 1, r1, r0 + 1, r1 + 1, r1)
    }
    vi += (N + 1) * 2
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  g.computeBoundingSphere(); g.computeBoundingBox()
  return g
}
