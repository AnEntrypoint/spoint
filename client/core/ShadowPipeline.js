import * as THREE from 'three'
import { installCascadeShadowSelect, CASCADE_BLEND_M } from './CascadeShadowSelect.js'
import { installCascadeShadowSelectTSL } from './CascadeShadowSelectTSL.js'
import { SHADOW_CASTER_ONLY_LAYER } from './ShadowLayers.js'

const CASCADE_SPLIT = 3.2
const MAX_CASCADES = 3
const SHADOW_REDRAW_CASTER_HEIGHT_M = 20
const FAR_CASCADE_LATERAL_STEP_M = 1
const DEPTH_STEP_DIVISOR = 16
const FAR_CASCADE_REDRAWS_PER_FRAME = 1
const FAR_CASCADE_MAX_DEFER_FRAMES = 2

// A fragment samples cascade i only inside cascade i's camera-distance band, cross-fading over
// CASCADE_BLEND_M at each split, and a caster's shadow lands within roughly one caster height of
// the caster itself (_casterShadowReachM). So a caster outside cascade i's widened band cannot
// change any texel cascade i ever reads: re-rendering cascade i for it shows nothing new.

export function createShadowPipeline(sun, opts = {}) {
  const scene = opts.scene || sun.parent || null
  const baseExtent = Number.isFinite(opts.extent) ? opts.extent : 60
  const requestedCascades = Number.isFinite(opts.cascades) ? opts.cascades : 1
  const cascade0NeverRenders = sun.castShadow === false
  const cascadeCount = cascade0NeverRenders ? 1 : Math.max(1, Math.min(MAX_CASCADES, Math.round(requestedCascades)))
  const offset = (opts.offset && opts.offset.isVector3) ? opts.offset.clone() : new THREE.Vector3(40, 80, 30)
  let offsetLen = offset.length()

  const _WORLD_UP = new THREE.Vector3(0, 1, 0)
  const _WORLD_FWD = new THREE.Vector3(0, 0, 1)

  const rawFarBudget = opts.farRedrawBudget !== undefined
    ? opts.farRedrawBudget
    : (typeof window !== 'undefined' && window.__shadowFarRedrawBudget !== undefined
      ? window.__shadowFarRedrawBudget
      : FAR_CASCADE_REDRAWS_PER_FRAME)
  const farRedrawBudget = Number.isFinite(rawFarBudget) ? Math.max(0, Math.round(rawFarBudget)) : Infinity
  const _cascades = []
  for (let i = 0; i < cascadeCount; i++) {
    const light = i === 0 ? sun : (() => {
      const l = new THREE.DirectionalLight(0xffffff, 0)
      l.castShadow = true
      l.shadow.mapSize.copy(sun.shadow.mapSize)
      l.shadow.bias = sun.shadow.bias
      l.shadow.normalBias = sun.shadow.normalBias
      l.shadow.radius = sun.shadow.radius
      l.name = `shadowCascade${i}`
      if (scene) { scene.add(l); scene.add(l.target) }
      return l
    })()
    light.shadow.autoUpdate = false
    light.shadow.needsUpdate = true
    _cascades.push({
      index: i,
      light,
      extent: baseExtent * Math.pow(CASCADE_SPLIT, i),
      _extentApplied: -1,
      _lastSnapped: new THREE.Vector3(NaN, NaN, NaN),
      _target: new THREE.Vector3(),
      _pendingFrames: 0,
    })
  }

  if (opts.renderer && opts.renderer.isWebGPURenderer) {
    for (const c of _cascades) c.light.shadow.camera.layers.enable(SHADOW_CASTER_ONLY_LAYER)
    installCascadeShadowSelectTSL(_cascades.map(c => c.light), _cascades.map(c => c.extent))
  } else {
    installCascadeShadowSelect(cascadeCount, _cascades.map(c => c.extent))
  }

  const _requestedOffset = new THREE.Vector3()
  const _lightDir = new THREE.Vector3()
  const _right = new THREE.Vector3()
  const _up = new THREE.Vector3()
  const _snapped = new THREE.Vector3()

  function mapSize() { return (sun.shadow && sun.shadow.mapSize && sun.shadow.mapSize.x) || 1024 }
  function texelWorld(cascadeIdx = 0) {
    const c = _cascades[cascadeIdx] || _cascades[0]
    return (2 * c.extent) / ((c.light.shadow.mapSize && c.light.shadow.mapSize.x) || mapSize())
  }

  function setSunDirection(dir) {
    if (!dir) return
    const l = Math.hypot(dir[0], dir[1], dir[2]) || 1
    _requestedOffset.set(dir[0] / l * offsetLen, dir[1] / l * offsetLen, dir[2] / l * offsetLen)
    for (const c of _cascades) { if (!c.light.castShadow) c.light.position.copy(c.light.target.position).add(_requestedOffset) }
    if (_requestedOffset.angleTo(offset) <= texelWorld(0) / SHADOW_REDRAW_CASTER_HEIGHT_M) return
    offset.copy(_requestedOffset)
    for (const c of _cascades) c._lastSnapped.set(NaN, NaN, NaN)
  }

  function _updateCascade(c, target) {
    const light = c.light
    if (!light || !light.castShadow) return false
    const texel = (2 * c.extent) / ((light.shadow.mapSize && light.shadow.mapSize.x) || mapSize())
    _lightDir.copy(offset).normalize().negate()
    const upRef = Math.abs(_lightDir.dot(_WORLD_UP)) > 0.99 ? _WORLD_FWD : _WORLD_UP
    _right.crossVectors(upRef, _lightDir).normalize()
    _up.crossVectors(_lightDir, _right).normalize()
    const cr = target.dot(_right), cu = target.dot(_up), cd = target.dot(_lightDir)
    const lateralStep = c.index === 0 ? texel : texel * Math.max(1, Math.floor(FAR_CASCADE_LATERAL_STEP_M / texel))
    const depthStep = c.extent / DEPTH_STEP_DIVISOR
    const sr = Math.round(cr / lateralStep) * lateralStep
    const su = Math.round(cu / lateralStep) * lateralStep
    const sd = Math.round(cd / depthStep) * depthStep
    _snapped.copy(_right).multiplyScalar(sr).addScaledVector(_up, su).addScaledVector(_lightDir, sd)

    const extentChanged = c.extent !== c._extentApplied
    let moved = false
    if (!Number.isFinite(c._lastSnapped.x) || !_snapped.equals(c._lastSnapped) || extentChanged) {
      c._lastSnapped.copy(_snapped)
      c._target.copy(_snapped)
      light.target.position.copy(c._target); light.target.updateMatrixWorld()
      light.position.copy(c._target).add(offset)
      moved = true
      light.shadow.needsUpdate = true
    }
    if (extentChanged) {
      const sc = light.shadow.camera
      sc.left = -c.extent; sc.right = c.extent; sc.top = c.extent; sc.bottom = -c.extent
      sc.near = 0.5; sc.far = offset.length() + c.extent * 1.5
      sc.updateProjectionMatrix(); c._extentApplied = c.extent
    }
    return moved
  }

  // Cascade 0 is the only cascade whose texel is finer than one frame of walking, so it is the only
  // one that has to follow the eye every frame, and it is never held. The far cascades time-share a
  // redraw budget per frame instead of all of them landing on the same frame: a far map held one
  // frame sits one frame of travel behind the eye, which is below its own snap step, and the defer
  // ceiling means a far cascade cannot be starved by one that comes due more often.
  function update(target) {
    let anyMoved = false
    let farIssued = 0
    for (const c of _cascades) {
      if (c.index > 0 && !(c._pendingFrames >= FAR_CASCADE_MAX_DEFER_FRAMES) && farIssued >= farRedrawBudget) {
        c._pendingFrames++
        continue
      }
      if (!_updateCascade(c, target)) { c._pendingFrames = 0; continue }
      anyMoved = true
      if (c.index > 0) farIssued++
      c._pendingFrames = 0
    }
    return anyMoved
  }

  // How far a caster can throw a shadow sideways, derived from the live sun elevation rather than
  // a flat guess: a caster of SHADOW_REDRAW_CASTER_HEIGHT_M throws height/tan(elevation). At the
  // horizon that is unbounded, which correctly disables the band skip altogether.
  function _casterShadowReachM() {
    const horiz = Math.hypot(offset.x, offset.z)
    const vert = Math.abs(offset.y)
    if (!(vert > 1e-6)) return Infinity
    return SHADOW_REDRAW_CASTER_HEIGHT_M * (horiz / vert)
  }

  // Camera-distance band of cascade i, widened by the cross-fade and by how far a caster can throw
  // a shadow. Outside it, a fragment never samples cascade i, so a caster there cannot dirty
  // anything cascade i shows.
  function _bandReachesCaster(index, dist, reach) {
    const lo = index === 0 ? 0 : _cascades[index - 1].extent - CASCADE_BLEND_M - reach
    const hi = _cascades[index].extent + CASCADE_BLEND_M + reach
    return dist >= lo && dist <= hi
  }

  // Dirty only the cascades a moved caster can actually change. `movers` are the caster roots
  // whose pose changed since the last sync and `eye` is the camera world position the bands are
  // measured from. Without both -- a caster appearing or vanishing carries no position -- every
  // cascade is dirtied, because the invalidation is then unbounded.
  function forceUpdate(movers, eye) {
    // One cascade is not band-selected at all -- installCascadeShadowSelect(TSL) leaves a lone
    // light on three's default shadow node, which samples its map at every fragment -- so there
    // is no band to test against and every caster can reach it.
    if (_cascades.length <= 1) { for (const c of _cascades) c.light.shadow.needsUpdate = true; return }
    if (!movers || movers.length === 0 || !eye || !Number.isFinite(eye.x)) {
      for (const c of _cascades) c.light.shadow.needsUpdate = true
      return
    }
    const ex = eye.x, ey = eye.y, ez = eye.z
    const reach = _casterShadowReachM()
    for (let i = 0; i < _cascades.length; i++) {
      const c = _cascades[i]
      const shadow = c.light.shadow
      if (shadow.needsUpdate || !c.light.castShadow) continue
      for (let k = 0; k < movers.length; k++) {
        const mover = movers[k]
        if (!mover || !mover.matrixWorld) continue
        const e = mover.matrixWorld.elements
        const dx = e[12] - ex, dy = e[13] - ey, dz = e[14] - ez
        if (_bandReachesCaster(i, Math.sqrt(dx * dx + dy * dy + dz * dz), reach)) {
          shadow.needsUpdate = true
          break
        }
      }
    }
  }

  const pipeline = {
    update, setSunDirection, forceUpdate,
    get extent() { return baseExtent },
    get cascadeCount() { return cascadeCount },
    get lights() { return _cascades.map(c => c.light) },
    texelWorld,
    debug() {
      return {
        cascadeCount,
        cascades: _cascades.map((c, i) => ({
          index: i, extent: c.extent, snapped: c._lastSnapped.toArray(), texelWorld: texelWorld(i),
          mapSize: (c.light.shadow.mapSize && c.light.shadow.mapSize.x) || mapSize(),
          needsUpdate: c.light.shadow.needsUpdate,
          pendingFrames: c._pendingFrames,
        })),
        offset: offset.toArray(),
        farRedrawBudget,
        cascadeSelect: (typeof window !== 'undefined' && window.__cascadeShadowSelect) || null,
      }
    },
    shiftFloatingOrigin(dx, dy, dz) {
      for (const c of _cascades) { if (Number.isFinite(c._lastSnapped.x)) c._lastSnapped.set(c._lastSnapped.x + dx, c._lastSnapped.y + dy, c._lastSnapped.z + dz) }
    },
  }
  if (typeof window !== 'undefined') window.__shadowPipeline = pipeline
  return pipeline
}

