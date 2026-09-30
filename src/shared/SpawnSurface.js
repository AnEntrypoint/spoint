const COLUMN_ABOVE_LIFT_M = 1
const COLUMN_RAY_LENGTH_M = 2000
const MAX_COLUMN_SURFACES = 24
const BELOW_HIT_SKIN_M = 0.02
const INSIDE_SOLID_LEAP_M = 0.25
const MIN_UP_NORMAL_Y = Math.cos(Math.PI / 4)
const MAX_LIFT_BODY_HEIGHTS = 2
const MAX_COLUMN_RAYS = 64

function hitY(r) {
  return r && r.hit && Number.isFinite(r.position?.[1]) ? r.position[1] : null
}

function walkable(r) {
  const n = r.normal
  return !n || !Number.isFinite(n[1]) || n[1] >= MIN_UP_NORMAL_Y
}

export function columnSurfaces(raycast, x, topY, z) {
  const surfaces = []
  let originY = topY
  let remaining = COLUMN_RAY_LENGTH_M
  let leap = INSIDE_SOLID_LEAP_M
  for (let i = 0; i < MAX_COLUMN_RAYS && surfaces.length < MAX_COLUMN_SURFACES && remaining > 0; i++) {
    const r = raycast([x, originY, z], [0, -1, 0], remaining)
    const y = hitY(r)
    if (y === null) break
    const startedInsideSolid = originY - y < BELOW_HIT_SKIN_M
    if (!startedInsideSolid && walkable(r)) surfaces.push(y)
    const nextY = startedInsideSolid ? originY - leap : y - BELOW_HIT_SKIN_M
    leap = startedInsideSolid ? leap * 2 : INSIDE_SOLID_LEAP_M
    remaining -= originY - nextY
    originY = nextY
  }
  return surfaces
}

const RIM_OFFSETS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

function clearAbove(raycast, x, surfaceY, z, headroom) {
  return hitY(raycast([x, surfaceY + BELOW_HIT_SKIN_M, z], [0, 1, 0], headroom)) === null
}

function hasHeadroom(raycast, x, surfaceY, z, headroom, radius) {
  if (!clearAbove(raycast, x, surfaceY, z, headroom)) return false
  if (!(radius > 0) || !(headroom > radius)) return true
  const rimBaseY = surfaceY + radius
  for (const [ox, oz] of RIM_OFFSETS) if (!clearAbove(raycast, x + ox * radius, rimBaseY, z + oz * radius, headroom - radius)) return false
  return true
}

export function spawnSurfaceY(raycast, pose, { standingOffset, headroom = 2 * standingOffset, terrainY = null, radius = 0 }) {
  if (typeof raycast !== 'function' || !Number.isFinite(pose?.[1]) || !(standingOffset > 0) || !(headroom > 0)) return null
  const x = pose[0], z = pose[2]
  const poseY = Number.isFinite(terrainY) ? Math.max(pose[1], terrainY) : pose[1]
  const feetY = poseY - standingOffset
  const liftCeilingY = feetY + MAX_LIFT_BODY_HEIGHTS * headroom
  let standing = null, lifted = null, dropped = null
  for (const y of columnSurfaces(raycast, x, liftCeilingY + COLUMN_ABOVE_LIFT_M, z)) {
    if (!hasHeadroom(raycast, x, y, z, headroom, radius)) continue
    if (y > poseY) { if (y <= liftCeilingY) lifted = y }
    else if (y >= feetY - standingOffset) { if (standing === null) standing = y }
    else if (dropped === null) dropped = y
  }
  return standing ?? lifted ?? dropped
}
