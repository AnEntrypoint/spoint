import { readVec3, sub, dot, length, normalize } from '../shared/vec3.js'

function refusal(code, message) {
  const err = new TypeError(`[press-router] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function routePress({ objects, origin, forward, maxDistance = 3, maxAngleRad = Math.PI / 6, label = 'Press E' } = {}) {
  if (!Array.isArray(objects)) throw refusal('press-objects-invalid', 'objects must be an array')
  readVec3(origin, 'origin')
  readVec3(forward, 'forward')
  if (!Number.isFinite(maxDistance) || maxDistance <= 0) throw refusal('press-distance-invalid', 'maxDistance must be a positive finite number')
  if (!Number.isFinite(maxAngleRad) || maxAngleRad < 0 || maxAngleRad > Math.PI) throw refusal('press-angle-invalid', 'maxAngleRad must be finite in [0,PI]')
  const facing = normalize(forward)
  let best = null
  for (const [i, obj] of objects.entries()) {
    if (!obj || typeof obj !== 'object' || typeof obj.id !== 'string' || !obj.id) throw refusal('press-object-invalid', `objects[${i}] needs a string id`)
    readVec3(obj.position, `objects[${i}].position`)
    const delta = sub(obj.position, origin)
    const distance = length(delta)
    if (distance > maxDistance || distance === 0) continue
    const cos = dot(normalize(delta), facing)
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)))
    if (angle > maxAngleRad) continue
    if (best === null || distance < best.distance) best = { id: obj.id, distance, angle }
  }
  if (best === null) return { ok: false, target: null, label, reasonCode: 'press-no-target' }
  return { ok: true, target: best.id, distance: best.distance, angle: best.angle, label, reasonCode: null }
}

export function createEventRouter() {
  const subs = new Map()
  const presses = []
  return {
    subscribe(channel, to, handler) {
      if (typeof channel !== 'string' || !channel || typeof handler !== 'function') throw refusal('press-subscribe-invalid', 'channel and handler are required')
      const key = `${channel}\u0000${String(to ?? '*')}`
      if (!subs.has(key)) subs.set(key, [])
      subs.get(key).push(handler)
      return () => { subs.set(key, subs.get(key).filter(fn => fn !== handler)) }
    },
    onPress(hook) {
      if (typeof hook !== 'function') throw refusal('press-hook-invalid', 'onPress needs a function')
      presses.push(hook)
    },
    emit(channel, payload, { to = null } = {}) {
      const envelopes = []
      for (const fn of presses) fn({ channel, payload, to })
      for (const [key, handlers] of subs.entries()) {
        const [ch, target] = key.split('\u0000')
        if (ch !== channel || (target !== '*' && to !== null && target !== String(to))) continue
        for (const fn of handlers) envelopes.push(fn(payload))
      }
      return { channel, to, delivered: envelopes.length }
    },
  }
}
