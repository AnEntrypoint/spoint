import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
import { createGrassDecal } from '/src/terrain/GrassDecal.js'
import {
  makeStreakGeo, makeSplashGeo, makeRainMaterial, makeSplashMaterial,
  makeFlakeGeo, makeSnowMaterial, makeFarSheetMaterial
} from './WeatherMaterials.js'

const _q = new THREE.Quaternion(), _upY = new THREE.Vector3(0, 1, 0)
const _camPos = new THREE.Vector3(), _camQuat = new THREE.Quaternion(), _authScratch = new THREE.Vector3()

function createWebGPUUnsupportedWeather(cfg) {
  let type = (cfg.type === 'rain' || cfg.type === 'snow') ? cfg.type : 'clear'
  let intensity = THREE.MathUtils.clamp(Number.isFinite(cfg.intensity) ? cfg.intensity : 1, 0, 1)
  const api = {
    update() {}, dispose() {},
    setType(t) { if (t === 'rain' || t === 'snow' || t === 'clear') type = t },
    getType() { return type },
    setIntensity(v) { if (Number.isFinite(v)) intensity = THREE.MathUtils.clamp(v, 0, 1) },
    getIntensity() { return intensity },
    getSnowAccumulationAt() { return 0 },
    getWetness() { return 0 },
    _im: null, _imSplash: null, _imSnow: null, _imFar: null, _snowAccum: null,
    get activeCount() { return 0 },
    get maxParticles() { return 0 },
    get farActiveCount() { return 0 },
    get maxFarParticles() { return 0 },
    cfg,
  }
  if (typeof window !== 'undefined') window.__weather = api
  return api
}

