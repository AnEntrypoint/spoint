import * as THREE from 'three'
import { installCascadeShadowSelect } from './CascadeShadowSelect.js'

// ShadowPipeline -- the ONE component that owns the sun shadow map(s): how the shadow camera follows the
// player, how it is TEXEL-SNAPPED for stability, when the map re-renders, and who consumes it.
//
// WHY IT EXISTS: the shadow lifecycle used to be smeared across SceneSetup (light + updateSunShadow),
// app.js (the needsUpdate cadence node), and TerrainBackdrop (the host-shadow bridge into mapspinner
// terrain). No single place owned "the shadow map and its stability", which is exactly why the close-tree
// MOTION FLASH was so hard to pin: the map re-renders every frame from the player-following ortho camera,
// and BOTH consumers -- THREE's own object shadows AND mapspinner's terrain-received bridge shadow --
// showed that per-frame movement as jitter (measured split: object-shadows ~4484 + terrain-bridge ~3355
// extra motion-change, on a ~8709 wind/motion floor). Fixing it means making the MAP itself stable under
// motion, in one owner, so both consumers are stable for free.
//
// THE FIX: TEXEL SNAPPING (the canonical directional-shadow-shimmer cure). The shadow-map depth texture
// samples world space on a fixed grid whose cell size is texelWorld = 2*extent / mapSize. If the shadow
// camera slides by a non-integer number of texels between frames, every shadowed pixel resamples a
// slightly different depth and the shadow edge crawls/shimmers as you move. Snapping the shadow-camera
// TARGET to whole-texel increments -- measured along the light's own right/up axes (the plane the shadow
// map spans), NOT world axes -- makes the sampling grid land on the same world texels frame to frame, so
// the shadow stops sliding. A prior naive attempt snapped in the wrong space and re-rendered on every
// texel step (discrete stepping = worse); this snaps in light space and only re-renders when the snapped
// target actually changed, so between texel steps the map is reused UNCHANGED (zero jitter) and each step
// is grid-aligned (no sub-texel slide).
//
// Verify only with the MOTION-BIG-CHANGE metric (during a pan, count pixels changing >110 that shadows add
// on top of smooth optical flow) + the user's eyes. The center-stripe-alternation metric is BANNED here
// (it read "fixed" three times while the flash was still live).
//
// CASCADES (csm-2-3-cascade-shadow-maps-shadowpipeline, first slice): 1-3 cascades, each an INDEPENDENT
// texel-snapped ortho shadow, applying the exact per-cascade generalization of the fix above -- never a
// new mechanism. Cascade 0 IS `sun` itself (byte-identical camera/extent/mapSize/bias to the pre-cascade
// single-shadow behavior; `cascades:1` is a no-op wrapper around the original code path). Cascade 1/2 are
// additional SHADOW-ONLY THREE.DirectionalLights (intensity 0, never contribute scene lighting -- only a
// shadow-casting placeholder) added to the same scene, aimed along the identical live sun direction, each
// with a wider extent (geometric split: extent, extent*CASCADE_SPLIT, extent*CASCADE_SPLIT^2) so cascade 1
// covers a bigger area at coarser texel resolution than cascade 0, etc -- the standard CSM split scheme.
//
// PER-CASCADE INDEPENDENCE IS LOAD-BEARING: each cascade gets its OWN _lastSnapped state and its own
// light.shadow.needsUpdate flag (THREE's WebGLShadowMap.render already gates per-light on
// `shadow.autoUpdate===false && shadow.needsUpdate===false` -- see node_modules/three's own
// WebGLShadowMap.js line ~170 -- independent of the renderer-level scope.needsUpdate/autoUpdate flag this
// file already sets false/true-on-demand). That per-light gate is what lets each cascade keep the EXACT
// proven "texel-step-gated, no heartbeat" cadence on its own terms: a near cascade (small extent, small
// texel) steps far more often under player motion than a far cascade (large extent, large texel), and
// forcing them onto one shared re-render decision would reintroduce the every-frame-repaint staleness this
// file exists to prevent. `renderer.shadowMap.needsUpdate` (the scene-wide flag app.js's shadow-move-gate
// sets) only has to go true if ANY cascade stepped this frame -- WebGLShadowMap.render then iterates every
// shadow-casting light and skips whichever cascade(s) did not individually request a re-render.
//
// Compositing (csm-per-fragment-cascade-select-shader, follow-up landed): client/core/CascadeShadowSelect.js
// patches THREE.ShaderChunk.lights_fragment_begin ONCE so each fragment selects (with a cross-fade band at
// the boundary) the ONE nearest cascade covering it by camera-space depth, instead of THREE's stock
// per-light multiplicative accumulation (every covering cascade's shadow term multiplied together). See
// that file's header for the full mechanism. installCascadeShadowSelect() is a COMPLETE NO-OP for
// cascadeCount<=1 (called below, but it returns immediately) -- the single-cascade path (the historically
// fragile close-tree-flicker subsystem's proven-safe default) stays byte-identical, zero regression risk.
// The near cascade still supplies HIGH-RESOLUTION shadows exactly where the fragile close-trunk-flicker
// geometry lives (small extent = small texelWorld), now composited via a real per-fragment select instead
// of an implicit accumulation, with the identical fragile-subsystem discipline (per-cascade texel-snap,
// per-cascade heartbeat-removal, one owner per concern) applied throughout.

