const LAYER_KINDS = new Set(['orbit', 'chase', 'firstPerson', 'cutscene', 'custom'])

function refuse(reasonCode, message) {
  const err = new TypeError(`[cameraRig] ${message}`)
  err.reasonCode = reasonCode
  throw err
}

function finiteOr(v, fallback) { return Number.isFinite(v) ? v : fallback }

function vec3(v) { return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v : null }

function orbitLayer(spec) {
  const distance = finiteOr(spec.distance, 4)
  const minPitch = finiteOr(spec.minPitch, -1.2)
  const maxPitch = finiteOr(spec.maxPitch, 1.2)
  const sensitivity = finiteOr(spec.sensitivity, 0.003)
  const targetHeight = finiteOr(spec.targetHeight, 1.6)
  return {
    init: () => ({ yaw: 0, pitch: 0 }),
    onInput(state, input) {
      state.yaw -= finiteOr(input.lookX, 0) * sensitivity
      state.pitch = Math.min(maxPitch, Math.max(minPitch, state.pitch - finiteOr(input.lookY, 0) * sensitivity))
      return true
    },
    update(state, pose) {
      const target = [pose.position[0], pose.position[1] + targetHeight, pose.position[2]]
      const cp = Math.cos(state.pitch)
      const position = [
        target[0] + distance * cp * Math.sin(state.yaw),
        target[1] + distance * Math.sin(state.pitch),
        target[2] + distance * cp * Math.cos(state.yaw)
      ]
      return { position, target }
    }
  }
}

function chaseLayer(spec) {
  const distance = finiteOr(spec.distance, 5)
  const height = finiteOr(spec.height, 2)
  const targetHeight = finiteOr(spec.targetHeight, 1.2)
  return {
    init: () => ({}),
    update(_state, pose) {
      const s = Math.sin(pose.yaw), c = Math.cos(pose.yaw)
      const target = [pose.position[0], pose.position[1] + targetHeight, pose.position[2]]
      const position = [
        pose.position[0] - distance * s,
        pose.position[1] + height,
        pose.position[2] - distance * c
      ]
      return { position, target }
    }
  }
}

function firstPersonLayer(spec) {
  const eyeHeight = finiteOr(spec.eyeHeight, 1.6)
  const sensitivity = finiteOr(spec.sensitivity, 0.002)
  const maxPitch = finiteOr(spec.maxPitch, 1.5)
  return {
    init: () => ({ yaw: 0, pitch: 0 }),
    onInput(state, input) {
      state.yaw -= finiteOr(input.lookX, 0) * sensitivity
      state.pitch = Math.min(maxPitch, Math.max(-maxPitch, state.pitch - finiteOr(input.lookY, 0) * sensitivity))
      return true
    },
    update(state, pose) {
      const position = [pose.position[0], pose.position[1] + eyeHeight, pose.position[2]]
      const cp = Math.cos(state.pitch)
      const target = [
        position[0] + Math.sin(state.yaw) * cp,
        position[1] + Math.sin(state.pitch),
        position[2] + Math.cos(state.yaw) * cp
      ]
      return { position, target }
    }
  }
}

function cutsceneLayer(spec) {
  const frames = Array.isArray(spec.frames) ? spec.frames : []
  if (frames.length === 0) refuse('cutscene-no-frames', 'cutscene layer needs a non-empty frames array')
  for (const f of frames) {
    if (!Number.isFinite(f?.t) || !vec3(f.position) || !vec3(f.target)) refuse('cutscene-bad-frame', `cutscene frame needs finite t, position[3] and target[3]: ${JSON.stringify(f)}`)
  }
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].t < frames[i - 1].t) refuse('cutscene-unsorted', 'cutscene frames must be sorted by ascending t')
  }
  const loop = spec.loop === true
  const span = frames[frames.length - 1].t
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
  return {
    init: () => ({ t: 0, done: false }),
    update(state, _pose, dt) {
      state.t += dt
      let t = state.t
      if (loop && span > 0) t = t % span
      else if (t >= span) { state.done = true; t = span }
      let i = 0
      while (i < frames.length - 2 && frames[i + 1].t <= t) i++
      const a = frames[i], b = frames[Math.min(i + 1, frames.length - 1)]
      const k = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0
      return { position: lerp(a.position, b.position, k), target: lerp(a.target, b.target, k), done: state.done }
    }
  }
}

