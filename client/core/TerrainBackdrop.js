// Renders the mapspinner Earth-scale planet backdrop around the spoint arena, sharing spoint's WebGL2 context. The planet draws first (fills canvas); app.js then clears depth and renders the spoint scene on top.
import * as THREE from 'three'
import { createPlanetFrame, DEFAULT_PATCH_MAX_LEVEL } from '/src/terrain/PlanetFrame.js'
import { createTerrainOcclusion } from './TerrainOcclusion.js'
import { dbg } from './debug-log.js'
import { RenderControls } from './RenderControls.js'

const _dbgTerrain = dbg('terrain')

// No-op fallback when the planet cannot initialize (e.g. WebGL2 ctx missing EXT_color_buffer_float). Deliberately does not set window.__terrain so veg/rocks/grass (gated on it) stay off instead of faulting on a stub frame.
function _createFallbackBackdrop() {
  const frame = {
    east: [1, 0, 0], up: [0, 1, 0], north: [0, 0, 1], anchorHeight: 0,
    groundHeightLocal: () => 0,
    localToWorld: (x, y, z) => [x, y, z],
    worldToLocal: (x, y, z) => [x, y, z],
  }
  const sampler = { heightAt: () => 0, anchorField: null }
  const planet = { frame: () => {}, clearCache: () => {} }
  return {
    planet, frame, sampler,
    renderPlanet() {},   // no backdrop to draw
    update() {},
    dispose() {},
    setSunLocal() {},
  }
}

