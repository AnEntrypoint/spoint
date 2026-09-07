// RenderControls -- the single discoverable registry of every render/optimization CONTROL KNOB.
//
// WHY THIS EXISTS: the render + optimization pipeline used to be steered by ~two dozen scattered,
// undocumented `window.__*` globals, each read ad-hoc deep inside a draw path. There was no way to
// answer "what can I tweak, what does it do, what is its default" without grepping the whole codebase.
// That undiscoverable coupling is exactly the counter-intuitive structure that let rendering bugs
// (stale-shadow flash, underwater-tint blue trees, depth z-fight) hide. This registry is the one place
// every knob is named, typed, defaulted, and documented.
//
// CONTRACT:
//   - Every render/opt knob is one entry: { key, group, type, default, doc } (key = the historical
//     `window.__<name>` name, so existing reads keep working unchanged).
//   - `get(key)` returns the live value (reads window.__<key> if set, else the default). Modules SHOULD
//     migrate to RenderControls.get(...) over time, but existing `window.__<key>` reads stay valid --
//     the registry mirrors onto window.__<key> and window.__renderControls, it does not replace it.
//   - `set(key, v)` writes the live value (window.__<key>) after validating the key exists.
//   - `list()` prints every knob with its group, current value, default, and doc -- the discovery
//     surface. `window.__renderControls.list()` in the console answers "what can I tweak".
//
// This registry is DEBUG/DISCOVERY + a single source of documentation. It does not itself change any
// render behavior; it catalogs the knobs the render code already reads. Handles/accessors (window.__app,
// __terrain, __scene, __renderGraph, __culling, per-system profile mirrors, __veg/__rocks/__grass debug
// objects) are deliberately NOT here -- they are live object handles, not tunable knobs.