export function createWeather(opts = {}) {
  const { renderer, scene } = opts
  if (!renderer || !scene) throw new Error('createWeather: renderer/scene required')
  const cfg = opts.cfg || {}
  const frame = opts.frame || null
  if (renderer.isWebGPURenderer) return createWebGPUUnsupportedWeather(cfg)

  const BOX_RADIUS = Number.isFinite(cfg.boxRadius) ? cfg.boxRadius : 22
  const BOX_HEIGHT = Number.isFinite(cfg.boxHeight) ? cfg.boxHeight : 18
  const FALL_SPEED = Number.isFinite(cfg.fallSpeed) ? cfg.fallSpeed : 14
  const MAX_PARTICLES = Number.isFinite(cfg.particleCount) ? cfg.particleCount : 3000
  const MAX_SPLASHES = 128

  const SNOW_FALL_SPEED = Number.isFinite(cfg.snowFallSpeed) ? cfg.snowFallSpeed : 1.4
  const SNOW_DRIFT_AMP = Number.isFinite(cfg.snowDriftAmp) ? cfg.snowDriftAmp : 0.6
  const SNOW_DRIFT_FREQ = Number.isFinite(cfg.snowDriftFreq) ? cfg.snowDriftFreq : 0.5

  const FAR_RADIUS = Number.isFinite(cfg.farRadius) ? cfg.farRadius : 90
  const FAR_INNER = Math.max(BOX_RADIUS * 1.15, FAR_RADIUS * 0.4)
  const FAR_HEIGHT = Number.isFinite(cfg.farHeight) ? cfg.farHeight : 55
  const MAX_FAR = Number.isFinite(cfg.farParticleCount) ? cfg.farParticleCount : 500

  const SNOW_ACCUM_CFG_DEFAULT = cfg.snowAccumulation !== false
  function _snowAccumEnabled() {
    if (typeof window !== 'undefined' && window.__snowAccumulation !== undefined) return !!window.__snowAccumulation
    return SNOW_ACCUM_CFG_DEFAULT
  }

  let type = (cfg.type === 'rain' || cfg.type === 'snow') ? cfg.type : 'clear'
  let intensity = THREE.MathUtils.clamp(Number.isFinite(cfg.intensity) ? cfg.intensity : 1, 0, 1)

  const WET_RAMP_UP_SEC = 4
  let wetness = 0

  function _tickWetness(dt) {
    const target = (type === 'rain') ? intensity : 0
    const dryOutSec = Number.isFinite(cfg.wetnessDryOutSec) ? cfg.wetnessDryOutSec
      : (typeof window !== 'undefined' && Number.isFinite(window.__wetnessDryOutSec)) ? window.__wetnessDryOutSec : 60
    const rateSec = (target > wetness) ? WET_RAMP_UP_SEC : Math.max(1, dryOutSec)
    const maxStep = dt / rateSec
    if (target > wetness) wetness = Math.min(target, wetness + maxStep)
    else if (target < wetness) wetness = Math.max(target, wetness - maxStep)
  }
  function getWetness() { return wetness }

  const geoStreak = makeStreakGeo()
  const matRain = makeRainMaterial()
  const im = new InstancedMesh2(geoStreak, matRain, { capacity: MAX_PARTICLES, renderer, createEntities: true })
  im.perObjectFrustumCulled = false
  im.frustumCulled = false
  im.visible = false
  scene.add(im)

  const geoSplash = makeSplashGeo()
  const matSplash = makeSplashMaterial()
  const imSplash = new InstancedMesh2(geoSplash, matSplash, { capacity: MAX_SPLASHES, renderer, createEntities: true })
  imSplash.initUniformsPerInstance({ vertex: { spawnTime: 'float' } })
  imSplash.perObjectFrustumCulled = false
  imSplash.frustumCulled = false
  imSplash.visible = false
  scene.add(imSplash)

  const geoFlake = makeFlakeGeo()
  const matSnow = makeSnowMaterial()
  const imSnow = new InstancedMesh2(geoFlake, matSnow, { capacity: MAX_PARTICLES, renderer, createEntities: true })
  imSnow.perObjectFrustumCulled = false
  imSnow.frustumCulled = false
  imSnow.visible = false
  scene.add(imSnow)

  const matFarRain = makeFarSheetMaterial(new THREE.Color(0.72, 0.78, 0.86), 0.4, false)
  const matFarSnow = makeFarSheetMaterial(new THREE.Color(0.95, 0.97, 1.0), 0.5, true)
  const geoFarRain = makeStreakGeo(), geoFarSnow = makeFlakeGeo()
  const imFar = new InstancedMesh2(geoFarRain, matFarRain, { capacity: MAX_FAR, renderer, createEntities: true })
  imFar.perObjectFrustumCulled = false
  imFar.frustumCulled = false
  imFar.visible = false
  scene.add(imFar)
  let _farGeoIsSnow = false

  const SNOW_MELT_HALF_LIFE_S = Number.isFinite(cfg.snowMeltHalfLifeS) ? cfg.snowMeltHalfLifeS : 1800
  const snowAccum = createGrassDecal(null, { halfLifeS: SNOW_MELT_HALF_LIFE_S })

  const dropX = new Float32Array(MAX_PARTICLES), dropY = new Float32Array(MAX_PARTICLES), dropZ = new Float32Array(MAX_PARTICLES)
  const dropSpeed = new Float32Array(MAX_PARTICLES)
  let _idsAdded = false
  const dropGround = new Float32Array(MAX_PARTICLES)
  const GROUND_RESAMPLE_BAND_M = 4
  let _lastWantRain = -1, _lastWantSnow = -1, _lastWantFar = -1

  const snowX = new Float32Array(MAX_PARTICLES), snowY = new Float32Array(MAX_PARTICLES), snowZ = new Float32Array(MAX_PARTICLES)
  const snowSpeed = new Float32Array(MAX_PARTICLES), snowPhase = new Float32Array(MAX_PARTICLES), snowFreqJ = new Float32Array(MAX_PARTICLES)
  const snowGH = new Float64Array(MAX_PARTICLES)
  const SNOW_GROUND_RESAMPLE_BAND_M = 2.0
  let _snowIdsAdded = false

  const farX = new Float32Array(MAX_FAR), farY = new Float32Array(MAX_FAR), farZ = new Float32Array(MAX_FAR)
  const farSpeed = new Float32Array(MAX_FAR)
  let _farIdsAdded = false

  const splashAge = new Float32Array(MAX_SPLASHES).fill(Infinity)
  let _splashCursor = 0
  let _splashIdsAdded = false

  let _lastCamYaw = NaN
  const RAIN_BILLBOARD_YAW_EPS_RAD = 0.02
  const NO_TERRAIN_GROUND_Y = -1e6

  function _groundHeight(x, z) {
    if (frame && typeof frame.groundHeightLocal === 'function') {
      try { const gh = frame.groundHeightLocal(x, z); if (Number.isFinite(gh)) return gh } catch (_) {}
    }
    return NO_TERRAIN_GROUND_Y
  }

  function _respawnDroplet(i, cx, cy, cz) {
    const ang = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * BOX_RADIUS
    dropX[i] = cx + Math.cos(ang) * r
    dropZ[i] = cz + Math.sin(ang) * r
    dropY[i] = cy + BOX_HEIGHT * (0.3 + Math.random() * 0.7)
    dropSpeed[i] = FALL_SPEED * (0.85 + Math.random() * 0.3)
    dropGround[i] = _groundHeight(dropX[i], dropZ[i])
  }

  function _applyVisiblePrefix(mesh, want, last, max) {
    if (want === last) return
    if (last < 0) { for (let i = 0; i < max; i++) mesh.setVisibilityAt(i, i < want); return }
    const lo = Math.min(want, last), hi = Math.max(want, last)
    for (let i = lo; i < hi; i++) mesh.setVisibilityAt(i, i < want)
  }

  function _respawnFlake(i, cx, cy, cz) {
    const ang = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * BOX_RADIUS
    snowX[i] = cx + Math.cos(ang) * r
    snowZ[i] = cz + Math.sin(ang) * r
    snowY[i] = cy + BOX_HEIGHT * (0.3 + Math.random() * 0.7)
    snowSpeed[i] = SNOW_FALL_SPEED * (0.7 + Math.random() * 0.6)
    snowPhase[i] = Math.random() * Math.PI * 2
    snowFreqJ[i] = 0.75 + Math.random() * 0.5
    snowGH[i] = _groundHeight(snowX[i], snowZ[i])
  }

  function _respawnFar(i, cx, cy, cz, speedBase) {
    const ang = Math.random() * Math.PI * 2
    const r = FAR_INNER + Math.random() * (FAR_RADIUS - FAR_INNER)
    farX[i] = cx + Math.cos(ang) * r
    farZ[i] = cz + Math.sin(ang) * r
    farY[i] = cy + FAR_HEIGHT * Math.random()
    farSpeed[i] = speedBase * (0.85 + Math.random() * 0.3)
  }

  function _spawnSplash(x, y, z, nowS) {
    if (!imSplash.visible || !imSplash.instances) return
    const id = _splashCursor
    _splashCursor = (_splashCursor + 1) % MAX_SPLASHES
    splashAge[id] = nowS
    const inst = imSplash.instances[id]
    if (!inst) return
    inst.position.set(x, y, z)
    inst.quaternion.identity()
    inst.updateMatrix()
    try { imSplash.setUniformAt(id, 'spawnTime', nowS) } catch (_) {}
  }

  function update(dt, camera, floatingOrigin) {
    _tickWetness(Number.isFinite(dt) ? dt : 0)
    const active = (type === 'rain' || type === 'snow') && intensity > 0 && !!camera
    if (!active) {
      if (im.visible) im.visible = false
      if (imSplash.visible) imSplash.visible = false
      if (imSnow.visible) imSnow.visible = false
      if (imFar.visible) imFar.visible = false
      return
    }
    const isSnow = type === 'snow'
    im.visible = !isSnow
    imSplash.visible = !isSnow
    imSnow.visible = isSnow
    imFar.visible = true
    if (imFar.material !== (isSnow ? matFarSnow : matFarRain)) imFar.material = isSnow ? matFarSnow : matFarRain
    if (_farGeoIsSnow !== isSnow) { imFar.geometry = isSnow ? geoFarSnow : geoFarRain; _farGeoIsSnow = isSnow }

    camera.getWorldPosition(_camPos)
    let cx = _camPos.x, cy = _camPos.y, cz = _camPos.z
    if (floatingOrigin && typeof floatingOrigin.toAuthoritative === 'function') {
      const a = floatingOrigin.toAuthoritative(_camPos, _authScratch)
      cx = a.x; cy = a.y; cz = a.z
    }

    const wantActive = Math.max(1, Math.round(MAX_PARTICLES * intensity))
    const wantFar = Math.max(1, Math.round(MAX_FAR * intensity))
    if (!_idsAdded) {
      let ci = 0
      im.addInstances(MAX_PARTICLES, (e) => {
        const i = ci++
        _respawnDroplet(i, cx, cy, cz)
        e.position.set(dropX[i], dropY[i], dropZ[i])
      })
      _idsAdded = true
    }
    if (!_splashIdsAdded) {
      imSplash.addInstances(MAX_SPLASHES, (e, id) => { e.position.set(0, -1e6, 0); try { imSplash.setUniformAt(id, 'spawnTime', -1e6) } catch (_) {} })
      _splashIdsAdded = true
    }
    if (!_snowIdsAdded) {
      let si = 0
      imSnow.addInstances(MAX_PARTICLES, (e) => {
        const i = si++
        _respawnFlake(i, cx, cy, cz)
        e.position.set(snowX[i], snowY[i], snowZ[i])
      })
      _snowIdsAdded = true
    }
    if (!_farIdsAdded) {
      let fi = 0
      const speedBase = isSnow ? SNOW_FALL_SPEED : FALL_SPEED
      imFar.addInstances(MAX_FAR, (e) => {
        const i = fi++
        _respawnFar(i, cx, cy, cz, speedBase)
        e.position.set(farX[i], farY[i], farZ[i])
      })
      _farIdsAdded = true
    }

    const nowS = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000
    const dtc = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0
    const groundClearance = 0.15

    camera.getWorldQuaternion(_camQuat)
    const camYaw = Math.atan2(2 * (_camQuat.w * _camQuat.y + _camQuat.x * _camQuat.z), 1 - 2 * (_camQuat.y * _camQuat.y + _camQuat.x * _camQuat.x))
    const yawChanged = !Number.isFinite(_lastCamYaw) || Math.abs(camYaw - _lastCamYaw) > RAIN_BILLBOARD_YAW_EPS_RAD
    if (yawChanged) { _lastCamYaw = camYaw; _q.setFromAxisAngle(_upY, camYaw) }

    if (!isSnow) {
      const instances = im.instances
      _applyVisiblePrefix(im, wantActive, _lastWantRain, MAX_PARTICLES); _lastWantRain = wantActive
      for (let i = 0; i < wantActive; i++) {
        dropY[i] -= dropSpeed[i] * dtc
        const ddx = dropX[i] - cx, ddz = dropZ[i] - cz
        if (ddx * ddx + ddz * ddz > BOX_RADIUS * BOX_RADIUS) {
          const ang = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * BOX_RADIUS
          dropX[i] = cx + Math.cos(ang) * r
          dropZ[i] = cz + Math.sin(ang) * r
          dropGround[i] = _groundHeight(dropX[i], dropZ[i])
        }
        let gh = dropGround[i]
        if (dropY[i] <= gh + GROUND_RESAMPLE_BAND_M) { gh = _groundHeight(dropX[i], dropZ[i]); dropGround[i] = gh }
        const hitGround = Number.isFinite(gh) && gh > -1e5 && dropY[i] <= gh + groundClearance
        if (hitGround || dropY[i] < cy - BOX_HEIGHT * 0.6) {
          if (hitGround) _spawnSplash(dropX[i], gh + 0.02, dropZ[i], nowS)
          _respawnDroplet(i, cx, cy, cz)
        }
        const inst = instances[i]
        if (!inst) continue
        inst.position.set(dropX[i], dropY[i], dropZ[i])
        if (yawChanged) inst.quaternion.copy(_q)
        inst.updateMatrix()
      }
    } else {
      const instances = imSnow.instances
      const accumEnabled = _snowAccumEnabled()
      let accumStampBudget = 24
      _applyVisiblePrefix(imSnow, wantActive, _lastWantSnow, MAX_PARTICLES); _lastWantSnow = wantActive
      for (let i = 0; i < wantActive; i++) {
        snowY[i] -= snowSpeed[i] * dtc
        const driftAng = nowS * SNOW_DRIFT_FREQ * snowFreqJ[i] * Math.PI * 2 + snowPhase[i]
        snowX[i] += Math.cos(driftAng) * SNOW_DRIFT_AMP * dtc
        snowZ[i] += Math.sin(driftAng) * SNOW_DRIFT_AMP * dtc
        const ddx = snowX[i] - cx, ddz = snowZ[i] - cz
        if (ddx * ddx + ddz * ddz > BOX_RADIUS * BOX_RADIUS) {
          const ang = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * BOX_RADIUS
          snowX[i] = cx + Math.cos(ang) * r
          snowZ[i] = cz + Math.sin(ang) * r
          snowGH[i] = _groundHeight(snowX[i], snowZ[i])
        }
        const gh = (snowY[i] <= snowGH[i] + SNOW_GROUND_RESAMPLE_BAND_M) ? (snowGH[i] = _groundHeight(snowX[i], snowZ[i])) : snowGH[i]
        const hitGround = Number.isFinite(gh) && gh > -1e5 && snowY[i] <= gh + groundClearance
        if (hitGround || snowY[i] < cy - BOX_HEIGHT * 0.6) {
          if (hitGround && accumEnabled && accumStampBudget > 0) {
            accumStampBudget--
            try { snowAccum.markScorched(snowX[i], snowZ[i], 0.6, 0.03 * intensity) } catch (_) {}
          }
          _respawnFlake(i, cx, cy, cz)
        }
        const inst = instances[i]
        if (!inst) continue
        inst.position.set(snowX[i], snowY[i], snowZ[i])
        inst.quaternion.copy(_camQuat)
        inst.updateMatrix()
      }
    }

    {
      const speedBase = isSnow ? SNOW_FALL_SPEED : FALL_SPEED
      const instances = imFar.instances
      _applyVisiblePrefix(imFar, wantFar, _lastWantFar, MAX_FAR); _lastWantFar = wantFar
      for (let i = 0; i < wantFar; i++) {
        farY[i] -= farSpeed[i] * dtc
        const ddx = farX[i] - cx, ddz = farZ[i] - cz
        const tooFar = ddx * ddx + ddz * ddz > FAR_RADIUS * FAR_RADIUS
        const tooLow = farY[i] < cy - FAR_HEIGHT * 0.55
        if (tooFar || tooLow) _respawnFar(i, cx, cy, cz, speedBase)
        const inst = instances[i]
        if (!inst) continue
        inst.position.set(farX[i], farY[i], farZ[i])
        inst.updateMatrix()
      }
    }

    matSplash.uniforms.uTime.value = nowS
    snowAccum.tick(2)
  }

  function setType(t) { if (t === 'rain' || t === 'snow' || t === 'clear') type = t }
  function getType() { return type }
  function setIntensity(v) { if (Number.isFinite(v)) intensity = THREE.MathUtils.clamp(v, 0, 1) }
  function getIntensity() { return intensity }
  function getSnowAccumulationAt(x, z) { try { return snowAccum.sampleAt(x, z) } catch (_) { return 0 } }

  function dispose() {
    try { scene.remove(im); scene.remove(imSplash); scene.remove(imSnow); scene.remove(imFar) } catch (_) {}
    try { geoStreak.dispose(); matRain.dispose(); im.dispose && im.dispose() } catch (_) {}
    try { geoSplash.dispose(); matSplash.dispose(); imSplash.dispose && imSplash.dispose() } catch (_) {}
    try { geoFlake.dispose(); matSnow.dispose(); imSnow.dispose && imSnow.dispose() } catch (_) {}
    try { geoFarRain.dispose(); geoFarSnow.dispose(); matFarRain.dispose(); matFarSnow.dispose(); imFar.dispose && imFar.dispose() } catch (_) {}
    try { snowAccum.clear() } catch (_) {}
    if (typeof window !== 'undefined' && window.__weather && window.__weather._im === im) delete window.__weather
  }

  const api = {
    update, dispose, setType, getType, setIntensity, getIntensity, getSnowAccumulationAt, getWetness,
    _im: im, _imSplash: imSplash, _imSnow: imSnow, _imFar: imFar, _snowAccum: snowAccum,
    get activeCount() { return Math.round(MAX_PARTICLES * intensity) },
    get maxParticles() { return MAX_PARTICLES },
    get farActiveCount() { return Math.round(MAX_FAR * intensity) },
    get maxFarParticles() { return MAX_FAR },
    cfg,
  }
  if (typeof window !== 'undefined') window.__weather = api
  return api
}
