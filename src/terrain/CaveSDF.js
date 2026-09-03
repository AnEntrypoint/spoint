import { marchRockSurface } from './RockShapes.js'

function tunnelHash(seed, i) {
  let h = seed | 0
  h = Math.imul(h ^ (i | 0), 0x27d4eb2d) >>> 0
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39) >>> 0
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

export function makeSphereCaveSDF(cx, cy, cz, radius) {
  return (x, y, z) => {
    const dx = x - cx, dy = y - cy, dz = z - cz
    return Math.sqrt(dx * dx + dy * dy + dz * dz) - radius
  }
}

export function makeCylinderCaveSDF(cx, cy, cz, radius, halfHeight, axis = 'y') {
  return (x, y, z) => {
    const dx = x - cx, dy = y - cy, dz = z - cz
    let radial, along, halfSpan
    if (axis === 'x') { radial = Math.hypot(dy, dz); along = dx; halfSpan = halfHeight }
    else if (axis === 'z') { radial = Math.hypot(dx, dy); along = dz; halfSpan = halfHeight }
    else { radial = Math.hypot(dx, dz); along = dy; halfSpan = halfHeight }
    const dRadial = radial - radius
    const dAlong = Math.abs(along) - halfSpan
    const outsideX = Math.max(dRadial, 0), outsideY = Math.max(dAlong, 0)
    const outsideDist = Math.hypot(outsideX, outsideY)
    const insideDist = Math.min(Math.max(dRadial, dAlong), 0)
    return outsideDist + insideDist
  }
}

export function makeTunnelCaveSDF(seed, radius, length, axis = 'y', warpAmp = 0.15, warpFreq = 2.5) {
  return (x, y, z) => {
    let along, u, v
    if (axis === 'x') { along = x; u = y; v = z }
    else if (axis === 'z') { along = z; u = x; v = y }
    else { along = y; u = x; v = z }
    const t = Math.max(-1, Math.min(1, along / (length * 0.5)))
    const sampleIdx = Math.round((t + 1) * 0.5 * 1000)
    const warpU = (tunnelHash(seed, sampleIdx * 2) * 2 - 1) * warpAmp * Math.sin(t * Math.PI * warpFreq + tunnelHash(seed, 1) * 6.28318)
    const warpV = (tunnelHash(seed, sampleIdx * 2 + 1) * 2 - 1) * warpAmp * Math.cos(t * Math.PI * warpFreq + tunnelHash(seed, 2) * 6.28318)
    const du = u - warpU, dv = v - warpV
    const dRadial = Math.hypot(du, dv) - radius
    const dAlong = Math.abs(along) - length * 0.5
    const outsideX = Math.max(dRadial, 0), outsideY = Math.max(dAlong, 0)
    const outsideDist = Math.hypot(outsideX, outsideY)
    const insideDist = Math.min(Math.max(dRadial, dAlong), 0)
    return outsideDist + insideDist
  }
}

export function polygonizeCaveSDF(sdf, res = 24) {
  return marchRockSurface(res, sdf)
}

function localSDFFor(shape) {
  if (shape.kind === 'cylinder') return makeCylinderCaveSDF(0, 0, 0, 1, shape.halfHeight ?? 1, shape.axis ?? 'y')
  if (shape.kind === 'tunnel') return makeTunnelCaveSDF(shape.seed ?? 0, 1, shape.length ?? 2, shape.axis ?? 'y', shape.warpAmp ?? 0.15, shape.warpFreq ?? 2.5)
  return makeSphereCaveSDF(0, 0, 0, 1)
}

export function createCaveVolume(worldX, worldY, worldZ, worldRadius, shape = { kind: 'sphere' }) {
  const sdf = localSDFFor(shape)
  const localToWorld = (lx, ly, lz) => [worldX + lx * worldRadius, worldY + ly * worldRadius, worldZ + lz * worldRadius]
  const worldToLocal = (wx, wy, wz) => [(wx - worldX) / worldRadius, (wy - worldY) / worldRadius, (wz - worldZ) / worldRadius]
  const worldSDF = (wx, wy, wz) => {
    const [lx, ly, lz] = worldToLocal(wx, wy, wz)
    return sdf(lx, ly, lz) * worldRadius
  }
  return { sdf: worldSDF, localSDF: sdf, localToWorld, worldToLocal, worldX, worldY, worldZ, worldRadius, shape }
}

export function polygonizeCaveVolume(caveVolume, res = 24) {
  const local = polygonizeCaveSDF(caveVolume.localSDF, res)
  const positions = new Float32Array(local.positions.length)
  for (let v = 0; v < local.vc; v++) {
    const [wx, wy, wz] = caveVolume.localToWorld(local.positions[v * 3], local.positions[v * 3 + 1], local.positions[v * 3 + 2])
    positions[v * 3] = wx
    positions[v * 3 + 1] = wy
    positions[v * 3 + 2] = wz
  }
  return { positions: positions.subarray(0, local.vc * 3), vc: local.vc, indices: local.indices, ic: local.ic }
}