// key is the window.__<key> global name (without the window.__ prefix).
const CONTROLS = [
  // ---- Depth / mapspinner<->THREE composite seam (see DepthComposite / TerrainBackdrop) ----
  { key: 'planetDepthToCanvas', group: 'depth-composite', type: 'boolean', default: true,
    doc: 'Stamp mapspinner terrain/water depth into the canvas depth buffer so the THREE scene is occluded by terrain. Off => THREE objects draw over terrain.' },
  { key: 'planetDepthBias', group: 'depth-composite', type: 'number', default: 0.000002,
    doc: 'Target depth01-space precision margin, converted per-frame into an eye-space distance bias (biasM = uDepthBias*zEye*zEye/((far*near)/(far-near))) derived from the actual dst near/far so it is bounded and self-consistent instead of a hand-tuned scalar. See TerrainBackdrop.js BIAS UNIT comment.' },
  { key: 'hostShadowOff', group: 'depth-composite', type: 'boolean', default: false,
    doc: 'Diagnostic: skip the host-shadow bridge so mapspinner terrain draws fully lit (no THREE shadow projected onto it). Isolates terrain-received-shadow jitter from object shadows.' },

  // ---- Adaptive resolution / device-pixel-ratio (perf) ----
  { key: 'vdrsScale', group: 'resolution', type: 'number', default: null,
    doc: 'Viewport dynamic-resolution scale in (0,1] for mapspinner terrain. null => use the world default. Lower = cheaper terrain, softer edges.' },
  { key: 'dprAuto', group: 'resolution', type: 'boolean', default: true,
    doc: 'Auto device-pixel-ratio adaptation: lower render resolution under sustained frame-time pressure, raise it back when headroom returns.' },
  { key: 'dprOff', group: 'resolution', type: 'boolean', default: false,
    doc: 'Force DPR auto-adaptation off (pin the current pixel ratio).' },
  { key: 'dpr', group: 'resolution', type: 'number', default: null,
    doc: 'Read-only mirror of the current effective device-pixel-ratio (set by the DPR adaptation loop).' },
  { key: 'vdrsAuto', group: 'resolution', type: 'boolean', default: false,
    doc: 'Adaptive TERRAIN internal-render-resolution controller (see FrameMetrics.js createTerrainVdrsController) -- the genuine render-at-N%-present-at-100% decouple, distinct from dprAuto: drives mapspinner\'s own vdrs/vdrsScale FBO+upscale mechanism under sustained frame-time pressure, WITHOUT touching renderer.setPixelRatio, so the canvas/THREE draw resolution and the final presented frame both stay full native resolution while only the terrain pass (the dominant per-pixel cost) renders fewer pixels. Default off, opt-in, same discipline as dprAuto.' },
  { key: 'vdrsOff', group: 'resolution', type: 'boolean', default: false,
    doc: 'Force the terrain VDRS auto-adaptation off regardless of vdrsAuto (pins the current __vdrs/__vdrsScale state). Mirrors dprOff\'s override shape.' },
  { key: 'terrainVdrs', group: 'resolution', type: 'object', default: null,
    doc: 'Read-only mirror of the terrain VDRS adaptation loop (createTerrainVdrsController): {scale, on, avgMs}. scale is the current terrain internal-resolution fraction (1.0 = full native); on reflects whether window.__vdrs is currently true.' },
  { key: 'threeVdrs', group: 'resolution', type: 'boolean', default: false,
    doc: 'THREE-scene-color resolution decouple (see client/core/ThreeVdrs.js, sibling to the terrain-only vdrs knob above): true routes THREE\'s own scene draw (trees/rocks/players/models) into a real-depth-buffered offscreen target at window.__threeVdrsScale<1, EASU+RCAS-upscales it, then composites onto the canvas with a real GPU depth-test against whatever terrain already wrote (so terrain still correctly occludes the result) and writes THREE\'s own upscaled depth back. The canvas/final presented resolution never changes -- only THREE\'s own internal draw resolution does. Pairs with threeVdrsScale. Normally driven automatically by threeVdrsAuto; settable directly for manual testing.' },
  { key: 'threeVdrsScale', group: 'resolution', type: 'number', default: 1.0,
    doc: 'THREE-scene-color internal-render-resolution fraction in [0.3,1.0] (clamped in ThreeVdrs.js, same range as mapspinner\'s own vdrsScale). Only has effect while threeVdrs is true.' },
  { key: 'threeVdrsSharpness', group: 'resolution', type: 'number', default: 0.5,
    doc: 'RCAS sharpen strength for the threeVdrs upscale pass, 0 (EASU output only) to 1 (maximum contrast-adaptive sharpen). Same formula/semantics as fsr1Sharpness/vdrsUpscaleFsr1Sharpness.' },
  { key: 'threeVdrsAuto', group: 'resolution', type: 'boolean', default: false,
    doc: 'Adaptive THREE-scene-color internal-render-resolution controller (see ThreeVdrs.js createThreeVdrsController), independent of vdrsAuto (terrain) and dprAuto (whole-canvas) -- drives window.__threeVdrs/__threeVdrsScale under sustained frame-time pressure. Default off, opt-in, same discipline as dprAuto/vdrsAuto.' },
  { key: 'threeVdrsOff', group: 'resolution', type: 'boolean', default: false,
    doc: 'Force the THREE-scene-color VDRS auto-adaptation off regardless of threeVdrsAuto (pins the current __threeVdrs/__threeVdrsScale state). Mirrors dprOff/vdrsOff\'s override shape.' },
  { key: 'threeVdrsState', group: 'resolution', type: 'object', default: null,
    doc: 'Read-only mirror of the THREE-scene-color VDRS adaptation loop (createThreeVdrsController): {scale, on, avgMs}.' },

  // ---- Fog ----
  { key: 'fogFar', group: 'fog', type: 'number', default: 200,
    doc: 'Base fog far-plane ceiling (metres), the world-config value before any adaptation. Mirrored from the scene fog / world config.' },
  { key: 'fogAdaptOff', group: 'fog', type: 'boolean', default: false,
    doc: 'Disable adaptive fog entirely (perf-driven pull-in/push-out AND the time-of-day density ceiling below both stop).' },
  { key: 'fogState', group: 'fog', type: 'object', default: null,
    doc: 'READ-ONLY mirror of the live FogController state ({far, ceil, baseCeil, mult, avgMs}), written whenever the controller ticks. `far` is the current fog.far; `ceil` is the EFFECTIVE ceiling (baseCeil * mult, the perf adapter never pushes far above this); `mult` is the combined time-of-day/weather density multiplier (client/core/FrameMetrics.js createFogController.setCeilMultiplier -- time-of-day proposes a denser/closer ceiling at dawn/dusk via elevation angle, a future weather system composes multiplicatively on top; FogController alone still owns every fog.far write, so perf-adaptation and atmosphere-driven density are always reconciled through one hysteresis/step path).' },

  // ---- Time of day (see client/core/TimeOfDay.js) ----
  { key: 'timeOfDay', group: 'time-of-day', type: 'object', default: null,
    doc: 'READ-ONLY mirror of the live time-of-day state ({t, elevationDeg, dir}), written every frame by the time-of-day render-graph node. Control surface is window.__timeOfDayApi (setFraction(0..1), getFraction(), setDayLengthSec(sec), getDayLengthSec(), setPaused(bool), isPaused(), getClockString(), isLocalOverrideActive()) -- a function-call API, not a scalar knob, since it drives an animated clock rather than a static value. setFraction() sets an 8s local-override grace window (LOCAL_OVERRIDE_GRACE_MS in TimeOfDay.js) during which app.js onTimeOfDaySync (server-authoritative sync, when the world opts in) calls setFractionFromServer() instead, which no-ops while the override is active -- so a manual devtools/UI scrub is visible for at least 8s instead of being stomped by the next periodic server correction. World-level default/opt-out is _terrainCfg.timeOfDay ({dayLengthSec, startFraction} or false to disable) or ?tod=off.' },

  // ---- Weather (see client/core/Weather.js -- camera-relative rain+snow particle systems plus a far
  //      billboard-sheet LOD tier shared by both, weather-particle-system-rain-snow-tiers +
  //      weather-snow-tier-and-billboard-far-lod) ----
  { key: 'weatherType', group: 'weather', type: 'string', default: null,
    doc: '"rain" | "snow" | "clear" (null => use the world config default from _terrainCfg.weather.type, or no weather at all if the world never opted in). Both "rain" and "snow" render a real near-tier sim (fast streaks / slow wind-drifted flakes) plus a shared far billboard-sheet tier beyond the near volume. Live-settable: window.__renderControls.set("weatherType","rain") takes effect next frame via the weather-update render-graph node. Also server-writable: when _terrainCfg.weather.serverAuthoritative===true (weather-server-driven-state-and-multiplayer-sync), a WEATHER_SYNC message (src/sdk/ServerWeather.js, client/app.js onWeatherSync) writes this SAME global on receipt -- a server-driven weather change and a manual devtools toggle both flow through the identical live-settable knob, indistinguishable to the weather-update render-graph node.' },
  { key: 'weatherIntensity', group: 'weather', type: 'number', default: null,
    doc: '0..1 particle density fraction of the configured max particle count, applied to BOTH the near tier and the far billboard-sheet tier. null => use the world config default from _terrainCfg.weather.intensity, or 1 if weather is on with no explicit intensity. Live-settable, same as weatherType, including server-writable via WEATHER_SYNC when server-authoritative (see weatherType doc).' },
  { key: 'snowAccumulation', group: 'weather', type: 'boolean', default: true,
    doc: 'Whether landed snow flakes stamp a decayed accumulation decal (reuses src/terrain/GrassDecal.js\'s sparse cell store, ~30min melt half-life) queryable via window.__weather.getSnowAccumulationAt(x,z). Off => snow still renders/falls, just never accumulates a ground-state trace. No ground-material consumer wired yet (follow-up row); this only gates the accumulation-store write.' },
  { key: 'wetness', group: 'weather', type: 'number', default: 0,
    doc: 'READ-ONLY: 0=dry..1=soaked, automatically driven by the weather-wetness render-graph node from Weather.js rain state (ramps up while raining, dries out over wetnessDryOutSec afterward -- see client/core/WetnessTint.js). Darkens albedo + adds a specular sheen on upward-facing THREE materials (GLTF/vegetation/primitives, precondition-gated same pattern as UnderwaterTint.js) AND drives mapspinner terrain.glsl uWetness uniform for the terrain splat (same scalar, one source of truth). Distinct from custom._wetness (ssr-material-wetness-mask-authoring): that is an AUTHORED per-entity puddle/wet-road flag for SSR reflections; this is the AUTOMATIC weather-wide scalar for albedo/specular response. Written every frame by that node, so window.__renderControls.set("wetness", x) would be clobbered on the next frame -- use window.__wetnessForce = x instead (checked FIRST by the weather-wetness node, before weather.getWetness()) to force-override for debugging; set it back to undefined/NaN to release control to weather state.' },
  { key: 'wetnessDryOutSec', group: 'weather', type: 'number', default: 60,
    doc: 'Seconds for `wetness` to fully decay 1->0 after rain stops (linear ramp-down). Ramp-up while raining is fast (a few seconds) since real rain wets a surface far quicker than it dries.' },

  // ---- Water / sea ----
  { key: 'seaLevelY', group: 'water', type: 'number', default: null,
    doc: 'World-space sea-level Y (metres), spliced into the underwater-tint shader by UnderwaterTint.setSeaLevelY at terrain-ready. Drives the below-water tint threshold.' },

  // ---- Vegetation render toggles (perf / debug) ----
  { key: 'vegWind', group: 'vegetation', type: 'boolean', default: true,
    doc: 'Vegetation wind animation. Off => static leaves/branches (also removes wind-driven shadow-caster motion).' },
  { key: 'vegLeafOff', group: 'vegetation', type: 'boolean', default: false,
    doc: 'Hide all vegetation LEAF meshes (branches/trunks stay). Debug/perf isolation.' },
  { key: 'vegAllOff', group: 'vegetation', type: 'boolean', default: false,
    doc: 'Hide ALL vegetation (branches, leaves, shared impostor). Debug/perf isolation.' },
  { key: 'vegHideFar', group: 'vegetation', type: 'array', default: null,
    doc: 'Array of species names to hide (branch+leaf). Debug/perf isolation.' },
  { key: 'vegImpostorParallax', group: 'vegetation', type: 'boolean', default: false,
    doc: 'Parallax-corrected octahedral tree/foliage impostors (EZ_PARALLAX, see packages/streaming-gltf/src/octahedral-impostor-ez.js + client/core/VegImpostorTier.js createSharedImpostorMesh). Depth-offset UV sampling using the normalDepth atlas\'s packed depth channel so a close-range impostor shows real per-fragment relief instead of a flat billboard look. Read ONCE at boot when the shared impostor mesh material is built (client/core/Vegetation.js) -- changing it live has no effect until next reload/world-load, same discipline as shadowCascades. Default off, byte-behaviour-unchanged on the existing flat-sampling path.' },
  { key: 'vegImpostorParallaxScale', group: 'vegetation', type: 'number', default: 0.3,
    doc: 'Parallax offset magnitude in cell-local UV units for vegImpostorParallax (see octahedral-impostor-ez.js parallaxOffsetUV). 0.3 was tuned against a unit-scale synthetic test box; wide-canopy species with more depth relief may want a larger value, narrow conifers a smaller one. Read at the same boot-time point as vegImpostorParallax.' },

  // ---- Grass ----
  { key: 'grassWind', group: 'grass', type: 'boolean', default: true,
    doc: 'Grass wind animation.' },
  { key: 'grassBend', group: 'grass', type: 'boolean', default: true,
    doc: 'Grass bends away from nearby players/actors (client/core/Grass.js uBenderPosXZ). Off => grass ignores player proximity entirely (still has wind sway).' },
  { key: 'grassDecal', group: 'grass', type: 'boolean', default: true,
    doc: 'Burn/flatten decals shrink+tint grass blades within a markScorched-stamped radius (client/core/Grass.js uDecalPosXZRS, backed by src/terrain/GrassDecal.js persistent sparse store). Off => decal stamps stay recorded in the store but have zero visible effect until re-enabled.' },

  // ---- Tonemapping / color grading (see SceneSetup.createRenderer + QualityPresets.js) ----
  { key: 'toneMappingMode', group: 'tonemapping', type: 'string', default: 'ACESFilmic',
    doc: 'Tonemapping operator applied to the final HDR scene color before display: "ACESFilmic" (filmic highlight rolloff, current default), "AgX" (Blender/OCIO-style, cooler highlights, more saturation retained), "Neutral" (THREE.NeutralToneMapping, minimal-grade), or "Linear" (no rolloff -- highlights clip, mainly a diagnostic/comparison mode). Live-settable: window.__renderControls.set("toneMappingMode","AgX") re-applies immediately via applyToneMapping(renderer).' },
  { key: 'toneMappingExposure', group: 'tonemapping', type: 'number', default: 1.0,
    doc: 'Exposure multiplier applied before the tonemapping curve. Device-tier presets lower this on low-end GPUs (replaces the old ad-hoc isLowEndGpu override in app.js, which is now preset-driven via QualityPresets.js PRESETS[name].toneMappingExposure).' },

  // ---- Shader / diagnostics ----
  { key: 'checkShaderErrors', group: 'diagnostics', type: 'boolean', default: false,
    doc: 'Enable THREE renderer.debug.checkShaderErrors (a real GPU sync per first-use shader variant -- on only for debugging).' },
  { key: 'thc', group: 'terrain', type: 'boolean', default: false,
    doc: 'Enable the mapspinner Terrain Height Cache (baked-tile fetch). Measured net-negative at the deck; kept as a lever, default off.' },

  // ---- Shadow-pass cost measurement (see ShadowCostProbe.js -- read-only, does not touch ShadowPipeline) ----
  { key: 'shadowCostProbeArm', group: 'shadow-cost', type: 'boolean', default: false,
    doc: 'Arm the static-vs-dynamic shadow-caster cost split (ShadowCostProbe.js). Runs 3 extra masked shadowMap.render() passes every Nth real texel-step re-render, self-restoring. window.__shadowCost.stats() reads the result. Default off, zero cost when off.' },
  { key: 'shadowCascades', group: 'shadow-cost', type: 'number', default: 1,
    doc: 'Number of cascaded shadow maps ShadowPipeline.js follows/texel-snaps (1-3). Read ONCE at boot (client/app.js createShadowPipeline call) -- changing it live has no effect until next reload, unlike most knobs here, since adding/removing a cascade light mid-session is not yet supported. 1 = the original single-shadow behavior (byte-identical camera/cadence, zero regression risk). 2-3 add additional shadow-only DirectionalLights (intensity 0, never affect scene lighting) at wider extents, each independently texel-snapped and heartbeat-free exactly like cascade 0 -- see ShadowPipeline.js header. Device-tier default via QualityPresets.js (Low/Medium=1, High=2, Ultra=3); each extra cascade is a full additional shadow-map render pass on every texel step of ITS OWN cadence.' },

  // ---- Ambient occlusion (see SSAO.js -- half-res GTAO-style screen-space AO, own dedicated
  //      G-buffer pass, does NOT touch the shared canvas depth contract documented in
  //      DepthComposite.js) ----
  { key: 'ssao', group: 'ambient-occlusion', type: 'boolean', default: false,
    doc: 'Half-res GTAO-style screen-space ambient occlusion. Device-tier default: off on low-tier, on for mid/high/ultra (see QualityPresets.js). Composited as a multiplicative darken pass over the canvas after scene-color.' },
  { key: 'ssaoRadius', group: 'ambient-occlusion', type: 'number', default: 3.0,
    doc: 'SSAO world-space sample radius (metres). Larger = softer/broader occlusion, more false contact-darkening on flat ground. Tuned via live pixel-luminance A/B against real map geometry (tps-game corridor/architecture scale): radius<=1.5m combined with intensity<=4 was measured visually imperceptible (mean-luminance delta 0 across 5+ dispatches); radius=3.0+intensity=4.0 gave a real, reproducible ~28% mean-luminance drop.' },
  { key: 'ssaoIntensity', group: 'ambient-occlusion', type: 'number', default: 4.0,
    doc: 'SSAO darkening strength multiplier applied to the raw occlusion term before compositing. See ssaoRadius doc -- tuned together via the same live A/B sweep (intensity<=4 alone at the default radius was imperceptible; intensity=4 at radius=3.0 was the smallest tested combination that produced a real measured effect, matching intensity=8/10 at smaller/larger radii).' },

  // ---- Screen-space reflections (see SSR.js -- half-res raymarch against SSAO's shared G-buffer,
  //      masked to the UNION of the sea-level wet-surface band, a real per-material wetness G-buffer
  //      (custom._wetness, authored via placed-model/primitive editorProps -- see EntityLoader.js's
  //      userData.wetness stamp), and the automatic weather-wetness scalar (window.__wetness, see
  //      wetness group below); does NOT touch the shared canvas depth contract documented in
  //      DepthComposite.js) ----
  { key: 'ssr', group: 'reflections', type: 'boolean', default: false,
    doc: 'Screen-space reflections for wet surfaces: near-sea-level geometry (see ssrBandHeight) OR any mesh with an authored custom._wetness value (puddle/wet-road/rain-soaked, placed-model/box-static/primitive editorProp -- see SSR.js header and EntityLoader.js userData.wetness) OR the live automatic weather-wetness scalar during rain (window.__wetness, see wetness knob -- rain-soaked ground reflects with zero per-entity authoring). Pool-routed (ModelPool ClusterLodMesh) entities are not yet covered by the material-wetness path, band-mask and weather-wetness still apply to them. Device-tier default: off (opt-in, higher cost than ssao/bloom -- see QualityPresets.js).' },
  { key: 'ssrIntensity', group: 'reflections', type: 'number', default: 0.6,
    doc: 'Reflection alpha multiplier applied after fresnel + wet-mask + march-distance falloff.' },
  { key: 'ssrMaxDistance', group: 'reflections', type: 'number', default: 40.0,
    doc: 'World-space march budget (metres) for the screen-space raymarch. Larger = reflections can resolve farther geometry, more likely to miss/undershoot within the fixed step count.' },
  { key: 'ssrBandHeight', group: 'reflections', type: 'number', default: 4.0,
    doc: 'Metres above/below seaLevelY a G-buffer fragment may sit and still be eligible for reflection via the sea-level-band mask. Independent of and additive to the per-material custom._wetness mask -- a fragment reflects if EITHER source says wet.' },

  // ---- Bloom (see Bloom.js -- half-res threshold-extract + separable-blur + additive-composite,
  //      does NOT touch the shared canvas depth contract documented in DepthComposite.js) ----
  { key: 'bloom', group: 'bloom', type: 'boolean', default: false,
    doc: 'Half-res threshold-extract + blur + additive-composite bloom pass over bright highlights (muzzle flashes, pickup/emissive glow). Device-tier default: off on low-tier, on for mid/high/ultra (see QualityPresets.js). Composited after scene-color and SSAO.' },
  { key: 'bloomThreshold', group: 'bloom', type: 'number', default: 1.0,
    doc: 'Luminance level above which a fragment starts contributing to bloom (soft-knee ramp below this). Lower = more of the scene blooms; raise on scenes with a lot of ordinary bright surfaces (snow, sky) to keep bloom scoped to genuinely emissive/HDR highlights.' },
  { key: 'bloomIntensity', group: 'bloom', type: 'number', default: 1.2,
    doc: 'Additive strength multiplier applied to the blurred bright-pass before compositing onto the canvas.' },
  { key: 'bloomResolutionScale', group: 'bloom', type: 'number', default: 0.5,
    doc: 'Render-target resolution scale (fraction of canvas size) for the bloom threshold/blur targets. Lower = cheaper, softer/blurrier glow.' },
  { key: 'bloomBlurPasses', group: 'bloom', type: 'number', default: 1,
    doc: 'Number of full horizontal+vertical separable-blur passes applied to the bright-pass texture. Higher = smoother/wider glow, more GPU cost.' },

  // ---- FSR1 spatial upscale/sharpen (see FSR1.js -- companion to the DPR controller below: a DPR
  //      drop shrinks the WebGL drawing buffer, which the browser then bilinear-stretches back up
  //      to CSS size; this pass replaces that dumb stretch with an EASU+RCAS upscale+sharpen so a
  //      DPR drop is visually softened rather than a jarring blur/pixelation step) ----
  { key: 'fsr1', group: 'fsr1', type: 'boolean', default: false,
    doc: 'FSR1-style (EASU edge-adaptive upsample + RCAS contrast-adaptive sharpen) post-process pass, gated to only run while window.__dpr.scale < 1 (createDprController has actually downscaled the drawing buffer -- no-op at native resolution). Composited last, after bloom/ssr. Device-tier default: off (opt-in companion to dprAuto).' },
  { key: 'fsr1Sharpness', group: 'fsr1', type: 'number', default: 0.5,
    doc: 'RCAS sharpen strength, 0 (soft, EASU output only) to 1 (maximum contrast-adaptive sharpen, matches AMD reference RCAS weight range). Anti-ringing clamped per-pixel by local min/max contrast, same as the real FSR1 RCAS formula -- will not oversharpen already-flat regions.' },

  // ---- Frame pacing (see FrameMetrics.js createVsyncMonitor -- read-only mirror at window.__vsync) ----
  { key: 'vsync', group: 'frame-pacing', type: 'object', default: null,
    doc: 'Read-only mirror of the vsync-miss detector (FrameMetrics.js createVsyncMonitor). Distinguishes a compositor/GPU-side present stall (isCompositorStall: rAF-to-rAF gap exceeded the inferred refresh interval even though this frame\'s own JS work was short) from an ordinary long-JS-work frame. window.__vsync.recent() lists the last 20 miss events; window.__vsync.missRate is the fraction of all frames that missed. Also CONSUMED downstream: client/app.js startInputLoop\'s independent setInterval(1000/60) input-sample loop is phase-unlocked from the rAF render loop, so it stamps this mirror (frame/miss/missStreak/missCount) onto every sent input object as `input._vsync` -- the sim/render pacing alignment follow-up -- letting server-side reconciliation see whether an input was sampled during/after a real vsync miss, without changing the send cadence itself.' },

  // ---- OffscreenCanvas / worker-hosted rendering (see SceneSetup.probeOffscreenCanvasWorkerRendering; offscreencanvas-worker-rendering epic) ----
  { key: 'offscreenCanvasWorkerRenderingSupported', group: 'worker-rendering', type: 'boolean', default: null,
    doc: 'Read-only mirror of a real feature-detection probe (API surface + Worker construction + an actual WebGL2-in-worker round trip via a transferred throwaway OffscreenCanvas), run once at boot. null until the async probe resolves. NOT a toggle -- rendering always runs on the main thread today; this only reports whether a future worker-hosted render loop is viable on this browser. See window.__offscreenCanvasWorkerRenderingDetail for the per-layer breakdown (apiSurface/workerConstructible/webgl2InWorker/error).' },
  { key: 'workerRenderer', group: 'worker-rendering', type: 'object', default: null,
    doc: 'Not a live value -- an API handle. window.__workerRenderer.create(canvasEl) transfers a real canvas to a dedicated module Worker (client/workers/OffscreenRenderWorker.js) running a real THREE.WebGLRenderer render loop entirely off the main thread (the actual worker-hosted render mechanism, not just detection). window.__workerRenderer.test() spins up a throwaway offscreen canvas, runs it for ~3s, and returns real per-frame telemetry the worker posted back (frame count, draw calls, triangles) -- proof frames actually execute in the worker. Scoped to an isolated diagnostic canvas only; does NOT drive the main game scene (offscreencanvas-worker-migration-followup epic, first functional slice -- the full game-loop migration needs a DOM/window proxy layer for mapspinner/MobileControls/HUD first).' },

  // ---- Texture / model VRAM budget (see client/ModelPoolAdapter.js + packages/streaming-gltf/src/
  //      model-pool.js -- ModelPool's own per-frame byteBudget/LodUnloadManager eviction was already
  //      fully wired and running; these two knobs are what makes it client-discoverable/configurable,
  //      see half-res-transparents-temporal-upscale-texture-vram-budget PRD row) ----
  { key: 'vramBudgetMB', group: 'vram-budget', type: 'number', default: null,
    doc: 'Target GPU texture/mesh-LOD VRAM budget in MB for the model pool. null => auto (device-tier-derived estimate * 0.65, see model-pool.js _detectAvailableVRAM). Live-settable: window.__renderControls.set(\'vramBudgetMB\', 512) calls ModelPoolAdapter.setVramBudgetMB, which retargets both ModelPool.byteBudget and its LodUnloadManager in one call and takes effect within 5 frames (the periodic unload-scan cadence). Reducing this under memory pressure demotes/evicts non-visible mesh+texture LODs; the pool self-tightens further at runtime if the live VRAM ratio stays unsafe (see vramStats).' },
  { key: 'vramStats', group: 'vram-budget', type: 'object', default: null,
    doc: 'READ-ONLY mirror of the live VRAM budget tracker (ModelPoolAdapter.getVramStats()), refreshed once per frame: {usedMB, estimatedVramMB, currentRatio, peakRatio, byteBudgetMB, totalBytes, unloadedCount, visibleEntities, invisibleEntities, recentEvents}. recentEvents is a real ring-buffer log (real vram-warning/vram-critical/budget-pressure/budget-relaxed/budget-adjust events the pool actually emitted, not synthetic). window.__vramBudget mirrors the same data plus setBudgetMB()/log() convenience calls.' },

  // ---- mapspinner-side knobs (read in packages/mapspinner/src/gl-render.js; documented here for discovery) ----
  { key: 'halfResWater', group: 'mapspinner-water', type: 'boolean', default: false,
    doc: 'mapspinner water-occlusion depth-share pass (near sea level). When active the scene renders into a single-sample VDRS FBO (losing MSAA) then upscales, purely so the water-occlusion depth test has a real depth buffer to blit (the default framebuffer cannot be read via blitFramebuffer). Default off (every quality preset sets this false) since the MSAA loss reads as a visible quality drop across the whole frame, not just water -- set true only to re-enable the occlusion-depth-share mechanism at the cost of full-frame MSAA.' },
  { key: 'vdrs', group: 'mapspinner-resolution', type: 'boolean', default: false,
    doc: 'mapspinner explicit viewport dynamic-resolution mode (independent of the half-res-water-forced path): true routes terrain+water into a fixed-size offscreen FBO, renders it at a flexed __vdrsScale<1 sub-viewport, then LINEAR-upscales that sub-rect to the canvas at its actual (unchanged) size -- terrain renders fewer pixels, the canvas/presented frame stays full resolution. Pairs with vdrsScale. Normally driven automatically by the vdrsAuto controller (see resolution group above); settable directly for manual testing.' },
  { key: 'vdrsUpscaleFsr1', group: 'mapspinner-resolution', type: 'boolean', default: false,
    doc: 'mapspinner VDRS upscale-to-canvas quality mode: swaps the plain single-tap LINEAR blit (packages/mapspinner/src/gl-render.js passUpscaleToCanvas) for an FSR1-style EASU (edge-adaptive spatial upsample) + RCAS (contrast-adaptive sharpen) two-pass upscale, same technique as client/core/FSR1.js\'s THREE-side pass (duplicated in raw GLSL ES 3.00 since mapspinner has no THREE dependency to share a ShaderMaterial with). Only visible while vdrs is true and vdrsScale < 1 (nothing to upscale at native res). Pairs with vdrsUpscaleFsr1Sharpness.' },
  { key: 'vdrsUpscaleFsr1Sharpness', group: 'mapspinner-resolution', type: 'number', default: 0.5,
    doc: 'RCAS sharpen strength for the vdrsUpscaleFsr1 pass, 0 (EASU output only, no sharpen) to 1 (maximum contrast-adaptive sharpen). Anti-ringing clamped per-pixel by local min/max contrast, same formula as FSR1.js\'s fsr1Sharpness.' },
  { key: 'waterDepthShareOff', group: 'mapspinner-water', type: 'boolean', default: false,
    doc: 'Disable writing the water surface depth into the shared depth buffer (submerged objects then draw over water).' },
  { key: 'waterVisGate', group: 'mapspinner-water', type: 'boolean', default: true,
    doc: 'Enable the water-visibility occlusion probe that gates the (expensive) water color pass when no water is on-screen.' },
  { key: 'geomorphLod', group: 'mapspinner-lod', type: 'boolean', default: true,
    doc: 'Per-vertex, level-keyed CDLOD-style geomorphing (terrain.glsl uMorphSplitDist path, TerrainBackdrop.js opts.geomorphLod): smoothly blends a quad\'s vertices toward its parent\'s grid as it nears an LOD split, eliminating the vertex-position POP at a split boundary. Crack-free by construction (shared boundary vertices evaluate the identical level-keyed formula) and independent of the separate skirt/overlap-ring mechanism that hides cross-LOD T-junction cracks. Read ONLY at planet-init time (construction-time opts, set window.__geomorphLod=false BEFORE the terrain backdrop initializes to opt out, e.g. via a pre-boot script tag -- toggling after init has no live effect). Adds a normalize()+distance()+mix() branch to every terrain vertex; see the perf-regression-terrain-geomorph-default-off-plus-gl-errors-investigation PRD history for the FPS-regression this gate was built to fix (unconditional-on collapsed FPS ~50->2-3) before it was made a real opt-in gate.' },
  { key: 'splitFactor', group: 'mapspinner-lod', type: 'number', default: 0.25,
    doc: 'mapspinner quadtree tessellation density (planet-orchestrator.js frame(), read live every frame -- unlike geomorphLod this one DOES take effect immediately). Smaller = quads split only when much closer to the camera = coarser mesh = more px per triangle edge; larger = denser mesh. 0.25 is the SDK-blessed flat density (TERRAIN_DEFAULTS.splitFactor, tuned to land the px/poly median inside the 4-50px acceptance band with zero altitude-ramp). Construction-time equivalent is opts.splitFactor (TerrainBackdrop.js initMapspinnerPlanet call); this knob is the LIVE per-frame override on top of whatever opts.splitFactor set at construction.' },
  { key: 'maxLevel', group: 'mapspinner-lod', type: 'number', default: 11,
    doc: 'mapspinner quadtree max subdivision depth (planet-orchestrator.js frame(), read live every frame, clamped to [2,22]). Higher = finer close-approach detail at higher quad-count cost; an altitude-gated deck cap and a high-altitude LOD-drop step both apply ONLY when this is left unset (explicit maxLevel always wins as a manual override, see planet-orchestrator.js _maxLevelOverridden). Construction-time equivalent is opts.maxLevel; this knob is the LIVE per-frame override on top of it.' },
  { key: 'distFactor', group: 'mapspinner-lod', type: 'number', default: null,
    doc: 'mapspinner LOD-pop distance multiplier (planet-orchestrator.js frame(), read live every frame). null => derived from the live splitFactor as splitFactor*8.0 (the "detail farther" default -- each LOD level pops roughly 2.2x farther from camera than the raw quadtree split distance would give, so close-up detail stays visible longer on approach). A larger explicit value pushes every LOD pop farther out (denser mesh at a given altitude); does not change total leaf-quad count, only WHERE each level engages.' },
  { key: 'deckCapAltKm', group: 'mapspinner-lod', type: 'number', default: 1.0,
    doc: 'mapspinner altitude threshold (km above the sea-level sphere) below which the deepest quadtree levels get capped for FPS (planet-orchestrator.js DECK_CAP_ALT_KM, read live every frame). Only engages when maxLevel is left unset (an explicit maxLevel override always wins). Trades close-approach relief detail for frame rate at low altitude; raise to push the cap trigger closer to the ground, lower to cap earlier.' },
  { key: 'frustumCull', group: 'mapspinner-lod', type: 'boolean', default: true,
    doc: 'mapspinner per-leaf screen-space frustum cull for off-screen quadtree leaves (planet-orchestrator.js frame(), read live every frame -- this window.__ global takes priority over opts.frustumCull when set, matching the source\'s own documented precedence). Off => every leaf in the quadtree\'s selected LOD set is drawn regardless of on-screen visibility, a real CPU-side perf cost with zero visual difference at normal camera framing (diagnostic/debug use only).' },

  // ---- mapspinner composeHeight shape-control uniforms (packages/mapspinner/src/gl-render.js
  //      setComposeHeightUniforms(), read live every draw call by BOTH the terrain render program
  //      AND the _PROBE_ GPU collision program via the same cacheKey-memoized _chuSet path -- see
  //      packages/mapspinner/AGENTS.md's FXC/ANGLE-d3d11 sections before touching ANYTHING near this
  //      function in source. RENDER/_PROBE_ PARITY IS LOAD-BEARING: both call sites read the IDENTICAL
  //      window.__<key> globals below, so the rendered mesh and the walkable collision surface stay in
  //      sync by construction; registering these here is documentation/discovery ONLY -- it does not
  //      change gl-render.js's call structure, its g(n,d) fallback helper, or the shared cacheKey. ----
  { key: 'hiFreqCut', group: 'mapspinner-composeheight', type: 'number', default: 1.0,
    doc: 'Fine-octave amplitude multiplier for the terrain fractal (uHiFreqCut, TERRAIN_DEFAULTS.hiFreqCut). DECISIVE for a real prior "blotchy at altitude" bug -- 0 removes the fine band entirely, 0.5 halves it. Applied identically in the render pass and the _PROBE_ collision program (parity).' },
  { key: 'detailOverlay', group: 'mapspinner-composeheight', type: 'number', default: 53.0,
    doc: 'Perlin-everywhere elevation overlay term in composeHeight (uDetailOverlay, TERRAIN_DEFAULTS.detailOverlay). Read identically by render + the _PROBE_ collision program -- changing it moves the rendered surface AND where a character stands, together.' },
  { key: 'canyonDepth', group: 'mapspinner-composeheight', type: 'number', default: 40.0,
    doc: 'Canyon-depth multiplier (feeds canyonDepthMul, TERRAIN_DEFAULTS.canyonDepth; the shader floors an unset/zero value to 1.0). Deeper canyons at higher values. Parity-critical -- see the group-level doc above.' },
  { key: 'vsCheap', group: 'mapspinner-composeheight', type: 'boolean', default: false,
    doc: 'Vertex-shader carve-cost profiling A/B toggle (uVsCheap). Diagnostic only, not a shape control -- swaps in a cheaper VS carve approximation to isolate carve cost from other per-frame cost.' },
  { key: 'beachShelf', group: 'mapspinner-composeheight', type: 'number', default: 0.0,
    doc: 'Land coastal-shelf width in metres (uBeachShelfM, TERRAIN_DEFAULTS.beachShelf; 0 => the shader falls back to an internal 600m guard). Geometry-affecting; parity-critical -- see the group-level doc above.' },
  { key: 'landBias', group: 'mapspinner-composeheight', type: 'number', default: -100000.0,
    doc: 'Hypsometry bias toward land vs sea (uLandBias, TERRAIN_DEFAULTS.landBias) -- more positive raises the land:sea area ratio. Parity-critical -- see the group-level doc above.' },
  { key: 'cliffAmt', group: 'mapspinner-composeheight', type: 'number', default: 5.0,
    doc: 'Cliff/mesa terrace strength (cliffAmt uniform, TERRAIN_DEFAULTS.cliffAmt). Parity-critical -- see the group-level doc above.' },
  { key: 'octMax', group: 'mapspinner-composeheight', type: 'number', default: 12,
    doc: 'Runtime octave bound for the broadShapeM fractal loop (uOctMax). THE FXC/ANGLE-d3d11 unroll-defeat fix (packages/mapspinner/AGENTS.md "rocks everywhere / normals gone" class) -- fractalTerrainH\'s octave loop must stay RUNTIME-bounded via this uniform (shader guards <=0 -> 12) or a constant-bound loop gets fully unrolled + cross-iteration reordered by FXC on default Chrome/AMD/Windows, corrupting the render. Do not treat this as a free perf dial without re-reading that AGENTS.md section first; altitude-clamped internally in addition to this explicit override.' },
  { key: 'inciseRidgeOcts', group: 'mapspinner-composeheight', type: 'number', default: 4,
    doc: 'Octave count for the incise-ridge fractal layer (uInciseRidgeOcts). Parity-critical -- see the group-level doc above.' },
  { key: 'broadLowOcts', group: 'mapspinner-composeheight', type: 'number', default: 2,
    doc: 'Octave count for the low-frequency broadShapeLowM layer (uBroadLowOcts). Measured 2026-06-15: 0 visual error going from 8->2 (only feeds a low-freq mesa-flatness slope gate); a perf-tuned default, not a shape knob to raise casually.' },
  { key: 'peakOcts', group: 'mapspinner-composeheight', type: 'number', default: 3,
    doc: 'Octave count for the peak-detail fractal layer (uPeakOcts). Parity-critical -- see the group-level doc above.' },
  { key: 'detailFbmOcts', group: 'mapspinner-composeheight', type: 'number', default: 3,
    doc: 'Octave count for the detail-overlay FBM layer (uDetailFbmOcts). Parity-critical -- see the group-level doc above.' },
  { key: 'fsDetailOcts', group: 'mapspinner-composeheight', type: 'number', default: 3,
    doc: 'Octave count for the fragment-shader-only detail layer (uFSDetailOcts) -- this one is FS-only (not sampled by the VS carve or the _PROBE_ collision program), so it is the one knob in this group that is safe to treat as a pure visual/perf dial without a parity concern.' },
  { key: 'nrmStepM', group: 'mapspinner-composeheight', type: 'number', default: 300.0,
    doc: 'Finite-difference step (metres) for the lit-normal tap (uNrmStepM). THE FXC/ANGLE-d3d11 per-callsite-inlining fold-defeat fix (packages/mapspinner/AGENTS.md FXC section, mechanism 2) -- uniform-feeding this offset is what stops d3d11/FXC from constant-folding it differently per composeHeight call site, which previously produced fake-slope rock-material/dead-normal patches on flat ground. Do not hardcode this back to a shader constant.' },
  { key: 'hpfInset', group: 'mapspinner-composeheight', type: 'boolean', default: true,
    doc: 'Height-pool-field sampler inset (uHpfInset). true (default) = inset sampling matching bakeFace\'s own fu=x/(RES-1) convention, the seam fix; window.__hpfInset===false is the only way to roll it back (inverted-default boolean: reading window.__hpfInset directly checks `=== false`, not truthiness -- RenderControls.get/set here still read/write the plain boolean, matching every other boolean knob\'s contract).' },
  { key: 'mtnBandWide', group: 'mapspinner-composeheight', type: 'number', default: 1.0,
    doc: 'Mountain-belt width anchor-step multiplier (uMtnBandWide, TERRAIN_DEFAULTS.mtnBandWide). Parity-critical -- see the group-level doc above.' },
  { key: 'climateRelief', group: 'mapspinner-composeheight', type: 'number', default: 1.0,
    doc: 'Climate-relief-zone width multiplier (uClimateRelief, TERRAIN_DEFAULTS.climateRelief). Parity-critical -- see the group-level doc above.' },
  { key: 'isleWide', group: 'mapspinner-composeheight', type: 'number', default: 0.55,
    doc: 'Island-zone width multiplier (uIsleWide, TERRAIN_DEFAULTS.isleWide). Parity-critical -- see the group-level doc above.' },
  { key: 'carveWide', group: 'mapspinner-composeheight', type: 'number', default: 0.0,
    doc: 'Carve-climate-zone width multiplier (uCarveWide, TERRAIN_DEFAULTS.carveWide). Parity-critical -- see the group-level doc above.' },
  { key: 'reliefScale', group: 'mapspinner-composeheight', type: 'number', default: null,
    doc: 'Scale-invariant relief multiplier (uReliefScale). null => derived as opts.reliefScale ?? (planetRadius / 63600000.0), so the fractal relief tuned in absolute metres at the 6360km design radius scales proportionally to whatever radius the consumer actually passes. Parity-critical -- see the group-level doc above.' },

  // ---- VRM spring-bone LOD (animation-vrm-spring-bone-lod-expression-wire) ----
  { key: 'springBoneLodDist', group: 'vrm-animation', type: 'number', default: 25,
    doc: 'Distance in metres from the camera beyond which a REMOTE VRM player\'s springBoneManager.update() (hair/cloth jiggle physics) is skipped for that frame -- humanoid pose/expressions/lookAt still update normally, only the secondary-motion spring-bone sim is gated. Local player is never gated. See client/app.js tickPlayerAnimators.' },
  { key: 'springBoneLodStats', group: 'vrm-animation', type: 'object', default: null,
    doc: 'READ-ONLY mirror of the live spring-bone LOD counters: {updated, skipped} remote-player springBoneManager.update() calls in the most recent frame.' },

  // ---- SPH fluid client render (sph-fluid-client-render-metaball-surface-evaluation, follow-on to the
  //      shipped sph-fluid-client-render-particle-mesh InstancedMesh2 droplet-cloud baseline) ----
  { key: 'fluidRenderMode', group: 'fluid', type: 'string', default: 'droplets',
    doc: '"droplets" (default, shipped baseline: an InstancedMesh2 of small spheres, one per SPH particle -- cheap, real, reads as discrete droplets/foam) | "surface" (opt-in: a metaball/marching-squares smooth 2D contour extruded into a thin slab, one real BufferGeometry per fluid entity, vertex-rewritten per snapshot -- costs real per-frame CPU to resample the scalar field + re-march the contour, see fluidSurfaceStats for the live-measured cost; per this row\'s own live perf-A/B, "surface" only pays off visually for a denser/settled pool, not a sparse emitter). Read PER-ENTITY at first-build time (buildEntityMesh/repaintEntity\'s lazy-upgrade path in client/EntityLoader.js) -- changing this live only affects entities built/rebuilt after the change, matching vegImpostorParallax\'s own boot-time-read discipline for construction-time render-mode choices.' },
  { key: 'fluidSurfaceCellSize', group: 'fluid', type: 'number', default: 0.15,
    doc: 'Marching-squares grid cell size (metres) for "surface" fluidRenderMode (see client/core/FluidSurface.js sampleScalarField). Smaller = smoother contour at higher per-rebuild CPU cost (grid point count scales as 1/cellSize^2); the field itself has no detail below one smoothingRadius so going much finer than ~smoothingRadius/3 buys no visible improvement.' },
  { key: 'fluidSurfaceThickness', group: 'fluid', type: 'number', default: 0.06,
    doc: 'Half-thickness (metres) of the extruded puddle slab for "surface" fluidRenderMode -- the flat 2D marching-squares contour is extruded +/- this amount in world Y so it reads as a solid puddle instead of a zero-thickness sheet (which would be invisible edge-on and z-fight with coplanar ground).' },
  { key: 'fluidSurfaceStats', group: 'fluid', type: 'object', default: null,
    doc: 'READ-ONLY mirror of the live per-entity metaball reconstruction cost, {lastMs, avgMs, samples, particleCount} for the MOST RECENTLY rebuilt "surface"-mode fluid entity -- the real live-measured per-frame CPU cost this row\'s own PRD detail required A/B\'d against the "droplets" baseline. Written by client/EntityLoader.js\'s _rewriteFluidSurfaceMesh on every rebuild.' },

  // ---- Remaining mapspinner tuning knobs (read live in gl-render.js / planet-orchestrator.js,
  //      registered for discovery only, zero mapspinner source change -- strategy (b)) ----
  { key: 'altOctClamp', group: 'mapspinner-composeheight', type: 'boolean', default: true,
    doc: 'Altitude-based octave clamping for the terrain fractal (gl-render.js _clampOcts, per-frame hot path). True => the octave count drops with altitude (fewer octaves farther from the deck, a GPU-vertex-cost optimization). False => flat full octave count at all altitudes (rollback lever if the clamping ever produces a visible pop at altitude transitions).' },
  { key: 'waterGrid', group: 'mapspinner-water', type: 'number', default: 4,
    doc: 'Water mesh quadtree grid density (gl-render.js WGRID, read once at init). The locally-flat water mesh is a WGRID*WGRID patch per face corner; higher = finer water surface at higher per-frame cost. 4 is the tuned default for the deck-altitude half-res water pass.' },
  { key: 'glCheck', group: 'diagnostics', type: 'boolean', default: false,
    doc: 'Enable per-frame render.checkGlError() (a real gl.getError() GPU sync per frame) in mapspinner planet-orchestrator.js frame() loop. Default off -- the GPU sync is a real perf cost, only for debugging.' },
  { key: 'elevEdgeInset', group: 'mapspinner-composeheight', type: 'number', default: 0.5,
    doc: 'Edge-inset offset (gl-render.js _collectElevEdgeSample, per-frame-per-edge hot path) for GPU collision probe elevation queries. 0.5 = centre of edge texel (the inset-sampler default, matches the hpfInset seam fix). Smaller = closer to the edge corner, more likely to fall outside the face and sample a zero/NULL elevation. Parity-critical: the render pass and the _PROBE_ collision program must see the identical inset value.' },
]

