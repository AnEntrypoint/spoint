// Weather -- GPU-instanced rain + snow particle systems, plus a far billboard-sheet LOD tier.
// (decomposed from time-of-day-weather-sun-animation-fog-rain-snow, see AGENTS.md/PRD history).
//
// TIER SHAPE (three tiers total, all camera-relative):
//   1. RAIN near-tier -- fast streak quads, real per-particle CPU fall+wrap sim, ground-contact splash
//      pulses. Shipped first (weather-particle-system-rain-snow-tiers row).
//   2. SNOW near-tier -- slow-falling, horizontally wind-drifted soft round flake quads, real per-
//      particle CPU fall+drift+wrap sim (same discipline as rain: no splash-on-contact, instead an
//      accumulation-aware ground effect via a REUSED src/terrain/GrassDecal.js sparse cell store --
//      snow accumulation is genuinely persistent per-cell world-state the same shape burn/flatten decals
//      already are, so this reuses that exact primitive instead of inventing a parallel one).
//   3. FAR BILLBOARD-SHEET tier -- shared by both rain and snow, a second much-larger-radius / much-
//      lower-density InstancedMesh2 pool giving the "it's precipitating everywhere, not just in a
//      22m bubble around me" reading beyond the near tier's BOX_RADIUS. Deliberately NOT a full per-
//      particle sim: far flakes/streaks only need Y-fall + camera-follow wrap (no per-instance yaw
//      billboard refresh, no ground contact query at all -- they never reach the ground before
//      recycling), matching the LOD-tier discipline VegImpostorTier/billboard-cylindrical-impostor
//      already use elsewhere in this codebase (cheap distant proxy, real detail only up close).
//
// WHY CAMERA-RELATIVE, NOT WORLD-PLACED: unlike vegetation/grass (which place real instances at real
// world XZ and stream by chunk), precipitation has no meaningful "world position" worth persisting -- it
// is a dense, uniform, camera-following volume. Every particle's XZ is drawn from a fixed-size box THAT
// TRANSLATES WITH THE CAMERA every frame (wrap-around: a particle that falls out the bottom or drifts
// out the side respawns at the opposite/top edge of the SAME box, still centered on the camera) -- this
// is the "never simulate off-screen particles" requirement from the PRD row: there is only ever
// PARTICLE_COUNT (+ FAR_PARTICLE_COUNT) particles in existence, all within camera range, none anywhere
// else in the world.
//
// WORLD-CONFIG GATE: a `weather` block on the terrain app config (analogous to _terrainCfg.timeOfDay),
// read by app.js's boot wiring (see _ensureWeather). { type: 'rain'|'snow'|'clear', intensity: 0..1,
// particleCount, farParticleCount, snowAccumulation }. RenderControls knobs: weatherType (string
// mirror), weatherIntensity (number mirror), snowAccumulation (boolean, default true) -- all
// live-settable via window.__renderControls.set(...), matching every other knob in that registry.

import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
import { createGrassDecal } from '/src/terrain/GrassDecal.js'
import {
  makeStreakGeo, makeSplashGeo, makeRainMaterial, makeSplashMaterial,
  makeFlakeGeo, makeSnowMaterial, makeFarSheetMaterial
} from './WeatherMaterials.js'

const _q = new THREE.Quaternion(), _upY = new THREE.Vector3(0, 1, 0)
const _camPos = new THREE.Vector3(), _camQuat = new THREE.Quaternion()

