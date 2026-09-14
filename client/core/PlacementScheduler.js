const PLACEMENT_INTERVAL_MS = 250
const MIN_TICK_GAP_MS = 40

const _authFocus = { x: 0, y: 0, z: 0 }

const _psPos = { x: 0, y: 0, z: 0 }
export function resolveCameraPose(camera, out) {
  const o = out || { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
  if (!camera) return o
  try {
    camera.updateWorldMatrix(true, false)
    const e = camera.matrixWorld.elements
    o.x = e[12]; o.y = e[13]; o.z = e[14]
    const q = camera.quaternion
    o.qx = q.x; o.qy = q.y; o.qz = q.z; o.qw = q.w
  } catch (_) {}
  return o
}

export function warmSceneryShaders(renderer, scene, camera) {
  if (!renderer || !scene || !camera) return 0
  try { renderer.render(scene, camera); renderer.render(scene, camera) } catch (_) {}
  return 2
}

export function createPlacementScheduler(getHandles) {
  let _lastTickAtMs = -Infinity
  let _timer = null
  let _lastRealMs = null

  function shouldTick(nowMs) {
    if (nowMs - _lastTickAtMs < MIN_TICK_GAP_MS) return false
    _lastTickAtMs = nowMs
    return true
  }

  function runPlacementTick(nowMs) {
    if (!shouldTick(nowMs)) return false
    const h = getHandles()
    if (!h) return false
    const { vegetation, rocks, grass, camera, floatingOrigin, pm } = h
    if (!camera || !(vegetation || rocks || grass)) return false

    const dt = _lastRealMs == null ? 0 : Math.min(Math.max((nowMs - _lastRealMs) / 1000, 0.001), 1.0)
    _lastRealMs = nowMs

    let focus = camera.position
    if (floatingOrigin) {
      focus = floatingOrigin.toAuthoritative(
        focus.position ? { x: focus.position[0], y: focus.position[1], z: focus.position[2] } : focus,
        _authFocus,
      )
    }

    if (vegetation && typeof vegetation.update === 'function') {
      try { vegetation.update(dt, camera, focus, true) } catch (_) {}
    }
    if (rocks && typeof rocks.update === 'function') {
      try { rocks.update(dt, camera, focus) } catch (_) {}
    }
    if (grass && typeof grass.update === 'function') {
      try { grass.update(dt, camera, focus, _EMPTY_BENDERS) } catch (_) {}
    }
    return true
  }

  function start() {
    if (_timer != null) return
    _timer = setInterval(() => {
      const now = (typeof performance !== 'undefined') ? performance.now() : Date.now()
      runPlacementTick(now)
    }, PLACEMENT_INTERVAL_MS)
    if (_timer && typeof _timer.unref === 'function') _timer.unref()
  }

  function stop() {
    if (_timer != null) { clearInterval(_timer); _timer = null }
  }

  return { start, stop, runPlacementTick, shouldTick }
}

const _EMPTY_BENDERS = []

if (typeof window !== 'undefined') {
  window.__placementScheduler = { create: createPlacementScheduler }
}