export async function createTerrainBackdrop(renderer, scene, cfg = {}) {
  // WebGPU fail-open (webgpurenderer-terrainbackdrop-getcontext-guard): mapspinner's raw-WebGL2
  // compositor (gl-render.js, 389 call sites) has no WebGPU port -- see docs/webgpu-shader-audit.md,
  // which scopes that as its own dedicated epic, not a shader-swap. renderer.getContext() returns
  // no real WebGL2RenderingContext under a WebGPURenderer (renderer.isWebGPURenderer === true), so
  // calling into initMapspinnerPlanet with it would throw deep inside mapspinner instead of at this
  // boundary. Same check-and-fail-open discipline TerrainOcclusion.js already applies one line below
  // (gl instanceof WebGL2RenderingContext -> isWebGL2, no throw either way) and the same fallback
  // _createFallbackBackdrop() this function already returns on a real mapspinner import failure --
  // this just reaches that same fallback one step earlier, before the GL calls that would throw, so
  // the rest of the scene (THREE-rendered content, the TSL post-fx passes) still renders under
  // ?webgpu=1 even though the planet/terrain/water backdrop stays WebGL2-only for now.
  if (renderer && renderer.isWebGPURenderer) {
    console.warn('[terrain] WebGPURenderer active -> mapspinner has no WebGPU port yet, running without planet backdrop (see docs/webgpu-shader-audit.md)')
    return _createFallbackBackdrop()
  }
  const gl = renderer.getContext()
  // predicate only reads verdicts; queries issue via runOcclusionQueries() after scene render (see TerrainOcclusion.js header)
  const _terrainOcclusion = createTerrainOcclusion(gl, { minCandidates: cfg.occlusionMinCandidates ?? 32, maxElev: cfg.occlusionMaxElev ?? 200 })
  let initMapspinnerPlanet, createHeightSampler
  try {
    ;({ initMapspinnerPlanet } = await import('mapspinner/planet-orchestrator'))
    ;({ createHeightSampler } = await import('mapspinner/height-cpu'))
  } catch (e) {
    console.warn('[terrain] mapspinner import failed -> running without planet backdrop:', e?.message || e)
    return _createFallbackBackdrop()
  }
  const radius = cfg.radius || 6360000
  // ?lightplanet: build the real CPU sampler+frame (veg places on real terrain, window.__terrain set) but skip the heavy planet GPU init -- isolates foliage/physics from the planet render block
  const _lightPlanet = typeof location !== 'undefined' && location.search.includes('lightplanet')
  let planet, sampler, frame
  // retry on transient init failure (a one-off fetch blip would otherwise permanently drop to the no-planet fallback)
  async function _initPlanet() {
    if (_lightPlanet) return { frame: () => {}, clearCache: () => {} }
    let lastErr
    for (let attempt = 0; attempt < 3; attempt++) {
      // reliefScale/seed must be passed explicitly so the GPU-rendered surface and the CPU height sampler use identical relief -- omitting it desyncs the two once cfg.reliefScale changes from the SDK default (floating trees / spawn-in-water)
      // gridMeshSize 11->9 (2026-07-05, iGPU perf): mapspinner's own tuned/blessed default is 9
      // (src/gl-render.js:86) -- -44% verts/quad, -33% tris/quad vs 11; GRID 8 was measured too
      // jagged for biome crossover lines, 9 is the floor. Screenshot-parity witnessed.
      // GEOMORPH LOD (2026-07-22, production-enable follow-up to the perf-regression gate): mapspinner's
      // per-vertex, level-keyed CDLOD-style morph (terrain.glsl uMorphSplitDist path) is crack-free BY
      // CONSTRUCTION -- a shared boundary vertex between two same-level neighbor quads has one world
      // position and one level, so both sides evaluate the identical morph formula (see quadtree.js's own
      // comment on why a per-quad ratio was rejected as neighbor-inconsistent) -- and is INDEPENDENT of the
      // separate skirt/overlap-ring mechanism (gl-render.js's GRID+2 overlap ring + terrain.glsl's
      // vertex.z>0.5 radial skirt-drop) that already hides cross-LOD T-junction cracks; the two mechanisms
      // solve different problems (morph = no vertex-position POP at a split; skirt = no crack at a
      // coarse/fine LOD BOUNDARY) and were verified live to compose without a new crack (2026-07-22
      // screenshot witness at a shore LOD-transition pose, geomorph on vs off, zero new discontinuity).
      // Default ON in production now that the FPS-regression root cause (unconditional VS morph cost, see
      // perf-regression-terrain-geomorph-default-off-plus-gl-errors-investigation) is fixed by this same
      // opts.geomorphLod gate -- the gate itself already existed and defaulted OFF; this call site is the
      // first production consumer to opt in. window.__geomorphLod overrides at boot (RenderControls-listed).
      // Read via RenderControls.get('geomorphLod') (offscreencanvas-mapspinner-config-channel-wiring first
      // slice): RenderControls.get already reads window.__geomorphLod when set, else falls back to the
      // registry's own default (true, matching this call site's prior inline `!== false ? ... : true`
      // fallback exactly) -- byte-identical resolved value for every window.__geomorphLod state
      // (unset/true/false), only the lookup is now routed through the discoverable registry instead of an
      // inline window.__<key> read, so a future worker-hosted config channel can swap the source with a
      // one-line change here instead of a second bespoke read.
      try { return await initMapspinnerPlanet(gl, { radius, gridMeshSize: 9, reliefScale: cfg.reliefScale, hpfSeed: cfg.seed, maxLevel: Number.isFinite(cfg.maxLevel) ? cfg.maxLevel : undefined, splitFactor: Number.isFinite(cfg.splitFactor) ? cfg.splitFactor : undefined, occlusionPredicate: cfg.occlusionCulling === false ? undefined : _terrainOcclusion.makePredicate(), geomorphLod: RenderControls.get('geomorphLod') !== false }) }
      catch (e) { lastErr = e; console.warn(`[terrain] planet init attempt ${attempt + 1}/3 failed:`, e?.message || e); await new Promise(r => setTimeout(r, 400 * (attempt + 1))) }
    }
    throw lastErr
  }
  // half-res water must stay ON -- mapspinner's _vdrsFbo pass also runs the atmosphere/aerial-perspective composite; disabling it whites out the whole terrain surface, not just water perf
  // (RE-CONFIRMED LIVE 2026-07-05: __halfResWater=false measured ~9ms p50 faster on the iGPU but whites out ALL open terrain at any vista pose -- only a courtyard pose looks intact. Not a usable lever as-is.)
  // THC (baked tile-height cache, window.__thc, gl-render.js:540-607) A/B'd live on THIS AMD iGPU
  // (2026-07-05, curtain-correct fresh-page protocol: gated on window.__app.revealedAt, not the
  // earlier window.__terrain-only readiness check which fired while the loading curtain was still
  // covering the canvas and measured that overlay's own render loop instead of the real scene --
  // drawCalls/triangles read 0 the whole time, the tell). 4 paired fresh-page runs at the default
  // spawn pose: THC-off p50 14.8/16.0/17.0/17.7ms vs THC-on p50 16.2/16.8/16.9/18.1ms -- THC-on was
  // flat-to-very-slightly-WORSE, never a >1ms win, no visible height/normal artifacts either way.
  // DECLINED: default stays off. (Plausible cause: this pose's visible terrain-tile count is small
  // -- walled spawn courtyard -- so the per-vertex composeHeight cost THC targets isn't the
  // bottleneck here; may be worth re-A/B'ing from an open-vista pose with many visible tiles.)
  // shared depth (window.__planetDepthToCanvas) ON so vegetation/models are occluded by terrain.
  // BIAS DEFAULT (impostor/rock/tree-trunk depth-flicker fix, was 0/"exact depth"): vegetation/rock
  // placement samples ground height from the finest-LOD-density GPU patch bake (patch-baker.js), but
  // the terrain surface actually RENDERED at distance is a much coarser LOD mesh (linear-interpolated
  // between sparser vertices) -- the two disagree by a few cm to a few dm at any given point between
  // coarse-mesh vertices, and which one reads "in front" flips with camera angle/LOD-tile selection as
  // the player moves. Exact (bias 0) depth meant flush-placed geometry (impostor billboards, rock/tree
  // bases) coin-flipped the raw z-test against its own supporting ground every few frames -- reported
  // live as "impostors appear and disappear like there's depth error" / "nearby tree trunks flicker
  // continuously" / "far away rocks flicker".
  // BIAS UNIT (was a flat depth01 epsilon added post-projection, now a zEye^2 scale coefficient applied
  // to eye-space distance BEFORE reprojection, see gl-render.js's depth-writeback shader): a flat
  // depth01 delta corresponds to a real-world separation that shrinks toward nothing at range (depth01
  // precision is hyperbolic in eye-space distance), so the old flat bias only protected near-camera
  // geometry -- long-range tree/rock bases kept flickering against the coarse terrain mesh (live-reported
  // "land interferes with the trees"). Scaling the real-world bias by zEye^2 before reprojecting cancels
  // that hyperbolic falloff exactly, giving a CONSTANT depth01 protection margin at every distance
  // instead of one that degrades with range (see VegImpostorTier.js's polygonOffset for the earlier,
  // impostor-mesh-only complement to this). The numeric default (0.00003) is unchanged -- it was solved
  // to reproduce the OLD bias's near-camera protection margin exactly, so close-range behavior is
  // byte-for-byte the same; only the long-range falloff is fixed.
  // Default-seed via RenderControls.set (offscreencanvas-mapspinner-config-channel-wiring first slice):
  // RenderControls.set writes the identical window.__<key> global RenderControls itself already lists
  // planetDepthToCanvas/planetDepthBias's defaults as (true / 0.00003, see RenderControls.js CONTROLS) --
  // this seed is now REDUNDANT with the registry default (RenderControls.get already falls back to it
  // when unset) but is kept as an explicit boot-time window.__<key> write since gl-render.js/DepthComposite.js
  // read the raw global directly, not through RenderControls.get, and must see a concrete value at
  // first-frame time, not `undefined`.
  if (typeof window !== 'undefined' && window.__planetDepthToCanvas === undefined) RenderControls.set('planetDepthToCanvas', true)
  if (typeof window !== 'undefined' && window.__planetDepthBias === undefined) RenderControls.set('planetDepthBias', 0.000002)
  try {
    planet = await _initPlanet()
    sampler = createHeightSampler({ radius, seed: cfg.seed, reliefScale: cfg.reliefScale })
    frame = createPlanetFrame({ sampler, anchorDir: cfg.anchorDir || [0, 1, 0], offsetY: cfg.offsetY || 0, reliefScale: cfg.reliefScale })
    // Overrides groundHeightLocal with an O(1) GPU patch lookup (server + client share createPatchHeightFn -> byte-identical tree parity); falls back to the CPU fractal on no-GPU/init-fail.
    if (cfg.gpuPatchCollider !== false) {
      try {
        const { createPatchBaker, createPatchHeightFn } = await import('/node_modules/mapspinner/src/patch-baker.js')
        const baker = await createPatchBaker({ radius, reliefScale: cfg.reliefScale, seed: cfg.seed }).catch(() => null)
        // must capture the fractal fn BEFORE it's overwritten below -- a fallbackFn that lazily re-reads frame.groundHeightLocal recurses infinitely once heightFn is reassigned (live RangeError repro'd 2026-07-02)
        const fractalGHL = frame.groundHeightLocal
        // blocking:false: client placement/render tolerates a value up to ~100 frames stale, so a non-blocking bake miss falls back to the CPU fractal instead of a synchronous GPU-readback stall. Server collider keeps blocking:true (physics correctness cannot tolerate a stale height).
        // maxLevel fallback (DEFAULT_PATCH_MAX_LEVEL) must match TerrainPhysics.js's server-side call -- see PlanetFrame.js.
        const ph = baker && createPatchHeightFn({ baker, frame, maxLevel: Number.isFinite(cfg.maxLevel) ? cfg.maxLevel : DEFAULT_PATCH_MAX_LEVEL, offsetY: cfg.offsetY || 0, fallbackFn: fractalGHL, blocking: false })
        if (ph) {
          frame.groundHeightLocal = (x, z) => ph.heightFn(x, z)
          frame._fractalGroundHeightLocal = fractalGHL
          if (typeof ph.prefetchAround === 'function') frame._patchPrefetch = ph.prefetchAround
          console.log(`[terrain] client placement height -> GPU PATCH lookup (${ph.spacing.toFixed(2)}m, finest-LOD density) -- matches server + render, no per-candidate fractal`)
        }
      } catch (e) { console.warn('[terrain] client patch-height override unavailable -> fractal placement:', e?.message || e) }
    }
    // Full resolution by default; tunable via window.__vdrsScale/cfg.renderScale. RenderControls.get
    // returns the registry default (null) when unset, same precondition the old `== null` check tested.
    if (typeof window !== 'undefined' && RenderControls.get('vdrsScale') == null && cfg.renderScale != null) RenderControls.set('vdrsScale', cfg.renderScale)
  } catch (e) {
    console.warn('[terrain] planet init failed -> running without planet backdrop:', e?.message || e)
    return _createFallbackBackdrop()
  }

  if (typeof window !== 'undefined') window.__terrain = { heightAt: (d) => sampler.heightAt(d), groundHeightLocal: (x, z) => frame.groundHeightLocal(x, z), frame, planet, occlusionStats: () => _terrainOcclusion.getStats() }

  const _fwd = new THREE.Vector3(), _pos = new THREE.Vector3(), _eye = [0, 0, 0], _tgt = [0, 0, 0]
  // sun dir is defined in spoint LOCAL space and must be rotated into the planet ECEF frame per-call (local up is anchorDir, not world +Y)
  // MUTABLE IN PLACE (not reassigned): renderPlanet's per-frame ECEF projection below (_sunE[i] = ...)
  // already reads this array fresh every call, so a live time-of-day driver (client/core/TimeOfDay.js)
  // can update it every frame via setSunLocal() with zero other change to the render path -- the
  // existing per-frame re-projection is what makes an animated sun direction free to wire in.
  const sunLocal = (() => { const s = cfg.sun || [0, 0.343, 0.939]; const l = Math.hypot(s[0], s[1], s[2]) || 1; return [s[0] / l, s[1] / l, s[2] / l] })()
  const _sunE = [0, 0, 0]
  // dir: [x,y,z] unit-ish local-space sun direction (normalized here so callers can pass a raw vector).
  function setSunLocal(dir) {
    if (!dir) return
    const l = Math.hypot(dir[0], dir[1], dir[2]) || 1
    sunLocal[0] = dir[0] / l; sunLocal[1] = dir[1] / l; sunLocal[2] = dir[2] / l
  }

  // Called from app.js BEFORE the three scene render; app.js clears depth + renders the scene on top.
  // HOST-ENGINE SHADOW BRIDGE (shadows-never-render-on-terrain): mapspinner's terrain is raw WebGL2
  // outside THREE's mesh graph, so it can never receiveShadow through WebGLShadowMap. Instead thread
  // THREE's live shadow depth texture + light-space matrix into mapspinner's terrain FS (see
  // terrain.glsl's sampleHostShadow / gl-render.js's shadowInfo upload). Reads whatever shadow-map
  // state the shadow-temporal-throttle (SceneSetup.js autoUpdate=false + app.js's needsUpdate-on-move
  // gate) last produced -- never forces a re-render, never touches that cadence.
  const _shadowMatrixArr = new Float32Array(16)
  // ECEF-to-local composition matrix (world->local rotation+translate, built once per frame's east/
  // up/north/anchorHeight/radius -- all fixed for the frame's lifetime, so this Matrix4 never changes
  // after the first call). uShadowMatrix is THREE's light.shadow.matrix, which maps spoint's LOCAL
  // space (a small +-extent box around the player, sized by ShadowPipeline) into shadow-map UV+depth --
  // but terrain.glsl's sampleHostShadow is called with vWorld, mapspinner's planet-ECEF world space
  // (~6.4e6 units from origin). Multiplying uShadowMatrix directly by an ECEF position projects to
  // values ~1e5x outside [0,1]^3, so sampleHostShadow's own bounds check rejects every real fragment
  // and terrain never receives a visible shadow despite the bridge uploading real data with no error.
  // Fix: pre-multiply an ECEF->local transform into the shadow matrix on the CPU side (one 4x4 multiply
  // per frame here, zero shader changes) so the shader's existing uShadowMatrix*vWorld already lands
  // in the correct small local-space box before the shadow-map projection is applied.
  let _worldToLocalM4 = null
  function _ensureWorldToLocalM4() {
    if (_worldToLocalM4) return _worldToLocalM4
    // world = up*(radius+anchorHeight+y) + east*x + north*z  (PlanetFrame.js localToWorld)
    // => local = R^T * (world - T), R columns = [east, up, north] (orthonormal), T = up*(radius+anchorHeight)
    const [ex, ey, ez] = frame.east, [ux, uy, uz] = frame.up, [nx, ny, nz] = frame.north
    const t = radius + frame.anchorHeight
    const Tx = ux * t, Ty = uy * t, Tz = uz * t
    // R^T rows are R's columns transposed: row0=east, row1=up, row2=north (maps world-delta -> local x,y,z)
    const m = new THREE.Matrix4()
    m.set(
      ex, ey, ez, -(ex * Tx + ey * Ty + ez * Tz),
      ux, uy, uz, -(ux * Tx + uy * Ty + uz * Tz),
      nx, ny, nz, -(nx * Tx + ny * Ty + nz * Tz),
      0, 0, 0, 1
    )
    _worldToLocalM4 = m
    return m
  }
  const _composedShadowM4 = new THREE.Matrix4()
  function _buildShadowInfo(sun) {
    if (!sun || !sun.castShadow || !sun.shadow || !sun.shadow.map) return undefined
    // depthTexture (NOT .texture, the render target's unused color attachment for PCFShadowMap) is
    // the actual comparison-mode depth THREE's own shadow shader samples -- see WebGLShadowMap.js:
    // shadow.map.depthTexture gets compareFunction set for PCFShadowMap (COMPARE_REF_TO_TEXTURE),
    // while shadow.map.texture is only populated/used for VSMShadowMap's blurred variance map.
    const tex = sun.shadow.map.depthTexture
    if (!tex) return undefined
    let glTex = null
    try {
      const props = renderer.properties.get(tex)
      glTex = props && props.__webglTexture
    } catch (_) { glTex = null }
    if (!glTex) return undefined
    _composedShadowM4.copy(sun.shadow.matrix).multiply(_ensureWorldToLocalM4())
    _composedShadowM4.toArray(_shadowMatrixArr)
    return {
      hasShadow: true,
      texture: glTex,
      matrix: _shadowMatrixArr,
      frameEast: frame.east, frameUp: frame.up, frameNorth: frame.north,
      frameAnchorHeight: frame.anchorHeight, frameRadius: radius,
      bias: sun.shadow.bias, normalBias: sun.shadow.normalBias,
      mapSize: sun.shadow.mapSize.x || 1024,
    }
  }
  let _lastPrefetchSec = -Infinity
  // SUSTAINED-SMALL-MOVEMENT RECONCILE (terrain-blocks-disappear-until-camera-moves fix): mapspinner's
  // own quadtree-rebuild gate (planet-orchestrator.js moveTol) floors at 1.0m absolute cumulative
  // displacement from the last-rebuilt pose -- a camera drifting slower than that (e.g. slow walk/
  // strafe) can go several seconds without crossing it, so a hidden-by-stale-occlusion-verdict tile
  // has NO rebuild to re-admit it except the flip-triggered clearCache() below, whose latency scales
  // with the query round-robin budget reaching that specific record (MAX_QUERIES_PER_FRAME=32) AND
  // the 2-consecutive-hidden-resolve hysteresis reversing -- not simply "did the camera move". Track
  // cumulative eye displacement independently of mapspinner's internal moveTol/cache and force a
  // reconcile rebuild once it crosses a much finer floor -- closes the gap directly rather than
  // waiting on flip-latency. RECONCILE_MOVE_M chosen well under mapspinner's 1.0m floor so this fires
  // first for any sustained movement, while a fully still camera (0 displacement) never triggers it,
  // preserving the existing still-camera cache-hold fps behavior untouched.
  const RECONCILE_MOVE_M = 0.35
  let _reconcileAccum = 0
  let _lastReconcilePos = null
  function _trackReconcileMovement(eyeW) {
    if (!_lastReconcilePos) { _lastReconcilePos = [eyeW[0], eyeW[1], eyeW[2]]; return }
    const dx = eyeW[0] - _lastReconcilePos[0], dy = eyeW[1] - _lastReconcilePos[1], dz = eyeW[2] - _lastReconcilePos[2]
    _lastReconcilePos[0] = eyeW[0]; _lastReconcilePos[1] = eyeW[1]; _lastReconcilePos[2] = eyeW[2]
    _reconcileAccum += Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (_reconcileAccum >= RECONCILE_MOVE_M) {
      _reconcileAccum = 0
      try { planet.clearCache && planet.clearCache() } catch (_) {}
    }
  }
  // toAuthoritative (optional): floating-origin conversion, render-space THREE position -> true
  // unbounded local-frame coordinate (see FloatingOrigin.js). mapspinner's frame.localToWorld/
  // groundHeightLocal project local x/z onto the actual planet surface -- once the render-space scene
  // graph gets rebased toward (0,0,0) at planetary range, camera.getWorldPosition() alone no longer IS
  // the local-frame coordinate, and feeding it the rebased (near-zero) value would sample the wrong
  // point on the planet. Defaults to identity so a caller not wired to FloatingOrigin (or a build
  // where the camera never leaves rebase range) behaves exactly as before.
  function renderPlanet(camera, elapsedSec, sun, toAuthoritative) {
    try {
      camera.getWorldPosition(_pos)
      const p = toAuthoritative ? toAuthoritative(_pos, _pos) : _pos
      if (frame._patchPrefetch && elapsedSec - _lastPrefetchSec > 0.25) {
        _lastPrefetchSec = elapsedSec
        try { frame._patchPrefetch(p.x, p.z) } catch (_) {}
      }
      const eyeW = frame.localToWorld(p.x, p.y, p.z)
      camera.getWorldDirection(_fwd)
      const fE = [
        frame.east[0] * _fwd.x + frame.up[0] * _fwd.y + frame.north[0] * _fwd.z,
        frame.east[1] * _fwd.x + frame.up[1] * _fwd.y + frame.north[1] * _fwd.z,
        frame.east[2] * _fwd.x + frame.up[2] * _fwd.y + frame.north[2] * _fwd.z,
      ]
      _eye[0] = eyeW[0]; _eye[1] = eyeW[1]; _eye[2] = eyeW[2]
      _trackReconcileMovement(eyeW)
      _tgt[0] = eyeW[0] + fE[0] * 1000; _tgt[1] = eyeW[1] + fE[1] * 1000; _tgt[2] = eyeW[2] + fE[2] * 1000
      const fovy = (camera.fov || 70) * Math.PI / 180
      _sunE[0] = frame.east[0] * sunLocal[0] + frame.up[0] * sunLocal[1] + frame.north[0] * sunLocal[2]
      _sunE[1] = frame.east[1] * sunLocal[0] + frame.up[1] * sunLocal[1] + frame.north[1] * sunLocal[2]
      _sunE[2] = frame.east[2] * sunLocal[0] + frame.up[2] * sunLocal[1] + frame.north[2] * sunLocal[2]
      renderer.resetState()
      // surfElev (radius-fraction) must track the live terrain height under the camera, not a fixed constant, or near tiles' LOD/near-plane goes wrong as the player changes elevation
      let surfElev = frame.anchorHeight
      try { const gh = frame.groundHeightLocal(p.x, p.z); if (Number.isFinite(gh)) surfElev = frame.anchorHeight + gh } catch (_) {}
      // The occlusion predicate (opts.occlusionPredicate) is a pure READ of last frame's resolved
      // verdicts -- query issue happens in runOcclusionQueries() AFTER renderer.render, when the
      // depth buffer holds this frame's full opaque content. See TerrainOcclusion.js's header for
      // why issuing inside planet.frame() is structurally impossible (mapspinner's own
      // draw-before-compute pipelining clears depth + rebinds GL state before the per-leaf loop).
      // window.__hostShadowOff (diagnostic): skip the host-shadow bridge so the terrain draws fully lit
      // (no THREE shadow projected onto it) -- isolates terrain-received-shadow jitter from THREE object shadows.
      // Read via RenderControls.get (offscreencanvas-mapspinner-config-channel-wiring first slice) -- this
      // is the PER-FRAME renderPlanet hot path (AGENTS.md tree-flicker fragile zone), so the read is a
      // single Map.get + one window.__hostShadowOff property read, same cost class as the raw inline read
      // it replaces (RenderControls.get does not deep-clone or allocate).
      const shadowInfo = RenderControls.get('hostShadowOff') ? undefined : _buildShadowInfo(sun)
      const _res = planet.frame(_eye, _tgt, fovy, 0, _sunE, elapsedSec, frame.up, surfElev / radius, shadowInfo)
      // FAIL-SAFE (2026-07-04 planet-disappeared outage): a rebuild that keeps ZERO quads gets
      // cached and an idle camera (below the rebuild move tolerance) holds it forever -> the whole
      // planet vanishes. Occlusion culling must never be able to produce that state: reset every
      // verdict to fail-open and drop the cached quad set so the next frame rebuilds and draws.
      if (_res && _res.cached === false && _res.quadCount === 0) {
        _dbgTerrain('zero-quad fail-safe triggered -> clearing occlusion verdicts + planet cache')
        try { _terrainOcclusion.clearVerdicts() } catch (e) { _dbgTerrain('clearVerdicts failed in zero-quad fail-safe:', e?.message || e) }
        try { planet.clearCache && planet.clearCache() } catch (e) { _dbgTerrain('planet.clearCache failed in zero-quad fail-safe:', e?.message || e) }
      }
      renderer.resetState()                                      // three reclaims gl state
      if (scene.background !== null) scene.background = null     // planet drew fine this frame; keep it the sole sky painter
    } catch (e) {
      // DEGRADE (sky-flickers-dark-until-camera-moves): scene.background is nulled once the planet
      // backdrop goes live (app.js) so mapspinner's raw-GL drawSky() is the ONLY thing that paints sky
      // pixels; gl-render.js clears the canvas to OPAQUE BLACK at the top of every render() call before
      // drawSky draws over it. This try/catch used to swallow any throw from planet.frame()/render.render
      // (most likely while the camera holds still and the cached !moved branch in planet-orchestrator.js
      // runs) with zero fallback paint -> the black clear color was the only thing left on screen until a
      // moved-branch frame succeeded (recovery-on-movement is what made it read as "goes dark until camera
      // moves"). Fix: restore a real sky color for the frames the backdrop fails to draw (never leave the
      // canvas on the raw black clear) and log once per unique message (never per-frame spam) so a future
      // occurrence is diagnosable instead of silently invisible.
      const msg = String(e && e.message || e)
      if (msg !== _lastRenderPlanetErr) { _lastRenderPlanetErr = msg; console.warn('[terrain] renderPlanet threw, painting fallback sky this frame:', msg) }
      if (scene.background === null) scene.background = _fallbackSkyColor
      // A throw partway through the raw-GL sequence above can leave three's own GL state assumptions
      // (bound VAO/program/buffers) clobbered -- reclaim state here too so the scene render right after
      // this call (app.js's scene-color node) never inherits mapspinner's half-mutated GL state, which
      // would otherwise corrupt THAT frame's THREE draw (trunks/rocks/impostors) on top of the sky miss.
      try { renderer.resetState() } catch (_) {}
    }
  }
  let _lastRenderPlanetErr = null
  const _fallbackSkyColor = new THREE.Color(0x87ceeb)
  // Called once per frame AFTER renderer.render(scene,camera) (same slot as
  // modelPool.runOcclusionQueries / sceneOcclusion.runQueries -- the depth buffer then holds every
  // opaque occluder: terrain depth writeback + walls/models). Issues/resolves the per-leaf box
  // queries whose verdicts the predicate reads on the next quadtree rebuild.
  //
  // STALE-CACHE-ON-VERDICT-FLIP FIX (2026-07-06, camera-pose gap bug): the orchestrator's
  // static-camera cache (planet-orchestrator.js's `!moved` branch) skips the 6-face quadtree
  // rebuild -- and the occlusion predicate is ONLY consulted during that rebuild -- for as long
  // as the camera holds still. But query resolution here (hysteresis settle, eyeAtIssue expiry,
  // the still-camera issue-throttle) keeps changing `rec.occluded` verdicts underneath the frozen
  // cache: a leaf newly occluded gets baked into the NEXT rebuild's exclusion, but a leaf that
  // just un-occluded (or one whose candidacy churned while the camera nudged and returned) never
  // gets a rebuild to re-admit it, since the camera "hasn't moved" by the orchestrator's own
  // metric. Live-witnessed: teleporting to a pose, nudging 300m away and back to the EXACT same
  // pose, kept-quad count for that identical viewpoint dropped 380 -> 274 -> 200 over a few
  // seconds and then froze there permanently (candidateCount hit 0, no further rebuilds) --
  // visible terrain gaps near the camera that never recover without moving again. Fix: track the
  // occlusion system's own `flips` counter (incremented whenever any record's occluded verdict
  // changes); a nonzero delta since last frame means the cached quad set the orchestrator is
  // about to redraw no longer matches its own occlusion predicate's current answers, so force
  // exactly one fresh rebuild (planet.clearCache()) to reconcile it. Cheap (a counter diff) and
  // self-limiting (only fires on an actual verdict change, never every frame).
  //
  // SUSTAINED-SMALL-MOVEMENT GAP FIX (terrain-blocks-disappear-until-camera-moves): the flip-trigger
  // above only reconciles once a flip has actually happened AND the round-robin budget has reached
  // that record -- under a large loaded candidate set, recovery latency scales with candidate count,
  // not with camera movement. A camera moving slower than mapspinner's own 1.0m-floor moveTol (see
  // planet-orchestrator.js) never gets ANY rebuild from mapspinner's side either. _trackReconcileMovement
  // (called every renderPlanet(), see its own comment above) closes this independently: it accumulates
  // real eye displacement and forces a clearCache() at a much finer floor (0.35m) than mapspinner's,
  // so sustained slow movement reconciles stale verdicts directly instead of waiting on a flip.
  let _lastFlips = 0
  function runOcclusionQueries() {
    try {
      _terrainOcclusion.runQueries((typeof window !== 'undefined') ? window.__lastVP : null)
      renderer.resetState()   // raw GL was touched behind three's state cache
      const flips = _terrainOcclusion.getStats().flips
      if (flips !== _lastFlips) { _lastFlips = flips; try { planet.clearCache && planet.clearCache() } catch (_) {} }
    } catch (_) {}
  }
  // legacy name used by app.js render loop (terrainBackdrop.update); now a no-op
  // because the planet renders via renderPlanet() in the compositing path.
  function update() {}
  function dispose() { try { planet.clearCache && planet.clearCache() } catch (e) { _dbgTerrain('planet.clearCache failed on dispose:', e?.message || e) }; try { _terrainOcclusion.dispose() } catch (e) { _dbgTerrain('terrainOcclusion dispose failed:', e?.message || e) }; if (typeof window !== 'undefined' && window.__terrain && window.__terrain.planet === planet) delete window.__terrain }
  // Render-DAG visibility-resolve node reads this: a pure snapshot of currently-occluded terrain
  // leaf keys, delegating to TerrainOcclusion's own snapshot (same records Map the predicate reads).
  function occlusionPredicateSnapshot() { return _terrainOcclusion.snapshotOccludedKeys() }
  // cull-shared-query-budget: pass-through so the shared OcclusionQueryBudget arbiter (see
  // client/core/OcclusionQueryBudget.js) can throttle terrain's occlusion-query issue rate the same
  // way it already throttles SceneOcclusion/ModelPoolAdapter -- _terrainOcclusion itself already
  // exposes setMaxQueriesPerFrame/getMaxQueriesPerFrame, this just surfaces them past the closure.
  function setOcclusionQueryBudget(n) { _terrainOcclusion.setMaxQueriesPerFrame(n) }
  function getOcclusionQueryBudget() { return _terrainOcclusion.getMaxQueriesPerFrame() }
  return { planet, frame, sampler, renderPlanet, runOcclusionQueries, update, dispose, getOcclusionStats: () => _terrainOcclusion.getStats(), getOcclusionCandidateCount: () => _terrainOcclusion.getCandidateCount(), occlusionPredicateSnapshot, setOcclusionQueryBudget, getOcclusionQueryBudget, setSunLocal }
}