const _byKey = new Map(CONTROLS.map(c => [c.key, c]))
for (const c of CONTROLS) c.globalName = '__' + c.key   // precomputed: get() runs ~10x/frame from shouldRun gates; no per-call string concat
const _hasWindow = typeof window !== 'undefined'

function get(key) {
  const c = _byKey.get(key)
  if (!c) { console.warn(`[render-controls] unknown knob '${key}'`); return undefined }
  if (_hasWindow) { const v = window[c.globalName]; if (v !== undefined) return v }
  return c.default
}

// Renderer-affecting knobs that need an imperative call on the live renderer, not just a
// window.__<key> write a later read will pick up (matches the `_rendererHandle` pattern already
// established in QualityPresets.js: most knobs are read lazily by their own subsystem, but a few
// -- shadowMap.enabled, setPixelRatio, and now tonemapping -- are one-shot renderer.* property
// writes with nothing else polling them per-frame, so `set()` must push them immediately).
// `bindTonemapping(renderer, THREE)` registers BOTH handles (called once from SceneSetup.createRenderer
// right after the renderer is built) so a later `set('toneMappingMode', ...)` from the console/UI can
// re-apply immediately without this module importing THREE itself (kept a pure data+string registry,
// per this file's existing no-side-effect contract -- THREE is a caller-supplied reference, never
// imported here).
let _tmRenderer = null
let _tmTHREE = null
function bindTonemapping(renderer, THREE) { _tmRenderer = renderer || _tmRenderer; _tmTHREE = THREE || _tmTHREE }

