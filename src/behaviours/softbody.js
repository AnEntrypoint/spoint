let _RAPIER = null
let _rapierInitPromise = null

async function _ensureRapier() {
  if (_RAPIER) return _RAPIER
  if (!_rapierInitPromise) {
    _rapierInitPromise = import('@dimforge/rapier3d-compat').then(async (mod) => {
      const RAPIER = mod.default || mod
      await RAPIER.init()
      _RAPIER = RAPIER
      return RAPIER
    })
  }
  return _rapierInitPromise
}

function _validateSpec(spec) {
  if (spec !== null && typeof spec !== 'object') throw new TypeError('[softbody] spec must be an object')
  const s = spec || {}
  if (s.cols != null && (!Number.isInteger(s.cols) || s.cols < 2)) throw new TypeError('[softbody] cols must be an integer >= 2')
  if (s.rows != null && (!Number.isInteger(s.rows) || s.rows < 2)) throw new TypeError('[softbody] rows must be an integer >= 2')
  if (s.spacing != null && (typeof s.spacing !== 'number' || !Number.isFinite(s.spacing) || s.spacing <= 0)) throw new TypeError('[softbody] spacing must be a positive finite number')
  if (s.mass != null && (typeof s.mass !== 'number' || !Number.isFinite(s.mass) || s.mass <= 0)) throw new TypeError('[softbody] mass must be a positive finite number (total cloth mass, split across particles)')
  if (s.stiffness != null && (typeof s.stiffness !== 'number' || !Number.isFinite(s.stiffness) || s.stiffness <= 0)) throw new TypeError('[softbody] stiffness must be a positive finite number')
  if (s.damping != null && (typeof s.damping !== 'number' || !Number.isFinite(s.damping) || s.damping < 0)) throw new TypeError('[softbody] damping must be a non-negative finite number')
  if (s.gravity != null && !(Array.isArray(s.gravity) && s.gravity.length === 3 && s.gravity.every(Number.isFinite))) throw new TypeError('[softbody] gravity must be a [x,y,z] array of finite numbers')
  if (s.pins != null && !Array.isArray(s.pins) && s.pins !== 'top-corners' && s.pins !== 'top-row') throw new TypeError('[softbody] pins must be an array of [col,row] pairs (or the string "top-corners"/"top-row")')
  if (s.wind != null && !(Array.isArray(s.wind) && s.wind.length === 3 && s.wind.every(Number.isFinite))) throw new TypeError('[softbody] wind must be a [x,y,z] force-per-particle array')
  if (s.substeps != null && (!Number.isInteger(s.substeps) || s.substeps < 1)) throw new TypeError('[softbody] substeps must be a positive integer')
}

function _resolvePins(pins, cols, rows) {
  const out = new Set()
  if (pins == null || pins === 'top-corners') {
    out.add(`0,0`); out.add(`${cols - 1},0`)
    return out
  }
  if (pins === 'top-row') {
    for (let c = 0; c < cols; c++) out.add(`${c},0`)
    return out
  }
  if (Array.isArray(pins)) {
    for (const p of pins) {
      if (!Array.isArray(p) || p.length !== 2) continue
      out.add(`${p[0]},${p[1]}`)
    }
    return out
  }
  return out
}