function volumeVerticalSpan(vol, horizontalDist) {
  if (vol.shape.kind === 'cylinder' || vol.shape.kind === 'tunnel') {
    if (horizontalDist > vol.worldRadius) return 0
    return vol.worldRadius * (vol.shape.halfHeight ?? 1)
  }
  return Math.sqrt(Math.max(0, vol.worldRadius * vol.worldRadius - horizontalDist * horizontalDist))
}

export function createCaveCarveLayer() {
  const volumes = []

  function addSphereCave(worldX, worldY, worldZ, worldRadius) {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY) || !Number.isFinite(worldZ)) return { added: false }
    if (!Number.isFinite(worldRadius) || worldRadius <= 0) return { added: false }
    volumes.push(createCaveVolume(worldX, worldY, worldZ, worldRadius, { kind: 'sphere' }))
    return { added: true, count: volumes.length }
  }

  function addCylinderCave(worldX, worldY, worldZ, worldRadius, halfHeight, axis = 'y') {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY) || !Number.isFinite(worldZ)) return { added: false }
    if (!Number.isFinite(worldRadius) || worldRadius <= 0) return { added: false }
    if (!Number.isFinite(halfHeight) || halfHeight <= 0) return { added: false }
    volumes.push(createCaveVolume(worldX, worldY, worldZ, worldRadius, { kind: 'cylinder', halfHeight, axis }))
    return { added: true, count: volumes.length }
  }

  function addTunnelCave(worldX, worldY, worldZ, worldRadius, length, axis = 'y', seed = 0, warpAmp = 0.15, warpFreq = 2.5) {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY) || !Number.isFinite(worldZ)) return { added: false }
    if (!Number.isFinite(worldRadius) || worldRadius <= 0) return { added: false }
    if (!Number.isFinite(length) || length <= 0) return { added: false }
    volumes.push(createCaveVolume(worldX, worldY, worldZ, worldRadius, { kind: 'tunnel', length: length / worldRadius, axis, seed, warpAmp, warpFreq }))
    return { added: true, count: volumes.length }
  }

  function heightDeltaAt(x, z, surfaceY) {
    if (volumes.length === 0) return 0
    let delta = 0
    for (const vol of volumes) {
      const dx = x - vol.worldX, dz = z - vol.worldZ
      const horizontalDist = Math.hypot(dx, dz)
      if (horizontalDist > vol.worldRadius) continue
      const verticalSpan = volumeVerticalSpan(vol, horizontalDist)
      if (verticalSpan <= 0) continue
      const caveTop = vol.worldY + verticalSpan
      if (caveTop < surfaceY) continue
      delta -= (caveTop - surfaceY) + verticalSpan
    }
    return delta
  }

  function wrapHeightFn(baseHeightFn) {
    if (typeof baseHeightFn !== 'function') return baseHeightFn
    return function caveWrappedHeightFn(x, z) {
      const base = baseHeightFn(x, z)
      if (!Number.isFinite(base)) return base
      return base + heightDeltaAt(x, z, base)
    }
  }

  function toJSON() {
    return {
      version: 2,
      volumes: volumes.map(v => ({
        worldX: v.worldX, worldY: v.worldY, worldZ: v.worldZ, worldRadius: v.worldRadius,
        kind: v.shape.kind, halfHeight: v.shape.halfHeight, axis: v.shape.axis,
        length: v.shape.length != null ? v.shape.length * v.worldRadius : undefined,
        seed: v.shape.seed, warpAmp: v.shape.warpAmp, warpFreq: v.shape.warpFreq,
      })),
    }
  }

  function clear() { volumes.length = 0 }

  return {
    addSphereCave, addCylinderCave, addTunnelCave, heightDeltaAt, wrapHeightFn, toJSON, clear,
    get volumes() { return volumes.slice() },
    get volumeCount() { return volumes.length },
  }
}

export function loadCaveCarveLayer(json) {
  const layer = createCaveCarveLayer()
  if (json && Array.isArray(json.volumes)) {
    for (const v of json.volumes) {
      if (!v || !Number.isFinite(v.worldX) || !Number.isFinite(v.worldY) || !Number.isFinite(v.worldZ) || !Number.isFinite(v.worldRadius)) continue
      if (v.kind === 'cylinder') layer.addCylinderCave(v.worldX, v.worldY, v.worldZ, v.worldRadius, v.halfHeight ?? 1, v.axis ?? 'y')
      else if (v.kind === 'tunnel') layer.addTunnelCave(v.worldX, v.worldY, v.worldZ, v.worldRadius, v.length ?? v.worldRadius * 2, v.axis ?? 'y', v.seed ?? 0, v.warpAmp ?? 0.15, v.warpFreq ?? 2.5)
      else layer.addSphereCave(v.worldX, v.worldY, v.worldZ, v.worldRadius)
    }
  }
  return layer
}