function _resolveToneMappingConstant(THREE, mode) {
  switch (mode) {
    case 'AgX': return THREE.AgXToneMapping
    case 'Neutral': return THREE.NeutralToneMapping
    case 'Linear': return THREE.NoToneMapping
    case 'ACESFilmic':
    default: return THREE.ACESFilmicToneMapping
  }
}

// Applies the current toneMappingMode/toneMappingExposure knob values to a live renderer.
// Callable at boot (SceneSetup.createRenderer, passing its own just-built renderer+THREE) AND at
// runtime (window.__renderControls.set(...) re-applies immediately via the bound handles, and
// QualityPresets.apply() calls it per-preset) so the knob is genuinely live, not just a value
// nothing re-reads until next reload.
function applyToneMapping(renderer, THREE) {
  const r = renderer || _tmRenderer
  const T = THREE || _tmTHREE
  if (!r || !T) return false
  r.toneMapping = _resolveToneMappingConstant(T, get('toneMappingMode'))
  r.toneMappingExposure = get('toneMappingExposure')
  return true
}

const _TONE_MAPPING_KEYS = new Set(['toneMappingMode', 'toneMappingExposure'])

function set(key, v) {
  const c = _byKey.get(key)
  if (!c) { console.warn(`[render-controls] set('${key}'): no such knob. Try __renderControls.list().`); return false }
  if (typeof window !== 'undefined') window['__' + key] = v
  if (_TONE_MAPPING_KEYS.has(key) && _tmRenderer && _tmTHREE) applyToneMapping()
  return true
}

