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

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

function parseCaveAnchor(spec) {
  if (!spec || typeof spec !== 'object') return null
  const { worldX, worldY, worldZ, worldRadius } = spec
  if (!Number.isFinite(worldX) || !Number.isFinite(worldY) || !Number.isFinite(worldZ)) return null
  if (!Number.isFinite(worldRadius) || worldRadius <= 0) return null
  return { worldX, worldY, worldZ, worldRadius }
}

function parseCaveShape(spec, worldRadius) {
  const src = spec && typeof spec === 'object' ? spec : {}
  const axis = typeof src.axis === 'string' ? src.axis : 'y'
  if (src.kind === 'cylinder') {
    const halfHeight = finiteOr(src.halfHeight, 1)
    if (halfHeight <= 0) return null
    return { kind: 'cylinder', halfHeight, axis, verticalSpan: halfHeight }
  }
  if (src.kind === 'tunnel') {
    const length = finiteOr(src.length, worldRadius * 2) / worldRadius
    if (length <= 0) return null
    return {
      kind: 'tunnel',
      length,
      axis,
      seed: finiteOr(src.seed, 0),
      warpAmp: finiteOr(src.warpAmp, 0.15),
      warpFreq: finiteOr(src.warpFreq, 2.5),
      verticalSpan: 1,
    }
  }
  return { kind: 'sphere' }
}

function localSDFFor(shape) {
  if (shape.kind === 'cylinder') return makeCylinderCaveSDF(0, 0, 0, 1, shape.halfHeight, shape.axis)
  if (shape.kind === 'tunnel') return makeTunnelCaveSDF(shape.seed, 1, shape.length, shape.axis, shape.warpAmp, shape.warpFreq)
  return makeSphereCaveSDF(0, 0, 0, 1)
}

function caveVolumeFrom(anchor, shape) {
  const { worldX, worldY, worldZ, worldRadius } = anchor
  const sdf = localSDFFor(shape)
  const localToWorld = (lx, ly, lz) => [worldX + lx * worldRadius, worldY + ly * worldRadius, worldZ + lz * worldRadius]
  const worldToLocal = (wx, wy, wz) => [(wx - worldX) / worldRadius, (wy - worldY) / worldRadius, (wz - worldZ) / worldRadius]
  const worldSDF = (wx, wy, wz) => {
    const [lx, ly, lz] = worldToLocal(wx, wy, wz)
    return sdf(lx, ly, lz) * worldRadius
  }
  return { sdf: worldSDF, localSDF: sdf, localToWorld, worldToLocal, worldX, worldY, worldZ, worldRadius, shape }
}

export function createCaveVolume(worldX, worldY, worldZ, worldRadius, spec = { kind: 'sphere' }) {
  const shape = parseCaveShape(spec, worldRadius)
  if (!shape) throw new TypeError(`createCaveVolume: ${JSON.stringify(spec)} is outside every cave shape domain`)
  return caveVolumeFrom({ worldX, worldY, worldZ, worldRadius }, shape)
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
  if (vol.shape.kind !== 'sphere') {
    if (horizontalDist > vol.worldRadius) return 0
    return vol.worldRadius * vol.shape.verticalSpan
  }
  return Math.sqrt(Math.max(0, vol.worldRadius * vol.worldRadius - horizontalDist * horizontalDist))
}

export function createCaveCarveLayer() {
  const volumes = []

  function addCaveVolume(spec) {
    const anchor = parseCaveAnchor(spec)
    if (!anchor) return { added: false }
    const shape = parseCaveShape(spec, anchor.worldRadius)
    if (!shape) return { added: false }
    volumes.push(caveVolumeFrom(anchor, shape))
    return { added: true, count: volumes.length }
  }

  function addSphereCave(worldX, worldY, worldZ, worldRadius) {
    return addCaveVolume({ worldX, worldY, worldZ, worldRadius, kind: 'sphere' })
  }

  function addCylinderCave(worldX, worldY, worldZ, worldRadius, halfHeight, axis = 'y') {
    return addCaveVolume({ worldX, worldY, worldZ, worldRadius, kind: 'cylinder', halfHeight, axis })
  }

  function addTunnelCave(worldX, worldY, worldZ, worldRadius, length, axis = 'y', seed = 0, warpAmp = 0.15, warpFreq = 2.5) {
    return addCaveVolume({ worldX, worldY, worldZ, worldRadius, kind: 'tunnel', length, axis, seed, warpAmp, warpFreq })
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
    return function caveWrappedHeightFn(x, z, yGuess) {
      const base = baseHeightFn(x, z, yGuess)
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
    addCaveVolume, addSphereCave, addCylinderCave, addTunnelCave, heightDeltaAt, wrapHeightFn, toJSON, clear,
    get volumes() { return volumes.slice() },
    get volumeCount() { return volumes.length },
  }
}

export function loadCaveCarveLayer(json) {
  const layer = createCaveCarveLayer()
  if (json && Array.isArray(json.volumes)) {
    for (const v of json.volumes) layer.addCaveVolume(v)
  }
  return layer
}