export function createSoftbodyCloth(spec = {}, appCtx = null) {
  _validateSpec(spec)
  if (!appCtx) throw new TypeError('[softbody] appCtx is required')

  const cols = spec.cols ?? 6
  const rows = spec.rows ?? 6
  const spacing = spec.spacing ?? 0.3
  const totalMass = spec.mass ?? 2
  const stiffness = spec.stiffness ?? 200
  const damping = spec.damping ?? 4
  const gravity = spec.gravity ?? [0, -9.81, 0]
  const wind = spec.wind ?? null
  const bendSprings = spec.bendSprings !== false
  const substeps = spec.substeps ?? 1
  const pinKeys = _resolvePins(spec.pins, cols, rows)

  const particleCount = cols * rows
  const nonPinnedCount = particleCount - pinKeys.size
  const perParticleMass = Math.max(0.01, totalMass / Math.max(1, nonPinnedCount))

  const _origin = [...appCtx.entity.position]
  const _positions = new Float64Array(particleCount * 3)
  let _ready = false
  let _disposed = false
  let _world = null
  const _bodies = []

  function _idx(col, row) { return row * cols + col }

  async function _build() {
    const RAPIER = await _ensureRapier()
    if (_disposed) return
    _world = new RAPIER.World({ x: gravity[0], y: gravity[1], z: gravity[2] })

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const key = `${col},${row}`
        const px = _origin[0] + col * spacing
        const py = _origin[1] - row * spacing
        const pz = _origin[2]
        const pinned = pinKeys.has(key)
        const desc = pinned ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic()
        desc.setTranslation(px, py, pz)
        const body = _world.createRigidBody(desc)
        const particleColliderDesc = RAPIER.ColliderDesc.ball(Math.max(0.02, spacing * 0.15)).setDensity(1).setMass(perParticleMass)
        _world.createCollider(particleColliderDesc, body)
        _bodies[_idx(col, row)] = body
        const i3 = _idx(col, row) * 3
        _positions[i3] = px; _positions[i3 + 1] = py; _positions[i3 + 2] = pz
      }
    }

    const addSpring = ([c1, r1], [c2, r2]) => {
      const bA = _bodies[_idx(c1, r1)], bB = _bodies[_idx(c2, r2)]
      const dx = (c2 - c1) * spacing, dy = (r1 - r2) * spacing, dz = 0
      const restLen = Math.hypot(dx, dy, dz)
      const params = RAPIER.JointData.spring(restLen, stiffness, damping, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
      _world.createImpulseJoint(params, bA, bB, true)
    }

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (col + 1 < cols) addSpring([col, row], [col + 1, row])
        if (row + 1 < rows) addSpring([col, row], [col, row + 1])
        if (bendSprings) {
          if (col + 2 < cols) addSpring([col, row], [col + 2, row])
          if (row + 2 < rows) addSpring([col, row], [col, row + 2])
        }
      }
    }

    _ready = true
  }

  _build()

  function tick(dt) {
    if (!_ready || _disposed || !_world) return
    const subDt = dt / substeps
    for (let s = 0; s < substeps; s++) {
      if (wind) {
        for (let i = 0; i < _bodies.length; i++) {
          const b = _bodies[i]
          if (b.isFixed()) continue
          b.resetForces(true)
          b.addForce({ x: wind[0], y: wind[1], z: wind[2] }, true)
        }
      }
      _world.timestep = subDt
      _world.step()
    }
    for (let i = 0; i < _bodies.length; i++) {
      const t = _bodies[i].translation()
      const i3 = i * 3
      _positions[i3] = t.x; _positions[i3 + 1] = t.y; _positions[i3 + 2] = t.z
    }
  }

  function positions() { return _positions }

  let _lastPublished = null
  const PUBLISH_EPS_METERS = 0.0008
  function publish() {
    if (!_ready) return false
    if (_lastPublished) {
      let maxDelta = 0
      for (let i = 0; i < _positions.length; i++) {
        const d = Math.abs(_positions[i] - _lastPublished[i])
        if (d > maxDelta) maxDelta = d
      }
      if (maxDelta < PUBLISH_EPS_METERS) return false
    }
    _lastPublished = Float64Array.from(_positions)
    appCtx.entity.custom = {
      ...(appCtx.entity.custom || {}),
      softbody: { cols, rows, spacing, positions: Array.from(_positions) }
    }
    return true
  }

  function setPin(col, row, pinned) {
    if (!_ready) return false
    const b = _bodies[_idx(col, row)]
    if (!b) return false
    b.setBodyType(pinned ? _RAPIER.RigidBodyType.Fixed : _RAPIER.RigidBodyType.Dynamic, true)
    const key = `${col},${row}`
    if (pinned) pinKeys.add(key); else pinKeys.delete(key)
    return true
  }

  function dispose() {
    if (_disposed) return
    _disposed = true
    if (_world) { _world.free(); _world = null }
    _bodies.length = 0
  }
  if (typeof appCtx._registerDisposer === 'function') appCtx._registerDisposer(dispose)

  return {
    get ready() { return _ready },
    get particleCount() { return particleCount },
    get pinnedKeys() { return new Set(pinKeys) },
    tick,
    positions,
    publish,
    setPin,
    dispose
  }
}

export default createSoftbodyCloth
