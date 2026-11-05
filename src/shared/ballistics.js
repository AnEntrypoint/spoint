function refusal(code, message) {
  const err = new TypeError(`[ballistics] ${message}`)
  err.reasonCode = code
  return err
}

function requirePositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw refusal('ballistics-positive-invalid', `${name} must be a positive finite number`)
  return value
}

function readPoint(value, name) {
  let x, y, z
  if (Array.isArray(value)) [x, y, z] = value
  else if (value && typeof value === 'object') ({ x, y, z } = value)
  else throw refusal('ballistics-point-invalid', `${name} must be a [x,y,z] array or an {x,y,z} object`)
  if (![x, y, z].every(Number.isFinite)) throw refusal('ballistics-point-invalid', `${name} needs three finite coordinates`)
  return { x, y, z }
}

export function elevation(speed, g, distance, rise) {
  requirePositive(speed, 'speed')
  requirePositive(g, 'g')
  if (!Number.isFinite(distance) || distance < 0) throw refusal('ballistics-distance-invalid', 'distance must be a finite number >= 0')
  if (!Number.isFinite(rise)) throw refusal('ballistics-rise-invalid', 'rise must be a finite number')
  if (distance === 0) return null
  const v2 = speed * speed
  const disc = v2 * v2 - g * (g * distance * distance + 2 * rise * v2)
  if (disc < 0) return null
  return Math.atan((v2 - Math.sqrt(disc)) / (g * distance))
}

function staticSolve(from, to, speed, g) {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const distance = Math.hypot(dx, dz)
  const theta = elevation(speed, g, distance, to.y - from.y)
  if (theta === null) return null
  const horizontal = speed * Math.cos(theta)
  if (!(horizontal > 0)) return null
  return {
    vel: { x: (dx / distance) * horizontal, y: speed * Math.sin(theta), z: (dz / distance) * horizontal },
    time: distance / horizontal,
  }
}

export function solveShot(from, to, speed, g, lead = null) {
  const origin = readPoint(from, 'from')
  const target = readPoint(to, 'to')
  requirePositive(speed, 'speed')
  requirePositive(g, 'g')
  const velocity = lead === null ? null : readPoint(lead, 'lead')
  let aim = { ...target }
  let firedAt = aim
  let solution = null
  for (let i = 0; i < 4; i++) {
    firedAt = aim
    solution = staticSolve(origin, firedAt, speed, g)
    if (solution === null) return null
    if (velocity === null) break
    aim = {
      x: target.x + velocity.x * solution.time,
      y: target.y + velocity.y * solution.time,
      z: target.z + velocity.z * solution.time,
    }
  }
  return { ...solution, aim: firedAt }
}