// Asking for a shadow redraw is a two-backend question and only one of the two answers is a
// renderer-level write. three's WebGPU Renderer.shadowMap is { enabled, transmitted, type } and
// ShadowNode.updateBefore gates on the PER-LIGHT light.shadow.needsUpdate, which forceUpdate()
// already writes; three's WebGLShadowMap.render gates the whole pass on renderer.shadowMap
// .needsUpdate because autoUpdate is off. So the renderer-level write is load-bearing on the legacy
// renderer and unreadable on the WebGPU one, and this is the one place that decides.
export function requestShadowRedraw(renderer) {
  const sm = renderer && renderer.shadowMap
  if (!sm || typeof sm.render !== 'function') return false
  sm.needsUpdate = true
  return true
}

const POSE_CHILDREN = 7, POSE_VISIBLE = 8, POSE_CASTING = 9, POSE_SLOTS = 10

function castsShadow(obj) {
  if (!obj.visible) return false
  if (obj.castShadow) return true
  for (const child of obj.children) if (castsShadow(child)) return true
  return false
}

function poseChanged(obj, pose) {
  const p = obj.position, q = obj.quaternion
  return pose[0] !== p.x || pose[1] !== p.y || pose[2] !== p.z
    || pose[3] !== q.x || pose[4] !== q.y || pose[5] !== q.z || pose[6] !== q.w
    || pose[POSE_CHILDREN] !== obj.children.length
    || pose[POSE_VISIBLE] !== (obj.visible ? 1 : 0)
}

