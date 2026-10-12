export const CONTACT_FIELD = Object.freeze({
  WINDOW_M: 512,
  TEXEL_M: 1.0,
  CENTRE_SNAP_M: 32,
  RECENTRE_SLACK_M: 64,
  FULL_LIGHT: 255,
  FALLOFF_SOFTNESS: 2,
  TREE_STRENGTH: 0.5,
  TREE_ZONE_SCALE: 1.25,
  BUSH_STRENGTH: 0.35,
  ROCK_STRENGTH: 0.45,
})

const BUSH_SPECIES = new Set([4, 9, 10])

function smoothstepUnit(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

export function treeContactStamps(placements) {
  const out = []
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i]
    const bush = BUSH_SPECIES.has(p.species)
    const r0 = bush ? 0.6 * p.scale : (0.35 * p.scale + 0.3) * CONTACT_FIELD.TREE_ZONE_SCALE
    const span = (bush ? 1.2 * p.scale : 1.8 * p.scale * CONTACT_FIELD.TREE_ZONE_SCALE) * CONTACT_FIELD.FALLOFF_SOFTNESS
    out.push({ x: p.x, z: p.z, r0, r1: r0 + span, strength: bush ? CONTACT_FIELD.BUSH_STRENGTH : CONTACT_FIELD.TREE_STRENGTH })
  }
  return out
}

export function rockContactStamps(placements) {
  const out = []
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i]
    const r0 = 0.5 * p.scale
    out.push({ x: p.x, z: p.z, r0, r1: r0 + 0.5 * p.scale * CONTACT_FIELD.FALLOFF_SOFTNESS, strength: CONTACT_FIELD.ROCK_STRENGTH })
  }
  return out
}

export function createContactField({ windowM = CONTACT_FIELD.WINDOW_M, texelM = CONTACT_FIELD.TEXEL_M } = {}) {
  const size = Math.round(windowM / texelM)
  return {
    windowM,
    texelM,
    size,
    data: new Uint8Array(size * size).fill(CONTACT_FIELD.FULL_LIGHT),
    originX: 0,
    originZ: 0,
    centreX: NaN,
    centreZ: NaN,
    dirty: true,
    chunks: new Map(),
  }
}

function texelBounds(field, minX, minZ, maxX, maxZ) {
  const T = field.texelM, S = field.size
  return {
    i0: Math.max(0, Math.floor((minX - field.originX) / T)),
    i1: Math.min(S - 1, Math.floor((maxX - field.originX) / T)),
    j0: Math.max(0, Math.floor((minZ - field.originZ) / T)),
    j1: Math.min(S - 1, Math.floor((maxZ - field.originZ) / T)),
  }
}

function clipToWindow(field, minX, minZ, maxX, maxZ) {
  const wx1 = field.originX + field.windowM, wz1 = field.originZ + field.windowM
  return [Math.max(minX, field.originX), Math.max(minZ, field.originZ), Math.min(maxX, wx1), Math.min(maxZ, wz1)]
}

function stampRect(stamp) {
  return [stamp.x - stamp.r1, stamp.z - stamp.r1, stamp.x + stamp.r1, stamp.z + stamp.r1]
}

function stampInto(field, stamp, clip) {
  const [sx0, sz0, sx1, sz1] = stampRect(stamp)
  const r = clipToWindow(field, Math.max(sx0, clip[0]), Math.max(sz0, clip[1]), Math.min(sx1, clip[2]), Math.min(sz1, clip[3]))
  if (r[2] <= r[0] || r[3] <= r[1]) return
  const b = texelBounds(field, r[0], r[1], r[2], r[3])
  const T = field.texelM, S = field.size, ox = field.originX, oz = field.originZ
  const span = stamp.r1 - stamp.r0
  for (let j = b.j0; j <= b.j1; j++) {
    const dz = oz + (j + 0.5) * T - stamp.z
    const row = j * S
    for (let i = b.i0; i <= b.i1; i++) {
      const dx = ox + (i + 0.5) * T - stamp.x
      const d = Math.sqrt(dx * dx + dz * dz)
      const darkness = stamp.strength * (1 - smoothstepUnit(stamp.r0, stamp.r0 + span, d))
      const light = Math.round((1 - darkness) * CONTACT_FIELD.FULL_LIGHT)
      if (light < field.data[row + i]) field.data[row + i] = light
    }
  }
}

function stampChunksInto(field, clip, skipKey) {
  for (const [key, chunk] of field.chunks) {
    if (key === skipKey) continue
    const [bx0, bz0, bx1, bz1] = chunk.bounds
    if (bx1 < clip[0] || bx0 > clip[2] || bz1 < clip[1] || bz0 > clip[3]) continue
    for (const stamp of chunk.stamps) stampInto(field, stamp, clip)
  }
}

function clearRect(field, clip) {
  const b = texelBounds(field, clip[0], clip[1], clip[2], clip[3])
  const S = field.size
  for (let j = b.j0; j <= b.j1; j++) field.data.fill(CONTACT_FIELD.FULL_LIGHT, j * S + b.i0, j * S + b.i1 + 1)
}

function boundsOfStamps(stamps) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  for (const s of stamps) {
    const r = stampRect(s)
    if (r[0] < x0) x0 = r[0]
    if (r[1] < z0) z0 = r[1]
    if (r[2] > x1) x1 = r[2]
    if (r[3] > z1) z1 = r[3]
  }
  return [x0, z0, x1, z1]
}

export function contactFieldLoadChunk(field, key, stamps) {
  if (field.chunks.has(key)) contactFieldUnloadChunk(field, key)
  if (stamps.length === 0) {
    field.chunks.set(key, { stamps, bounds: [Infinity, Infinity, -Infinity, -Infinity] })
    return
  }
  const bounds = boundsOfStamps(stamps)
  field.chunks.set(key, { stamps, bounds })
  const clip = clipToWindow(field, ...bounds)
  if (clip[2] <= clip[0] || clip[3] <= clip[1]) return
  for (const stamp of stamps) stampInto(field, stamp, clip)
  field.dirty = true
}

export function contactFieldUnloadChunk(field, key) {
  const chunk = field.chunks.get(key)
  if (!chunk) return
  field.chunks.delete(key)
  if (chunk.stamps.length === 0) return
  const clip = clipToWindow(field, ...chunk.bounds)
  if (clip[2] <= clip[0] || clip[3] <= clip[1]) return
  clearRect(field, clip)
  stampChunksInto(field, clip, null)
  field.dirty = true
}

export function contactFieldRecentre(field, camX, camZ) {
  const drift = Math.hypot(camX - field.centreX, camZ - field.centreZ)
  if (drift <= CONTACT_FIELD.RECENTRE_SLACK_M) return false
  const snap = CONTACT_FIELD.CENTRE_SNAP_M
  field.centreX = Math.round(camX / snap) * snap
  field.centreZ = Math.round(camZ / snap) * snap
  field.originX = field.centreX - field.windowM / 2
  field.originZ = field.centreZ - field.windowM / 2
  field.data.fill(CONTACT_FIELD.FULL_LIGHT)
  const clip = [field.originX, field.originZ, field.originX + field.windowM, field.originZ + field.windowM]
  stampChunksInto(field, clip, null)
  field.dirty = true
  return true
}

export const contactOcclusionField = createContactField()
