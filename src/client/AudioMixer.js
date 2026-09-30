const _CLIENT = (typeof window !== 'undefined') && (typeof Audio !== 'undefined')

const OCCLUSION_INTERVAL_MS = 200
const OCCLUDED_VOLUME_MUL = 0.35
const OCCLUDED_LOWPASS_HZ = 800
const UNOCCLUDED_LOWPASS_HZ = 22000
const DEFAULT_AUDIBLE_RANGE_M = 40
const LOWPASS_LERP = 0.35
const EMITTER_SELF_HIT_TOLERANCE_M = 0.5

function _hasLineOfSight(listenerPos, emitterPos) {
  const scene = (typeof window !== 'undefined') ? window.__scene : null
  const THREE = (typeof window !== 'undefined') ? window.THREE : null
  if (!scene || !THREE || !THREE.Raycaster || !THREE.Vector3) return true
  try {
    const from = new THREE.Vector3(listenerPos[0], listenerPos[1], listenerPos[2])
    const to = new THREE.Vector3(emitterPos[0], emitterPos[1], emitterPos[2])
    const delta = to.clone().sub(from)
    const dist = delta.length()
    if (dist < 1e-4) return true
    const dir = delta.normalize()
    const ray = new THREE.Raycaster(from, dir, 0, dist)
    const hits = ray.intersectObject(scene, true)
    if (!hits || hits.length === 0) return true
    return hits[0].distance >= dist - EMITTER_SELF_HIT_TOLERANCE_M
  } catch (_) {
    return true
  }
}

const _mixerLevels = { master: 1, sfx: 1, music: 1 }
const _registry = new Set()

function _effectiveLevel(category) {
  const cat = (category === 'sfx' || category === 'music') ? _mixerLevels[category] : 1
  return clamp01(_mixerLevels.master, 1) * clamp01(cat, 1)
}

function _applyMixerToAll() {
  for (const handle of _registry) handle._applyMixer()
}

function setMixerVolume(category, v) {
  if (category !== 'master' && category !== 'sfx' && category !== 'music') { console.warn(`[audio] setMixerVolume: unknown category '${category}'`); return }
  _mixerLevels[category] = clamp01(v, _mixerLevels[category])
  _applyMixerToAll()
}
function getMixerVolume(category) { return _mixerLevels[category] ?? 1 }