function customLayer(spec) {
  if (typeof spec.update !== 'function') refuse('custom-no-update', 'custom layer needs an update(state, pose, dt) function')
  return {
    init: typeof spec.init === 'function' ? spec.init : () => ({}),
    onInput: typeof spec.onInput === 'function' ? spec.onInput : null,
    update: spec.update
  }
}

const KIND_FACTORY = { orbit: orbitLayer, chase: chaseLayer, firstPerson: firstPersonLayer, cutscene: cutsceneLayer, custom: customLayer }

function compileLayer(raw) {
  if (!raw || typeof raw !== 'object') refuse('layer-not-object', 'each layer must be an object')
  if (typeof raw.id !== 'string' || !raw.id) refuse('layer-no-id', 'each layer needs a non-empty string id')
  if (!LAYER_KINDS.has(raw.kind)) refuse('layer-unknown-kind', `layer "${raw.id}" has unknown kind ${JSON.stringify(raw.kind)}`)
  const impl = KIND_FACTORY[raw.kind](raw)
  return { id: raw.id, priority: finiteOr(raw.priority, 0), impl }
}

export function defineCameraRig(spec = {}, appCtx = null) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) refuse('spec-not-object', 'spec must be an object')
  if (!Array.isArray(spec.layers) || spec.layers.length === 0) refuse('no-layers', 'spec.layers must be a non-empty array')
  const layers = new Map()
  for (const raw of spec.layers) {
    const layer = compileLayer(raw)
    if (layers.has(layer.id)) refuse('layer-duplicate-id', `layer id "${layer.id}" is declared twice`)
    layers.set(layer.id, layer)
  }
  const defaultId = spec.default ?? spec.layers[0].id
  if (!layers.has(defaultId)) refuse('default-unknown', `default layer "${defaultId}" is not declared`)

  const players = new Map()

  function playerState(playerId, create) {
    let p = players.get(playerId)
    if (!p && create) {
      p = { active: new Set([defaultId]), perLayer: new Map() }
      players.set(playerId, p)
    }
    return p
  }

  function layerState(p, layer) {
    let s = p.perLayer.get(layer.id)
    if (!s) { s = layer.impl.init(); p.perLayer.set(layer.id, s) }
    return s
  }

  function ordered(p) {
    return [...p.active].map(id => layers.get(id)).sort((a, b) => b.priority - a.priority)
  }

  return {
    push(playerId, layerId) {
      if (!layers.has(layerId)) refuse('push-unknown-layer', `push: layer "${layerId}" is not declared`)
      const p = playerState(playerId, true)
      p.active.add(layerId)
    },
    pop(playerId, layerId) {
      const p = playerState(playerId, false)
      if (!p || layerId === defaultId) return
      p.active.delete(layerId)
      p.perLayer.delete(layerId)
    },
    top(playerId) {
      const p = playerState(playerId, false)
      return p ? ordered(p)[0].id : defaultId
    },
    remove(playerId) { players.delete(playerId) },
    onInput(playerId, input) {
      const p = playerState(playerId, true)
      for (const layer of ordered(p)) {
        if (!layer.impl.onInput) continue
        if (layer.impl.onInput(layerState(p, layer), input || {}) === true) return true
      }
      return false
    },
    update(playerId, pose, dt) {
      if (!pose || !vec3(pose.position) || !Number.isFinite(pose.yaw)) refuse('pose-invalid', 'update: pose needs position[3] and finite yaw')
      if (!Number.isFinite(dt) || dt < 0) refuse('dt-invalid', 'update: dt must be a finite non-negative number')
      const p = playerState(playerId, true)
      const layer = ordered(p)[0]
      const camera = layer.impl.update(layerState(p, layer), pose, dt)
      if (!vec3(camera.position) || !vec3(camera.target)) refuse('camera-invalid', `layer "${layer.id}" returned a non-finite camera`)
      return { position: camera.position, target: camera.target, layer: layer.id, done: camera.done === true }
    },
    layerIds() { return [...layers.keys()] }
  }
}

export default defineCameraRig
