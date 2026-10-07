import { FIRE_EVENT, FIRE_MAX_WIND_COMPONENT } from './fireKernel.js'

export const FIRE_WIRE_TYPE = 'fire'
export const FIRE_MAX_EXTINGUISH_RADIUS_CELLS = 16
export { FIRE_MAX_WIND_COMPONENT }
export const FIRE_MAX_BYTE = 255
export const FIRE_MAX_IGNITE_RADIUS_CELLS = 8
export const FIRE_SEQ_RANGE = 4096
export const FIRE_MAX_TICK = 2 ** 40
export const FIRE_MAX_ROWS_PER_MESSAGE = 256

const ARITY = Object.freeze({ [FIRE_EVENT.IGNITE]: 5, [FIRE_EVENT.EXTINGUISH]: 5, [FIRE_EVENT.WIND]: 6, [FIRE_EVENT.MOISTURE]: 4, [FIRE_EVENT.RAIN]: 4, [FIRE_EVENT.IGNITE_AREA]: 5 })

function isUint(v) { return Number.isSafeInteger(v) && v >= 0 }

function reject(row, why) { throw new TypeError(`[fire] malformed fire event ${JSON.stringify(row)}: ${why}`) }

export function encodeFireEvent(lattice, ev) {
  switch (ev.kind) {
    case FIRE_EVENT.IGNITE: return [ev.kind, ev.tick, ev.seq, lattice.cellKey(ev.face, ev.I, ev.J), ev.source ?? 0]
    case FIRE_EVENT.EXTINGUISH: case FIRE_EVENT.IGNITE_AREA: return [ev.kind, ev.tick, ev.seq, lattice.cellKey(ev.face, ev.I, ev.J), ev.radius]
    case FIRE_EVENT.WIND: return [ev.kind, ev.tick, ev.seq, ev.wx, ev.wy, ev.wz]
    case FIRE_EVENT.MOISTURE: case FIRE_EVENT.RAIN: return [ev.kind, ev.tick, ev.seq, ev.value]
    default: throw new TypeError(`[fire] cannot encode event kind ${ev.kind}`)
  }
}

export function decodeFireEvent(lattice, row) {
  if (!Array.isArray(row) || !Number.isInteger(row[0]) || ARITY[row[0]] === undefined) reject(row, 'unknown event kind')
  const kind = row[0]
  if (row.length !== ARITY[kind]) reject(row, `expected ${ARITY[kind]} fields`)
  if (!isUint(row[1]) || row[1] > FIRE_MAX_TICK || !isUint(row[2]) || row[2] >= FIRE_SEQ_RANGE) reject(row, `tick must be an integer within 0..2^40 and seq 0..${FIRE_SEQ_RANGE - 1}`)
  const ev = { kind, tick: row[1], seq: row[2], id: row[1] * FIRE_SEQ_RANGE + row[2] }
  if (kind === FIRE_EVENT.IGNITE || kind === FIRE_EVENT.EXTINGUISH || kind === FIRE_EVENT.IGNITE_AREA) {
    const key = row[3], n = lattice.cellsPerFace
    if (!isUint(key) || key >= lattice.faceCount * n * n) reject(row, 'cell key outside the lattice')
    const c = lattice.cellOfKey(key, { face: 0, I: 0, J: 0 })
    ev.face = c.face; ev.I = c.I; ev.J = c.J
    if (kind === FIRE_EVENT.IGNITE) {
      if (!isUint(row[4]) || row[4] > FIRE_MAX_BYTE) reject(row, 'source must be a byte')
      ev.source = row[4]
    } else {
      const maxRadius = kind === FIRE_EVENT.IGNITE_AREA ? FIRE_MAX_IGNITE_RADIUS_CELLS : FIRE_MAX_EXTINGUISH_RADIUS_CELLS
      if (!isUint(row[4]) || row[4] > maxRadius) reject(row, `radius must be 0..${maxRadius} cells`)
      ev.radius = row[4]
    }
  } else if (kind === FIRE_EVENT.WIND) {
    for (let i = 3; i < 6; i++) if (!Number.isInteger(row[i]) || Math.abs(row[i]) > FIRE_MAX_WIND_COMPONENT) reject(row, `wind components must be integers within +-${FIRE_MAX_WIND_COMPONENT}`)
    ev.wx = row[3]; ev.wy = row[4]; ev.wz = row[5]
  } else {
    if (!isUint(row[3]) || row[3] > FIRE_MAX_BYTE) reject(row, 'value must be a byte')
    ev.value = row[3]
  }
  return ev
}