const CASCADE_SPLIT = 3.2   // each further cascade's extent = prior extent * this factor (geometric CSM split)
const MAX_CASCADES = 3

export function createShadowPipeline(sun, opts = {}) {
  const scene = opts.scene || sun.parent || null
  const baseExtent = Number.isFinite(opts.extent) ? opts.extent : 60
  const requestedCascades = Number.isFinite(opts.cascades) ? opts.cascades : 1
  // Cascade 0 IS `sun` (see the loop below) -- if sun.castShadow is false (the documented tree-flicker
  // workaround, SceneSetup.js's sun.castShadow=false), cascade 0's light never renders a shadow map at
  // all, so its shadow.needsUpdate stays true forever and _lastSnapped/target are never placed
  // (_updateCascade's `if (!light.castShadow) return false` early-return, hit every call). A >1 cascade
  // pipeline built on top of that still installs the per-fragment CascadeShadowSelect blend shader,
  // which samples directionalShadowMap[0] -- an uninitialized/never-rendered depth texture -- for every
  // fragment within cascade 0's band (near geometry: the player, close trees, close architecture),
  // producing a visible ghosting/duplication artifact live-witnessed as a real ~2-week-old user-reported
  // bug (2026-08-09). A multi-cascade pipeline is only coherent when every cascade actually renders;
  // clamp to 1 cascade whenever sun.castShadow is off so this file's own multi-cascade code path is
  // never reached with a permanently-dead cascade 0 in it.
  const cascadeCount = sun.castShadow === false ? 1 : Math.max(1, Math.min(MAX_CASCADES, Math.round(requestedCascades)))
  // Sun-from-target offset: DIRECTION is the live light direction, LENGTH places the ortho camera.
  const offset = (opts.offset && opts.offset.isVector3) ? opts.offset.clone() : new THREE.Vector3(40, 80, 30)
  let offsetLen = offset.length()

  const _WORLD_UP = new THREE.Vector3(0, 1, 0)
  const _WORLD_FWD = new THREE.Vector3(0, 0, 1)

  // One cascade record per light (cascade 0 IS `sun`). Extra cascades are shadow-only DirectionalLights
  // (intensity 0 -- never touch scene lighting/color, only cast a shadow) sharing the sun's direction.
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
    // Own per-light throttle: THREE's WebGLShadowMap only re-renders a light whose OWN
    // shadow.needsUpdate is true (autoUpdate=false makes that explicit, not implicit-default).
    light.shadow.autoUpdate = false
    light.shadow.needsUpdate = true // first frame must render
    _cascades.push({
      light,
      extent: baseExtent * Math.pow(CASCADE_SPLIT, i),
      _extentApplied: -1,
      _lastSnapped: new THREE.Vector3(NaN, NaN, NaN),
      _target: new THREE.Vector3(),
    })
  }

  // Per-fragment cascade select (no-op for cascadeCount<=1, see CascadeShadowSelect.js header). Split
  // boundaries are each cascade's own extent -- the same definition the shadow camera itself already
  // uses to size cascade i's ortho frustum, so "camera-space distance inside cascade i's band" and
  // "inside cascade i's frustum" stay the same thing.
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

  // Aim every cascade along a unit local direction (length preserved per-cascade offset), matching the
  // planet sunLocal basis so foreground shadows agree with terrain lighting.
  function setSunDirection(dir) {
    if (!dir) return
    const l = Math.hypot(dir[0], dir[1], dir[2]) || 1
    offset.set(dir[0] / l * offsetLen, dir[1] / l * offsetLen, dir[2] / l * offsetLen)
    for (const c of _cascades) c._lastSnapped.set(NaN, NaN, NaN)   // force a re-place next update, every cascade
  }

  // Follow `target` with a texel-snapped shadow camera, once per cascade. Returns true iff ANY cascade's
  // snapped target actually moved this call (caller re-renders the scene-wide shadow pass only then;
  // WebGLShadowMap.render itself skips any individual cascade whose own shadow.needsUpdate stayed false).
  function _updateCascade(c, target) {
    const light = c.light
    if (!light || !light.castShadow) return false
    const texel = (2 * c.extent) / ((light.shadow.mapSize && light.shadow.mapSize.x) || mapSize())
    // Light view direction (from light toward target) and the right/up axes spanning the shadow map plane.
    _lightDir.copy(offset).normalize().negate()
    const upRef = Math.abs(_lightDir.dot(_WORLD_UP)) > 0.99 ? _WORLD_FWD : _WORLD_UP
    _right.crossVectors(upRef, _lightDir).normalize()
    _up.crossVectors(_lightDir, _right).normalize()
    // Snap the target's projection onto (right, up) to whole texels; keep the along-light component exact.
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
      light.shadow.needsUpdate = true   // per-cascade throttle: only THIS cascade re-renders this frame
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

  // Forces EVERY cascade's own light.shadow.needsUpdate true, not just the renderer-level scene-wide
  // flag. Needed whenever new shadow-casting geometry streams in (app.js's _scheduleFitShadow) or the
  // very first frame: THREE's WebGLShadowMap.render resets each light's shadow.needsUpdate=false right
  // after rendering it (see node_modules/three WebGLShadowMap.js ~line 363), independently of the
  // renderer-level scope.needsUpdate it also resets (~line 369) -- so setting only
  // renderer.shadowMap.needsUpdate=true (which merely un-gates the PASS from being skipped entirely,
  // WebGLShadowMap.js line 95) does nothing for a cascade whose OWN needsUpdate is still false from a
  // prior render (the per-light gate, line 170): a far cascade that hasn't texel-stepped recently would
  // silently keep showing newly-streamed geometry as un-shadowed/missing from its map indefinitely.
  function forceUpdate() {
    for (const c of _cascades) c.light.shadow.needsUpdate = true
  }

  const pipeline = {
    update, setSunDirection, forceUpdate,
    get extent() { return baseExtent },
    get cascadeCount() { return cascadeCount },
    // Real array of every cascade's THREE light (index 0 IS `sun`) -- the same array
    // WebGLShadowMap.render receives from THREE's per-frame lights list, in cascade order. Consumers
    // (e.g. ShadowCostProbe.js) that need to mask/measure every cascade together, not just cascade 0,
    // must use this instead of hardcoding `sun` (see csm-shadowcostprobe-cascade-blind-measurement).
    get lights() { return _cascades.map(c => c.light) },
    texelWorld,
    // Debug surface: current snapped target + texel size per cascade, for the shadow-flash investigation.
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
    // Floating-origin support (see core/FloatingOrigin.js): every cascade light/target is a real scene
    // child so FloatingOrigin's own translate pass already moves them correctly; each cascade's own
    // _lastSnapped is a persistent Vector3 held OUTSIDE the scene graph and must be shifted in lockstep or
    // the next update() call reads it as stale (an artificial big jump from the shift alone), spuriously
    // flagging `moved` and forcing an extra shadow-map re-render the same frame the scene rebased --
    // harmless (a rebase is rare and one map re-render per cascade is cheap) but this keeps the texel-snap
    // state exactly consistent instead of relying on that fallback.
    shiftFloatingOrigin(dx, dy, dz) {
      for (const c of _cascades) { if (Number.isFinite(c._lastSnapped.x)) c._lastSnapped.set(c._lastSnapped.x + dx, c._lastSnapped.y + dy, c._lastSnapped.z + dz) }
    },
  }
  if (typeof window !== 'undefined') window.__shadowPipeline = pipeline
  return pipeline
}
