const AXES = 3

function refusal(code, message) {
  const err = new TypeError(`[triggerVolume] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

function readId(value, code, label) {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw refusal(code, `${label} must be a non-empty string or a safe integer, got ${JSON.stringify(value)}`)
}

function readVec3(value) {
  if (!Array.isArray(value) || value.length !== AXES) return false
  for (let i = 0; i < AXES; i += 1) if (!Number.isFinite(value[i])) return false
  return true
}

function readBounds(bounds) {
  if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds) || !readVec3(bounds.min) || !readVec3(bounds.max)) {
    throw refusal('trigger-bounds-invalid', 'bounds needs min[3] and max[3] of finite numbers')
  }
  for (let i = 0; i < AXES; i += 1) {
    if (bounds.min[i] > bounds.max[i]) throw refusal('trigger-bounds-invalid', `bounds.min[${i}] exceeds bounds.max[${i}]`)
  }
  return { min: [...bounds.min], max: [...bounds.max] }
}

function readHook(value, name) {
  if (value === undefined || value === null) return () => {}
  if (typeof value !== 'function') throw refusal('trigger-hooks-invalid', `${name} must be a function`)
  return value
}

export function createTriggerVolume({ id, bounds, onEnter, onExit, rearmMs = 0, now = () => 0, linkedState } = {}) {
  const volumeId = readId(id, 'trigger-id-invalid', 'id')
  const box = readBounds(bounds)
  const enterHook = readHook(onEnter, 'onEnter')
  const exitHook = readHook(onExit, 'onExit')
  const writeHook = readHook(linkedState, 'linkedState')
  if (!Number.isFinite(rearmMs) || rearmMs < 0) throw refusal('trigger-rearm-invalid', 'rearmMs must be a non-negative finite number')
  if (typeof now !== 'function') throw refusal('trigger-clock-invalid', 'now must be a function')

  let overlapping = new Set()
  const active = new Set()
  const pending = new Set()
  let down = false
  let armed = true
  let rearmUntilMs = 0
  let writtenState = 'up'

  function clock() {
    const atMs = now()
    if (!Number.isFinite(atMs)) throw refusal('trigger-clock-invalid', 'now() must return a finite number')
    return atMs
  }

  function inside(p) {
    return p[0] >= box.min[0] && p[0] <= box.max[0]
      && p[1] >= box.min[1] && p[1] <= box.max[1]
      && p[2] >= box.min[2] && p[2] <= box.max[2]
  }

  function write(state, atMs, ids) {
    writtenState = state
    writeHook({ id: volumeId, state, down: state === 'down', overlapping: [...ids], atMs })
  }

  function syncLinked(atMs, ids) {
    const desired = down ? 'down' : 'up'
    if (desired === writtenState) return
    if (down && !armed) return
    write(desired, atMs, ids)
  }

  function emitEnter(entityId, atMs, p, ids) {
    active.add(entityId)
    enterHook(entityId, { id: volumeId, atMs, position: [...p], overlapping: [...ids] })
  }

  function emitExit(entityId, atMs, ids) {
    active.delete(entityId)
    exitHook(entityId, { id: volumeId, atMs, overlapping: [...ids] })
  }

  function update(entities) {
    if (!Array.isArray(entities)) throw refusal('trigger-entities-invalid', 'update(entities) needs an array')
    const atMs = clock()
    const seen = new Set()
    const next = new Set()
    const positions = new Map()
    for (const entity of entities) {
      if (!entity || typeof entity !== 'object' || Array.isArray(entity)) throw refusal('trigger-entity-invalid', 'each entity must be an object with id and position[3]')
      const entityId = readId(entity.id, 'trigger-entity-invalid', 'entity.id')
      if (!readVec3(entity.position)) throw refusal('trigger-entity-invalid', `entity ${String(entityId)} needs position[3] of finite numbers`)
      if (seen.has(entityId)) throw refusal('trigger-duplicate-id', `entity id ${String(entityId)} appears twice in one update`)
      seen.add(entityId)
      if (inside(entity.position)) {
        next.add(entityId)
        positions.set(entityId, entity.position)
      }
    }

    let released = []
    if (!armed && atMs >= rearmUntilMs) {
      armed = true
      released = [...pending]
      pending.clear()
    }

    const entered = []
    const exited = []
    for (const entityId of next) {
      if (overlapping.has(entityId)) continue
      entered.push(entityId)
      if (armed) emitEnter(entityId, atMs, positions.get(entityId), next)
      else pending.add(entityId)
    }
    for (const entityId of overlapping) {
      if (next.has(entityId)) continue
      exited.push(entityId)
      if (active.has(entityId)) emitExit(entityId, atMs, next)
      else pending.delete(entityId)
    }
    for (const entityId of released) {
      if (next.has(entityId) && !active.has(entityId)) emitEnter(entityId, atMs, positions.get(entityId), next)
    }

    const wasDown = down
    down = next.size > 0
    overlapping = next
    syncLinked(atMs, overlapping)
    if (wasDown && !down && armed && rearmMs > 0) {
      armed = false
      rearmUntilMs = atMs + rearmMs
    }
    return { entered, exited, down, up: !down, armed, overlapping: [...overlapping] }
  }

  return {
    get id() { return volumeId },
    get bounds() { return { min: [...box.min], max: [...box.max] } },
    get overlapping() { return new Set(overlapping) },
    get size() { return overlapping.size },
    get down() { return down },
    get up() { return !down },
    get state() { return down ? 'down' : 'up' },
    get armed() { return armed },
    get rearmUntilMs() { return rearmUntilMs },
    update,
  }
}

export default createTriggerVolume
