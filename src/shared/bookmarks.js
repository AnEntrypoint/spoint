import { angleFromAnchorDeg } from './relocation.js'
import { DEFAULT_MAX_SLOPE_ANGLE_RAD } from '../physics/CharacterManager.js'

const AXIS_NAMES = ['x', 'y', 'z']
const OUT_KM = [5, 20, 100]
const SEARCH_BOOKMARKS = ['coast', 'hills', 'forest', 'rocks']
const REACHABLE_BELOW_ANCHOR_DEG = 87
const WALKABLE_BELOW_ANCHOR_DEG = DEFAULT_MAX_SLOPE_ANGLE_RAD * 180 / Math.PI

function cubeDirections() {
  const out = []
  for (let code = 1; code < 27; code++) {
    let rest = code, count = 0
    const dir = [0, 0, 0], parts = []
    for (let a = 0; a < 3; a++) {
      const digit = rest % 3
      rest = (rest - digit) / 3
      if (!digit) continue
      dir[a] = digit === 1 ? 1 : -1
      parts.push((digit === 1 ? 'p' : 'n') + AXIS_NAMES[a])
      count++
    }
    out.push({ name: (count === 1 ? 'face-' : count === 2 ? 'seam-' : 'corner-') + parts.join('-'), dir })
  }
  return out
}

export function listBookmarks(worldDef, frame) {
  const list = []
  const sp = worldDef?.spawnPoint
  if (Array.isArray(sp) && sp.length === 3) list.push({ name: 'spawn', spec: { x: sp[0], standNearY: sp[1], z: sp[2] } })
  for (const e of worldDef?.entities || []) {
    if (e.app === 'spawn-point' && Array.isArray(e.position)) list.push({ name: String(e.id).replace(/^spawn-/, ''), spec: { x: e.position[0], standNearY: e.position[1], z: e.position[2] } })
  }
  list.push({ name: 'origin', spec: { x: 0, z: 0 } })
  for (const km of OUT_KM) list.push({ name: `out-${km}km`, spec: { x: km * 1000, z: 0 } })
  for (const name of SEARCH_BOOKMARKS) list.push({ name, search: name })
  const directions = cubeDirections()
  directions.push({ name: 'pole-north', dir: [0, 1, 0] }, { name: 'pole-south', dir: [0, -1, 0] })
  for (const d of directions) {
    const angleDeg = frame ? angleFromAnchorDeg(frame, d.dir) : null
    const known = angleDeg !== null
    list.push({ name: d.name, spec: { dir: d.dir }, angleDeg, reachable: known ? angleDeg < REACHABLE_BELOW_ANCHOR_DEG : null, tiltWalkable: known ? angleDeg < WALKABLE_BELOW_ANCHOR_DEG : null })
  }
  return list
}