// opts: { renderer, scene, frame (terrain frame, for ground-height sampling -- optional, falls back
// to a fixed splash plane if absent), cfg: { type: 'rain'|'snow'|'clear', intensity: 0..1,
// particleCount, farParticleCount, boxRadius, boxHeight, fallSpeed, snowAccumulation } }
export function createWeather(opts = {}) {
  const { renderer, scene } = opts
  if (!renderer || !scene) throw new Error('createWeather: renderer/scene required')
  const cfg = opts.cfg || {}
  const frame = opts.frame || null

  const BOX_RADIUS = Number.isFinite(cfg.boxRadius) ? cfg.boxRadius : 22   // XZ half-extent of the near-tier falling-volume box, camera-centered
  const BOX_HEIGHT = Number.isFinite(cfg.boxHeight) ? cfg.boxHeight : 18   // Y extent above the camera near-tier particles fall through
  const FALL_SPEED = Number.isFinite(cfg.fallSpeed) ? cfg.fallSpeed : 14   // m/s, real-world-ish heavy rain fall speed
  const MAX_PARTICLES = Number.isFinite(cfg.particleCount) ? cfg.particleCount : 3000
  const MAX_SPLASHES = 128

  // Snow near-tier: slower fall, real horizontal wind-drift sway (sinusoidal per-particle phase, cheap
  // CPU trig -- analogous to Grass.js's windPhase sway but computed CPU-side since snow needs its XZ
  // position, not just a vertex-shader offset, to feed the accumulation-decal query below).
  const SNOW_FALL_SPEED = Number.isFinite(cfg.snowFallSpeed) ? cfg.snowFallSpeed : 1.4   // m/s, real snow falls ~0.5-2m/s depending on flake size
  const SNOW_DRIFT_AMP = Number.isFinite(cfg.snowDriftAmp) ? cfg.snowDriftAmp : 0.6       // m, horizontal sway amplitude
  const SNOW_DRIFT_FREQ = Number.isFinite(cfg.snowDriftFreq) ? cfg.snowDriftFreq : 0.5     // Hz, sway frequency

  // Far billboard-sheet tier (shared shape for rain+snow, one active at a time matching `type`): a much
  // larger radius / much lower density ring beyond BOX_RADIUS..FAR_RADIUS giving the "precipitating
  // everywhere" reading. See file header for why this tier skips ground-contact/drift entirely.
  const FAR_RADIUS = Number.isFinite(cfg.farRadius) ? cfg.farRadius : 90     // outer XZ half-extent
  const FAR_INNER = Math.max(BOX_RADIUS * 1.15, FAR_RADIUS * 0.4)             // inner exclusion so far-tier particles don't overlap the dense near-tier volume
  const FAR_HEIGHT = Number.isFinite(cfg.farHeight) ? cfg.farHeight : 55
  const MAX_FAR = Number.isFinite(cfg.farParticleCount) ? cfg.farParticleCount : 500

  const SNOW_ACCUM_CFG_DEFAULT = cfg.snowAccumulation !== false // world-config default (on unless the world explicitly opts out)
  // Live-readable each frame (see update()'s snow branch) so RenderControls' snowAccumulation knob
  // (window.__renderControls.set('snowAccumulation', false)) takes effect without a reload, matching
  // weatherType/weatherIntensity's own live-apply contract -- window.__snowAccumulation undefined means
  // "no live override", fall back to the world-config default above.
  function _snowAccumEnabled() {
    if (typeof window !== 'undefined' && window.__snowAccumulation !== undefined) return !!window.__snowAccumulation
    return SNOW_ACCUM_CFG_DEFAULT
  }

  let type = (cfg.type === 'rain' || cfg.type === 'snow') ? cfg.type : 'clear'
  let intensity = THREE.MathUtils.clamp(Number.isFinite(cfg.intensity) ? cfg.intensity : 1, 0, 1)

  // WETNESS (wetness-material-modifier-weather-driven): a 0..1 scalar tracking "how wet the world
  // currently reads", driven by this weather state -- ramps toward `intensity` while type==='rain'
  // (fast: real rain wets a surface in a handful of seconds, not the slow dry-out), decays toward 0
  // over WET_DRY_OUT_SEC once rain stops (configurable via cfg.wetnessDryOutSec / RenderControls
  // wetnessDryOutSec -- read live each tick so a mid-session knob change takes effect immediately,
  // matching every other live-settable knob in this file). Snow does NOT drive wetness (a snow-covered
  // surface is not "wet" in the darken/specular-sheen sense this effect models -- that would be its
  // own accumulation effect, out of scope, see the snow-tier follow-up row).
  const WET_RAMP_UP_SEC = 4 // fast: rain wets ground quickly
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

  // createEntities: true -- every tier here needs REAL per-frame transform updates (fall simulation,
  // expanding splash rings, drift sway), unlike Grass.js/Vegetation.js which only ever set an instance's
  // transform once at placement time (addInstances' onCreation callback, then never again). Without
  // createEntities, InstancedMesh2 hands onCreation a single SHARED _tempInstance object that is not
  // retained -- there is no per-frame "setPositionAt"/"setQuaternionAt" mesh-level API (verified by
  // reading node_modules/@three.ez/instanced-mesh's actual source: the real per-frame mutation surface is
  // im.instances[id].position/.quaternion + instance.updateMatrix()/.updateMatrixPosition()).
  const geoStreak = makeStreakGeo()
  const matRain = makeRainMaterial()
  const im = new InstancedMesh2(geoStreak, matRain, { capacity: MAX_PARTICLES, renderer, createEntities: true })
  im.perObjectFrustumCulled = false   // camera-centered volume is always roughly on-screen; per-instance culling is pure overhead (same rationale as Grass.js)
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

  // Far sheet: one pool, re-skinned (material swapped) per type rather than two separate meshes --
  // only one of rain/snow is ever active at a time (type is a single enum), so there is no benefit to
  // keeping both far-tier pools live simultaneously; matFarRain/matFarSnow are built once and the mesh's
  // .material is swapped on a type change (cheap, InstancedMesh2 supports a live material swap the same
  // way any THREE.Mesh does).
  // 0.22 (this system's original, never-tuned default) was under half of matFarSnow's own 0.5 despite
  // being the more complex streak shape -- same under-tuned-relative-to-snow pattern as the near-tier
  // rain material (see WeatherMaterials.js's makeRainMaterial comment). Raised proportionally.
  const matFarRain = makeFarSheetMaterial(new THREE.Color(0.72, 0.78, 0.86), 0.4, false)
  const matFarSnow = makeFarSheetMaterial(new THREE.Color(0.95, 0.97, 1.0), 0.5, true)
  const geoFarRain = makeStreakGeo(), geoFarSnow = makeFlakeGeo()
  const imFar = new InstancedMesh2(geoFarRain, matFarRain, { capacity: MAX_FAR, renderer, createEntities: true })
  imFar.perObjectFrustumCulled = false
  imFar.frustumCulled = false
  imFar.visible = false
  scene.add(imFar)
  let _farGeoIsSnow = false

  // Snow ground accumulation: a REUSED src/terrain/GrassDecal.js sparse cell store (see file header --
  // same shape as burn/flatten decals, a persistent 0..1 scalar per world cell with cosine-falloff
  // stamping and half-life decay). Snow accumulates (never fully saturating to a hard white, decay ==
  // melt) at a slow steady rate while it's snowing, sampled via getSnowAccumulationAt(x,z) for a future
  // ground-material consumer (matches this row's own scoping: build the accumulation STORE + feed loop
  // now, a visual ground-whitening shader consumer is a natural follow-up once a material owner is
  // chosen, same "expose the primitive, a later row wires the shader" discipline underwater-tint/wetness
  // already use). Melt half-life is long (real snow melts over hours, not the ~2min grass-regrowth
  // default) so accumulation reads as genuinely persistent within a play session.
  const SNOW_MELT_HALF_LIFE_S = Number.isFinite(cfg.snowMeltHalfLifeS) ? cfg.snowMeltHalfLifeS : 1800
  const snowAccum = createGrassDecal(null, { halfLifeS: SNOW_MELT_HALF_LIFE_S })

  // Per-particle CPU state: x,y,z (world-space authoritative-ish local frame, NOT render-space -- see
  // update()'s floatingOrigin note), fallSpeed jitter. Flat typed arrays, not an object pool, matching
  // the perf discipline the rest of this codebase's per-frame-hot loops use (Grass.js's _benderPool,
  // RenderGraph.nodes.js's pooled scratch rows).
  const dropX = new Float32Array(MAX_PARTICLES), dropY = new Float32Array(MAX_PARTICLES), dropZ = new Float32Array(MAX_PARTICLES)
  const dropSpeed = new Float32Array(MAX_PARTICLES)
  let _idsAdded = false

  const snowX = new Float32Array(MAX_PARTICLES), snowY = new Float32Array(MAX_PARTICLES), snowZ = new Float32Array(MAX_PARTICLES)
  const snowSpeed = new Float32Array(MAX_PARTICLES), snowPhase = new Float32Array(MAX_PARTICLES), snowFreqJ = new Float32Array(MAX_PARTICLES)
  let _snowIdsAdded = false

  const farX = new Float32Array(MAX_FAR), farY = new Float32Array(MAX_FAR), farZ = new Float32Array(MAX_FAR)
  const farSpeed = new Float32Array(MAX_FAR)
  let _farIdsAdded = false

  const splashAge = new Float32Array(MAX_SPLASHES).fill(Infinity)
  let _splashCursor = 0
  let _splashIdsAdded = false

  let _lastCamYaw = NaN
  const YAW_EPS = 0.02 // ~1.1deg -- rain streak billboard-refresh gate (see file header)

  function _groundHeight(x, z) {
    if (frame && typeof frame.groundHeightLocal === 'function') {
      try { const gh = frame.groundHeightLocal(x, z); if (Number.isFinite(gh)) return gh } catch (_) {}
    }
    return -1e6 // no terrain frame available -> never trigger a ground splash/accumulation (falls through the whole box height instead)
  }

  // Places (or re-places) droplet i at a random XZ within BOX_RADIUS of (cx,cz), at the TOP of the box
  // (used both at first-spawn and on recycle-after-wrap). yTop is BOX_HEIGHT above the camera Y.
  function _respawnDroplet(i, cx, cy, cz) {
    const ang = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * BOX_RADIUS
    dropX[i] = cx + Math.cos(ang) * r
    dropZ[i] = cz + Math.sin(ang) * r
    dropY[i] = cy + BOX_HEIGHT * (0.3 + Math.random() * 0.7)
    dropSpeed[i] = FALL_SPEED * (0.85 + Math.random() * 0.3)
  }

  // Places (or re-places) flake i, same box-wrap shape as rain but with a persistent per-particle
  // drift phase/frequency-jitter so each flake sways on its own independent cycle (real snow doesn't
  // sway in lockstep).
  function _respawnFlake(i, cx, cy, cz) {
    const ang = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * BOX_RADIUS
    snowX[i] = cx + Math.cos(ang) * r
    snowZ[i] = cz + Math.sin(ang) * r
    snowY[i] = cy + BOX_HEIGHT * (0.3 + Math.random() * 0.7)
    snowSpeed[i] = SNOW_FALL_SPEED * (0.7 + Math.random() * 0.6)
    snowPhase[i] = Math.random() * Math.PI * 2
    snowFreqJ[i] = 0.75 + Math.random() * 0.5
  }

  // Places (or re-places) far-tier particle i in the RING between FAR_INNER and FAR_RADIUS (never
  // inside the near tier's own volume -- avoids double-density right at the seam) at a random height
  // through FAR_HEIGHT. No drift/splash bookkeeping -- see file header for why this tier is fall+wrap
  // only.
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

  // dt: frame delta seconds. camera: THREE.Camera (render-space position -- see the floatingOrigin
  // param). floatingOrigin: optional { toAuthoritative(pos) } converter (same contract
  // RenderGraph.nodes.js's foliage-lod-sync already uses) so particle placement/ground-height sampling
  // happens in the SAME authoritative local-frame space terrain sampling expects, exactly like
  // Vegetation/Rocks/Grass already do -- render-space camera position would silently desync ground
  // splashes/accumulation from the real terrain surface past a floating-origin rebase.
  function update(dt, camera, floatingOrigin) {
    // Wetness ticks REGARDLESS of the early-return below (dry-out must keep decaying even once rain
    // has stopped and the particle sim itself goes inert) -- Number.isFinite guard so a garbage dt
    // (e.g. a first-frame 0/undefined) never NaNs the ramp.
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
      const a = floatingOrigin.toAuthoritative({ x: cx, y: cy, z: cz })
      cx = a.x; cy = a.y; cz = a.z
    }

    const wantActive = Math.max(1, Math.round(MAX_PARTICLES * intensity))
    const wantFar = Math.max(1, Math.round(MAX_FAR * intensity))
    if (!_idsAdded) {
      // One-time real addInstances batch (matches Grass.js's batched-addInstances discipline -- a
      // single call instead of MAX_PARTICLES individual ones). All capacity is added up front and
      // intensity is expressed via visibility (setVisibilityAt), not by growing/shrinking the
      // instance set -- cheaper to toggle than to add/remove every time intensity changes.
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

    // Billboard yaw: computed once per frame (not per-instance -- every particle shares the same
    // camera-facing yaw), gated on the camera's OWN yaw changing enough to matter (see YAW_EPS) so a
    // static-pitch/rolling-only camera doesn't force a full re-orient of every active instance. Snow's
    // flat-square flakes additionally need full (yaw+pitch) billboarding, computed every frame below
    // (cheaper to always refresh MAX_PARTICLES quaternions than to track a second epsilon-gate --
    // snow's own count is the same order as rain's and pitch changes far more often than pure-yaw does
    // during normal play, so the gate would rarely pay off).
    camera.getWorldQuaternion(_camQuat)
    const camYaw = Math.atan2(2 * (_camQuat.w * _camQuat.y + _camQuat.x * _camQuat.z), 1 - 2 * (_camQuat.y * _camQuat.y + _camQuat.x * _camQuat.x))
    const yawChanged = !Number.isFinite(_lastCamYaw) || Math.abs(camYaw - _lastCamYaw) > YAW_EPS
    if (yawChanged) { _lastCamYaw = camYaw; _q.setFromAxisAngle(_upY, camYaw) }

    if (!isSnow) {
      // Real per-frame instance mutation via im.instances[i] (createEntities:true) -- see the
      // constructor comment above for why the mesh-level "setPositionAt" API this file originally
      // (incorrectly) assumed does not exist on InstancedMesh2.
      const instances = im.instances
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const a = i < wantActive
        im.setVisibilityAt(i, a)
        if (!a) continue
        dropY[i] -= dropSpeed[i] * dtc
        // wrap XZ back toward the camera if the box has drifted away (camera moved) -- keeps every
        // particle within BOX_RADIUS without a hard per-frame full respawn (only Y needs continuous
        // fall simulation; XZ only needs to stay inside the moving box).
        const ddx = dropX[i] - cx, ddz = dropZ[i] - cz
        if (ddx * ddx + ddz * ddz > BOX_RADIUS * BOX_RADIUS) {
          const ang = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * BOX_RADIUS
          dropX[i] = cx + Math.cos(ang) * r
          dropZ[i] = cz + Math.sin(ang) * r
        }
        const gh = _groundHeight(dropX[i], dropZ[i])
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
      // Snow: slow fall + horizontal drift sway, no splash -- on ground contact, stamp a small
      // accumulation decal (_snowAccumEnabled()-gated, live-settable via RenderControls
      // snowAccumulation) instead of a splash pulse, then respawn at the top like rain.
      // accumStampBudget caps how many flakes get to stamp per frame -- accumulation is a slow
      // multi-second process visually, stamping every landed flake every single frame is unnecessary
      // decal-store churn (each markScorched call is O(radius^2 cells), see GrassDecal.js).
      const instances = imSnow.instances
      const accumEnabled = _snowAccumEnabled()
      let accumStampBudget = 24
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const a = i < wantActive
        imSnow.setVisibilityAt(i, a)
        if (!a) continue
        snowY[i] -= snowSpeed[i] * dtc
        const driftAng = nowS * SNOW_DRIFT_FREQ * snowFreqJ[i] * Math.PI * 2 + snowPhase[i]
        snowX[i] += Math.cos(driftAng) * SNOW_DRIFT_AMP * dtc
        snowZ[i] += Math.sin(driftAng) * SNOW_DRIFT_AMP * dtc
        const ddx = snowX[i] - cx, ddz = snowZ[i] - cz
        if (ddx * ddx + ddz * ddz > BOX_RADIUS * BOX_RADIUS) {
          const ang = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * BOX_RADIUS
          snowX[i] = cx + Math.cos(ang) * r
          snowZ[i] = cz + Math.sin(ang) * r
        }
        const gh = _groundHeight(snowX[i], snowZ[i])
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
        // Full camera-facing billboard (yaw+pitch): copy the camera's own world quaternion so the flat
        // flake quad always faces the viewer regardless of pitch, unlike rain's yaw-only hang.
        inst.quaternion.copy(_camQuat)
        inst.updateMatrix()
      }
    }

    // Far billboard-sheet tier: Y-fall + wrap only (no per-instance yaw/pitch billboard refresh -- the
    // shader's own uColor/shape read is orientation-agnostic enough at this distance/density that a
    // fixed world-aligned quad reads fine, matching the cheap-distant-proxy discipline named in the file
    // header). No ground contact query at all -- far particles just wrap on the Y floor.
    {
      const speedBase = isSnow ? SNOW_FALL_SPEED : FALL_SPEED
      const instances = imFar.instances
      for (let i = 0; i < MAX_FAR; i++) {
        const a = i < wantFar
        imFar.setVisibilityAt(i, a)
        if (!a) continue
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
  // 0..1 decayed snow accumulation at a given world (x,z) -- 0 = bare ground, higher = more/fresher
  // snow. Always safe to call (returns 0 if accumulation was ever disabled or nothing has landed there
  // yet); the ground-material consumer this feeds is a follow-up row (see file header).
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