export function defineAudio(spec = {}) {
  const tracks = { ...(spec.tracks || {}) }
  const base = typeof spec.base === 'string' ? spec.base : ''
  const category = spec.category === 'sfx' || spec.category === 'music' ? spec.category : 'master'
  const audibleRange = (typeof spec.audibleRange === 'number' && spec.audibleRange > 0) ? spec.audibleRange : DEFAULT_AUDIBLE_RANGE_M
  let baseVolume = clamp01(spec.volume, 1)
  const _els = new Map()
  const _positional = new Map()
  const _graphs = new Map()
  let _sharedCtx = null

  function urlFor(key) {
    const u = tracks[key] || key
    return typeof u === 'string' ? base + u : null
  }
  function elFor(key) {
    let el = _els.get(key)
    if (el) return el
    const url = urlFor(key); if (!url) return null
    el = new Audio(url); el.preload = 'auto'; _els.set(key, el)
    return el
  }
  function effectiveVolume(perCallVolume) {
    return baseVolume * clamp01(perCallVolume, 1) * _effectiveLevel(category)
  }

  function _distanceGain(listenerPos, emitterPos) {
    if (!Array.isArray(listenerPos) || !Array.isArray(emitterPos)) return 1
    const dx = emitterPos[0] - listenerPos[0], dy = emitterPos[1] - listenerPos[1], dz = emitterPos[2] - listenerPos[2]
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (!Number.isFinite(dist)) return 1
    return clamp01(1 - dist / audibleRange, 1)
  }
  function _listenerPos() {
    const cam = (typeof window !== 'undefined') ? window.__camera : null
    return (cam && cam.position) ? [cam.position.x, cam.position.y, cam.position.z] : null
  }

  function _ensureGraph(key, el) {
    if (_graphs.has(key)) return _graphs.get(key)
    try {
      const Ctx = (typeof AudioContext !== 'undefined') ? AudioContext : (typeof webkitAudioContext !== 'undefined') ? webkitAudioContext : null
      if (!Ctx) { _graphs.set(key, null); return null }
      if (!_sharedCtx || _sharedCtx.state === 'closed') _sharedCtx = new Ctx()
      const source = _sharedCtx.createMediaElementSource(el)
      const filter = _sharedCtx.createBiquadFilter()
      filter.type = 'lowpass'; filter.frequency.value = UNOCCLUDED_LOWPASS_HZ
      const gain = _sharedCtx.createGain()
      gain.gain.value = 1
      source.connect(filter); filter.connect(gain); gain.connect(_sharedCtx.destination)
      const graph = { source, filter, gain }
      _graphs.set(key, graph)
      return graph
    } catch (_) {
      _graphs.set(key, null)
      return null
    }
  }

  function _updatePositional(key) {
    const state = _positional.get(key)
    if (!state) return
    const el = _els.get(key)
    if (!el || el.paused || el.ended) return
    const listener = _listenerPos()
    const distGain = listener ? _distanceGain(listener, state.position) : 1
    const occluded = listener ? !_hasLineOfSight(listener, state.position) : false
    const occludeGain = occluded ? OCCLUDED_VOLUME_MUL : 1
    const targetVolume = effectiveVolume(state.perCallVolume) * distGain * occludeGain
    el.volume = clamp01(targetVolume, el.volume)
    const graph = _ensureGraph(key, el)
    if (graph) {
      const targetHz = occluded ? OCCLUDED_LOWPASS_HZ : UNOCCLUDED_LOWPASS_HZ
      const cur = graph.filter.frequency.value
      graph.filter.frequency.value = cur + (targetHz - cur) * LOWPASS_LERP
      graph.gain.gain.value = clamp01(targetVolume, graph.gain.gain.value)
    }
  }

  function _stopPositional(key) {
    const state = _positional.get(key)
    if (!state) return
    if (state.timer) clearInterval(state.timer)
    _positional.delete(key)
  }

  if (!_CLIENT) {
    return {
      play() { return null }, stop() {}, stopAll() {}, setVolume(v) { baseVolume = clamp01(v, baseVolume) },
      isPlaying() { return false }, preload() {}, has(key) { return key in tracks },
    }
  }

  const handle = {
    play(key, { loop = false, volume, restart = false, position } = {}) {
      const el = elFor(key); if (!el) return null
      el.loop = !!loop
      const hasPos = Array.isArray(position) && position.length === 3 && position.every(Number.isFinite)
      if (hasPos) {
        let state = _positional.get(key)
        if (!state) {
          state = { position, perCallVolume: volume, timer: null }
          _positional.set(key, state)
          state.timer = setInterval(() => _updatePositional(key), OCCLUSION_INTERVAL_MS)
        } else {
          state.position = position
          state.perCallVolume = volume
        }
        _updatePositional(key)
      } else if (_positional.has(key)) {
        _stopPositional(key)
        el.volume = effectiveVolume(volume)
      } else {
        el.volume = effectiveVolume(volume)
      }
      if (restart || el.paused || el.ended) {
        try { el.currentTime = 0 } catch (_) {}
        if (_sharedCtx && _sharedCtx.state === 'suspended') { _sharedCtx.resume().catch(() => {}) }
        el.play().catch(() => {})
      }
      return el
    },
    stop(key) { const el = _els.get(key); if (el) { el.pause(); try { el.currentTime = 0 } catch (_) {} }; _stopPositional(key) },
    stopAll() { for (const el of _els.values()) { el.pause(); try { el.currentTime = 0 } catch (_) {} }; for (const key of Array.from(_positional.keys())) _stopPositional(key) },
    setVolume(v) { baseVolume = clamp01(v, baseVolume); handle._applyMixer() },
    isPlaying(key) { const el = _els.get(key); return !!el && !el.paused && !el.ended },
    preload(key) { const el = elFor(key); if (el) { try { el.load() } catch (_) {} } },
    has(key) { return key in tracks || _els.has(key) },
    setPosition(key, position) {
      const state = _positional.get(key)
      if (state && Array.isArray(position) && position.length === 3 && position.every(Number.isFinite)) state.position = position
    },
    dispose() {
      _registry.delete(handle)
      handle.stopAll()
      if (_sharedCtx) { try { _sharedCtx.close() } catch (_) {}; _sharedCtx = null }
      _graphs.clear()
    },
    _applyMixer() { for (const [key, el] of _els.entries()) { if (!_positional.has(key)) el.volume = baseVolume * _effectiveLevel(category) } },
  }
  _registry.add(handle)
  return handle
}

export const AudioMixer = { setVolume: setMixerVolume, getVolume: getMixerVolume }

function clamp01(v, dflt) { return (typeof v === 'number' && Number.isFinite(v)) ? Math.min(1, Math.max(0, v)) : dflt }