function list() {
  const groups = {}
  for (const c of CONTROLS) {
    (groups[c.group] = groups[c.group] || []).push(c)
  }
  const out = []
  for (const g of Object.keys(groups).sort()) {
    out.push(`\n== ${g} ==`)
    for (const c of groups[g]) {
      const live = get(c.key)
      const isDefault = live === c.default
      out.push(`  __${c.key} = ${JSON.stringify(live)}${isDefault ? ' (default)' : ` (default ${JSON.stringify(c.default)})`}  [${c.type}]\n      ${c.doc}`)
    }
  }
  const text = out.join('\n')
  if (typeof console !== 'undefined') console.log(text)
  return text
}

export const RenderControls = {
  controls: CONTROLS, get, set, list, keys: () => CONTROLS.map(c => c.key),
  bindTonemapping, applyToneMapping,
}

// ---------------------------------------------------------------------------------------------
// RUNTIME FLAGS -- the non-render query-string / env-var switches that gate boot-time behavior
// (world selection, networking mode, server auth, one-shot debug probes). These are NOT
// window.__* live knobs like CONTROLS above -- most are read once at module-load/boot time from
// location.search or process.env, so `set()` on them would not retroactively change behavior.
// This registry exists purely for DISCOVERY: `window.__flags.list()` answers "what flags exist,
// where do I set them, what do they do" without grepping the whole codebase.
// ---------------------------------------------------------------------------------------------
const FLAGS = [
  { flag: '?veg=none', kind: 'query', group: 'vegetation', readAt: 'client/app.js',
    doc: 'Skip building vegetation entirely (Vegetation.js never constructed). Debug/perf isolation.' },
  { flag: '?norocks', kind: 'query', group: 'rocks', readAt: 'client/app.js',
    doc: 'Skip building rocks entirely (Rocks.js never constructed). Debug/perf isolation.' },
  { flag: '?nograss', kind: 'query', group: 'grass', readAt: 'client/app.js',
    doc: 'Skip building grass entirely (Grass.js never constructed). Debug/perf isolation.' },
  { flag: '?drawcollider', kind: 'query', group: 'physics-debug', readAt: 'client/app.js, client/core/ColliderDebug.js',
    doc: 'Show the physics terrain collider (Jolt heightfield) wireframe on boot. Also toggleable at runtime with the C key via window.__colliderDebug.' },
  { flag: '?webgpu=1', kind: 'query', group: 'renderer', readAt: 'client/app.js, client/core/SceneSetup.js (probeAndCreateWebGPURenderer)',
    doc: 'EXPERIMENTAL opt-in: construct THREE.WebGPURenderer instead of WebGLRenderer, gated by a real probeWebGPU() capability check, falling back to WebGL2 on any failure. Never default-on -- the shader-compatibility audit (TSL vs raw GLSL across mapspinner/streaming-gltf/vegetation shaders, ShadowPipeline.js, RenderGraph.js) has not run, so most of the scene is expected to render incorrectly under this flag today. See AGENTS.md webgpurenderer-primary-renderer-switch-staged-rollout.' },
  { flag: '?leak', kind: 'query', group: 'diagnostics', readAt: 'client/app.js',
    doc: 'Enable BUILD-HEAP console probes (performance.memory.usedJSHeapSize snapshots) at key build/load checkpoints, for tracking down memory leaks across world (re)loads.' },
  { flag: '?debug=ns1,ns2', kind: 'query', group: 'diagnostics', readAt: 'client/core/debug-log.js',
    doc: 'Enable namespaced debug logging (dbg(namespace) factory). Comma list of namespaces, or "*" for all. See client/core/debug-log.js.' },
  { flag: '?singleplayer', kind: 'query', group: 'networking', readAt: 'client/app.js',
    doc: 'Run in singleplayer mode: an in-Worker BrowserServer instead of a WebSocket PhysicsNetworkClient to a real server process. Same server.js binary, different in-page client mode.' },
  { flag: '?room=<id>', kind: 'query', group: 'networking', readAt: 'client/app.js',
    doc: 'Wireweave P2P room id to host/join. Paired with ?wwjoin to join an existing room instead of hosting a new one.' },
  { flag: '?wwjoin', kind: 'query', group: 'networking', readAt: 'client/app.js',
    doc: 'Join an existing wireweave room (given by ?room=) as a peer, instead of hosting a new one.' },
  { flag: '?meshdebug', kind: 'query', group: 'networking', readAt: 'client/app.js, client/hud/MeshDebugPanel.js',
    doc: 'Mount a live P2P mesh-topology panel (peer list, connection states, current app-layer host) on top of a ?room= session. window.__meshDebug.list()/.snapshot() are always available regardless of this flag (see client/core/MeshDebug.js) -- this only adds the on-screen visual.' },
  { flag: '?debugpanel=1', kind: 'query', group: 'render-debug', readAt: 'client/app.js, client/hud/RenderDebugPanel.js',
    doc: 'Mount an on-screen checkbox panel for live A/B-testing render subsystem suspects (sun shadow, SSAO, decal system, grass decals, shadow cascades, player VAT) without console commands -- built for live-tester bisection of visual artifacts.' },
  { flag: '?netsim=<preset>', kind: 'query', group: 'networking', readAt: 'client/app.js, src/transport/NetworkSimTransport.js',
    doc: 'Transport simulation harness: wraps the real WebSocket/WebTransport connection in NetworkSimTransport, injecting loss/latency/jitter/reorder so netcode is tuned against a real degraded link instead of localhost. Preset names: clean, broadbandGood, wifiTypical, cellular4g, roadmapTarget (150ms/3% loss), degradedWan, brutal (see NETWORK_SIM_PRESETS). Live-retune after connecting via window.__netSim.configure({lossPct,latencyMs,jitterMs,reorderPct}); inspect drop/reorder counts via window.__netSim.getStats().' },
  { flag: '?world=<name>', kind: 'query', group: 'world', readAt: 'client/app.js',
    doc: 'World definition name to load client-side (singleplayer / world override). See also the server-side WORLD env var.' },
  { flag: '?editorToken=<token>', kind: 'query', group: 'editor-auth', readAt: 'client/app.js',
    doc: 'Opts a locally-run editor connection into the EDITOR_TOKEN auth gate (sent as X-Editor-Token) without touching regular player connections.' },
  { flag: 'WORLD', kind: 'env', group: 'world', readAt: 'src/sdk/server.js, scripts/perf-gate.mjs',
    doc: 'Server-side world definition name to boot (default "tps-game"). Set as an environment variable on the node server.js process, not a query param.' },
  { flag: 'EDITOR_TOKEN', kind: 'env', group: 'editor-auth', readAt: 'src/sdk/ServerAPI.js, src/sdk/ServerHandlers.js, src/sdk/authCompare.js',
    doc: 'Server-side editor-endpoint auth token. Unset = open (dev default, endpoint unauthenticated). Set = required via X-Editor-Token header on every editor request, refused outright if absent/mismatched.' },
  { flag: 'PORT', kind: 'env', group: 'server', readAt: 'src/sdk/server.js, scripts/*.mjs',
    doc: 'Port the node server.js process listens on (default 8090 in most scripts). One process per port -- never run a second server.js on a different port for the same project (see AGENTS.md one-server-two-client-modes-same-origin).' },
]

function listFlags() {
  const groups = {}
  for (const f of FLAGS) (groups[f.group] = groups[f.group] || []).push(f)
  const out = []
  for (const g of Object.keys(groups).sort()) {
    out.push(`\n== ${g} ==`)
    for (const f of groups[g]) {
      out.push(`  ${f.flag}  [${f.kind}]  (${f.readAt})\n      ${f.doc}`)
    }
  }
  const text = out.join('\n')
  if (typeof console !== 'undefined') console.log(text)
  return text
}

export const RuntimeFlags = { flags: FLAGS, list: listFlags }

// Live discovery surface: `window.__renderControls.list()` prints every render/opt knob + doc;
// `window.__flags.list()` prints every non-render runtime flag (query-string + env var) + doc.
export function installRenderControls() {
  if (typeof window !== 'undefined') {
    window.__renderControls = RenderControls
    window.__flags = RuntimeFlags
  }
  return RenderControls
}
