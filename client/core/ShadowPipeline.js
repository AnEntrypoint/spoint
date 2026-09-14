import * as THREE from 'three'
import { installCascadeShadowSelect } from './CascadeShadowSelect.js'

const CASCADE_SPLIT = 3.2
const MAX_CASCADES = 3

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
      light,
      extent: baseExtent * Math.pow(CASCADE_SPLIT, i),
      _extentApplied: -1,
      _lastSnapped: new THREE.Vector3(NaN, NaN, NaN),
      _target: new THREE.Vector3(),
    })
  }

  installCascadeShadowSelect(cascadeCount, _cascades.map(c => c.extent))

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
    offset.set(dir[0] / l * offsetLen, dir[1] / l * offsetLen, dir[2] / l * offsetLen)
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
    const sr = Math.round(cr / texel) * texel
    const su = Math.round(cu / texel) * texel
    _snapped.copy(_right).multiplyScalar(sr).addScaledVector(_up, su).addScaledVector(_lightDir, cd)

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

  function update(target) {
    let anyMoved = false
    for (const c of _cascades) { if (_updateCascade(c, target)) anyMoved = true }
    return anyMoved
  }

  function forceUpdate() {
    for (const c of _cascades) c.light.shadow.needsUpdate = true
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
        })),
        offset: offset.toArray(),
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