function writePose(obj, pose) {
  const p = obj.position, q = obj.quaternion
  pose[0] = p.x; pose[1] = p.y; pose[2] = p.z
  pose[3] = q.x; pose[4] = q.y; pose[5] = q.z; pose[6] = q.w
  pose[POSE_CHILDREN] = obj.children.length
  pose[POSE_VISIBLE] = obj.visible ? 1 : 0
}

export function createShadowCasterTracker() {
  const _poses = new WeakMap()
  let _castingCount = 0

  // `movers` accumulates the roots whose pose changed, so the caller can dirty only the cascades
  // they can reach. A change in the NUMBER of casters has no position, so it clears `movers` and
  // the caller falls back to dirtying every cascade.
  function sync(objects, movers) {
    let moved = false
    let castingNow = 0
    for (const obj of objects) {
      let pose = _poses.get(obj)
      if (pose === undefined) {
        pose = new Float64Array(POSE_SLOTS).fill(NaN)
        _poses.set(obj, pose)
      }
      if (poseChanged(obj, pose)) {
        writePose(obj, pose)
        const casting = castsShadow(obj)
        if (casting || pose[POSE_CASTING] === 1) { moved = true; if (movers) movers.push(obj) }
        pose[POSE_CASTING] = casting ? 1 : 0
      }
      castingNow += pose[POSE_CASTING]
    }
    if (castingNow !== _castingCount) { moved = true; if (movers) movers.length = 0 }
    _castingCount = castingNow
    return moved
  }

  return { sync }
}
