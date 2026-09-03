// WebGL2 terrain RENDER layer: compiles and executes src/shaders/terrain.glsl
// (spherical deformation VS + CLOD blend + lit FS) per frame. Per-quad deformation
// uniforms (screenQuadCorners C / verticals N / cornerNorms L / offset / camera /
// blending / localToWorld) are computed in JS. No WebGPU.

// SDK CANONICAL DEFAULTS: the g()/_g()/o3()/C() fallbacks below read TD.<key> so the calibrated
// "blessed" look lives in ONE SDK-side place (src/terrain-defaults.js). A window.__<key> override
// (set live by the demo's tweak panel) still wins per-frame; with no override the SDK renders the
// blessed look on its own -- the demo no longer has to force-set anything on boot.
import { TERRAIN_DEFAULTS as TD } from './terrain-defaults.js';
import { bakeTransmittanceLUT, LUT_WIDTH, LUT_HEIGHT } from './atmosphere-transmittance-lut.js';
import { bakeScatteringLUT, SCAT_LUT_WIDTH, SCAT_LUT_HEIGHT, SCAT_LUT_LAYERS } from './atmosphere-scattering-lut.js';
import { canDecodeImages, decodeImageToPixels } from './surface-texture-decode.js';

import { TU, M4 } from './gl-render-mat4.js';

// MODULE-SCOPE (not per-initMapspinnerRender-instance) cache for the CPU-side atmosphere LUT bakes.
// bakeTransmittanceLUT/bakeScatteringLUT are pure functions of their own fixed default args (always
// called with the same LUT_WIDTH/HEIGHT/etc constants below) -- the raw {data,width,height} they
// produce never varies across instances, so caching it here means a SECOND initMapspinnerRender call
// within the same page load (the documented cold-load GL-error-storm retry in client/app.js:383-397,
// which fully disposes+reconstructs terrainBackdrop) reuses the already-computed CPU math instead of
// re-running the ~1.5s+ optical-depth/in-scatter integration a second time -- live-profiled at ~16%
// combined CPU self-time per bake (opticalDepth/densities/inscatterAt/sampleTransmittance), confirmed
// via a real cold-load double-bake (window.__lutBakeCount:2, initMapspinnerRender profiled hits:2) in
// the 2026-08-10 144fps-push perf investigation. Each initMapspinnerRender instance still re-uploads
// its OWN fresh GPU texture (the WebGLTexture object itself cannot be shared across GL contexts/a
// disposed-and-recreated renderer state), only the CPU bake math is shared.
let _sharedRawTransLUT = null
let _sharedRawScatLUT = null
// Same rationale as _sharedRawTransLUT/_sharedRawScatLUT above: loadSurfaceTextures()'s decoded
// pixel data (albAll/nrmAll, pre-GPU-upload) is a pure function of the fixed texture URLs it fetches
// -- caching the DECODE (network fetch + JPG decode + de-shade blur + Sobel normal derivation, all
// real per-pixel CPU work) at module scope means a second initMapspinnerRender instance (the same
// cold-load GL-error-storm retry documented at _sharedRawTransLUT) reuses the already-decoded pixels
// instead of re-fetching and re-decoding 8 JPGs from scratch. Each instance still builds its own GPU
// sampler2DArray from this shared pixel data (mkArray/gl.createTexture cannot be shared across a
// disposed-and-recreated renderer). Cached as a Promise (not the resolved value) so concurrent
// initMapspinnerRender calls within the same tick await the SAME in-flight decode instead of racing
// two decodes.
let _sharedSurfaceTexDecode = null

export async function initMapspinnerRender(gl, opts = {}) {
  // GUARD (consumer-facing input validation): see the matching guard in planet-orchestrator.js
  // initMapspinnerPlanet -- a degenerate radius/gridMeshSize here feeds straight into the shader
  // uniforms (defRadius etc.) and mesh generation with no error, producing NaN/garbage geometry.
  if (opts.radius != null && (!Number.isFinite(opts.radius) || opts.radius <= 0)) {
    throw new TypeError(`mapspinner: opts.radius must be a positive finite number, got ${opts.radius}`);
  }
  if (opts.gridMeshSize != null && (!Number.isInteger(opts.gridMeshSize) || opts.gridMeshSize < 2)) {
    throw new TypeError(`mapspinner: opts.gridMeshSize must be an integer >= 2, got ${opts.gridMeshSize}`);
  }
  const R = opts.radius || 6360.0;  // default matches _planetScale=0.001
  // ===== PERF BOUND (ff-planet-fragment-bound-rootcause / terrain-one-two-drawcalls, 2026-06-19) =====
  // CONFIRMED by code analysis + the in-file measured comments: the planet render is VERTEX/TILE-COUNT
  // bound, NOT fragment bound. Evidence:
  //   * broadShapeM (terrain.glsl:440) is a 12-octave fractal evaluated ~5x PER VERTEX -- the inline
  //     geometry-height cascade plus 4 finite-difference normal taps (terrain.glsl:1102-1109) -- across
  //     GRID^2 (=121) verts/tile x ~500-900 visible tiles. That is the 96%+ "VS+raster-bound" the deck
  //     measurements record (browser-18: fullMs 36.3, vsRaster 35.1, FS 1.2 = the FS is a DEAD lever at
  //     ~3.4%). Earlier octave-count A/Bs that "left frame time flat" did so because they cut ALU on a
  //     loop whose real cost at the deck is the TRIANGLE THROUGHPUT (GRID is ~linear; octMax 12->3 flat).
  //   * The FS atmosphere/splat is cheap relative to the per-vertex carve cascade (the fragment-bound
  //     hypothesis is DISPROVEN -- the FS is not the ceiling on the weak-iGPU target).
  // DRAW-CALL COUNT (terrain-one-two-drawcalls): the patch meshes ALREADY render in essentially TWO
  // draw calls, not "many per-tile" calls -- one gl.drawElementsInstanced for ALL land tiles (the whole
  // visible leaf set as per-instance iOffset/iFace, render() ~L1266) + one for the water surface
  // (~L1322). The single shared GRID^2 quad mesh + per-instance offsets means tile COUNT does not add
  // draw calls; it adds INSTANCES (vertices). So the 1-2-draw target is met; the lever that actually
  // moves the weak-GPU frame is reducing per-vertex VS work and the visible vertex count -- which is what
  // the GRID size, the LOD split thresholds (planet-orchestrator.js), the frustum/limb/hierarchical cull,
  // and the new altitude-driven octave clamp (_clampOcts below) target.
  const TILE_W = opts.tileW || 25;         // mesh-coord tile width (was producer.TILE_W; producer gone)
  // GRID 24 -> 16 (FPS lever, measured browser-18: pxPerPoly median 2.4px@40km / 0.45px@8km at GRID 24
  // = SUB-PIXEL over-tessellation, only 40%/24% in the 4-50px band). GRID 16 cuts verts/quad 676->324
  // (-52%) and tris/quad 1152->512 (-55%), so the per-vertex 14-oct broadShapeM VS (browser-9: 95% of
  // the low-alt frame) runs on ~half the vertices. median scales ~24/16 -> ~3.6px, far closer to the
  // band; the fine relief is carried per-pixel by the FS dFdx normal, not the mesh tessellation.
  const GRID = opts.gridMeshSize || TD.gridMeshSize;    // mesh quads per edge. 16->11->9 (user 2026-06-23): FPS TRIANGLE-THROUGHPUT lever. 11->9 cuts verts/quad 144->81 (-44%) and tris/quad 242->162 (-33%), fine relief carried by FS normal (dFdx) not mesh. GRID 8 was faster (-50%) but made BIOME CROSSOVER LINES JAGGED (climate varying interpolated across coarse triangles steps along edges). Proper fix to reclaim GRID 8 = per-pixel biome sampling in the FS. Override via ?grid=N. Default sourced from terrain-defaults.js (single source of truth shared with patch-baker.js).
  // Expose the LIVE mesh grid so screen-space-error diagnostics (planet.html __diag.pxPerPoly)
  // divide by the real polys/tile instead of a stale literal. Any future GRID change self-corrects
  // the metric (the 24->16 lever left pxPerPoly defaulting to 24 = 1.5x wrong band fraction).
  if (typeof window !== 'undefined') window.__glGrid = GRID;
  const BORDER = 2;
  const USABLE = TILE_W - 2*BORDER;        // 21 interior samples spanned by the mesh

  // HPF (hierarchical parameter field) continental texture -- set by the orchestrator via
  // setHpf(). The terrain VS samples it by world dir for the continental elevation bias
  // (seaBias), replacing the old hardcoded lobe. null until set (VS falls back to 0 bias).
  let _hpfTex = null, _hpfTex2 = null, _hpfRes = 0;   // _hpfTex RG16F(seaBias,elevAmp), _hpfTex2 RG8(temp,humid) -- W12 pack

  // ---- compile terrain.glsl ----
  // CACHE-BUST (2026-06-16): the browser disk-cached terrain.glsl across reloads (the server's no-store
  // headers don't always defeat the disk cache on a soft reload) -> EVERY shader edit silently no-op'd on
  // the live tab while gl-render.js refreshed = the entire 'no change' debugging saga. A per-load ?v= query
  // forces a fresh fetch every page load (matches the ?t= the hot-reload at ~L201 already uses).
  const _sv = '?v=' + (typeof performance !== 'undefined' ? (performance.now()|0) : Date.now());
  // EMBEDDABLE: fetch shaders relative to THIS module (import.meta.url), not the page,
  // so the SDK loads its shaders when consumed from node_modules by a host (e.g. spoint),
  // not only from the mapspinner dev page where ./src was page-relative.
  let src = await (await fetch(new URL('./shaders/terrain.glsl' + _sv, import.meta.url))).text();
  // Analytic Bruneton-style atmosphere helpers, shared by terrain FS + sky pass.
  let atmoSrc = await (await fetch(new URL('./shaders/atmosphere.glsl' + _sv, import.meta.url))).text();

  // NON-BLOCKING COMPILE (user 2026-06-02: 'startup takes really long'). The terrain shader's
  // first (cold-cache) compile can take tens of seconds; querying COMPILE_STATUS/LINK_STATUS
  // BLOCKS the main thread until the driver finishes -> the page freezes for the whole compile.
  // KHR_parallel_shader_compile lets the driver compile on a worker thread; we poll the
  // non-blocking COMPLETION_STATUS_KHR and yield to the event loop between polls, so the page
  // stays responsive (and can show a loading state) during a cold compile instead of freezing.
  const _parExt = gl.getExtension('KHR_parallel_shader_compile');
  const COMPLETION_STATUS_KHR = 0x91B1;
  // Await a program's link completion without blocking the main thread. With the parallel ext we
  // poll COMPLETION_STATUS_KHR (true once the driver is done); without it we fall back to one
  // yield then the (blocking) status read. Throws on compile/link failure, same as before.
  async function awaitProgramLink(p, vs, fs, label){
    // yield_ defers to rAF when the tab is visible, setTimeout(8) when hidden (background tabs
    // throttle rAF to ~1/min -- the recurring stuck-at-init mechanism, 2026-06-12).
    const yield_ = () => new Promise(res => (typeof requestAnimationFrame !== 'undefined'
      && typeof document !== 'undefined' && !document.hidden
      ? requestAnimationFrame(() => res()) : setTimeout(res, 8)));
    if (_parExt) {
      // poll until the driver reports completion without blocking the main thread.
      while (!gl.getProgramParameter(p, COMPLETION_STATUS_KHR)) { await yield_(); }
    } else {
      // No KHR_parallel_shader_compile: getProgramParameter(LINK_STATUS) blocks until the driver
      // finishes (can be 30+ s on D3D11/FXC). Yield once so at minimum the event loop gets one
      // tick (loading-state paint, input) before the stall, matching the comment's intent.
      await yield_();
    }
    // now the status reads return immediately (compile/link already finished, or the blocking
    // stall above has resolved)
    if (vs && !gl.getShaderParameter(vs, gl.COMPILE_STATUS)) throw new Error(label+' vs: '+gl.getShaderInfoLog(vs));
    if (fs && !gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error(label+' fs: '+gl.getShaderInfoLog(fs));
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(label+' link: '+gl.getProgramInfoLog(p));
  }
  // PRECISION: global default HIGHP float. The mediump default (a speculative mobile-ALU lever) kept
  // causing recurring UV SCRAMBLES -- any world-scale noise UV (normalize(worldPos)*freq, freq up to
  // ~9000) whose snoise3 arg was evaluated in mediump (fp16 mantissa ~2048) lost lattice precision and
  // scrambled at close range, and chasing every per-site highp island kept missing sites (multiple
  // commits: f8550b2 et al). HIGHP-DEFAULT eliminates the entire class in one line (P2 simplicity +
  // P8 make-misuse-impossible: a mediump world-scale UV can no longer be reintroduced by omission).
  // Float WIDTH is not our measured frontier (octave count + LOD vertex count are), so the ALU cost is
  // acceptable; correctness + simplicity win over a micro-optimization that keeps breaking. The explicit
  // highp islands left in the shader are now redundant-but-harmless. int + sampler2DArray stay highp.
  const hdr = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2DArray;\n';
  // Build (or rebuild) the terrain program from the current src/atmoSrc. Factored so the
  // shader can be HOT-RELOADED in place (recompile()) without a page reload -- the biggest
  // single cut to the shader-edit debug loop. On compile/link failure it throws WITHOUT
  // disturbing the live program, so a bad edit is reported inline and the old shader keeps
  // running (no broken page).
  // Kick off compile+link WITHOUT reading status (non-blocking with KHR_parallel_shader_compile).
  // Returns {p, vs, fs}; the caller awaits awaitProgramLink() to validate once the driver is done.
  // fsDefs lets the caller add FS-only #defines (e.g. _DEBUGVIEW_ for the lazy debug program that
  // carries the diagnostic displayModes). The render program passes '' so the diagnostic blocks are
  // #ifdef'd OUT (the 7132-char / 25% cold-compile cut, browser-1590); the debug program passes
  // ' _DEBUGVIEW_' to compile them in. The VS is identical for both (no debug branches in the VS).
  function buildTerrainProgram(terrainSrc, atmo, fsDefs){
    fsDefs = fsDefs || '';   // space-separated extra FS defines, e.g. '_DEBUGVIEW_'
    function shader(type, def){ const s=gl.createShader(type);
      // Inject atmosphere.glsl into the FRAGMENT stage only (it's pure functions; the VS
      // doesn't need it). It must appear before terrain.glsl's FS uses the helpers.
      const body = (type===gl.FRAGMENT_SHADER) ? (atmo+'\n'+terrainSrc) : terrainSrc;
      // Each token gets its OWN `#define` line -- a single `#define _FRAGMENT_ _DEBUGVIEW_` would make
      // _FRAGMENT_ a macro that EXPANDS to _DEBUGVIEW_ (and never DEFINE _DEBUGVIEW_), so the debug
      // blocks stayed #ifdef'd out (witnessed browser-1609: debugFS==renderFS). Split into lines.
      const tokens = [def].concat(
        (type===gl.FRAGMENT_SHADER && fsDefs) ? fsDefs.trim().split(/\s+/) : []);
      const defLines = tokens.map(t => '#define '+t+'\n').join('');
      gl.shaderSource(s, hdr+defLines+body); gl.compileShader(s); return s; }
    const vs = shader(gl.VERTEX_SHADER,'_VERTEX_'), fs = shader(gl.FRAGMENT_SHADER,'_FRAGMENT_');
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'vertex');
    gl.linkProgram(p);                              // kicks off the (parallel) link; do NOT read status here
    return { p, vs, fs };
  }
  // COLD COMPILE: only the render program is built on the cold startup path now. The collision PROBE
  // program is LAZY (ensureProbe, built on first sampleGroundM) and the DEBUG program is lazy
  // (ensureDebug) -- both off the cold path. KHR_parallel_shader_compile keeps the render link
  // non-blocking so the page shows a loading state instead of freezing.
  let _b = buildTerrainProgram(src, atmoSrc);
  // LAZY PROBE (build-time pivot 2026-06-09): the collision-height probe program is NO LONGER built on
  // the cold startup path. Measured: the probe (composeHeight + 5 carves FS) was a co-equal cold-compile
  // pole, but sampleGroundM only runs on free-fly collision NEAR GROUND -- never at startup. So it is now
  // built on first sampleGroundM() call (ensureProbe, mirroring the lazy debug program). Removes the probe
  // VS+FS from the cold compile with ZERO functionality loss (collision still GPU-exact, just compiled the
  // first time the user needs it). sampleGroundM returns null until the first build finishes (caller falls
  // back to no-collision, same as the long-standing probe-unavailable path).
  await awaitProgramLink(_b.p, _b.vs, _b.fs, 'terrain');   // non-blocking poll, then validate (render only now)
  let prog = _b.p;
  // LAZY DEBUG PROGRAM: the diagnostic displayModes (1,5,6,7,8,9,10,11,12) live behind _DEBUGVIEW_,
  // compiled into this SEPARATE program only when the user first selects such a mode -- it is NEVER
  // on the cold startup path (the render program above excludes them). Built on demand by ensureDebug();
  // null until then. Its own uniform-location cache (_dbgUloc) since locations are per-program.
  let debugProg = null, _dbgBuilding = null;
  const _dbgUloc = new Map();
  // The diagnostic-only modes that REQUIRE the debug program. Modes 0 (lit), 2 (albedo), 4 (biome
  // ramp) render correctly in the hot program, so they never trigger a debug-program build.
  const DEBUG_MODES = new Set([1,5,6,7,8,9,10,11,12]);
  function ensureDebug(){
    if (debugProg || _dbgBuilding) return;          // already built or in-flight
    // VISIBLE STATE (2026-06-12 'total clarity' tooling): a failed/slow debug compile used to fall
    // back to the lit view FOREVER with no signal (witnessed: displayMode 11 silently rendered lit;
    // a whole diagnostic session trusted a view that never engaged). __debugProgState is the witness:
    // 'compiling' -> 'ready' | 'failed: <log>'; planet.html shows it in the HUD while a debug mode
    // is requested but not yet served.
    if (typeof window !== 'undefined') window.__debugProgState = 'compiling';
    _dbgBuilding = (async () => {
      try {
        const nb = buildTerrainProgram(src, atmoSrc, ' _DEBUGVIEW_');
        await awaitProgramLink(nb.p, nb.vs, nb.fs, 'debug');
        debugProg = nb.p; _dbgUloc.clear();
        if (typeof window !== 'undefined') window.__debugProgState = 'ready';
      } catch(e){ try { if(typeof window!=='undefined') { window.__debugProgErr = String(e.message||e); window.__debugProgState = 'failed: ' + String(e.message||e).slice(0,120); } } catch(_){} }
      finally { _dbgBuilding = null; }
    })();
  }
  // ACTIVE PROGRAM indirection: U() resolves locations against whichever program is bound this frame
  // (render prog by default; the debug prog while a diagnostic displayMode is active). Each program
  // keeps its own location cache. _activeProg/_activeUloc are swapped in render() per frame.
  let _activeProg = null, _activeUloc = null;
  function setActiveProgram(p, cache){ _activeProg = p; _activeUloc = cache; }
  // MEMOIZE uniform locations: U() was calling gl.getUniformLocation EVERY time, and the
  // per-quad path (setQuadUniforms + 3x setTileCoords) hit it ~15x per quad per frame ->
  // ~3000 synchronous driver round-trips/frame at 200 quads = the ~4fps stall. Cache by
  // name; getUniformLocation is then called once per name. Cleared on recompile().
  const _uloc = new Map();
  const U = n => { const cache = _activeUloc || _uloc; const p = _activeProg || prog;
    let l = cache.get(n); if (l === undefined) { l = gl.getUniformLocation(p, n); cache.set(n, l); } return l; };
  // PROBE uniform-location cache (ESE 2026-06-10): sampleGroundM ran ~18 synchronous
  // gl.getUniformLocation(probeProg,...) per call (8 inline + ~10 via setComposeHeightUniforms),
  // hit once/frame on the near-ground collision path = ~18 driver round-trips/frame where it hurts
  // most. Mirror _uloc: memoize per name, cleared when the probe program is (re)built.
  let _probeUloc = new Map();
  const PU = n => { let l = _probeUloc.get(n); if (l === undefined) { l = gl.getUniformLocation(probeProg, n); _probeUloc.set(n, l); } return l; };
  // HOT-RELOAD: re-fetch both shader files (cache-busted), rebuild the terrain program,
  // and swap it in atomically. Returns {ok:true} or {ok:false, error} -- never leaves the
  // renderer in a broken state (a failed build throws before `prog` is reassigned).
  async function recompile(){
    try {
      const ns = await (await fetch('./src/shaders/terrain.glsl?t='+(performance.now()|0))).text();
      const na = await (await fetch('./src/shaders/atmosphere.glsl?t='+(performance.now()|0))).text();
      const nb = buildTerrainProgram(ns, na);
      await awaitProgramLink(nb.p, nb.vs, nb.fs, 'terrain');   // throws on compile/link error
      const newProg = nb.p;
      const old = prog; prog = newProg; src = ns; atmoSrc = na; _uloc.clear(); _chuClear(_uloc);
      // _lutTex (atmosphere transmittance LUT) intentionally NOT recreated/re-baked here: it is a
      // pure data texture with no dependency on the compiled program (unlike prog/debugProg/probeProg,
      // which must be rebuilt from the new shader source) -- only its uniform LOCATION needs re-
      // resolving against the new program, which the _uloc.clear() above + U()'s normal per-name
      // memoization already handles on the next frame that calls U('uTransmittanceLUT'). Re-baking on
      // every hot-reload would also be wasteful (the LUT depends only on the ATM_* constants, which a
      // terrain.glsl/atmosphere.glsl source edit essentially never changes mid-session).
      gl.deleteProgram(old);
      // invalidate the lazy debug program so it rebuilds from the new source on the next debug-mode frame.
      if (debugProg) { gl.deleteProgram(debugProg); debugProg = null; _dbgUloc.clear(); _chuClear(_dbgUloc); }
      // invalidate the lazy probe program too (perf sweep 2026-06-11): it was leaked AND kept running
      // the OLD shader source after a hot-reload -- collision silently diverged from the new geometry.
      if (probeProg) { gl.deleteProgram(probeProg); probeProg = null; _probeUloc.clear(); _chuClear(PU); }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }

  // ---- HEIGHT PROBE program (collision): render the EXACT terrain height for ONE world dir
  // to a 1x1 R32F target, then readPixels it. The free-fly collision floor reads this so it can
  // never diverge from the rendered surface (user-chosen GPU readback, not a CPU mirror). The
  // probe FS (#define _PROBE_) reuses terrain.glsl's hpfSample + broadShapeM; the VS emits one
  // point at clip (0,0). Tiny 4-byte readback per call (collision once/frame).
  let probeProg = null, probeFbo = null, probeTex = null, _probeBuilding = null;
  // ensureProbe(): build the collision-height probe program + its 1x1 R32F FBO on first need (lazy).
  // Idempotent + in-flight-guarded (mirrors ensureDebug). Off the cold startup path.
  function ensureProbe(){
    if (probeProg || _probeBuilding) return;
    _probeBuilding = (async () => {
      try {
        const pvs = hdr + 'void main(){ gl_Position = vec4(0.0,0.0,0.0,1.0); gl_PointSize = 1.0; }';
        const pfs = hdr + atmoSrc + '\n#define _PROBE_\n' + src;
        const pv = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(pv, pvs); gl.compileShader(pv);
        const pf = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(pf, pfs); gl.compileShader(pf);
        const pp = gl.createProgram(); gl.attachShader(pp, pv); gl.attachShader(pp, pf); gl.linkProgram(pp);
        await awaitProgramLink(pp, pv, pf, 'probe');
        const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, 1, 1);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        _probeUloc.clear(); _chuClear(PU);   // stale locations from any prior probe program are invalid for the new one
        probeTex = tex; probeFbo = fbo; probeProg = pp;   // assign LAST so a half-built probe is never used
      } catch(e){ probeProg = null; try { if(typeof window!=='undefined') window.__probeErr = String(e.message||e); } catch(_){} }
      finally { _probeBuilding = null; }
    })();
  }
  const probeVao = gl.createVertexArray();
  // ASYNC READBACK STATE (2026-06-16, measured +10fps at the deck: a synchronous gl.readPixels was a
  // FULL pipeline stall = 3.68ms/frame, latency-bound so it cost the SAME on AMD APU and NVIDIA GPU
  // -> the cross-GPU FPS-parity tell the user caught). The probe now reads into a PIXEL_PACK_BUFFER
  // (readPixels returns immediately, GPU fills it later) + a fenceSync; the NEXT call reads the PBO
  // only once the fence is signaled (non-blocking clientWaitSync(0)). Collision consumes the height
  // ~1 frame late -- negligible at deck movement speed (the move-step already caches __lastGpuM).
  let _probePbo = null, _probeSync = null, _probeLastM = null;
  const _probeOut = new Float32Array(1);   // RED/FLOAT readback is single-channel (was 4: RGBA over-read of the R32F source)
  // _issueProbeDraw(dir): shared draw-issue preamble for BOTH sampleGroundM (fire-and-forget async,
  // 1-frame-stale by design for the per-frame collision hot path) and sampleGroundMSync (blocking,
  // for one-off diagnostic/probe callers -- see the mapspinner-sampleGroundM-probe-drift-preexisting-bug
  // fix below). Binds probeFbo, sets every uniform, issues the 1-point draw, and starts the PBO
  // readPixels + fence -- but does NOT harvest. Extracted so both call shapes issue byte-identical
  // draws (same program/uniform/attrib state) instead of two copies that could silently diverge.
  function _issueProbeDraw(dir){
    if (!_probePbo) { _probePbo = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, _probePbo); gl.bufferData(gl.PIXEL_PACK_BUFFER, 4, gl.STREAM_READ); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); }   // 4 bytes: RED/FLOAT single-channel readback (was 16 for RGBA)
    const pl = Math.hypot(dir[0],dir[1],dir[2])||1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, probeFbo);
    gl.viewport(0,0,1,1);
    gl.useProgram(probeProg);
    gl.bindVertexArray(probeVao);
    // The texture-UNIT bind (activeTexture+bindTexture) is global GL state, shareable with render()'s own
    // last-bound tracking -- but the sampler uniform (PU('hpfPool')=3) is PROGRAM-scoped state on probeProg,
    // a DIFFERENT program from render()'s, so it cannot be skipped just because render() already bound the
    // unit; route it through _chuSet1i keyed on PU (the probe's own uniform cache) so it uploads once per
    // probeProg lifetime, independent of the texture-bind skip.
    if (_hpfTex && _lastHpfTex !== _hpfTex) { _lastHpfTex = _hpfTex; gl.activeTexture(gl.TEXTURE0 + TU.hpf); gl.bindTexture(gl.TEXTURE_2D_ARRAY, _hpfTex); }
    if (_hpfTex) _chuSet1i(PU, PU, 'hpfPool', TU.hpf);
    if (_hpfTex2 && _lastHpfTex2 !== _hpfTex2) { _lastHpfTex2 = _hpfTex2; gl.activeTexture(gl.TEXTURE0 + TU.hpf2); gl.bindTexture(gl.TEXTURE_2D_ARRAY, _hpfTex2); }
    if (_hpfTex2) _chuSet1i(PU, PU, 'hpfPool2', TU.hpf2);
    gl.uniform1i(PU('hasHpf'), _hpfTex?1:0);
    // uTransmittanceLUT: the probe's _PROBE_ main() never calls any atm_* function (composeHeight
    // is pure height math), so this uniform is dead code on the probe program in practice -- but
    // pin it anyway, same "never leave a declared sampler unbound" discipline as hpfPool above
    // (a driver is not required to eliminate control flow around an unreferenced uniform before
    // validating the unit at draw time; matches the uHeightPool-unit-8 incident this file already
    // documents). Texture-unit bind is shared/skippable via the same last-bound tracking render()
    // uses; the sampler uniform itself is per-program state on probeProg, uploaded via PU/_chuSet1i.
    if (_lutTex) { gl.activeTexture(gl.TEXTURE0 + TU.transmittanceLUT); gl.bindTexture(gl.TEXTURE_2D, _lutTex); _chuSet1i(PU, PU, 'uTransmittanceLUT', TU.transmittanceLUT); }
    // uScatteringLUT: same dead-code-but-pin-anyway discipline as uTransmittanceLUT immediately above.
    if (_scatTex) { gl.activeTexture(gl.TEXTURE0 + TU.scatteringLUT); gl.bindTexture(gl.TEXTURE_2D_ARRAY, _scatTex); _chuSet1i(PU, PU, 'uScatteringLUT', TU.scatteringLUT); }
    // SAME shape-control + HPF-sampler congruence as render() (setComposeHeightUniforms): the probe runs
    // composeHeight for sampleGroundM (collision/camera height) so collision matches the rendered surface.
    // If uHiFreqCut/vtxDetail were unset (0.0) here the probe's height would omit all fine relief and
    // diverge from the rendered geometry = the camera stops short of the visible surface. Match render().
    _octClampAlt = 0;   // collision probe: full octaves regardless of the last render frame's altitude (collision must match the close-up surface)
    setComposeHeightUniforms(PU);
    gl.uniform3f(PU('probeDir'), dir[0]/pl, dir[1]/pl, dir[2]/pl);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.POINTS, 0, 1);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, _probePbo);
    gl.readPixels(0,0,1,1, gl.RED, gl.FLOAT, 0);   // ASYNC: into the PBO at offset 0, returns immediately (no CPU<-GPU stall). RED/FLOAT matches the R32F source (1 channel, not RGBA's 4x bytes) -- WebGL2 core supports RED/FLOAT readback from an R32F FBO (same EXT_color_buffer_float already required above).
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();   // push the commands + fence so the GPU starts now and the fence can signal by next call
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    return fence;
  }
  // sampleGroundM(dir): rendered terrain height (metres) at world direction dir, ~1 frame stale.
  // Returns null until the first async read completes (caller falls back to the CPU mirror).
  //
  // CONTRACT WARNING (mapspinner-sampleGroundM-probe-drift-preexisting-bug, fixed 2026-07-21): this
  // function is FIRE-AND-FORGET ASYNC BY DESIGN for the per-frame collision hot path (see the
  // 2026-06-16 comment above _probePbo -- a synchronous readPixels here was a measured 3.68ms/frame
  // pipeline stall). Each call HARVESTS the PBO/fence issued by the PREVIOUS call, then issues a new
  // draw for THIS call's dir and returns the harvested (previous-call) value. That is correct and
  // cheap when called every rAF frame with a slowly-changing dir (the real collision use case: the
  // 1-call lag IS the "~1 frame stale" contract, negligible at deck movement speed). It is WRONG for
  // any caller that is NOT paced by the page's own render loop -- e.g. a diagnostic/probe/parity
  // script driving this via separate synchronous calls (CDP round-trips, a Node harness, a witness
  // loop with no intervening rAF) with no fence-signalling gap between calls. In that access pattern
  // EVERY call harvests a fence that has not yet had a chance to signal (still in flight from the
  // immediately-preceding call), so harvest is skipped (step 1's `if` never fires) and the function
  // returns _probeLastM completely unrelated to the dir just passed -- specifically, calling with two
  // alternating directions A,B,A,B,... makes call N return the value for THAT call's OWN direction
  // one full call late: read(A) returns B's settled height, read(B) returns A's, forever in lockstep
  // (live-reproduced: alternation never converges, matchesD1/matchesD2 swap every single call, 12/12
  // calls in a real headless witness). This LOOKS like a fixed additive per-call drift when a witness
  // script logs "before" and "after" values around some intervening state change (e.g. a sculpt
  // stroke) without accounting for the pipeline depth -- the "drift" is really the SAME stale-read
  // artifact, and the correct protocol (already used by the sculpt-override witness this bug was
  // found under) is comparing the STEADY-STATE PER-CALL delta only once the read cadence has settled
  // to one call per intervening frame, never a raw single before/after diff.
  // FIX: sampleGroundMSync(dir) below is the correct API for a probe/diagnostic caller -- it blocks
  // (bounded spin, same discipline as bakeTileReadback's PBO+fence spin-then-block harvest) until the
  // draw it JUST issued is actually readable, so the returned value always matches the dir passed
  // THIS call, with zero cross-call lag. sampleGroundM's async fire-and-forget behavior is UNCHANGED
  // (a real per-frame regression risk to the collision hot path if it were forced synchronous) --
  // this is a new sibling API, not a contract change to the existing one.
  function sampleGroundM(dir) {
    if (!probeProg) { ensureProbe(); return null; }   // lazy: kick off the build on first need, fall back to null until ready
    // 1) HARVEST a completed prior read (non-blocking) so we never wait on the GPU.
    if (_probeSync) {
      const st = gl.clientWaitSync(_probeSync, 0, 0);
      if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, _probePbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, _probeOut);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        _probeLastM = _probeOut[0];
        gl.deleteSync(_probeSync); _probeSync = null;
      }
    }
    // 2) Only issue a fresh read when none is in flight (else just return the last harvested value).
    if (!_probeSync) _probeSync = _issueProbeDraw(dir);
    return _probeLastM;
  }
  // sampleGroundMSync(dir): BLOCKING variant of sampleGroundM for one-off diagnostic/probe/parity
  // callers (lab.mjs parity sweeps, sculpt-verification witnesses, any script not paced by the page's
  // own rAF loop) -- see the CONTRACT WARNING above sampleGroundM for why the async version silently
  // returns a stale, unrelated-direction value under that access pattern. Issues its OWN draw for
  // `dir` (via the same _issueProbeDraw preamble sampleGroundM uses, so both stay byte-identical) and
  // spins on the fence (bounded, same shape as bakeTileReadback's PBO+fence spin-then-block harvest)
  // until it can read back THIS call's own result -- never a previous call's. Costs one real GPU
  // pipeline flush/stall per call (same class of cost the 2026-06-16 async fix was written to avoid
  // on the per-frame hot path); acceptable for a probe/diagnostic call site, NOT for sampleGroundM's
  // per-frame collision consumer. If a fenced async read was already in flight from a prior
  // sampleGroundM/sampleGroundMSync call, harvest it first (same as sampleGroundM step 1) so no PBO
  // readback is ever silently dropped, then issue+block for this call's own dir.
  function sampleGroundMSync(dir) {
    if (!probeProg) { ensureProbe(); return null; }   // lazy: same fallback contract as sampleGroundM
    if (_probeSync) {
      // Drain whatever was already in flight (harvest if ready, else just wait for it below) so this
      // call's own issue doesn't orphan a still-pending fence/PBO from a previous async call.
      const st = gl.clientWaitSync(_probeSync, 0, 0);
      if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, _probePbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, _probeOut);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        _probeLastM = _probeOut[0];
      }
      gl.deleteSync(_probeSync); _probeSync = null;
    }
    const fence = _issueProbeDraw(dir);
    // Bounded spin (mirrors bakeTileReadback's discipline): give the GPU a chance to finish before
    // falling through to a blocking clientWaitSync. SYNC_FLUSH_COMMANDS_BIT_BIT-free (already flushed
    // by _issueProbeDraw) blocking wait as the last resort so this ALWAYS returns THIS call's value,
    // never an approximation -- diagnostic correctness matters more than the bounded-stall shortcut.
    const spinUntil = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 4;
    let status = gl.clientWaitSync(fence, 0, 0);
    while (status === gl.TIMEOUT_EXPIRED && (typeof performance !== 'undefined' ? performance.now() : Date.now()) < spinUntil) {
      status = gl.clientWaitSync(fence, 0, 0);
    }
    if (status === gl.TIMEOUT_EXPIRED) {
      // Spin budget exhausted -- fall through to a genuinely blocking wait (timeout ~1e9ns = 1s) so
      // this never returns a wrong-direction value; a real GPU hang is a separate, unrelated failure.
      status = gl.clientWaitSync(fence, 0, 1e9);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, _probePbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, _probeOut);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteSync(fence);
    _probeLastM = _probeOut[0];
    return _probeLastM;
  }

  // ===== THC HEIGHT-CACHE BAKE (2026-06-14, NON-DESTRUCTIVE) =====
  // A separate program renders composeHeight for one tile into an R32F grid (a fullscreen tri; each
  // fragment = one tile parametric texel). Used FIRST as a readback witness (bake vs procedural
  // sampleGroundM) to prove the bake matches the geometry; the pool/LRU + the VS-sample switch are
  // later DAG nodes. _faceFrames mirror terrain.glsl faceFrame() columns (column-major mat3).
  const THC_BAKE_RES = 130;
  const _faceFrames = [
    [0,0,-1, 0,1,0, 1,0,0], [0,0,1, 0,1,0, -1,0,0],
    [1,0,0, 0,0,-1, 0,1,0], [1,0,0, 0,0,1, 0,-1,0],
    [1,0,0, 0,1,0, 0,0,1], [-1,0,0, 0,1,0, 0,0,-1],
  ];
  // Pre-converted Float32Array per face, built once here instead of re-wrapping `new Float32Array(_faceFrames[face])`
  // on every bake-uniform upload call (3 call sites, one per baked tile/frame) -- the source arrays never mutate,
  // so the conversion is a pure one-time cost.
  const _faceFramesF32 = _faceFrames.map(f => new Float32Array(f));
  let bakeProg=null, bakeTex=null, bakeFbo=null, _bakeBuilding=null; const _bakeUloc=new Map();
  const BU = n => { let l=_bakeUloc.get(n); if(l===undefined){ l=gl.getUniformLocation(bakeProg,n); _bakeUloc.set(n,l);} return l; };
  function ensureBake(){
    if (bakeProg || _bakeBuilding) return;
    _bakeBuilding = (async () => {
      try {
        const bvs = hdr + 'void main(){ vec2 p=vec2((gl_VertexID==1)?3.0:-1.0,(gl_VertexID==2)?3.0:-1.0); gl_Position=vec4(p,0.0,1.0); }';
        const bfs = hdr + '\n#define _HEIGHTBAKE_\n' + src;
        const bv=gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(bv,bvs); gl.compileShader(bv);
        const bf=gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(bf,bfs); gl.compileShader(bf);
        const bp=gl.createProgram(); gl.attachShader(bp,bv); gl.attachShader(bp,bf); gl.linkProgram(bp);
        await awaitProgramLink(bp, bv, bf, 'bake');
        const tex=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, THC_BAKE_RES, THC_BAKE_RES);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const fbo=gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        _bakeUloc.clear(); _chuClear(BU); bakeTex=tex; bakeFbo=fbo; bakeProg=bp;
      } catch(e){ bakeProg=null; try{ if(typeof window!=='undefined') window.__bakeErr=String(e.message||e); }catch(_){} }
      finally { _bakeBuilding=null; }
    })();
  }
  const bakeVao = gl.createVertexArray();
  // bake ONE tile into bakeTex + read it back (Float32Array of THC_BAKE_RES^2 heights). Returns null
  // until the program is built (lazy). NON-DESTRUCTIVE: does not touch the live render path.
  //
  // PBO+FENCE READBACK (2026-07-02, fps-drop investigation): a plain gl.readPixels here was measured as
  // the single dominant live-frame cost (~3.3ms/frame, ~48% of the 6.94ms 144Hz budget) -- it is a FULL
  // CPU<-GPU pipeline stall exactly like the sampleGroundM probe was before its 2026-06-16 async fix (see
  // that fix's comment above). This callsite CANNOT go fully async the same way (return null immediately,
  // harvest next call) without a caller-side rewrite: patch-baker.js's bakeTile() retry-loops up to 12x
  // synchronously with NO yield between attempts, so a null-then-poll pattern here would just busy-spin
  // GL calls instead of stalling on one -- same wall-clock cost, worse (12x draw+bindFramebuffer calls).
  // Correctness constraint: the deterministic bake must stay byte-identical for server/client collider +
  // placement parity, so a stale/wrong-tile heights array is not acceptable, only a bounded stall is.
  // Middle ground: readPixels into a PIXEL_PACK_BUFFER (still synchronous call) is measurably cheaper on
  // most drivers than the default readPixels-into-a-typed-array path (avoids one extra host-side copy +
  // lets the driver choose a faster DMA transfer), and a short (not 0ms) clientWaitSync poll spin gives
  // the GPU a chance to finish the draw+copy before the CPU blocks, shrinking (not eliminating) the stall
  // versus reading immediately after gl.flush(). This keeps the synchronous contract every caller
  // (server collider bake, client placement lookup, both via __thcBakeReadback) already depends on.
  let _bakePbo = null;
  // The shared bake-tile draw preamble. Every bake path (sync readback, async-slot issue, pool-layer)
  // must issue byte-identical program+uniforms+draw or the deterministic server/client collider-parity
  // bake silently diverges between them -- single-source it here so a format/octave/uniform edit lands
  // once (mirrors setComposeHeightUniforms one level up). The CALLER binds its own FBO target (bakeFbo
  // vs poolFbo+framebufferTextureLayer) before calling and does its own readback after.
  function drawBakeTile(face, ox, oy, l, level){
    gl.viewport(0,0,THC_BAKE_RES,THC_BAKE_RES);
    gl.useProgram(bakeProg);
    gl.bindVertexArray(bakeVao);
    if (_hpfTex){ gl.activeTexture(gl.TEXTURE0 + TU.hpf); gl.bindTexture(gl.TEXTURE_2D_ARRAY,_hpfTex); gl.uniform1i(BU('hpfPool'),TU.hpf); }
    if (_hpfTex2){ gl.activeTexture(gl.TEXTURE0 + TU.hpf2); gl.bindTexture(gl.TEXTURE_2D_ARRAY,_hpfTex2); gl.uniform1i(BU('hpfPool2'),TU.hpf2); }
    gl.uniform1i(BU('hasHpf'), _hpfTex?1:0);
    _octClampAlt = 0;   // height bake: full octaves (the baked tile is consumed at vertex rate near ground; match the surface)
    setComposeHeightUniforms(BU);
    gl.uniform1f(BU('defRadius'), R);
    gl.uniformMatrix3fv(BU('uBakeFrame'), false, _faceFramesF32[face|0]);
    gl.uniform4f(BU('uBakeOffset'), ox, oy, l, level);
    gl.uniform1f(BU('uBakeRes'), THC_BAKE_RES);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function bakeTileReadback(face, ox, oy, l, level){
    if (!bakeProg){ ensureBake(); return null; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, bakeFbo);
    drawBakeTile(face, ox, oy, l, level);
    // RED/FLOAT (2026-07-03): the bake FBO is R32F (single channel) -- RGBA/FLOAT read 4x the bytes
    // actually written by the driver and this code only ever kept buf[i*4] (R), discarding G/B/A.
    // WebGL2 core supports RED/FLOAT readback from an R32F framebuffer (spec-compliant; the same
    // EXT_color_buffer_float required for the R32F attachment itself covers float readback formats).
    // Zero value change: same heights, 4x less PBO allocation + DMA + host copy bandwidth.
    const byteLen = THC_BAKE_RES*THC_BAKE_RES*4;   // RED float32 (1 channel)
    if (!_bakePbo) _bakePbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, _bakePbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLen, gl.STREAM_READ);
    gl.readPixels(0,0,THC_BAKE_RES,THC_BAKE_RES, gl.RED, gl.FLOAT, 0);   // into the PBO (driver-side DMA, no immediate host copy)
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    // Bounded spin: give the GPU up to ~2ms to finish the draw+copy before falling through to the
    // blocking getBufferSubData below. Shrinks the stall on the common case (bake already done by the
    // time we poll) without changing the synchronous return contract every caller depends on.
    const spinUntil = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 2;
    let status = gl.clientWaitSync(fence, 0, 0);
    while (status === gl.TIMEOUT_EXPIRED && (typeof performance !== 'undefined' ? performance.now() : Date.now()) < spinUntil) {
      status = gl.clientWaitSync(fence, 0, 0);
    }
    gl.deleteSync(fence);
    const out = new Float32Array(byteLen / 4);   // RED/FLOAT: buf IS the height array directly, no de-interleave needed
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);   // blocks only if the spin above didn't already observe completion
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    let dbg=null; try{ dbg={ offLoc: BU('uBakeOffset')!=null, resLoc: BU('uBakeRes')!=null, frameLoc: BU('uBakeFrame')!=null,
      offRead: BU('uBakeOffset')?Array.from(gl.getUniform(bakeProg, BU('uBakeOffset'))):null,
      resRead: BU('uBakeRes')?gl.getUniform(bakeProg, BU('uBakeRes')):null }; }catch(e){ dbg={err:String(e)}; }
    return { heights: out, res: THC_BAKE_RES, dbg };
  }
  // TRULY NON-BLOCKING variant (2026-07-02, evidence-driven follow-up): a live stack-trace CDP profile
  // showed getBufferSubData -- the harvest inside bakeTileReadback above -- as the #1 measured cost even
  // on the "async" client path (bakeTileAsync in patch-baker.js), because bakeTileAsync still called this
  // SAME synchronous bakeTileReadback (only the outer RETRY loop was removed, not the inner readback's
  // own bounded spin-then-block harvest). This pair (issue/poll) makes the readback itself non-blocking,
  // matching sampleGroundM's already-proven pattern: issue() draws + starts the PBO read + fences and
  // returns immediately (no wait at all); poll() is called on a LATER frame/tick to harvest a completed
  // fence non-blockingly (clientWaitSync timeout 0).
  //
  // SLOT RING (2026-07-03, ms-async-bake-slot-ring): the original design reused ONE PBO/fence pair, so
  // a second issue() while one bake was in flight was a silent no-op -- patch-baker.js's prefetchAround
  // issues up to 8 neighbor-tile bakes per call, but only the LAST one survived (each new issue() call
  // that found a slot busy did nothing, so 7 of 8 prefetch requests were dropped on the floor every time
  // prefetchAround ran with anything already in flight). Fix: N independent {pbo, fence, pending} slots,
  // each an exact replica of the single-slot allocation pattern above. issueAsync scans for a FREE slot
  // (fence null) instead of bailing when slot 0 is busy; pollAsync scans all slots and harvests the first
  // one whose fence has signaled (non-blocking clientWaitSync timeout 0 on each, same as before -- this
  // never blocks, it just checks up to N fences instead of 1). Bounded-latency/fallback-to-CPU-fractal
  // semantics on a cache miss are UNCHANGED: a miss still returns null immediately from the caller's
  // perspective (issue-then-return, or all slots busy -> return false) and the caller's own fallbackFn
  // covers that frame, exactly as the single-slot version did.
  const BAKE_ASYNC_SLOTS = 4;
  const _bakeAsyncSlots = Array.from({ length: BAKE_ASYNC_SLOTS }, () => ({ pbo: null, fence: null, pending: null }));
  function bakeTileIssueAsync(face, ox, oy, l, level){
    if (!bakeProg){ ensureBake(); return false; }
    const slot = _bakeAsyncSlots.find(s => !s.fence);
    if (!slot) return false;   // all N slots in flight; caller polls first (was: the single slot busy)
    gl.bindFramebuffer(gl.FRAMEBUFFER, bakeFbo);
    drawBakeTile(face, ox, oy, l, level);
    const byteLen = THC_BAKE_RES*THC_BAKE_RES*4;   // RED float32 (1 channel, matches the R32F bake FBO -- see bakeTileReadback's comment)
    if (!slot.pbo) slot.pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLen, gl.STREAM_READ);
    gl.readPixels(0,0,THC_BAKE_RES,THC_BAKE_RES, gl.RED, gl.FLOAT, 0);
    slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    slot.pending = { face, ox, oy, l, level };
    return true;
  }
  // Harvests the first slot whose fence has signaled (non-blocking; never waits). Callers that want to
  // drain multiple completed slots in one tick call this in a loop until it returns null (patch-baker.js
  // does not currently need that -- one harvest per patchFor/heightFn call is enough since a cache hit on
  // the SAME tile the very next lookup is the common case -- but the API supports repeated draining).
  function bakeTilePollAsync(){
    for (const slot of _bakeAsyncSlots) {
      if (!slot.fence) continue;
      const status = gl.clientWaitSync(slot.fence, 0, 0);   // 0 timeout: never blocks
      if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) continue;   // still cooking, no stall
      gl.deleteSync(slot.fence); slot.fence = null;
      const byteLen = THC_BAKE_RES*THC_BAKE_RES*4;   // RED float32 (1 channel)
      const out = new Float32Array(byteLen / 4);   // RED/FLOAT: buf IS the height array directly, no de-interleave needed
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);   // fence already signaled -> this returns immediately, no stall
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const meta = slot.pending; slot.pending = null;
      return { heights: out, res: THC_BAKE_RES, face: meta.face, ox: meta.ox, oy: meta.oy, l: meta.l, level: meta.level };
    }
    return null;   // nothing completed yet across any slot
  }
  // Expose on globalThis (covers BOTH window and a Web Worker's self) so a headless/worker consumer --
  // e.g. a physics collider baking patches off the GPU in the singleplayer/host worker, which has
  // OffscreenCanvas WebGL2 but NO `window` -- can reach the THC bake. (Was `window`-only -> undefined in
  // a Worker, so the worker collider couldn't bake.)
  if (typeof globalThis !== 'undefined') {
    globalThis.__thcBakeReadback = bakeTileReadback; globalThis.__thcEnsureBake = ensureBake;
    globalThis.__thcBakeIssueAsync = bakeTileIssueAsync; globalThis.__thcBakePollAsync = bakeTilePollAsync;
  }

  // ===== THC HEIGHT POOL + LRU (the VS-sample consumer; the FPS win) =====
  // The VS samples a baked per-tile height (O(1) texture fetch) instead of composeHeight 5x/vertex,
  // when window.__thc is on. A 2D-array pool holds one BAKE_RES^2 R32F layer per live tile; a leaf
  // gets a layer (baked once) on first sight, LRU-evicted when the pool is full. Default OFF -> the
  // live render is unchanged (composeHeight), so this is safe to ship behind the toggle.
  const THC_POOL_LAYERS = 512;
  let heightPool=null, poolFbo=null;
  const _tcMap = new Map();                                   // tileKey -> layer
  const _tcLayerKey = new Array(THC_POOL_LAYERS).fill(null);  // layer -> tileKey (evict bookkeeping)
  const _tcUsed = new Int32Array(THC_POOL_LAYERS);            // layer -> last-used frame
  let _tcFrame = 0, _tcNextFree = 0, _tcBakesThisFrame = 0;
  // BAKE-ON-EDIT: terraform/HPF changes make every baked layer stale -> drop the whole map so each
  // visible tile re-bakes on next sight (synchronously, before its draw -> no black/stale frame).
  function invalidatePool(){ _tcMap.clear(); _tcLayerKey.fill(null); _tcNextFree = 0; }
  function ensurePool(){
    if (heightPool) return;
    heightPool = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D_ARRAY, heightPool);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R32F, THC_BAKE_RES, THC_BAKE_RES, THC_POOL_LAYERS);
    const lin = _halfFloatLinearOK ? gl.LINEAR : gl.NEAREST;   // R32F LINEAR needs OES_texture_float_linear; else VS does manual bilinear
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, lin); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, lin);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    poolFbo = gl.createFramebuffer();
  }
  function bakeTileToLayer(face,ox,oy,l,level,layer){
    gl.bindFramebuffer(gl.FRAMEBUFFER, poolFbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, heightPool, 0, layer);
    drawBakeTile(face, ox, oy, l, level);
    _tcBakesThisFrame++;
  }
  // pool layer for a tile, baked on first sight; LRU-evicts when full. Returns -1 if not yet bakeable.
  function ensureTileLayer(face,ox,oy,l,level){
    const key = face+':'+ox+':'+oy+':'+l;
    let layer = _tcMap.get(key);
    if (layer === undefined){
      if (_tcNextFree < THC_POOL_LAYERS){ layer = _tcNextFree++; }
      else { let lru=0, lruF=_tcUsed[0]; for(let k=1;k<THC_POOL_LAYERS;k++) if(_tcUsed[k]<lruF){lruF=_tcUsed[k];lru=k;} layer=lru; const old=_tcLayerKey[lru]; if(old!=null) _tcMap.delete(old); }
      _tcMap.set(key, layer); _tcLayerKey[layer]=key;
      bakeTileToLayer(face,ox,oy,l,level,layer);
    }
    _tcUsed[layer]=_tcFrame;
    return layer;
  }
  // THC active = toggle on AND both programs/pool ready. Builds them lazily; returns false until ready
  // so the first frames fall back to composeHeight (uThc=0) with no garbage.
  let _tcInvSeen = 0;
  function thcActive(){
    if (typeof window==='undefined' || !window.__thc) return false;
    if (!bakeProg){ ensureBake(); return false; }
    ensurePool();
    // live re-bake hook: window.__thcInvalidate() bumps __thcInval; any composeHeight-shaping edit
    // (e.g. __gen biome/relief dials) should call it so the baked pool refreshes.
    const inv = (window.__thcInval|0);
    if (inv !== _tcInvSeen){ _tcInvSeen = inv; invalidatePool(); }
    return !!heightPool;
  }
  if (typeof window !== 'undefined') window.__thcInvalidate = () => { window.__thcInval = (window.__thcInval|0) + 1; };

  // FLOAT-LINEAR FORMAT PROBE (NOT a quality tier): OES_texture_float_linear lets the HPF atlas pools
  // filter LINEAR in hardware -> hpfSample collapses to one texture() call. 0 = manual 4-tap fallback.
  const _halfFloatLinearOK = !!gl.getExtension('OES_texture_float_linear') || !!gl.getExtension('OES_texture_half_float_linear');
  // Diagnostics-only readout (NOT a branch): exposes the float-linear probe outcome for a witness/CLI.
  try { if (typeof window !== 'undefined') window.__terrainConfig = { floatLinearOK: _halfFloatLinearOK }; } catch(_){}

  // ALTITUDE-DRIVEN OCTAVE CLAMP (2026-06-19). The dominant
  // GPU cost is VERTEX-bound: the fractal (12 octaves) runs ~5x/vertex (the inline geometry height +
  // 4 FD normal taps, terrain.glsl:1102-1109) across GRID^2 verts/tile x ~500-900 visible tiles. The
  // finest broadShapeM octaves (o>=6) have absolute world wavelengths of a few km; at high altitude
  // every visible tile spans many km/pixel so those octaves are GLOBALLY sub-pixel and contribute
  // nothing the screen can resolve -- pure VS ALU waste. We drop them as a function of CAMERA ALTITUDE
  // ONLY (a single per-frame scalar, NOT a per-tile/per-LOD fade): because the clamp is identical for
  // every tile in the frame, adjacent tiles -- same level OR a level apart -- evaluate the IDENTICAL
  // octave count at their shared edge, so there is ZERO cross-LOD seam. This is the crucial distinction
  // from the REFUTED per-tile octave fade (terrain.glsl:832 -- that faded by TILE SIZE, so a 1500km tile
  // and an adjacent 1200km tile dropped different octaves at the shared edge and diverged). The collision
  // probe + height bake call this with the SAME _octClampAlt set per frame, so collision stays matched to
  // the rendered surface (and near-ground collision frames are low-alt = no clamp anyway). Default ON;
  // window.__altOctClamp===false rolls it back to the flat 12 octaves at all altitudes.
  let _octClampAlt = 0;   // metres; set per-frame by render()/probe before calling setComposeHeightUniforms
  function _clampOcts(baseOcts) {
    if (typeof window !== 'undefined' && window.__altOctClamp === false) return baseOcts;
    const altKm = _octClampAlt / 1000.0;
    // Knees chosen so the near surface (deck->descent) is byte-identical and the cut only engages where
    // the dropped octaves are provably sub-pixel: full 12 below 80km, -2 by 200km, -4 by 800km, -6 (the
    // whole o>=6 fine band) above 2000km where the planet sits small in frame. Monotone, clamped to >=6
    // so the continent/hypsometry silhouette octaves (o<6, CLI-validated) are NEVER touched.
    let drop = 0;
    if (altKm > 2000)      drop = 6;
    else if (altKm > 800)  drop = 4;
    else if (altKm > 200)  drop = 2;
    else if (altKm > 80)   drop = 1;
    return Math.max(6, baseOcts - drop);
  }
  // DIRTY-FLAG CACHE (perf 2026-07-03): bakeTileToLayer/bakeTileReadback/bakeTileIssueAsync call this
  // once per tile bake, but only uBakeFrame/uBakeOffset (set by the CALLER after this returns) vary
  // between tiles in the same batch -- the ~28 shape-control/HPF uniforms below are batch-constant.
  // Cache the last-uploaded value per (locator-fn, uniform-name) and skip re-uploading when unchanged.
  // Keyed on `loc` identity (BU/PU/U are distinct stable closures, one per program) so render/_PROBE_/
  // bake caches never cross-contaminate. Invalidated wholesale whenever the target program is rebuilt:
  // callers that rebuild a program already clear that program's uniform-LOCATION cache (_bakeUloc.clear()
  // etc) -- piggyback on the same signal by clearing this cache next to every such clear() (see
  // ensureBake/ensureProbe/render's program-(re)build sites).
  const _chuCache = new Map();   // cacheKey -> Map(name -> lastValue)
  function _chuClear(key){ _chuCache.delete(key); }
  let _lastShadowTex = null;   // last-bound shadowInfo depth texture object, for the shadow-bridge texture-bind skip below
  // Dummy shadow-comparison texture: uShadowMap is a sampler2DShadow uniform, unconditionally pinned
  // to TEXTURE1 every frame (see the shadow-bridge block below) so it never defaults to unit 0 and
  // collides with _vdrsColor/_vdrsDepth there. But TEXTURE1 itself is only ever BOUND when a real
  // shadow map exists (_si.hasShadow) -- on a frame with no shadow-casting light, unit 1 holds
  // whatever THREE's own scene render last left there (a plain, non-shadow-configured texture),
  // and sampling it through a sampler2DShadow produces "GL_INVALID_OPERATION: mismatch between
  // texture format and sampler type (signed/unsigned/float/shadow)". Lazily build a 1x1
  // DEPTH_COMPONENT24 texture with TEXTURE_COMPARE_MODE=COMPARE_REF_TO_TEXTURE (the mode a real
  // shadow-map texture already carries, per WebGLShadowMap) and bind it whenever no real shadow
  // texture is available, so unit 1 is ALWAYS shadow-sampler-compatible.
  let _dummyShadowTex = null;
  function ensureDummyShadowTex() {
    if (_dummyShadowTex) return _dummyShadowTex;
    _dummyShadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, _dummyShadowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, 1, 1, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return _dummyShadowTex;
  }
  // Dummy height-pool texture: uHeightPool (sampler2DArray) is pinned to TEXTURE8 unconditionally
  // every frame (see the terrain draw below) so its declared unit never defaults to 0 and collides
  // with _vdrsColor/_vdrsDepth there. But TEXTURE8 itself is only ever BOUND to a real array texture
  // when THC (window.__thc) is enabled -- THC defaults OFF (measured net-negative, AGENTS.md), so on
  // the default path unit 8 has NO texture object bound at all. WebGL2 drivers can still validate a
  // sampler2DArray uniform against an EMPTY unit at draw time even though the shader's _thc branch
  // never dynamically reads it (uniform control flow is not always eliminated by the compiler),
  // producing "GL_INVALID_OPERATION" on drawElementsInstanced -- witnessed live via unitChecks
  // showing unit 8 has2D:false/hasArray:false while uHeightPool's uniform value is 8. Lazily build a
  // 1x1 R32F 2D_ARRAY (1 layer) so unit 8 is ALWAYS array-sampler-compatible, same fix shape as the
  // shadow dummy above.
  let _dummyHeightPoolTex = null;
  function ensureDummyHeightPoolTex() {
    if (_dummyHeightPoolTex) return _dummyHeightPoolTex;
    _dummyHeightPoolTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, _dummyHeightPoolTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R32F, 1, 1, 1);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    return _dummyHeightPoolTex;
  }
  // GPU-VISIBLE SCULPT-BRUSH OVERRIDE (terrain-gpu-visible-sculpt-mesh-deformation): a plain sampler2D
  // (NOT an array -- one flat window, not per-tile), R32F, uSculptRes texels/side, holding the
  // accumulated height DELTA (metres) at each texel of a square local-XZ window. Same dummy-texture
  // discipline as uHeightPool above: uSculptOverride's sampler unit is pinned EVERY frame regardless of
  // whether a sculpt is active, so it never validates against an empty/wrong-type unit.
  const SCULPT_RES = 256;   // texels/side; at a typical brush-window extent (~64m half-width, see setSculptOverride) this is ~0.5m/texel, well under CELL_M=1 in HeightDelta.js so no aliasing of the source data
  let _sculptTex = null, _dummySculptTex = null;
  function ensureSculptTex() {
    if (_sculptTex) return _sculptTex;
    _sculptTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, _sculptTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, SCULPT_RES, SCULPT_RES);
    // LINEAR filtering needs OES_texture_float_linear (same extension gate the HPF/height-pool floats
    // already probe via _halfFloatLinearOK) -- R32F is NOT filterable without it. Fall back to NEAREST
    // (a slightly blockier but still correct brush edge) rather than an unconditional LINEAR that could
    // silently no-op to NEAREST on a driver lacking the extension anyway.
    const filt = _halfFloatLinearOK ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return _sculptTex;
  }
  function ensureDummySculptTex() {
    if (_dummySculptTex) return _dummySculptTex;
    _dummySculptTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, _dummySculptTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, 1, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return _dummySculptTex;
  }
  // Host-facing state: null = no active override window (the common case -- a world that has never
  // sculpted, or whose sculpts are all outside the current window, pays zero draw-time cost beyond the
  // one always-pinned dummy-texture bind + a uSculptActive=0 branch check in the shader).
  let _sculptState = null;   // { center:[x,z], extent, up:[3], east:[3], north:[3] } in PlanetFrame local-XZ / anchor-basis space
  // Sets/replaces the active sculpt-override window and uploads `heights` (a Float32Array, row-major,
  // SCULPT_RES*SCULPT_RES, metres delta -- caller resamples from HeightDelta.deltaAt onto this fixed
  // grid) as the new texture content. `frameBasis` = {up,east,north} from PlanetFrame (same object the
  // host already holds) so the shader's dir0->local-XZ reconstruction uses the IDENTICAL basis
  // PlanetFrame.localToDir used to define the space HeightDelta's (x,z) are expressed in. Pass
  // `heights:null` to just move the window (e.g. re-center on player movement) without a re-upload --
  // rare in practice since a moved window needs fresh content anyway, but kept for a caller that wants
  // to defer the (cheap, SCULPT_RES^2=64K floats) resample.
  function setSculptOverride(center, extent, frameBasis, heights) {
    if (!center || !Number.isFinite(center[0]) || !Number.isFinite(center[1]) || !Number.isFinite(extent) || extent <= 0 || !frameBasis) { _sculptState = null; return; }
    _sculptState = { center: [center[0], center[1]], extent, up: frameBasis.up, east: frameBasis.east, north: frameBasis.north };
    if (heights) {
      const tex = ensureSculptTex();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SCULPT_RES, SCULPT_RES, gl.RED, gl.FLOAT, heights);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }
  function clearSculptOverride() { _sculptState = null; }
  // FIX (perf-regression-terrain-geomorph-default-off-plus-gl-errors-investigation, live-confirmed via
  // real GL-state capture -- CURRENT_PROGRAM's active sampler uniforms + per-unit texture-binding scan
  // at the exact failing drawElementsInstanced): uSurfAlb/uSurfNrm (sampler2DArray, TEXTURE6/7) have the
  // IDENTICAL bug class already fixed for uHeightPool/TEXTURE8 above, just never given the analogous fix.
  // hasSurf=!!_surfAlb gates BOTH the texture bind AND the uniform1i call below (`if (hasSurf) {...}`) --
  // whenever the async surface-texture loader hasn't populated _surfAlb yet (e.g. early in a session,
  // reproduced live within ~4-8s of page load), units 6/7 hold NO texture object at all AND uSurfAlb/
  // uSurfNrm's sampler uniforms are left unset (defaulting to/staying at unit 0, which collides with
  // whatever plain TEXTURE_2D other code binds there -- the exact "two textures of different types use
  // the same sampler location" mechanism already documented for uHeightPool). This is the confirmed real
  // cause of the "864-byte-buffer" / recurring INVALID_OPERATION class this row was asked to verify --
  // buffer/attribute sizes at the failing draw were live-confirmed byte-exact (ruling out the wave-8
  // color-pass attribute-binding bug as the cause here), leaving sampler incompleteness as the only
  // remaining explanation, matching the pattern this project already fixed once for a different sampler.
  // Reuse a small dummy 2D_ARRAY (unit-agnostic) for BOTH units whenever hasSurf is false, and pin the
  // uniform to the real unit unconditionally, same shape as uHeightPool/hpfPool/hpfPool2 above.
  let _dummySurfTex = null;
  function ensureDummySurfTex() {
    if (_dummySurfTex) return _dummySurfTex;
    _dummySurfTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, _dummySurfTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 1);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    return _dummySurfTex;
  }
  // FIX (perf-regression-terrain-geomorph-default-off-plus-gl-errors-investigation, SAME bug class, 3rd
  // instance): uSceneTex (sampler2D, TEXTURE9) is declared+active in the shared terrain/water program
  // (terrain.glsl) but its uniform1i + texture bind ONLY happen inside the water color-pass block (which
  // runs AFTER the terrain draw, and is itself gated behind `if (!_waterHidden)` -- can be skipped
  // entirely on a given frame). _sceneCopyTex starts null and is lazily created by ensureSceneCopy(),
  // called only from that same water block. So on the TERRAIN draw itself (the first draw of the shared
  // program each frame) unit 9 can hold nothing at all -- live-confirmed as the still-firing residual
  // INVALID_OPERATION on drawElementsInstanced at the terrain draw (gl-render.js render()) after the
  // uSurfAlb/uSurfNrm fix above eliminated the water-visibility-probe instance of this same bug class.
  // Same fix shape: a small dummy TEXTURE_2D (matching uSceneTex's sampler2D type, not 2D_ARRAY) bound to
  // unit 9 and the uniform pinned unconditionally BEFORE the terrain draw; the water block's own later
  // bind of the real _sceneCopyTex/_hrwColor on frames that need it is unaffected (it always re-binds).
  let _dummySceneTex = null;
  function ensureDummySceneTex() {
    if (_dummySceneTex) return _dummySceneTex;
    _dummySceneTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, _dummySceneTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return _dummySceneTex;
  }
  // ===== ATMOSPHERE TRANSMITTANCE LUT (Bruneton-lite precomputed transmittance) =====
  // Baked ONCE at init (CPU-side, atmosphere-transmittance-lut.js -- pure analytic optical-
  // depth march at high step-count, no GPU dependency) and uploaded as an RGB32F 2D texture.
  // Replaces atmosphere.glsl's atm_transmittanceToSun's runtime 4-step trapezoid march (called
  // up to 8x per sky pixel from inside atm_marchRadiance's own per-sample loop) with a single
  // texture sample. atm_transmittanceSeg/atm_opticalDepth themselves are UNCHANGED and stay in
  // use for the camera-to-sample transmittance inside atm_marchRadiance (a different, shorter-
  // segment quantity a single top-of-atmosphere LUT does not directly encode -- see the LUT
  // module's own header comment; scattering-LUT + aerial-perspective are explicit follow-ups).
  // Pinned to TEXTURE0+TU.transmittanceLUT unconditionally every frame across all three programs
  // that carry atmosphere.glsl in their FS (render/debug/probe) -- same "always bound, never an
  // empty unit" discipline as the shadow/heightPool dummies above (AGENTS.md documents the exact
  // GL_INVALID_OPERATION class an unconditionally-declared-but-sometimes-unbound sampler causes).
  let _lutTex = null;
  let _rawTransLUT = null; // {data,width,height} kept RAW (not the RGBA-repacked upload buffer) so ensureScatteringLUT can reuse the exact same bake for its inner-loop transmittance sampling instead of re-baking (see atmosphere-scattering-lut.js's perf note: sharing one transmittance bake vs re-baking a 2nd one saves ~1.5s of eager-init CPU time).
  function ensureTransmittanceLUT() {
    if (_lutTex) return _lutTex;
    if (!_sharedRawTransLUT) {
      if (typeof window !== 'undefined') window.__lutBakeCount = (window.__lutBakeCount || 0) + 1;
      _sharedRawTransLUT = bakeTransmittanceLUT(LUT_WIDTH, LUT_HEIGHT);
    }
    const { data, width, height } = _sharedRawTransLUT;
    _rawTransLUT = { data, width, height };
    // RGBA32F, not RGB32F: live-witnessed on real hardware (ANGLE/D3D11) that RGB32F is NOT
    // framebuffer-color-attachable (gl.checkFramebufferStatus -> FRAMEBUFFER_INCOMPLETE_ATTACHMENT)
    // even with EXT_color_buffer_float present, while RGBA32F IS (a real, common WebGL2 spec gap --
    // 3-component float formats are frequently excluded from the color-renderable set). Sampling via
    // texture() in a shader would have worked fine either way (that restriction is rendering-TO the
    // format, not reading FROM it), but RGBA32F is the more broadly hardware-safe/diagnosable choice
    // (readback/FBO-blit tooling, future debug views) for one wasted alpha channel.
    const dataRGBA = new Float32Array(width * height * 4);
    for (let i = 0, n = width * height; i < n; i++) {
      dataRGBA[i*4] = data[i*3]; dataRGBA[i*4+1] = data[i*3+1]; dataRGBA[i*4+2] = data[i*3+2]; dataRGBA[i*4+3] = 1.0;
    }
    _lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, _lutTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, dataRGBA);
    const lin = _halfFloatLinearOK ? gl.LINEAR : gl.NEAREST; // RGBA32F LINEAR needs OES_texture_float_linear
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, lin);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    // Expose {width,height,floatLinearOK,tex} for live diagnostics/witness (e.g. a direct GPU-side
    // readback via a throwaway FBO) -- the texture OBJECT itself, not just its bake metadata, since a
    // diagnostic running outside a render() frame cannot otherwise recover which unit/object to read.
    try { if (typeof window !== 'undefined') window.__atmLutBaked = { width, height, floatLinearOK: _halfFloatLinearOK, tex: _lutTex }; } catch(_){}
    return _lutTex;
  }
  // ===== ATMOSPHERE SCATTERING LUT (Bruneton-lite precomputed single-scatter in-scattered radiance) =====
  // Baked ONCE at init (CPU-side, atmosphere-scattering-lut.js), depends on the transmittance LUT
  // already existing (its own inner march bilinearly samples the transmittance bake instead of
  // re-marching it, the load-bearing perf fix documented in that module -- 91.7s naive re-march vs
  // ~1-2s LUT-sampled, live-measured this session). Uploaded as an RGBA32F sampler2DArray: rgb =
  // Rayleigh in-scatter density, a = Mie in-scatter density (kept separate per-channel exactly like
  // the bake module, since the runtime phase-function multiply is wavelength-dependent for Rayleigh
  // but not Mie -- collapsing them pre-emptively would lose that split). Layers = sun-angle-cosine
  // (muS) bins, mirroring the hpfPool/heightPool sampler2DArray convention already used in this file
  // (a real 3D texture would need texStorage3D+an extra interpolated axis for no accuracy benefit
  // over per-layer bilinear + nearest-layer/manual-lerp-across-layers, matching how this codebase
  // already treats its other 3-axis-ish bakes as arrays, not 3D textures).
  let _scatTex = null;
  function ensureScatteringLUT() {
    if (_scatTex) return _scatTex;
    ensureTransmittanceLUT(); // guarantees _rawTransLUT is populated before the scattering bake needs it
    if (!_sharedRawScatLUT) {
      _sharedRawScatLUT = bakeScatteringLUT(SCAT_LUT_WIDTH, SCAT_LUT_HEIGHT, SCAT_LUT_LAYERS, undefined, _rawTransLUT);
    }
    const { data, width, height, layers } = _sharedRawScatLUT;
    _scatTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, _scatTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA32F, width, height, layers);
    // WebGL2 spec forbids UNPACK_FLIP_Y_WEBGL/UNPACK_PREMULTIPLY_ALPHA_WEBGL (INVALID_OPERATION) on
    // any TEXTURE_3D/TEXTURE_2D_ARRAY upload -- gl is a context shared with the host page's own
    // renderer, which can leave either flag set true. Reset both before this raw typed-array upload.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, width, height, layers, gl.RGBA, gl.FLOAT, data);
    const lin = _halfFloatLinearOK ? gl.LINEAR : gl.NEAREST; // RGBA32F LINEAR needs OES_texture_float_linear, same gate as the transmittance LUT
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, lin);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, lin);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    // Expose {width,height,layers,floatLinearOK,tex} for live diagnostics/witness -- same pattern as
    // window.__atmLutBaked above, the property this task's own live-witness dispatch checks for.
    try { if (typeof window !== 'undefined') window.__atmScatteringLutBaked = { width, height, layers, floatLinearOK: _halfFloatLinearOK, tex: _scatTex }; } catch(_){}
    return _scatTex;
  }
  // Bake+upload EAGERLY here (not purely lazy on first render()/probe draw): guarantees the texture
  // object exists before ANY draw call that might bind it, including a collision probe draw that
  // could in principle run before the first render() frame. Called here (rather than right after the
  // render program links, ~line 219) because ensureTransmittanceLUT reads _halfFloatLinearOK (const,
  // defined just above this point) -- calling it earlier throws a TDZ ReferenceError (caught the hard
  // way: window.__atmLutBaked stayed null through a full live browser witness pass with zero visible
  // page/GL errors, since the throw landed inside this async initMapspinnerRender before any caller-
  // side try/catch could surface it as __pageErr). The bake itself is pure CPU computation (no GL
  // calls) -- see atmosphere-transmittance-lut.js -- so this adds no GPU/driver cost to the cold-
  // compile critical path, only a few ms of JS math + one texture upload.
  ensureTransmittanceLUT();
  // Scattering LUT bakes AFTER the transmittance LUT (same eager-at-init discipline, same TDZ
  // ordering constraint on _halfFloatLinearOK) -- costs ~1-2s of additional synchronous CPU time
  // at init (live-measured this session), same order of magnitude as the transmittance LUT's own
  // ~1.5s bake this codebase already accepts eagerly; not deferred to first-render since the probe
  // program (collision) can in principle draw before the first render() frame, same rationale as
  // the transmittance LUT's own eager call above.
  ensureScatteringLUT();
  // TEXTURE-BIND DIRTY-CACHE (perf, 2026-07-08): _hpfTex/_hpfTex2/_surfAlb/_surfNrm are each assigned
  // EXACTLY ONCE (setHpf() on HPF-bake completion; the async surface-texture loader) and then held as
  // the SAME WebGLTexture object for the rest of the session -- identical shape to the shadowInfo.texture
  // case above. render() was re-doing activeTexture+bindTexture EVERY single frame regardless, an
  // unconditional driver round-trip x4/frame for state that (on the overwhelmingly common frame) never
  // changes. Track the last-bound object per unit and skip JUST the activeTexture+bindTexture pair when
  // unchanged. The uniform1i sampler-unit assignment stays SEPARATE (program-scoped GL state, unlike the
  // texture-unit bind which is global) -- routed through _chuSet1i at each call site so it still uploads
  // once per program even on a frame where the texture-bind itself is skipped (e.g. right after a
  // hot-reload swaps in a fresh program with unset sampler uniforms, while the bound texture object is
  // unchanged).
  let _lastHpfTex = null, _lastHpfTex2 = null, _lastSurfAlb = null, _lastSurfNrm = null;
  function _chuSet1f(loc, key, name, v){
    let m = _chuCache.get(key); if (!m){ m=new Map(); _chuCache.set(key,m); }
    if (m.get(name) === v) return;
    m.set(name, v); gl.uniform1f(loc(name), v);
  }
  function _chuSet1i(loc, key, name, v){
    let m = _chuCache.get(key); if (!m){ m=new Map(); _chuCache.set(key,m); }
    if (m.get(name) === v) return;
    m.set(name, v); gl.uniform1i(loc(name), v);
  }
  // MULTI-COMPONENT dirty-cache (perf, 2026-07-06): same skip-if-unchanged idiom as _chuSet1f/1i, extended
  // to vec2/vec3 uniforms. Packs the components into one comparable numeric key (avoids allocating a
  // fresh array/string every frame just to compare) -- collision-free for the finite float range these
  // uniforms carry (colors 0..~2, distances/metres, band edges) since it's a pure equality check, not a hash.
  function _chuSet2f(loc, key, name, x, y){
    let m = _chuCache.get(key); if (!m){ m=new Map(); _chuCache.set(key,m); }
    const prev = m.get(name);
    if (prev !== undefined && prev[0] === x && prev[1] === y) return;
    m.set(name, [x,y]); gl.uniform2f(loc(name), x, y);
  }
  function _chuSet3f(loc, key, name, x, y, z){
    let m = _chuCache.get(key); if (!m){ m=new Map(); _chuCache.set(key,m); }
    const prev = m.get(name);
    if (prev !== undefined && prev[0] === x && prev[1] === y && prev[2] === z) return;
    m.set(name, [x,y,z]); gl.uniform3f(loc(name), x, y, z);
  }
  function _chuSet4f(loc, key, name, x, y, z, w){
    let m = _chuCache.get(key); if (!m){ m=new Map(); _chuCache.set(key,m); }
    const prev = m.get(name);
    if (prev !== undefined && prev[0] === x && prev[1] === y && prev[2] === z && prev[3] === w) return;
    m.set(name, [x,y,z,w]); gl.uniform4f(loc(name), x, y, z, w);
  }
  // ONE SOURCE OF TRUTH for composeHeight's shape-control + HPF-sampler uniforms: every program that runs
  // composeHeight (render, _PROBE_) calls this with its own uniform-locator so they CANNOT diverge.
  // `cacheKey` identifies which program's uniform state this call targets (BU/PU are each a single
  // stable program so the locator itself is a safe key; U() is DYNAMIC -- it resolves against
  // whichever program is active this frame (render prog or the debug prog), so callers through U()
  // MUST pass the actual active uniform-location cache as cacheKey, not U itself, or a debug-mode
  // frame would wrongly skip re-uploading onto a different real GL program).
  function setComposeHeightUniforms(loc, cacheKey) {
    if (cacheKey === undefined) cacheKey = loc;
    const g = (n,d)=> (typeof window!=='undefined' && window['__'+n]!=null) ? +window['__'+n] : d;
    _chuSet1f(loc, cacheKey, 'uHiFreqCut',     g('hiFreqCut', TD.hiFreqCut));   // DECISIVE: ungated *= at terrain.glsl fine octaves; 0.5->0.25 (2026-06-10 'blotchy': the 4x fine band read as leopard dapple at altitude -- live-isolated, hiFreqCut=0 removed it entirely)
    _chuSet1f(loc, cacheKey, 'uDetailOverlay', g('detailOverlay', TD.detailOverlay));  // perlin-everywhere ELEVATION term in composeHeight -- probe must match the VS or collision diverges
    // (vtxDetail probe setter removed 2026-06-18 -- vtxDisplace is a 0.0 stub, the uniform is gone.)
    _chuSet1f(loc, cacheKey, 'canyonDepthMul', g('canyonDepth', TD.canyonDepth));   // TD.canyonDepth=1.0 (demo baked __canyonDepth=0 -> shader floors to 1.0). DEFAULT MUST MATCH the render set (line ~982) or the _PROBE_ collision carves shallower than the rendered geometry. Kept 2.0 so a warm tab (module-cached gl-render) and a fresh load are CONSISTENT -- the canyon-intensity cut now lives in CANYON_INCISE_DEPTH (terrain.glsl, cache-busted = reliably delivered; gl-render is NOT cache-busted on a soft reload). LIVE fine-tune via window.__canyonDepth.
    _chuSet1f(loc, cacheKey, 'uVsCheap',       (typeof window!=='undefined' && window.__vsCheap) ? 1.0 : 0.0);   // VS carve-cost profiling A/B
    _chuSet1f(loc, cacheKey, 'uBeachShelfM',   g('beachShelf', TD.beachShelf));   // land coastal shelf (geometry); probe MUST match render
    _chuSet1f(loc, cacheKey, 'uLandBias',      g('landBias', TD.landBias));       // hypsometry bias = ~+30% land:sea (measured: landFrac 0.041 -> 0.054 over a 700-dir sphere grid, user 2026-06-14). window.__landBias dials it live.
    _chuSet1f(loc, cacheKey, 'cliffAmt',       g('cliffAmt', TD.cliffAmt));
    _chuSet1i(loc, cacheKey, 'uFloatLinearOK', _halfFloatLinearOK ? 1 : 0);
    // FXC unroll-defeat (2026-06-12 AMD d3d11 fix): runtime octave bound for broadShapeM; the shader
    // guards uOctMax<=0 -> 12, so this set is belt-and-braces. Live dial: window.__octMax.
    _chuSet1i(loc, cacheKey, 'uOctMax',        (typeof window!=='undefined' && window.__octMax!=null) ? (window.__octMax|0) : _clampOcts(12));   // altitude-clamped (see _clampOcts); explicit window.__octMax still wins
    _chuSet1i(loc, cacheKey, 'uNoUnroll',      64);   // FXC anti-unroll for the NoiseLayer const-numOct loops (value_fbm/value_ridged_fbm_rot); runtime-opaque bound, 64 > every layer's numOct so value semantics are unchanged. See terrain.glsl uNoUnroll comment + scripts/needle-ab.mjs.
    _chuSet1i(loc, cacheKey, 'uInciseRidgeOcts', (typeof window!=='undefined' && window.__inciseRidgeOcts!=null) ? (window.__inciseRidgeOcts|0) : 4);
    _chuSet1i(loc, cacheKey, 'uBroadLowOcts',    (typeof window!=='undefined' && window.__broadLowOcts!=null) ? (window.__broadLowOcts|0) : 2);   // 8->2 PERF (2026-06-15): MEASURED 0 visual error (mtn+space) -- broadShapeLowM only feeds the 2400m-FD-step mesa-flatness slope gate, which is low-freq so the high octaves do nothing (its elevation-AO consumer was removed).
    _chuSet1i(loc, cacheKey, 'uPeakOcts',        (typeof window!=='undefined' && window.__peakOcts!=null) ? (window.__peakOcts|0) : 3);
    // (uVtxBaseOcts/uVtxErodeOcts probe setters removed 2026-06-18 -- vtxDisplace is a 0.0 stub, the uniforms are gone.)
    _chuSet1i(loc, cacheKey, 'uDetailFbmOcts',   (typeof window!=='undefined' && window.__detailFbmOcts!=null) ? (window.__detailFbmOcts|0) : 3);
    _chuSet1i(loc, cacheKey, 'uFSDetailOcts',    (typeof window!=='undefined' && window.__fsDetailOcts!=null) ? (window.__fsDetailOcts|0) : 3);
    // FXC fold-defeat (2026-06-12, the rock-on-flat patches): the lit-normal FD step is uniform-fed
    // so d3d11/FXC cannot constant-fold the 150/R offset. Live dial: window.__nrmStepM.
    _chuSet1f(loc, cacheKey, 'uNrmStepM',      g('nrmStepM', 300.0));
    _chuSet1f(loc, cacheKey, 'uGrid',          GRID);
    _chuSet1f(loc, cacheKey, 'uHpfInset',      (typeof window!=='undefined' && window.__hpfInset === false) ? 0.0 : 1.0);   // SEAM FIX: inset sampler is the permanent default (matches bakeFace fu=x/(RES-1)); window.__hpfInset===false rolls back
    // ANCHOR-STEP A/B TOGGLES (per-area stairstep, wrxo0rr7a). Default 0 = current; set window.__<name>=1
    // to widen that anchor-keyed band. Set HERE so BOTH render and the _PROBE_ collision see them (parity).
    _chuSet1f(loc, cacheKey, 'uMtnBandWide',   g('mtnBandWide', TD.mtnBandWide));
    _chuSet1f(loc, cacheKey, 'uClimateRelief', g('climateRelief', TD.climateRelief));
    _chuSet1f(loc, cacheKey, 'uIsleWide',      g('isleWide', TD.isleWide));
    _chuSet1f(loc, cacheKey, 'uCarveWide',     g('carveWide', TD.carveWide));
    // SCALE-INVARIANT relief (2026-06-17): the fractal relief is tuned in absolute metres at the 6360km
    // DESIGN radius. Scale it by R/6360km so the GEOMETRY is proportional to whatever radius a consumer
    // passes -> any radius renders identically (the dev demo at 6360km => exactly 1.0 = no-op), while the
    // camera/LOD/collision use the real R. Set on BOTH render + _PROBE_ here so the rendered mesh and the
    // collision probe scale together (else the camera clamps to an unscaled surface).
    _chuSet1f(loc, cacheKey, 'uReliefScale',   g('reliefScale', opts.reliefScale != null ? opts.reliefScale : R / 63600000.0));   // default R/63600000 (10x smaller than Earth-geometry default) gives ~350m peak relief at 6360m radius
    // GPU-VISIBLE SCULPT-BRUSH OVERRIDE uniforms (see composeHeight's sculptOverrideAt in terrain.glsl
    // + setSculptOverride/ensureSculptTex above). Bound through the SAME cacheKey-memoized _chuSet path
    // as every other compose-height uniform so render + probe/bake programs never diverge, and the
    // sampler unit is pinned EVERY frame (dummy fallback when inactive) exactly like uHeightPool's own
    // documented "never leave a sampler unit unbound" discipline just above.
    const sc = _sculptState;
    _chuSet1f(loc, cacheKey, 'uSculptActive', sc ? 1.0 : 0.0);
    if (sc) {
      _chuSet3f(loc, cacheKey, 'uSculptUp',    sc.up[0], sc.up[1], sc.up[2]);
      _chuSet3f(loc, cacheKey, 'uSculptEast',  sc.east[0], sc.east[1], sc.east[2]);
      _chuSet3f(loc, cacheKey, 'uSculptNorth', sc.north[0], sc.north[1], sc.north[2]);
      _chuSet2f(loc, cacheKey, 'uSculptCenter', sc.center[0], sc.center[1]);
      _chuSet1f(loc, cacheKey, 'uSculptExtent', sc.extent);
    }
    _chuSet1i(loc, cacheKey, 'uSculptOverride', TU.sculptOverride);
    gl.activeTexture(gl.TEXTURE0 + TU.sculptOverride);
    gl.bindTexture(gl.TEXTURE_2D, sc ? ensureSculptTex() : ensureDummySculptTex());
  }


  // ---- SURFACE PHOTO-TEXTURES (user 2026-06-10): grass/rock/sand/snow color + displacement JPGs
  // from /textures, packed into two mipped sampler2DArrays. Normals are SOBEL-DERIVED from the
  // displacement at load (3x3, WRAPPED edges -- the textures tile, so the kernel must wrap or the
  // tile border gets a seam line). uSurfAlb = sRGB color (RGB) + displacement (A, linear alpha);
  // uSurfNrm = tangent normal xy 0.5-biased (RG) + displacement (B). Loaded ASYNC off the cold
  // startup path; uHasSurfTex stays 0 (procedural-only) until the upload lands.
  let _surfAlb = null, _surfNrm = null, _surfMeanL = [0.2, 0.2, 0.2, 0.5];
  // 8-bit -> linear LUT (perf sweep 2026-06-11): gamma-2.2 on an 8-bit input has exactly 256 values;
  // the per-pixel Math.pow de-shade/mean passes were ~30M transcendental calls = ~0.5s+ of main-thread
  // long tasks per load. The LUT is bit-identical for every 8-bit input.
  const LIN8 = new Float32Array(256);
  for (let v = 0; v < 256; v++) LIN8[v] = Math.pow(v / 255, 2.2);
  async function _decodeSurfaceTextures() {
    const MATS = ['grass', 'rock', 'sand', 'snow'];   // layer order: matches terrain.glsl splat
    // Normal JPG filenames per material (null = derive from displacement via Sobel)
    const NRM_JPGS = ['grass-normals.jpg', 'ground-normals.jpg', 'sand-normals.jpg', 'snow-normals.jpg'];
    const SZ = 1024;
    // WORKER-SAFE DECODE (surface-texture-decode.js): fetch+createImageBitmap+OffscreenCanvas, no
    // document/Image -- works identically on the main thread and inside a Worker. crossOrigin: fetch()
    // defaults to CORS mode for a cross-origin URL (e.g. a consumer loading the SDK from unpkg), same
    // intent as the old img.crossOrigin='anonymous'; unpkg serves Access-Control-Allow-Origin:*.
    const px = async (u) => (await decodeImageToPixels(u, SZ, SZ)).data;
    const albAll = new Uint8Array(SZ * SZ * 4 * MATS.length);
    const nrmAll = new Uint8Array(SZ * SZ * 4 * MATS.length);
    for (let m = 0; m < MATS.length; m++) {
      const _tex = (n) => new URL('../textures/' + n, import.meta.url).href   // EMBEDDABLE: module-relative, not page-relative
      const [c, d, nj] = await Promise.all([px(_tex(MATS[m] + '-color.jpg')), px(_tex(MATS[m] + '-displacement.jpg')), px(_tex(NRM_JPGS[m])).catch(() => null)]);
      // DE-SHADE (user 2026-06-11 'flat, unangled bowls of rock'): the photos carry baked large-scale
      // shading (shadowed depressions), which at a 2.4km tile pastes bowl-shaped shadows onto geometry
      // with no matching shape. Divide each pixel by a wrapped-bilinear 32x32 blur of the photo's own
      // linear luminance (renormalized to the photo mean) -- kills the bowl-scale light, keeps detail.
      // PER-CHANNEL (user 2026-06-11 'rocky patches on flat ground, no steep slopes': the grass
      // photo carries large grey-brown bare-dirt patches that differ in CHROMA, not just luminance;
      // at the 2.4km tile they become hundred-metre grey blotches that read as rock. Per-channel
      // division flattens large-scale COLOR blotches too; fine grain untouched.)
      { const G = 32, cell = SZ / G, grid = new Float32Array(G * G * 3), cnt = cell * cell;
        const lin = (v) => LIN8[v], delin = (v) => Math.pow(v, 1 / 2.2) * 255;
        for (let y = 0; y < SZ; y++) for (let x = 0; x < SZ; x++) {
          const i = (y * SZ + x) * 4, g = (((y / cell) | 0) * G + ((x / cell) | 0)) * 3;
          grid[g] += LIN8[c[i]]; grid[g + 1] += LIN8[c[i + 1]]; grid[g + 2] += LIN8[c[i + 2]];
        }
        const gMean = [0, 0, 0];
        for (let g = 0; g < G * G; g++) for (let ch = 0; ch < 3; ch++) { grid[g * 3 + ch] /= cnt; gMean[ch] += grid[g * 3 + ch]; }
        for (let ch = 0; ch < 3; ch++) gMean[ch] /= G * G;
        for (let y = 0; y < SZ; y++) for (let x = 0; x < SZ; x++) {
          const gx = x / cell - 0.5, gy = y / cell - 0.5;
          const x0 = (Math.floor(gx) + G) % G, y0 = (Math.floor(gy) + G) % G;
          const x1 = (x0 + 1) % G, y1 = (y0 + 1) % G;
          const fx = gx - Math.floor(gx), fy = gy - Math.floor(gy);
          const i = (y * SZ + x) * 4;
          for (let ch = 0; ch < 3; ch++) {
            const blur = (grid[(y0 * G + x0) * 3 + ch] * (1 - fx) + grid[(y0 * G + x1) * 3 + ch] * fx) * (1 - fy)
                       + (grid[(y1 * G + x0) * 3 + ch] * (1 - fx) + grid[(y1 * G + x1) * 3 + ch] * fx) * fy;
            // pow 0.8: stronger than the old 0.65 luma-only pass -- the patches must GO; fine
            // (sub-64px) structure is untouched by construction.
            const s = Math.min(2.5, Math.max(0.4, Math.pow(gMean[ch] / Math.max(blur, 1e-4), 0.8)));
            // FINE-CONTRAST RESTORE (user 2026-06-11 'grass texture... not on grassy areas'): the
            // de-shade flattened large blotches but also left flats reading textureless once the
            // shade-match lands the average on the macro color. Stretch the remaining (fine-grain)
            // deviation around the channel mean x1.35 so the texture stays visible on flat ground.
            const v = lin(c[i + ch]) * s;
            c[i + ch] = Math.min(255, Math.max(0, Math.round(delin(Math.max(0, gMean[ch] + (v - gMean[ch]) * 1.35)))));
          }
        }
      }
      // yield between the de-shade and Sobel passes too (perf sweep 2026-06-11): one material was a
      // single contiguous main-thread block; splitting halves the worst long task.
      await new Promise(res => setTimeout(res, 0));
      const base = m * SZ * SZ * 4;
      if (nj) {
        // Use artist-authored normal JPG directly (RG = tangent XY 0.5-biased, standard normal map format)
        for (let i = 0; i < SZ * SZ; i++) {
          const o = base + i * 4;
          albAll[o] = c[i * 4]; albAll[o + 1] = c[i * 4 + 1]; albAll[o + 2] = c[i * 4 + 2]; albAll[o + 3] = d[i * 4];
          nrmAll[o] = nj[i * 4]; nrmAll[o + 1] = nj[i * 4 + 1]; nrmAll[o + 2] = d[i * 4]; nrmAll[o + 3] = 255;
        }
      } else {
        // Derive normals from displacement via multi-scale Sobel (fallback when no normals JPG)
        const S = 2.2;
        for (let y = 0; y < SZ; y++) {
          const ym = (y + SZ - 1) % SZ, yp = (y + 1) % SZ;
          for (let x = 0; x < SZ; x++) {
            const xm = (x + SZ - 1) % SZ, xp = (x + 1) % SZ;
            const i = y * SZ + x, o = base + i * 4;
            const r = (X, Y) => d[(Y * SZ + X) * 4];
            const gx = (r(xp, ym) + 2 * r(xp, y) + r(xp, yp) - r(xm, ym) - 2 * r(xm, y) - r(xm, yp)) / (8 * 255);
            const gy = (r(xm, yp) + 2 * r(x, yp) + r(xp, yp) - r(xm, ym) - 2 * r(x, ym) - r(xp, ym)) / (8 * 255);
            const x6p = (x + 6) % SZ, x6m = (x + SZ - 6) % SZ, y6p = (y + 6) % SZ, y6m = (y + SZ - 6) % SZ;
            const gx2 = (r(x6p, y) - r(x6m, y)) / (2 * 255), gy2 = (r(x, y6p) - r(x, y6m)) / (2 * 255);
            const x48p = (x + 48) % SZ, x48m = (x + SZ - 48) % SZ, y48p = (y + 48) % SZ, y48m = (y + SZ - 48) % SZ;
            const gx3 = (r(x48p, y) - r(x48m, y)) / (2 * 255), gy3 = (r(x, y48p) - r(x, y48m)) / (2 * 255);
            let nx = -(gx * S + gx2 * 2.5 + gx3 * 2.0), ny = -(gy * S + gy2 * 2.5 + gy3 * 2.0);
            const tm = Math.hypot(nx, ny);
            if (tm > 0.9) { nx *= 0.9 / tm; ny *= 0.9 / tm; }
            const il = 1 / Math.hypot(nx, ny, 1);
            albAll[o] = c[i * 4]; albAll[o + 1] = c[i * 4 + 1]; albAll[o + 2] = c[i * 4 + 2]; albAll[o + 3] = d[i * 4];
            nrmAll[o] = Math.round((nx * il * 0.5 + 0.5) * 255);
            nrmAll[o + 1] = Math.round((ny * il * 0.5 + 0.5) * 255);
            nrmAll[o + 2] = d[i * 4]; nrmAll[o + 3] = 255;
          }
        }
      }
      await new Promise(res => setTimeout(res, 0));
    }
    // mean LINEAR color of the rock photo (layer 1): the far-field macro bcRock defaults to this so
    // the >20km rock shade matches the near-field photo rock (no color pop across the fade).
    let rockMean;
    { let r = 0, g = 0, b = 0; const base = 1 * SZ * SZ * 4, n = SZ * SZ;
      for (let i = 0; i < n; i++) { r += albAll[base + i * 4]; g += albAll[base + i * 4 + 1]; b += albAll[base + i * 4 + 2]; }
      const lin = (v) => Math.pow(v / n / 255, 2.2);
      rockMean = [lin(r), lin(g), lin(b)];
    }
    // mean LINEAR luminance per layer (user 2026-06-11 'terrain gets darker' + 'dont see grass/snow
    // textures'): the shader shade-matches the photo by dividing out its LAYER-MEAN luminance (not
    // per-pixel, which cancelled all structure; not raw photo, which shifted the shade).
    const meanL = [0, 0, 0, 0];
    for (let m = 0; m < MATS.length; m++) {
      let s = 0; const base = m * SZ * SZ * 4, n = SZ * SZ;
      for (let i = 0; i < n; i++) {
        s += 0.2126 * LIN8[albAll[base + i * 4]] + 0.7152 * LIN8[albAll[base + i * 4 + 1]] + 0.0722 * LIN8[albAll[base + i * 4 + 2]];
      }
      meanL[m] = s / n;
    }
    return { albAll, nrmAll, meanL, rockMean, matCount: MATS.length, sz: SZ };
  }

  async function loadSurfaceTextures() {
    if (!_sharedSurfaceTexDecode) _sharedSurfaceTexDecode = _decodeSurfaceTextures();
    const { albAll, nrmAll, meanL, rockMean, matCount, sz } = await _sharedSurfaceTexDecode;
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    function mkArray(data, internal) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 11, internal, sz, sz, matCount);   // 11 = full 1024 mip chain
      // WebGL2 spec forbids UNPACK_FLIP_Y_WEBGL/UNPACK_PREMULTIPLY_ALPHA_WEBGL (INVALID_OPERATION) on
      // any TEXTURE_3D/TEXTURE_2D_ARRAY upload. gl is a context shared with the host page's own
      // renderer (THREE.js), which routinely sets either flag true while uploading its own 2D image
      // textures -- reset both unconditionally before this raw typed-array upload.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, sz, sz, matCount, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
      if (aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      return t;
    }
    _surfMeanL = meanL;
    if (typeof window !== 'undefined') { window.__surfMeanL = meanL; window.__surfRockMean = rockMean; }
    _surfAlb = mkArray(albAll, gl.SRGB8_ALPHA8);   // sRGB decode in hardware (color); A (displacement) stays linear
    _surfNrm = mkArray(nrmAll, gl.RGBA8);          // normals/displacement are data, NOT color -> linear
    if (typeof window !== 'undefined') window.__surfTexReady = true;
  }
  // canDecodeImages(): true on the main thread AND inside a Worker (createImageBitmap+
  // OffscreenCanvas), false only in a plain Node process with neither -- was `typeof document`,
  // which unconditionally skipped this whole call inside a worker even though the decode itself is
  // now worker-safe (offscreencanvas-worker-safe-texture-loading).
  if (canDecodeImages()) {
    loadSurfaceTextures().catch(e => { try { if (typeof window !== 'undefined') window.__surfTexErr = String(e.message || e); else if (typeof self !== 'undefined') self.__surfTexErr = String(e.message || e); } catch (_) {} });
  }

  // ---- fullscreen SKY pass program (atmospheric limb/halo behind the terrain) ----
  // VS emits a fullscreen triangle; FS reconstructs the world-space view ray from the
  // inverse view-projection and calls atm_skyRadiance. Drawn before terrain (depth
  // writes off) so terrain overdraws where the planet is, leaving sky on the limb.
  const skyVsSrc = hdr + `out vec2 vNdc;
    void main(){ vec2 p = vec2((gl_VertexID==1)?3.0:-1.0, (gl_VertexID==2)?3.0:-1.0);
      vNdc = p; gl_Position = vec4(p, 1.0, 1.0); }`;
  const skyFsSrc = hdr + atmoSrc + `
    in vec2 vNdc;
    layout(location=0) out vec4 fragColor;
    uniform mat3 camRot;        // world<-view rotation (columns = view basis in world)
    uniform vec2 projDiag;      // (proj[0][0], proj[1][1]) for NDC->view-ray
    uniform vec3 skyCamWorld;   // camera world pos (meters)
    uniform vec3 skySunDir;     // world sun dir (normalized)
    uniform float skyR;         // sphere radius (meters)
    uniform float uSkyFade;     // 1 at surface, 0 at 100km
    uniform float uSkyDbg;      // sky-FS intermediate readout: 0=off 1=raw radiance 2=post-bias*exposure(c) 3=ACES-mapped
    void main(){
      // Reconstruct the world-space view ray from NDC, like the WebGPU skyFs: undo the
      // projection (divide by the proj diagonal) to get a view-space dir, then rotate
      // into world with the camera basis. Robust (no near-far matrix inverse).
      vec3 dirView = normalize(vec3(vNdc.x/projDiag.x, vNdc.y/projDiag.y, -1.0));
      vec3 viewRay = normalize(camRot * dirView);
      vec3 camAtm = atmPos(skyCamWorld, skyR);
      vec3 t;
      vec3 radiance = atm_skyRadiance(camAtm, viewRay, skySunDir, t);

      // ---- Explicit limb/halo glow (guarantees a visible atmosphere ring from orbit).
      // The physical single-scatter limb is sub-pixel thin at orbital range, so we add
      // an analytic glow keyed on the ray's IMPACT PARAMETER b = perpendicular distance
      // of the view ray from the planet centre. b in [BOTTOM, ~BOTTOM+halo] -> bright
      // blue rim that fades outward; lit only on the sun-facing side, scaled by a soft
      // forward-scatter term. This is a deliberate visual augmentation of the analytic
      // single-scatter model (documented simplification).
      {
        float rc = length(camAtm);
        float muc = dot(camAtm, viewRay) / rc;
        float b = rc * sqrt(max(1.0 - muc*muc, 0.0)); // impact parameter (km)
        // Only for rays passing in FRONT of the planet (muc<0) and outside the surface.
        float halo = 0.0;
        if (muc < 0.0) {
          float t0 = (b - ATM_BOTTOM) / (ATM_TOP - ATM_BOTTOM);  // 0 at surface -> 1 at top
          // Inner rim brightest, fading to the shell top; zero below surface / above top.
          halo = smoothstep(0.0, 0.06, t0) * (1.0 - smoothstep(0.25, 1.6, t0));
        }
        // Daylight side weighting from the sun's relation to the limb point direction.
        vec3 limbDir = normalize(camAtm + viewRay * (-rc*muc)); // closest-approach dir
        // Day-side rim brightest; keep a small floor so the whole ring stays visible.
        float lit = 0.25 + 0.75 * smoothstep(-0.5, 0.6, dot(limbDir, skySunDir));
        vec3 haloColor = vec3(0.32, 0.55, 1.0);  // Rayleigh-blue rim
        radiance += haloColor * (halo * lit) * 0.03;
      }
      // Sun disc through the view transmittance.
      float cosVS = dot(viewRay, skySunDir);
      if (cosVS > cos(ATM_SUN_ANGULAR_RADIUS)) {
        radiance += t * ATM_SOLAR_IRRADIANCE * 6.0;   // sun disc
      }
      // The analytic single-scatter radiance is HDR with small magnitudes; lift then
      // ACES tonemap (matches the WebGPU sky pass family). EXPOSURE tuned so the limb
      // glow + daylit sky read as an atmosphere without blowing out.
      // GROUND-LEVEL MIDDAY OVEREXPOSURE (round-3 critic: "blown-out white sky with a thin yellow
      // horizon band instead of a flat hard-lit midday look"): 105 was tuned for the orbital limb
      // halo, where most of the frame is dark space around a thin bright ring -- at ground level with
      // the whole upper hemisphere daylit, that same exposure drives every channel into the ACES
      // curve's flat white shoulder before the post-tonemap saturation push (1.35) has any per-channel
      // headroom left to pull back out, so zenith-to-horizon reads as uniform white instead of the
      // reference's flat-but-legibly-blue Performance-Mode dome. Exposure cut further (105->72) so the
      // daylit dome sits below the shoulder; saturation push raised (1.35->1.6) to compensate and keep
      // the flat, saturated-primary Performance-Mode color (no bloom pass to soften it) rather than a
      // washed pastel. Sun disc/halo terms are unaffected (added post this exposure, still clamp to 1).
      // ROUND-4 FIX (critic: "saturated white-to-yellow gradient wash rather than a flat hard-lit
      // blue midday sky -- round 3's 72.0/1.6 wasn't enough"): the prior approach pushed exposure
      // high enough that R/G/B all independently approach the ACES shoulder together, so by the time
      // the post-tonemap luma-mix saturation runs, per-channel separation is ALREADY destroyed (all
      // channels clipped near 1.0 = white/yellow, not blue) -- no post-hoc saturation multiplier can
      // recover a hue that tonemapping already erased. Fix at the source instead: (1) exposure cut
      // further (72->48) so the daylit dome sits mid-curve, well below the shoulder, preserving
      // per-channel spread through tonemap; (2) a direct pre-tonemap blue-bias (boost B, trim R) on
      // the RAW radiance -- physically what Rayleigh scattering does, and what makes a flat
      // Performance-Mode dome read as legibly BLUE instead of relying on saturation to invent color
      // difference from already-equalized channels.
      // ROUND-5 FIX (found live: the fixed 48.0 constant was tuned specifically for round-4's
      // golden-hour (~8deg) sun elevation; at midday's much higher elevation the raw single-scatter
      // radiance is naturally brighter, so the SAME fixed exposure re-overexposes into the ACES
      // shoulder -- the exact round-3/4 bug recurring at a different sun angle, proving a single
      // constant can never work across the day cycle. Fix at the actual root: scale exposure
      // inversely with sun elevation (dot(skySunDir, local-up)) so a higher sun gets LESS exposure
      // lift, keeping the daylit dome consistently mid-curve at every time of day instead of only
      // the one angle a fixed constant happened to be tuned for.
      // ROUND-7 FOLLOW-UP: 22.0 at zenith was still overexposed live at 56deg elevation (post the
      // separate TimeOfDay sun.position fix, which finally made this angle actually reachable to
      // test) -- lowered the zenith end further so high-sun angles genuinely clear the ACES shoulder.
      float sunElevDot = clamp(dot(skySunDir, normalize(skyCamWorld)), 0.0, 1.0);
      float skyExposure = mix(48.0, 14.0, sunElevDot); // 48 at horizon, 14 at zenith
      vec3 c = radiance * vec3(0.82, 0.95, 1.22) * skyExposure;
      vec3 mapped = clamp((c*(2.51*c+0.03))/(c*(2.43*c+0.59)+0.14), 0.0, 1.0); // ACES
      float skyLum = dot(mapped, vec3(0.2126, 0.7152, 0.0722));
      mapped = clamp(mix(vec3(skyLum), mapped, 1.3), 0.0, 1.0);
      if (uSkyDbg > 0.5) {
        vec3 dbg = radiance;
        if (uSkyDbg < 1.5) dbg = radiance;              // 1: raw single-scatter radiance (linear, no exposure)
        else if (uSkyDbg < 2.5) dbg = c;                // 2: post blue-bias * exposure (linear, pre-ACES)
        else if (uSkyDbg < 3.5) dbg = mapped;            // 3: post-ACES, post-saturation (pre-gamma)
        fragColor = vec4(dbg, 1.0);
        return;
      }
      fragColor = vec4(pow(mapped, vec3(1.0/2.2)) * uSkyFade, 1.0);
    }`;
  function rawShader(type, source){ const s=gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error('sky '+type+': '+gl.getShaderInfoLog(s)); return s; }
  const skyProg = gl.createProgram();
  gl.attachShader(skyProg, rawShader(gl.VERTEX_SHADER, skyVsSrc));
  gl.attachShader(skyProg, rawShader(gl.FRAGMENT_SHADER, skyFsSrc));
  gl.linkProgram(skyProg);
  if(!gl.getProgramParameter(skyProg, gl.LINK_STATUS)) throw new Error('sky link: '+gl.getProgramInfoLog(skyProg));
  const _usloc = new Map();
  const SU = n => { let l = _usloc.get(n); if (l === undefined) { l = gl.getUniformLocation(skyProg, n); _usloc.set(n, l); } return l; };
  const skyVao = gl.createVertexArray();
  // atmosphere.glsl declares uTransmittanceLUT (sampler2D) + uScatteringLUT (sampler2DArray); every
  // GLSL sampler uniform defaults to texture unit 0 until explicitly assigned, and unlike the main/
  // probe programs (gl-render.js ~1972-1980) skyProg never got that assignment -- both samplers sat
  // on unit 0 with DIFFERENT types, which WebGL2 flags as "two textures of different types use the
  // same sampler location" (getProgramInfoLog), failing VALIDATE_STATUS and making every skyProg
  // drawArrays a silent GL_INVALID_OPERATION no-op -- this was the black-sky root cause. Assignment
  // is per-program static state (unlike per-frame texture BINDING to those units), so set once here.
  gl.useProgram(skyProg);
  const skyTransLoc = gl.getUniformLocation(skyProg, 'uTransmittanceLUT');
  if (skyTransLoc) gl.uniform1i(skyTransLoc, TU.transmittanceLUT);
  const skyScatLoc = gl.getUniformLocation(skyProg, 'uScatteringLUT');
  if (skyScatLoc) gl.uniform1i(skyScatLoc, TU.scatteringLUT);

  // ---- VIEWPORT DYNAMIC RESOLUTION (opt-in, window.__vdrs===true): render the scene into a FIXED full-
  // size FBO at a FLEXED gl.viewport, then a fullscreen-quad LINEAR upscale to the canvas. Unlike the
  // canvas-resize render-scale (which reallocates the drawing buffer = a one-frame hitch / "transfer
  // spike"), changing resolution here only changes the VIEWPORT rect + the sampled sub-rect -> NO realloc,
  // NO hitch. The FBO is (re)allocated ONLY when the CANVAS size changes (window resize), never on a
  // resolution change, so window.__vdrsScale can be dialed every frame for smooth space->deck 144 holding.
  // Single-sample MVP (no MSAA in the FBO -> edges alias at rs<=1; a multisample FBO + resolve is the
  // look-preserving follow-up). DEFAULT path (vdrs off) is byte-untouched: scene renders straight to the
  // canvas with the context MSAA. window.__vdrsScale in (0,1] = viewport fraction (the upscale source rect).
  const upVsSrc = '#version 300 es\nprecision highp float;\nout vec2 vUv;\nvoid main(){ vec2 p=vec2((gl_VertexID==1)?3.0:-1.0,(gl_VertexID==2)?3.0:-1.0); vUv=p*0.5+0.5; gl_Position=vec4(p,0.0,1.0); }';
  const upFsSrc = '#version 300 es\nprecision highp float;\nuniform sampler2D uTex;\nuniform vec2 uUvScale;\nin vec2 vUv;\nout vec4 fragColor;\nvoid main(){ fragColor=texture(uTex, vUv*uUvScale); }';
  const upProg = gl.createProgram();
  gl.attachShader(upProg, rawShader(gl.VERTEX_SHADER, upVsSrc));
  gl.attachShader(upProg, rawShader(gl.FRAGMENT_SHADER, upFsSrc));
  gl.linkProgram(upProg);
  if(!gl.getProgramParameter(upProg, gl.LINK_STATUS)) throw new Error('upscale link: '+gl.getProgramInfoLog(upProg));
  const upUTex = gl.getUniformLocation(upProg, 'uTex');
  const upUScale = gl.getUniformLocation(upProg, 'uUvScale');
  // SHARED-DEPTH write program: stamp the planet depth (_vdrsDepth) into the bound (default/MSAA)
  // framebuffer via gl_FragDepth so a consumer scene (e.g. a THREE world) is OCCLUDED by the terrain.
  // A single-sample -> MSAA blitFramebuffer of DEPTH is GL_INVALID_OPERATION (the canvas is commonly
  // MSAA), so the previous blit silently failed and nothing was occluded -- this shader pass writes
  // per-fragment depth and is MSAA-safe. uDepthBias pushes depth away to avoid z-fight with geometry ON
  // the surface. Full-screen triangle reuses upVsSrc (vUv).
  // uUvScale MUST mirror the color upscale pass's subregion mapping (upFsSrc samples
  // vUv*uUvScale): when VDRS flexes the viewport below full size (__vdrs===true, scale<1),
  // _vdrsDepth's active content lives in the [0..scale] subregion -- sampling it with the raw
  // full-range vUv stamped depth from the WRONG texels (stretched subregion + stale texels from
  // frames when the viewport was larger), so a consumer scene depth-tested against garbage.
  // RE-ENCODE, not a raw copy: a non-linear GL depth value is only meaningful under the near/far pair
  // that produced it (z_ndc = (f+n)/(f-n) + (1/z_eye)*(-2fn)/(f-n)) -- if the consumer (THREE) uses a
  // DIFFERENT near/far for its own projection/depth-test than the one this depth was encoded with
  // (uSrcNear/uSrcFar), comparing the two directly is comparing values on two different curves, not
  // two distances. Linearize with the SOURCE near/far, then re-project with the CONSUMER's (uDstNear/
  // uDstFar) so the stamped value means the same eye-space distance under whichever projection THREE
  // is actually using this frame. (Bug: THREE's camera.near/far decoupled from mapspinner's own
  // terrain-horizon near/far, see decouple-vegetation-visibility-from-horizon-far-plane -- without
  // this re-encode, "terrain cutting off trees and GLBs" -- confirmed live: raw-copy stamped a value
  // meaningful under mapspinner's (0.5,4591.6) while THREE compared under its own (0.1,500).)
  const dwFsSrc = '#version 300 es\nprecision highp float;\nuniform highp sampler2D uDepth;\nuniform float uDepthEps;\nuniform vec2 uUvScale;\nuniform float uSrcNear;\nuniform float uSrcFar;\nuniform float uDstNear;\nuniform float uDstFar;\nin vec2 vUv;\nout vec4 fragColor;\nvoid main(){\n  float zNdcSrc = texture(uDepth, vUv*uUvScale).r * 2.0 - 1.0;\n  float zEye = (2.0*uSrcNear*uSrcFar) / (uSrcFar+uSrcNear - zNdcSrc*(uSrcFar-uSrcNear));\n  float projB = (uDstFar*uDstNear) / (uDstFar-uDstNear);\n  float biasM = (projB > 0.0) ? (uDepthEps * zEye * zEye / projB) : 0.0;\n  float zEyeBiased = zEye + biasM;\n  float zNdcDst = (uDstFar+uDstNear)/(uDstFar-uDstNear) + (1.0/zEyeBiased)*((-2.0*uDstFar*uDstNear)/(uDstFar-uDstNear));\n  float depth01 = clamp(zNdcDst * 0.5 + 0.5, 0.0, 1.0);\n  gl_FragDepth = depth01;\n  fragColor = vec4(0.0);\n}';
  const dwProg = gl.createProgram();
  gl.attachShader(dwProg, rawShader(gl.VERTEX_SHADER, upVsSrc));
  gl.attachShader(dwProg, rawShader(gl.FRAGMENT_SHADER, dwFsSrc));
  gl.linkProgram(dwProg);
  const dwUDepth = gl.getUniformLocation(dwProg, 'uDepth');
  const dwUBias = gl.getUniformLocation(dwProg, 'uDepthEps');
  const dwUScale = gl.getUniformLocation(dwProg, 'uUvScale');
  const dwUSrcNear = gl.getUniformLocation(dwProg, 'uSrcNear');
  const dwUSrcFar = gl.getUniformLocation(dwProg, 'uSrcFar');
  const dwUDstNear = gl.getUniformLocation(dwProg, 'uDstNear');
  const dwUDstFar = gl.getUniformLocation(dwProg, 'uDstFar');
  // DEBUG depth-readback program (window.__depthProbeOn): encode depth01 into RGBA8 as (hi,lo) byte split.
  const dpFsSrc = '#version 300 es\nprecision highp float;\nuniform highp sampler2D uDepth;\nuniform vec2 uUvScale;\nin vec2 vUv;\nout vec4 fragColor;\nvoid main(){\n  float z = texture(uDepth, vUv*uUvScale).r;\n  float hi = floor(z*255.0)/255.0;\n  float lo = fract(z*255.0);\n  fragColor = vec4(hi, lo, 0.0, 1.0);\n}';
  const dpProg = gl.createProgram();
  gl.attachShader(dpProg, rawShader(gl.VERTEX_SHADER, upVsSrc));
  gl.attachShader(dpProg, rawShader(gl.FRAGMENT_SHADER, dpFsSrc));
  gl.linkProgram(dpProg);
  const dpUTex = gl.getUniformLocation(dpProg, 'uDepth');
  const dpUScale = gl.getUniformLocation(dpProg, 'uUvScale');
  let _dpFbo = null, _dpTex = null, _dpW = 0, _dpH = 0;
  // PREMULTIPLIED-ALPHA composite for the half-res water (perf 2026-06-24): the half-res FBO clears to
  // (0,0,0,0); at the waterline a straight-alpha LINEAR upsample mixes water-rgb toward the cleared
  // BLACK as alpha falls 1->0, then a SRC_ALPHA blend lays partial-black over land = a black fringe
  // (user 'black line where water meets land'). The water FS outputs alpha=1 wherever it draws, so its
  // colour is ALREADY premultiplied (rgb*1); the LINEAR filter then mixes premultiplied water with the
  // premultiplied-zero cleared texels = correct alpha-weighted edge (rgb and a scale together). So the
  // composite is a PASSTHROUGH sample blended with ONE, ONE_MINUS_SRC_ALPHA -> zero-alpha edge texels
  // add zero colour, no black bleed. (Distinct from upProg only in the blend mode used at the call site.)
  const cmpUTex = upUTex;   // reuse upProg (passthrough sample); the fix is the premultiplied blend func

  // ---- FSR1-QUALITY VDRS UPSCALE (opt-in, window.__vdrsUpscaleFsr1===true): the plain LINEAR
  // upFsSrc single-tap sample above is functionally correct but visually softer than an edge-adaptive
  // upscale, especially at the lower end of the [0.3,1.0] vdrsScale clamp. Ports the SAME EASU
  // (edge-adaptive spatial upsample) + RCAS (robust contrast-adaptive sharpen) technique
  // client/core/FSR1.js already runs for the THREE-side canvas-DPR-drop consumer (see that module's
  // header for the full design rationale) into mapspinner's own raw-GL upscale-to-canvas tail. Cannot
  // share a THREE.ShaderMaterial instance (mapspinner is raw-GL, no THREE dependency) so the GLSL
  // logic is duplicated here in WebGL2 GLSL ES 3.00 form (FSR1.js already targets the same language/
  // version, so the port is direct). DEDICATED programs, not a reuse of upProg: upProg/cmpUTex is also
  // used by the half-res-water composite (blend-mode passthrough, a different consumer with different
  // correctness needs -- see the comment above), so this pass gets its own easuProg/rcasProg rather
  // than risking a shared-program edit rippling into that call site.
  const easuFsSrc = '#version 300 es\nprecision highp float;\nuniform sampler2D uTex;\nuniform vec2 uUvScale;\nuniform vec2 uSrcTexel;\nin vec2 vUv;\nout vec4 fragColor;\nvoid main(){\n  vec2 uv = vUv*uUvScale;\n  vec2 texel = uSrcTexel*uUvScale;\n  vec3 center = texture(uTex, uv).rgb;\n  vec3 n = texture(uTex, uv + vec2(0.0, -texel.y)).rgb;\n  vec3 s = texture(uTex, uv + vec2(0.0,  texel.y)).rgb;\n  vec3 e = texture(uTex, uv + vec2( texel.x, 0.0)).rgb;\n  vec3 w = texture(uTex, uv + vec2(-texel.x, 0.0)).rgb;\n  float lc = dot(center, vec3(0.2126, 0.7152, 0.0722));\n  float ln = dot(n, vec3(0.2126, 0.7152, 0.0722));\n  float ls = dot(s, vec3(0.2126, 0.7152, 0.0722));\n  float le = dot(e, vec3(0.2126, 0.7152, 0.0722));\n  float lw = dot(w, vec3(0.2126, 0.7152, 0.0722));\n  float lmin = min(lc, min(min(ln, ls), min(le, lw)));\n  float lmax = max(lc, max(max(ln, ls), max(le, lw)));\n  float contrast = clamp((lmax - lmin) * 4.0, 0.0, 1.0);\n  vec3 dirAvg = (n + s + e + w) * 0.25;\n  vec3 sharp = center * (1.0 + contrast * 0.5) - dirAvg * (contrast * 0.5);\n  fragColor = vec4(mix(center, sharp, contrast), 1.0);\n}';
  const easuProg = gl.createProgram();
  gl.attachShader(easuProg, rawShader(gl.VERTEX_SHADER, upVsSrc));
  gl.attachShader(easuProg, rawShader(gl.FRAGMENT_SHADER, easuFsSrc));
  gl.linkProgram(easuProg);
  if(!gl.getProgramParameter(easuProg, gl.LINK_STATUS)) throw new Error('easu link: '+gl.getProgramInfoLog(easuProg));
  const easuUTex = gl.getUniformLocation(easuProg, 'uTex');
  const easuUScale = gl.getUniformLocation(easuProg, 'uUvScale');
  const easuUSrcTexel = gl.getUniformLocation(easuProg, 'uSrcTexel');
  // RCAS: real AMD formula (same as FSR1.js _rcasFrag) -- per-pixel local min/max, contrast-adaptive
  // sharpen weight clamped so flat regions never ring (the anti-ringing clamp this row's PRD detail
  // calls out as the thing to not reintroduce).
  const rcasFsSrc = '#version 300 es\nprecision highp float;\nuniform sampler2D uTex;\nuniform vec2 uTexel;\nuniform float uSharpness;\nin vec2 vUv;\nout vec4 fragColor;\nvoid main(){\n  vec2 uv = vUv;\n  vec3 c = texture(uTex, uv).rgb;\n  vec3 n = texture(uTex, uv + vec2(0.0, -uTexel.y)).rgb;\n  vec3 s = texture(uTex, uv + vec2(0.0,  uTexel.y)).rgb;\n  vec3 e = texture(uTex, uv + vec2( uTexel.x, 0.0)).rgb;\n  vec3 w = texture(uTex, uv + vec2(-uTexel.x, 0.0)).rgb;\n  vec3 mn4 = min(min(n, s), min(e, w));\n  vec3 mx4 = max(max(n, s), max(e, w));\n  vec3 mn = min(mn4, c);\n  vec3 mx = max(mx4, c);\n  vec3 reciprocalMx = 1.0 / max(mx, vec3(0.0001));\n  vec3 ampl = clamp(min(mn, vec3(2.0) - mx) * reciprocalMx, vec3(0.0), vec3(1.0));\n  ampl = sqrt(ampl);\n  vec3 w4 = ampl * mix(vec3(-0.125), vec3(-0.20), uSharpness);\n  vec3 numerator = w4 * (n + s + e + w) + c;\n  vec3 denominator = vec3(1.0) + 4.0 * w4;\n  vec3 result = numerator / denominator;\n  fragColor = vec4(clamp(result, 0.0, 4.0), 1.0);\n}';
  const rcasProg = gl.createProgram();
  gl.attachShader(rcasProg, rawShader(gl.VERTEX_SHADER, upVsSrc));
  gl.attachShader(rcasProg, rawShader(gl.FRAGMENT_SHADER, rcasFsSrc));
  gl.linkProgram(rcasProg);
  if(!gl.getProgramParameter(rcasProg, gl.LINK_STATUS)) throw new Error('rcas link: '+gl.getProgramInfoLog(rcasProg));
  const rcasUTex = gl.getUniformLocation(rcasProg, 'uTex');
  const rcasUTexel = gl.getUniformLocation(rcasProg, 'uTexel');
  const rcasUSharpness = gl.getUniformLocation(rcasProg, 'uSharpness');
  // Intermediate EASU-output target: allocated lazily at canvas drawing-buffer resolution (same
  // resolution RCAS reads back at -- this pass upscales WITHIN the already-full-res canvas target,
  // same "in-place quality-preserving resharpen" scope note as FSR1.js's own _ensureTargets).
  let _fsr1UpTex = null, _fsr1UpFbo = null, _fsr1UpW = 0, _fsr1UpH = 0;
  function ensureFsr1UpTarget(W, H) {
    if (_fsr1UpTex && _fsr1UpW === W && _fsr1UpH === H) return;
    if (_fsr1UpTex) gl.deleteTexture(_fsr1UpTex);
    if (_fsr1UpFbo) gl.deleteFramebuffer(_fsr1UpFbo);
    _fsr1UpTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, _fsr1UpTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    _fsr1UpFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, _fsr1UpFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, _fsr1UpTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    _fsr1UpW = W; _fsr1UpH = H;
  }
  const upVao = gl.createVertexArray();
  let _vdrsFbo = null, _vdrsColor = null, _vdrsDepth = null, _vdrsW = 0, _vdrsH = 0, _vdrsRsThisFrame = 0;
  // Scene-copy texture: snapshot of the terrain pass color buffer read by the water FS for refraction.
  // Allocated once (canvas size), updated each frame via copyTexSubImage2D (GPU blit, zero allocation).
  let _sceneCopyTex = null, _sceneCopyW = 0, _sceneCopyH = 0;
  function ensureSceneCopy(W, H) {
    if (_sceneCopyTex && _sceneCopyW === W && _sceneCopyH === H) return;
    if (_sceneCopyTex) gl.deleteTexture(_sceneCopyTex);
    _sceneCopyTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, _sceneCopyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    _sceneCopyW = W; _sceneCopyH = H;
  }
  // HALF-RES WATER FBO (perf 2026-06-24, user opted in): the water pass is ~9ms of per-pixel FS-ALU
  // over a large screen area (measured: not verts/raster/swell). Rendering it at half resolution = ~4x
  // fewer water FS invocations. Color = RGBA8 (alpha carries coverage for the composite); its own depth
  // renderbuffer is cleared each frame -- the water relies on the terrain.glsl vH>1 discard to drop
  // under-land water (front-occlusion by tall land over ocean is negligible at the deck). Gated behind
  // window.__halfResWater. Reallocated only on a real half-size change.
  let _hrwFbo=null, _hrwColor=null, _hrwDepth=null, _hrwW=0, _hrwH=0;
  function ensureHrwTargets(W, H){
    if (_hrwFbo && _hrwW===W && _hrwH===H) return;
    if (_hrwColor) gl.deleteTexture(_hrwColor);
    if (_hrwDepth) gl.deleteRenderbuffer(_hrwDepth);
    if (_hrwFbo)   gl.deleteFramebuffer(_hrwFbo);
    // FIX (instanced-draw-sampler-type-collision-new-instance, non-deterministic
    // "GL_INVALID_OPERATION: glDrawElementsInstanced: Feedback loop formed between Framebuffer
    // and active Texture" on the VERY FIRST frame / any hrw-resolution-changed frame): this
    // function's own gl.bindTexture(TEXTURE_2D, _hrwColor) below had no preceding
    // gl.activeTexture call, so it silently bound _hrwColor onto WHATEVER unit the caller left
    // active -- which is TU.sceneTex (unit 9) on the real call path (render() calls
    // ensureSceneCopy + binds _sceneCopyTex to unit 9 immediately before calling this). That
    // clobbers unit 9's intended _sceneCopyTex binding with _hrwColor, and since _hrwColor is
    // ALSO this same function's own FBO color attachment (below), unit 9 now points at the
    // exact texture the immediately-following gl.bindFramebuffer(_hrwFbo) draw target attaches
    // -- a real feedback loop, live-confirmed via texture-identity capture (the failing draw's
    // bound FBO color attachment and unit 9's bound texture were the SAME object, both tracing
    // to this line). Explicitly scope texture creation/setup to a dedicated scratch unit (15,
    // unused by every TU.* role) and restore the caller's active unit afterward, so this
    // function's internal texture work can never bleed into whatever unit the caller had active.
    const _prevActiveUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE15);
    _hrwColor=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,_hrwColor);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,W,H,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);   // unbind from the scratch unit -- never left resident
    gl.activeTexture(_prevActiveUnit);
    _hrwDepth=gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER,_hrwDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT24,W,H);
    _hrwFbo=gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER,_hrwFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,_hrwColor,0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,_hrwDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    _hrwW=W; _hrwH=H;
  }
  function ensureVdrsTargets(W, H){
    if (_vdrsFbo && _vdrsW === W && _vdrsH === H) return;   // realloc ONLY on a real canvas-size change
    if (_vdrsColor) gl.deleteTexture(_vdrsColor);
    if (_vdrsDepth) gl.deleteTexture(_vdrsDepth);
    if (_vdrsFbo)   gl.deleteFramebuffer(_vdrsFbo);
    _vdrsColor = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, _vdrsColor);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // DEPTH as a sampleable TEXTURE: the half-res water FS samples this full-res scene depth for
    // per-pixel occlusion (the cross-size depth blit was broken on NVIDIA/ANGLE). NEAREST (depth must
    // not be filtered). Must be unbound from its sampler unit before _vdrsFbo is rebound as a draw
    // target (the composite) or NVIDIA flags a feedback loop -> black.
    _vdrsDepth = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, _vdrsDepth);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, W, H, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    _vdrsFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, _vdrsFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, _vdrsColor, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, _vdrsDepth, 0);
    // Pre-clear _vdrsDepth to far plane (1.0) so frame-1 terrain fragments are not universally
    // discarded by the depth-discard gate (terrain.glsl:~1041). On frame 1, uSceneDepth is
    // uninitialized (0); any terrain with z > ~0.0003 in NDC space gets discarded, causing the
    // entire terrain to vanish. Clearing to 1.0 (far plane) ensures frame-1 fragments pass.
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.clearDepth(1.0); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    _vdrsW = W; _vdrsH = H;
  }

  // ---- mesh grid: OVERLAP-RING tessellation (replaces the old dropped-skirt curtain).
  // The mesh spans (GRID+2) cells in each axis: the INTERIOR GRID cells cover the tile's
  // usable region in param coord [0,1] exactly as before, plus ONE EXTRA RING of cells on
  // every side reaching param coord [-1/GRID, 1+1/GRID]. The extra ring extends the surface
  // one cell INTO the neighbor tile's territory (a real, continuous part of the elevation
  // field -- the atlas carries BORDER=2 texels of valid margin, so uv just outside [0,1]
  // samples genuine neighbor-edge texels, NOT garbage). At a coarse/fine LOD T-junction the
  // coarse tile's overlap ring covers the crack the skirt used to hide; at a same-LOD seam
  // both neighbors overlap into each other and overdraw a COPLANAR surface (both compute
  // near-identical world height from the continuous field, so no z-fight). The neighbor's
  // own interior overdraws the overlap, so the visible surface still ends at the true tile
  // boundary -- the outer ring is the "hidden last ring". vertex.z is always 0 (no skirt).
  const g2 = GRID+2;              // cells per axis (GRID interior + 1 ring each side)
  const n2 = g2+1;               // verts per axis
  const du = 1.0/GRID;           // param step = one interior cell
  // SKIRT not OVERLAP (fix-visible-overlap-ring): the outer ring used to extend one cell INTO the
  // neighbor [-du, 1+du] and rasterize a FLAT flap there -> a visible band at every patch edge (user:
  // 'ring polys visible'). Instead, CLAMP each outer-ring vertex's xy to the true interior edge [0,1]
  // and flag it (z=1) as a SKIRT: the VS drops it radially below the surface, forming a near-vertical
  // curtain at the tile boundary. The skirt fills any T-junction crack (so no seam, unlike deleting
  // the ring) but is hidden behind the surface (so no visible flat band, unlike the overlap).
  const vlist = []; // x, y (param coord clamped to [0,1]), z = skirt flag (0 surface, 1 skirt)
  for (let y=0;y<n2;y++) for (let x=0;x<n2;x++){
    const isRing = (x===0 || x===n2-1 || y===0 || y===n2-1);
    const px = Math.min(Math.max((x-1)*du, 0.0), 1.0);   // clamp ring xy onto the true edge
    const py = Math.min(Math.max((y-1)*du, 0.0), 1.0);
    vlist.push(px, py, isRing ? 1.0 : 0.0);
  }
  const idx = [];
  for (let y=0;y<g2;y++) for (let x=0;x<g2;x++){
    const a=y*n2+x,b=a+1,c=a+n2,d=c+1;
    // Murmur3 finalizer on packed (x,y) -> quasi-random diagonal per quad.
    let h = (x | (y << 16)) | 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b | 0);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b | 0);
    h = h ^ (h >>> 16);
    if ((h >>> 17) & 1) idx.push(a,c,d, a,d,b);   // TL-BR diagonal (same CCW winding)
    else                idx.push(a,c,b, b,c,d);   // TR-BL diagonal (original)
  }
  const verts = new Float32Array(vlist);
  const indices = new Uint32Array(idx);
  const vbo=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,vbo); gl.bufferData(gl.ARRAY_BUFFER,verts,gl.STATIC_DRAW);
  const ibo=gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indices,gl.STATIC_DRAW);

  // SEPARATE COARSE WATER MESH (perf 2026-06-24): the water surface is near-flat (swell VS is ~0.4ms,
  // measured; waves are an FS effect) so it does NOT need the terrain GRID density. MEASURED at the
  // deck the water pass was ~12ms of a 20ms frame and pure vertex/triangle THROUGHPUT (262 tiles x
  // GRID^2 verts). A coarse water grid cuts that throughput ~Nx with no visual change (the FS raymarch
  // + per-pixel normal carry all wave detail; the mesh only needs enough verts to follow the sphere +
  // the waterline discard). No skirt ring (water sets skirt=0). Live-tunable via window.__waterGrid.
  const WGRID = (typeof window!=='undefined' && window.__waterGrid) ? window.__waterGrid : 4;
  const wg2 = WGRID+2, wn2 = wg2+1, wdu = 1.0/WGRID;
  const wvlist = [];
  for (let y=0;y<wn2;y++) for (let x=0;x<wn2;x++){
    const isRing=(x===0||x===wn2-1||y===0||y===wn2-1);
    wvlist.push(Math.min(Math.max((x-1)*wdu,0.0),1.0), Math.min(Math.max((y-1)*wdu,0.0),1.0), isRing?1.0:0.0);
  }
  const widx=[];
  for (let y=0;y<wg2;y++) for (let x=0;x<wg2;x++){ const a=y*wn2+x,b=a+1,c=a+wn2,d=c+1; widx.push(a,c,b,b,c,d); }
  const waterVerts=new Float32Array(wvlist), waterIndices=new Uint32Array(widx);
  const wvbo=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,wvbo); gl.bufferData(gl.ARRAY_BUFFER,waterVerts,gl.STATIC_DRAW);
  const wibo=gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,wibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,waterIndices,gl.STATIC_DRAW);
  const instBuf=gl.createBuffer();   // per-instance [ox,oy,l,level,face] (filled per frame in render())
  // DATA-CONTINUITY CACHE (2026-06-14): terrain + water get their OWN persistent instance buffers so
  // neither clobbers the other (the shared-buffer clobber forced a re-upload every frame and was the
  // root of the prior 'water drawn as terrain' regression). On a STATIC frame (same quads array object)
  // the instance data is identical -> skip the Float32Array build + bufferData + water dedup Set-loop
  // and just rebind+draw. Pure CPU/GC win (GPU is vertex-bound, the upload is off the critical path).
  const instBufWater=gl.createBuffer();
  let _instQuadsRef=null, _instWaterRef=null, _instWaterN=0, _lastThc=false;
  // WATER VISIBILITY GATE (2026-07-05, iGPU perf): at an inland/no-water-visible pose the water
  // pipeline still burned ~6ms/frame on a weak iGPU (measured fresh-page A/B, __waterSurface=false
  // arm: 22.1 -> 15.8ms p50 @1080p AMD iGPU/ANGLE): a FULL-RES scene copyTexSubImage2D for
  // refraction, the half-res water color pass (depth-test OFF -> every water-sphere fragment shades
  // even when fully behind terrain), and a fullscreen composite -- all for zero visible pixels.
  // The gate wraps the depth-only water stamp (which draws water depth-tested LESS against the
  // just-rendered terrain depth in _vdrsFbo) in an ANY_SAMPLES_PASSED_CONSERVATIVE occlusion query:
  // if the GPU proves no water fragment wins the depth test for 2 consecutive resolved queries, the
  // scene copy + color pass + composite are SKIPPED. The stamp/probe itself still draws EVERY frame
  // (it doubles as the shared-depth water stamp), so re-appearing water flips the verdict within
  // 1-2 frames (~imperceptible at a horizon waterline; the CONSERVATIVE query only ever
  // over-reports visibility = draws water when in doubt = look-preserving by construction).
  // Off-switch: window.__waterVisGate = false. Witness: window.__waterVisSkips counts skipped frames.
  let _waterVisQ = null, _waterVisQPending = false, _waterVisZeroRuns = 0;
  // SCRATCH POOLS (perf 2026-07-03): the _dirty instanced-draw rebuild (fires every frame the camera
  // moves, i.e. the common gameplay case -- NOT just on quad-set change, since the front-to-back sort
  // and instance buffer must be rebuilt whenever camera position changes the sort order/layer values)
  // used to allocate a fresh Float64Array(n)/Array(n)/Float32Array(n*FLOATS) EVERY such frame -- the
  // exact steady-state-allocation class quadtree.js's _leaves pool already eliminated elsewhere in this
  // codebase ('PERSISTENT leaf-object POOL ... reused across frames ... zero steady-state allocation').
  // Grow-only capacity-tracked scratch, matching that established idiom: allocate once, reuse, only
  // grow (never shrink) when a larger n is seen. GC-neutral on the common case (stable visible tile
  // count); correctness unchanged (same values written, just into a persistent backing store).
  let _scrD2 = new Float64Array(0), _scrOrd = new Int32Array(0), _scrInst = new Float32Array(0);
  let _scrWl = new Float32Array(0);
  function _ensureScratch(n, FLOATS) {
    if (_scrD2.length < n) _scrD2 = new Float64Array(n);
    if (_scrOrd.length < n) _scrOrd = new Int32Array(n);
    if (_scrInst.length < n * FLOATS) _scrInst = new Float32Array(n * FLOATS);
  }
  function _ensureWaterScratch(n, FLOATS) {
    if (_scrWl.length < n * FLOATS) _scrWl = new Float32Array(n * FLOATS);
  }
  // Reused across frames (perf 2026-07-03): the water dedup Set was `new Set()` every dirty frame.
  // .clear() keeps the same backing store, avoiding a fresh hash-table alloc on the common
  // (camera-moved) path.
  const _waterSeen = new Set();
  const _camRotScratch = new Float32Array(9);   // sky-pass camRot uniform: was a fresh alloc every frame the sky pass runs (below 100km alt)

  // per-face local->world (cube face -> sphere local frame). Column-major mat3 packed
  // into a Float32Array(9). Matches localToWorld3 convention:
  // col0 = U/rs, col1 = faceCenter, col2 = V/rs. rootQuadSize=2 -> face spans [-1,1].
  function localToWorld3(face) {
    // face axes (cube): for face 3 (+Z) U=+X, V=+Y, center=+Z. Generic table:
    const F = [
      {c:[ 1,0,0], u:[0,0,-1], v:[0,1,0]}, // +X
      {c:[-1,0,0], u:[0,0, 1], v:[0,1,0]}, // -X
      {c:[0, 1,0], u:[1,0,0], v:[0,0,-1]}, // +Y
      {c:[0,-1,0], u:[1,0,0], v:[0,0, 1]}, // -Y
      {c:[0,0, 1], u:[1,0,0], v:[0,1,0]},  // +Z
      {c:[0,0,-1], u:[-1,0,0],v:[0,1,0]},  // -Z
    ][face];
    // local plane coords (ox,oy) in [-1,1]; the VS builds P=(ox',oy',R) then normalizes
    // *defLocalToWorld* P. So localToWorld maps the local (x,y,z=R) basis to the face.
    // col0<-U, col1<-V, col2<-center (z axis = outward). Column-major 3x3.
    return new Float32Array([ F.u[0],F.u[1],F.u[2],  F.v[0],F.v[1],F.v[2],  F.c[0],F.c[1],F.c[2] ]);
  }

  // Compute & set the per-quad deformation uniforms (SphericalDeformation::setScreenUniforms).
  // quad = {level, tx, ty, ox, oy, l}; localCam = camera in this face's local plane coords.
  // (setQuadUniforms DELETED 2026-06-11 dead-code sweep: the single instanced draw replaced the
  // per-quad uniform path -- defOffset/defLocalToWorld are VS locals from iOffset/iFace now, and
  // the defViewProjRel/defOffset/defLocalToWorld uniforms no longer exist in the shader.)

  // textureTile coords for a tile resident at `layer` of the elev/normal atlas.
  // vertex.xy in [0,1] must sweep the tile INTERIOR (skip the BORDER): base = border/W,
  // span = (USABLE)/W. pixelScale carried in .z (unused by the simple textureTile).
  // ANCESTOR-FALLBACK: an optional `sub` = {ox,oy,scale} restricts sampling to a
  // sub-rectangle of the (ancestor) tile's USABLE interior. The mesh uv [0,1] then sweeps
  // only [ox,ox+scale] x [oy,oy+scale] of the usable region: base shifts by ox/oy of the
  // usable span, span shrinks by `scale`. With sub=null this is the full-tile interior.
  function setTileCoords(prefix, pool, layer, sub) {
    const fullSpan = (USABLE-1)/TILE_W;
    // EDGE-INSET fix lever (window.__elevEdgeInset, default 0.0): the texel-center offset of the
    // mesh-edge sample inside the BORDER. At 0.5 the edge vertex sampled texel (BORDER+0.5) so the
    // LINEAR filter blended the last INTERIOR texel with the adjacent SEAM BORDER texel -- a faint
    // per-tile-edge height kink that projected into a streak at grazing angle (the user's 'subtle
    // mip-bleed at medium distance', visible only when a tile edge aligned near-parallel to the
    // view ray). At 0.0 the edge vertex lands on the integer interior edge texel (= BORDER), the
    // shared-edge value both neighbours agree on, so there is NO border blend -> the static streak
    // floor is removed. VALIDATED (browser-401/402, this session): at the oblique heading where the
    // streak appeared, subtleFrac 0.0113->0.0027 + bestVertRun 6->2 (3-4x drop); harmless (0->0) at
    // clean oblique + closeup nadir (411/412/413/414), so it does not regress the ff5c8ba dim-line
    // fix. Default is now 0.0; the global stays as a live A/B lever.
    const inset = (typeof window.__elevEdgeInset === 'number') ? window.__elevEdgeInset : 0.5;
    const base0 = (BORDER + inset) / TILE_W;
    if (sub) {
      gl.uniform3f(U(prefix+'.tileCoords'), base0 + sub.ox*fullSpan, base0 + sub.oy*fullSpan, layer);
      gl.uniform3f(U(prefix+'.tileSize'),   fullSpan*sub.scale,     fullSpan*sub.scale,     1.0/TILE_W);
    } else {
      gl.uniform3f(U(prefix+'.tileCoords'), base0,    base0,    layer);
      gl.uniform3f(U(prefix+'.tileSize'),   fullSpan, fullSpan, 1.0/TILE_W);
    }
  }

  // SINGLE SOURCE OF TRUTH for the camera-relative clip matrix + near/far. Both render()
  // and the orchestrator's frustum cull use this so the cull can never disagree with the
  // draw (a divergence would cull on-screen quads or keep off-screen ones).
  // scalarsIn (optional): {aspect,near,far} already computed by a caller (render() computes the
  // identical altitude-tied near/far/aspect for its own octave-clamp/planetNearFar bookkeeping
  // just before calling this) -- reuse them instead of re-deriving from cam.eye/surfElev, so a
  // single render() frame does this scalar math exactly once instead of twice. Callers that only
  // need the cull matrices (planet-orchestrator's per-frame cull pass, which runs BEFORE render()
  // even builds its own scalars) omit scalarsIn and get the original self-contained derivation --
  // behavior/output is byte-identical either way, this is purely a redundant-recompute removal.
  function cullMatrix(cam, scalarsIn) {
    let aspect, near, far;
    if (scalarsIn) {
      aspect = scalarsIn.aspect; near = scalarsIn.near; far = scalarsIn.far;
    } else {
      aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
      const camDist = Math.hypot(cam.eye[0], cam.eye[1], cam.eye[2]);
      const alt = Math.max(0.0, camDist - R);
      const altAboveTerrain = Math.max(0.001, alt - R * (cam.surfElev || 0));
      // FAR-PLANE HORIZON RADIUS = R - 500m (user 2026-06-14: 'nearby mountains disappear at water level;
      // adjust that level to 500m under water'). The far plane tracks the sea-level horizon = sqrt(camDist^2
      // - R^2), which at the deck (camDist~=R) collapses to a few hundred metres -> coastal mountains a km
      // out fall beyond the far plane and vanish. Dropping the horizon reference radius 500m below sea level
      // extends the horizon to tens of km at low altitude so near-shore relief stays in view (negligible
      // depth-precision cost: 500m vs R~6.37e6). Both the cull and the draw use this (single source).
      const RHORIZON = R - 150.0;   // far brought in 500->250 (user 2026-06-14 'bring far plane in a bit'): deck horizon ~80km->~56km = more z-precision; still clears coastal mountains
      // UNDERWATER FAR-PLANE FIX (user 2026-06-14 'at -214m visible, at -500m it disappears'): when the
      // camera is more than 500m below sea level, camDist < RHORIZON so the sea-level horizon is imaginary
      // (-> 0) and alt is negative; the old max(horizon, alt*8) then collapsed the far plane to ~0 and the
      // whole scene vanished past -500m deep (= the 'ocean looks shallow/empty' when exploring). Floor the
      // far reach to 60km when submerged so the seabed + the underwater view stay visible.
      const horizon = (camDist > RHORIZON) ? Math.sqrt(camDist*camDist - RHORIZON*RHORIZON) : 60000.0;
      // MATCH render()'s near exactly (2026-06-14 jank fix): the cull frustum must use the SAME near
      // as the draw frustum, else behind-limb/screen-AABB culling diverges from what is actually drawn
      // at the deck (cull near was max(*0.1,0.1) while render used the <2m 0.05 branch).
      near = altAboveTerrain < 2.0 ? 0.5 : Math.max(altAboveTerrain * 0.1, 0.5);   // near nudged out 0.05->0.25 (user 2026-06-14 'improve on-ground'): more z-precision on the deck
      // FAR PLANE: horizon distance tracks the visible ground edge; blends toward camDist
      // above 500km for orbital views so the full planet is visible.
      const _fBlend = Math.min(1.0, Math.max(0.0, (alt - 500000.0) / 4500000.0));
      const farGround = Math.max(horizon, alt * 8.0);
      far = farGround * (1.0 - _fBlend) + camDist * _fBlend;
    }
    const proj = M4.perspective(cam.fovy||0.785, aspect, near, far);
    const eye = cam.eye;
    const viewRel = M4.lookAt([0,0,0], [cam.center[0]-eye[0], cam.center[1]-eye[1], cam.center[2]-eye[2]], cam.up||[0,1,0]);
    const viewProjRel = M4.mul(M4.mul(proj, viewRel), M4.translate([-eye[0],-eye[1],-eye[2]]));
    // viewProjNoEye = proj*viewRel WITHOUT the translate(-eye). The frustum cull must feed it
    // corners ALREADY made camera-relative (corner-eye, subtracted in JS double precision) --
    // folding translate(-eye) into the matrix and feeding ABSOLUTE ~6.37e6 m corners suffers
    // fp32 cancellation at ground level (eye~=world), garbaging the projection and blanking the
    // footprint. Subtracting in JS doubles first keeps the cull's projection precise near ground.
    const viewProjNoEye = M4.mul(proj, viewRel);
    return { viewProjRel, viewProjNoEye, eye, near, far, proj, viewRel };
  }

  // ===== RENDER PASS MANIFEST (rg-decompose-glrender-monolith) =====
  // Pure-observability decomposition of render()'s internal GL call sequence into named passes with
  // declared in/out resources. This is NOT a behavior change: every pass below is the SAME code that
  // ran inline before, called in the SAME order, sharing render()'s local closure (cam/sunDir/time/
  // viewProjRel/_cm/etc) exactly as it did as inline statements -- extracting to closures over the
  // same scope is behavior-preserving by construction (no variable is copied/re-derived, no state is
  // read at a different point in the frame than before). shouldRun reflects a REAL runtime condition
  // (read live, not cached) so the manifest always describes the CURRENT frame's actual gating -- a
  // host RenderGraph inspector can mirror these read-only sub-nodes without re-implementing the gates.
  // Exported via getPassManifest() below; each entry's `reads`/`writes` name the GL resources touched.
  const _passManifest = [
    { id: 'terrain-tile-draw', purpose: 'Instanced draw of all visible terrain quads (+ optional THC bake-on-sight)', reads: ['quads', 'viewProjRel', 'composeHeight uniforms'], writes: ['color', 'depth'] },
    { id: 'water-visibility-probe', purpose: 'Conservative occlusion query + shared-depth stamp for the half-res water gate', reads: ['depth'], writes: ['depth (stamp)', 'occlusion query result'] },
    { id: 'half-res-water-color', purpose: 'Half- or full-res water color pass (raymarched animated surface) + scene-copy refraction source', reads: ['color (scene copy)', 'depth'], writes: ['color', '_hrwColor (half-res target)'] },
    { id: 'water-depth-share', purpose: 'Depth-only re-draw of the water surface into _vdrsDepth so submerged consumer geometry is occluded', reads: ['water mesh'], writes: ['depth'] },
    { id: 'half-res-water-composite', purpose: 'Premultiplied-alpha upscale-composite of the half-res water color target onto the scene FBO', reads: ['_hrwColor'], writes: ['color'] },
    { id: 'upscale-to-canvas', purpose: 'VDRS fullscreen-quad LINEAR upscale of the flexed-viewport FBO color to the canvas', reads: ['_vdrsColor'], writes: ['canvas color'] },
    { id: 'planet-depth-writeback', purpose: 'Shader-pass re-encode + stamp of planet depth into the canvas depth buffer for a host consumer scene', reads: ['_vdrsDepth'], writes: ['canvas depth'] },
    { id: 'atmosphere-aerial-composite', purpose: 'Fullscreen sky/atmosphere pass (drawSky), depth-tested only when the bound framebuffer holds this frame real depth', reads: ['depth (conditional)'], writes: ['color'] },
  ];
  function getPassManifest() { return _passManifest.map(p => ({ ...p })); }   // defensive copy -- read-only for consumers
  if (typeof globalThis !== 'undefined') globalThis.__mapspinnerPassManifest = getPassManifest;

  // Render a set of quads. quads: [{quad, face, elevLayer, normalLayer}], cam: {eye, center, up, fovy}
  function render(quads, cam, sunDir, time) {
    const aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    // ADAPTIVE near/far (altitude-tied). A fixed near=1 / far=R*8 (~5e7) at a 50km eye
    // pushed ALL near-surface geometry to NDC z~=1 (the far-plane limit), collapsing depth
    // precision so most near quads z-fought / clamped off -> only one screen rectangle
    // survived. Tie the planes to altitude: near = alt*0.1 (naturally scales from 1m at
    // deck to 1200km at orbit), far = horizon distance blended toward camDist above 500km
    // for orbital views. From space the far widens out to ~R*8, preserving the full-globe
    // view. Clamped so near>=1 and far>near.
    const camDist = Math.hypot(cam.eye[0], cam.eye[1], cam.eye[2]);
    const alt = Math.max(0.0, camDist - R);
    const altAboveTerrain = Math.max(0.001, alt - R * (cam.surfElev || 0));
    // FAR-PLANE HORIZON RADIUS = R - 500m (user 2026-06-14: 'nearby mountains disappear at water level;
    // adjust that level to 500m under water'). The far plane tracks the sea-level horizon = sqrt(camDist^2
    // - R^2), which at the deck (camDist~=R) collapses to a few hundred metres -> coastal mountains a km
    // out fall beyond the far plane and vanish. Dropping the horizon reference radius 500m below sea level
    // extends the horizon to tens of km at low altitude so near-shore relief stays in view (negligible
    // depth-precision cost: 500m vs R~6.37e6). Both the cull and the draw use this (single source).
    const RHORIZON = R - 150.0;   // far brought in 500->250 (user 2026-06-14 'bring far plane in a bit'): deck horizon ~80km->~56km = more z-precision; still clears coastal mountains
    // UNDERWATER FAR-PLANE FIX (user 2026-06-14 'at -214m visible, at -500m it disappears'): when the
    // camera is more than 500m below sea level, camDist < RHORIZON so the sea-level horizon is imaginary
    // (-> 0) and alt is negative; the old max(horizon, alt*8) then collapsed the far plane to ~0 and the
    // whole scene vanished past -500m deep (= the 'ocean looks shallow/empty' when exploring). Floor the
    // far reach to 60km when submerged so the seabed + the underwater view stay visible.
    const horizon = (camDist > RHORIZON) ? Math.sqrt(camDist*camDist - RHORIZON*RHORIZON) : 60000.0;
    const near = altAboveTerrain < 2.0 ? 0.5 : Math.max(altAboveTerrain * 0.1, 0.5);   // near nudged out 0.05->0.25 (user 2026-06-14 'improve on-ground'): more z-precision on the deck
    const _fBlend = Math.min(1.0, Math.max(0.0, (alt - 500000.0) / 4500000.0));
    const farGround = Math.max(horizon, alt * 8.0);
    const far = farGround * (1.0 - _fBlend) + camDist * _fBlend;
    // ALTITUDE OCTAVE CLAMP: drive the per-frame fractal octave count from camera
    // altitude (see _clampOcts). Scaled by R/Earth so a small-radius consumer planet gets the same RELATIVE
    // cut. Read by setComposeHeightUniforms(U) below; the probe/bake leave _octClampAlt at 0 (full octaves)
    // so near-ground collision never diverges from the rendered surface. window.__altOctClamp===false rolls back.
    _octClampAlt = alt * (6360000.0 / R);
    // CAMERA-RELATIVE projection path (fp32 precision fix). At close range the world
    // coords (~6.36e6 m) and the eye (~9.5e6 m) are huge & nearly equal; view*world
    // suffers catastrophic fp32 cancellation, throwing gl_Position off-screen and
    // blanking the terrain. Build the projection so geometry is expressed RELATIVE to
    // the eye: place the eye at the origin (lookAt center-eye) and pre-translate world
    // corners by -eye. Then view*world differences are computed in fp32 BEFORE the big
    // magnitudes appear, so the small near-camera coords keep their precision. The
    // atmosphere/lighting path (camWorld, vWorld) stays ABSOLUTE -- only gl_Position is
    // relative.
    const eye = cam.eye;
    // reuse the near/far/aspect this function already derived above (identical formula
    // cullMatrix would otherwise re-derive from cam.eye/surfElev) -- removes one redundant
    // camDist/alt/altAboveTerrain/horizon/near/far scalar recompute per render() call.
    const _cm = cullMatrix(cam, { aspect, near, far });
    const viewProjRel = _cm.viewProjRel;   // same matrix the frustum cull uses
    const viewProjNoEye = _cm.viewProjNoEye;   // proj*viewRel WITHOUT folded translate(-eye) -- for the
    // camera-relative VS path (vertex-jitter fix): the VS forms a SMALL camera-relative position so the
    // big ~6.4e6 radial magnitude never enters fp32 -> no ~0.5m quantization step = no vertex jitter.
    const _camDist = Math.hypot(eye[0], eye[1], eye[2]) || 1;
    const camDir = [eye[0]/_camDist, eye[1]/_camDist, eye[2]/_camDist];
    const camAlt = _camDist - R;
    // Expose the ACTUAL draw matrix + a finite-check for the motion debug probes. A NaN
    // viewProj (degenerate lookAt: fwd parallel up) is the classic disappear-on-move
    // signature -- all gl_Position go NaN and nothing draws. The probe reads __lastVP /
    // __lastVPFinite instead of guessing from a black screenshot.
    if (typeof window !== 'undefined') {
      // EMBED depth-share: expose the projection planes so a host (e.g. spoint) can match
      // its own camera near/far/fovy and SHARE the depth buffer (planet occludes + is
      // occluded by host geometry instead of being a clearDepth backdrop).
      window.__planetNearFar = { near, far, fovy: cam.fovy || 0.785, aspect };
      window.__lastVP = viewProjRel;
      window.__lastVPFinite = viewProjRel.every(v => Number.isFinite(v));
      window.__deviceLost = gl.isContextLost();
    }

    // VIEWPORT-DRS (opt-in): render the scene into the fixed FBO at a flexed viewport (the upscale tail
    // blits it to the canvas), else straight to the canvas. THC bake mode rebinds the canvas mid-frame, so
    // vdrs stays off when THC is active. No canvas realloc happens here -> dialing __vdrsScale is hitch-free.
    const _vW = gl.drawingBufferWidth, _vH = gl.drawingBufferHeight;
    let _vrs = 0;
    // HALF-RES WATER needs to blit the scene DEPTH into its half-res buffer, but blitFramebuffer cannot
    // read DEPTH from the DEFAULT framebuffer (WebGL2) -- doing so silently fails -> garbage half-res
    // depth -> occluded water draws OVER terrain (user 2026-06-24 'occluded water drawing over the
    // terrain', witnessed as a horizon line over a ridge; forcing the vdrs FBO made it vanish). So when
    // half-res water is active, render the scene into _vdrsFbo (a real depth-renderbuffer FBO) at full
    // scale; the existing VDRS upscale tail composites it to the canvas. _aboveWater guards underwater.
    const _hrwActive = (typeof window==='undefined' || window.__halfResWater!==false) && (camDist >= R - 2.0);
    // HOST-NEARFAR MISMATCH (ground-depth-writeback-altitude-cutaway, 2026-08-24): the straight-to-canvas
    // path (both _hrwActive and window.__vdrs false, the DEFAULT app config) writes this frame's terrain
    // depth using mapspinner's OWN near/far (near=altAboveTerrain*0.1, so it climbs from ~0.5 at deck to
    // 15+ at a few hundred metres altitude) straight into the canvas depth buffer with NO re-encode --
    // passPlanetDepthWriteback() below only ever runs when _vdrsRsThisFrame>0, i.e. only on the VDRS/half-
    // res-water path. Any host that decouples its own camera.near/far from this value (spoint's
    // RenderGraph.nodes.js host-near-far node deliberately pins hostNearFar.near=0.3 fixed, see that
    // file's own header) then depth-tests real scene geometry (trees, players, models) against a raw NDC
    // value meaningful only under mapspinner's curve -- the mismatch GROWS with altitude (mapspinner's own
    // near grows, the host's stays fixed), so more of the depth range aliases to "nearer than everything"
    // the higher the camera goes: live-witnessed as scene objects up to 70m tall becoming fully depth-
    // occluded by terrain at deck+80m and above, while a deck-level pose (near~=0.5, close to the host's
    // fixed 0.3) showed none of the defect. Route this case through the SAME vdrsFbo+writeback machinery
    // the half-res-water path already uses (full-res, _vrs=1.0) instead of straight-to-canvas, so
    // passPlanetDepthWriteback() actually runs and re-projects mapspinner's depth onto the host's curve.
    const _hostNF = (typeof window !== 'undefined') ? window.__hostNearFar : null;
    const _hostNearFarMismatch = !!(_hostNF && Number.isFinite(_hostNF.near) && Number.isFinite(_hostNF.far)
      && (Math.abs(_hostNF.near - near) > 1e-6 || Math.abs(_hostNF.far - far) > 1e-3));
    const _vdrsOn = (typeof window!=='undefined' && window.__vdrs === true) || _hrwActive || _hostNearFarMismatch;
    if (_vdrsOn && !thcActive()) {
      _vrs = (typeof window!=='undefined' && window.__vdrs === true) ? Math.min(1.0, Math.max(0.3, +window.__vdrsScale || 1.0)) : 1.0;
      ensureVdrsTargets(_vW, _vH);
      gl.bindFramebuffer(gl.FRAMEBUFFER, _vdrsFbo);
      gl.viewport(0, 0, Math.max(1, Math.round(_vW*_vrs)), Math.max(1, Math.round(_vH*_vrs)));
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0,0,_vW,_vH);
    }
    _vdrsRsThisFrame = _vrs;
    gl.clearColor(0.0,0.0,0.0,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);

    // SKY/ATMOSPHERE PASS moved to AFTER terrain (see drawSky below, called at the two frame-exit
    // points) -- drawing depth-test-off FIRST shaded every one of ~2M canvas pixels every frame,
    // only for terrain to overdraw most of them. depthFunc(LEQUAL) + gl_Position.z=w (skyVsSrc
    // already emits z=w=1.0, the standard "sky at the far plane" trick) means the sky FS now only
    // runs where terrain (or water) left the depth buffer at its cleared/far value -- i.e. only
    // actually-visible-sky pixels. Kept as a closure so both frame-exit paths (VDRS-upscale tail and
    // the rare straight-to-canvas path) can call it once depth is final for that path.
    // `depthTested`: true only when the CURRENTLY BOUND framebuffer's depth is guaranteed to be
    // THIS frame's real terrain/water depth (straight-to-canvas path, or the VDRS path AFTER the
    // depth-writeback stamp when __planetDepthToCanvas is on). Otherwise the canvas depth buffer
    // may be stale (a previous frame's, or never written this frame) -- fall back to the original
    // depth-test-OFF draw so the look never regresses (fail-open, matches pre-existing behavior).
    function drawSky(depthTested) {
      const skyFade = Math.max(0.0, 1.0 - camAlt / 100000.0);
      // TEMP DIAGNOSTIC (window.__passProbe): log sky-pass entry/exit/early-return per frame.
      if (typeof window !== 'undefined' && window.__passProbe === true) {
        (window.__passProbeLog = window.__passProbeLog || []).push(
          'drawSky enter depthTested=' + depthTested + ' camAlt=' + camAlt.toFixed(1) + ' skyFade=' + skyFade.toFixed(4));
      }
      if (skyFade <= 0.001) {
        if (typeof window !== 'undefined' && window.__passProbe === true) (window.__passProbeLog = window.__passProbeLog || []).push('drawSky EARLY-RETURN skyFade<=0.001');
        return;
      }
      gl.useProgram(skyProg);
      _camRotScratch[0]=_cm.viewRel[0]; _camRotScratch[1]=_cm.viewRel[4]; _camRotScratch[2]=_cm.viewRel[8];
      _camRotScratch[3]=_cm.viewRel[1]; _camRotScratch[4]=_cm.viewRel[5]; _camRotScratch[5]=_cm.viewRel[9];
      _camRotScratch[6]=_cm.viewRel[2]; _camRotScratch[7]=_cm.viewRel[6]; _camRotScratch[8]=_cm.viewRel[10];
      gl.uniformMatrix3fv(SU('camRot'), false, _camRotScratch);
      gl.uniform2f(SU('projDiag'), _cm.proj[0], _cm.proj[5]);
      gl.uniform3f(SU('skyCamWorld'), eye[0], eye[1], eye[2]);
      gl.uniform3f(SU('skySunDir'), sunDir[0], sunDir[1], sunDir[2]);
      gl.uniform1f(SU('skyR'), R);
      gl.uniform1f(SU('uSkyFade'), skyFade);
      gl.uniform1f(SU('uSkyDbg'), (typeof window!=='undefined' && window.__skyDbg) ? window.__skyDbg : 0.0);  // sky-FS intermediate readout (1=raw radiance 2=post-bias*exposure 3=post-ACES)
      // TEMP DIAGNOSTIC (__passProbe-gated): force the sky depth test off to A/B "sky rejected
      // by a depth-only writer" vs "sky paints but something black overwrites it later".
      if (typeof window !== 'undefined' && window.__passProbeSkyNoDepth === true) depthTested = false;
      if (depthTested) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false); }
      else { gl.disable(gl.DEPTH_TEST); }
      gl.disable(gl.CULL_FACE);   // the sky is a fullscreen triangle -- NEVER cull it. The terrain cull
      // state (frontFace/cullFace) persists from the previous frame's draw, so without this the sky
      // triangle inherits whatever winding was culled and VANISHES (user 2026-06-17 'the sky disappears').
      gl.bindVertexArray(skyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
      if (typeof window !== 'undefined' && window.__passProbe === true) (window.__passProbeLog = window.__passProbeLog || []).push('drawSky exit drew fullscreen tri');
    }

    gl.enable(gl.DEPTH_TEST);
    // STANDARD BACK-FACE CULL (user 2026-06-17 'cant we have actual normal backface culling?'). cullFace(FRONT)
    // + frontFace(CCW) is the CORRECT winding for this cube-sphere mesh -- WITNESSED on the real GPU this build:
    //   - ORBIT: keeps the full near hemisphere, culls the far (terr 0.378 vs cullBack 0.185).
    //   - DECK: terrain intact to the horizon, screenshot identical to cull-off (the 'sky drawing over the
    //     terrain' that an earlier FS sea-level-tangent cull caused is GONE -- a real winding cull culls actual
    //     triangle facings, not a sphere approximation, so distant relief over the horizon is kept).
    //   - UNDER the surface: culls the terrain underside the depth buffer can't hide (nzFrac 1.0 -> 0.05).
    // The old 'winding flips with altitude' (which had defaulted this to 'none') was a STALE reading from before
    // the camera-relative VS; vRel now translates UNIFORMLY by altitude, so a front-facing triangle's winding is
    // altitude-invariant -> one fixed cullFace works everywhere. The sky pass disables CULL_FACE (fullscreen
    // triangle) so it is never culled. Diagnostic overrides: window.__cullMode = 'none' (off) | 'back'.
    const cm = window.__cullMode || 'front';
    if (cm === 'none') { gl.disable(gl.CULL_FACE); }
    else { gl.enable(gl.CULL_FACE); gl.cullFace((cm === 'back') ? gl.BACK : gl.FRONT); gl.frontFace(gl.CCW); }
    // ACTIVE PROGRAM select: a diagnostic displayMode needs the lazily-built debug program (which
    // carries the _DEBUGVIEW_ blocks). Build it on first request; until it finishes linking, fall
    // back to the render program (the lit view) for that frame -- no black flash, just one frame of
    // lit before the debug view appears. Modes 0/2/4 always use the render program.
    const _dm = cam.displayMode||0;
    if (DEBUG_MODES.has(_dm)) {
      ensureDebug();
      if (debugProg) setActiveProgram(debugProg, _dbgUloc); else setActiveProgram(prog, _uloc);
    } else { setActiveProgram(prog, _uloc); }
    gl.useProgram(_activeProg);
    gl.uniform3f(U('camWorld'), cam.eye[0], cam.eye[1], cam.eye[2]);
    gl.uniform1f(U('terrainR'), R);
    // camera-relative VS projection uniforms (vertex-jitter fix): the VS builds vRel = (dir0-camDir)*R
    // + dir0*h - camDir*camAlt (no 6.4e6 intermediate) and projects with defViewProjNoEye.
    gl.uniformMatrix4fv(U('defViewProjNoEye'), false, viewProjNoEye);
    gl.uniform3f(U('defCamDir'), camDir[0], camDir[1], camDir[2]);
    gl.uniform1f(U('defCamAlt'), camAlt);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
    gl.vertexAttribDivisor(0, 0);   // per-vertex
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    // No elevation/normal/ortho atlas: terrain shape+normal+material come from the GPU fractal +
    // biome ramp (the atlas producer is removed). Only the HPF continental field is sampled.
    // HPF continental field (TEXTURE3): sampled in the VS by world dir for the continental
    // elevation bias. hasHpf=0 -> VS uses 0 bias (graceful fallback before setHpf()).
    const hasHpf = !!_hpfTex;
    // TEXTURE-UNIT bind (activeTexture+bindTexture) is global GL state -- skip it when the same object is
    // already bound to that unit (see _lastHpfTex comment above). The SAMPLER uniform (hpfPool=3) is
    // PROGRAM-scoped state on whichever program is active this frame (render vs the lazy debug program),
    // so it is INDEPENDENTLY dirty-cached via _chuSet1i keyed on _cck (that program's own uniform cache) --
    // it must still upload once per program even on a frame where the texture-unit bind itself is skipped
    // (e.g. right after a hot-reload swaps in a fresh program whose sampler uniforms are unset, while the
    // texture object bound to unit 3 hasn't changed at all).
    const _cck = _activeUloc || _uloc;
    // hpfPool/hpfPool2 sampler units are pinned UNCONDITIONALLY every frame (dirty-cache skip REMOVED,
    // 2026-07-10, same reasoning + same live-witnessed bug class as the shadow-texture fix above: a
    // JS-side "already bound, skip the rebind" cache is unsound whenever a third party -- here, THREE's
    // own renderer.render() pass running between mapspinner draws within the same frame -- can rebind
    // the SAME texture unit without mapspinner's dirty-cache variable finding out). Also: hasHpf===false
    // previously left units 3/5 with NO texture object bound at all when _hpfTex is still null (early
    // frames before setHpf() fires) -- an empty sampler2DArray unit can itself trigger the driver's
    // GL_INVALID_OPERATION validation exactly like the uHeightPool-unit-8 bug fixed above. Bind the
    // height-pool dummy (already 2D_ARRAY-shaped) as a placeholder so units 3/5 are never empty.
    gl.activeTexture(gl.TEXTURE0 + TU.hpf);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, hasHpf ? _hpfTex : ensureDummyHeightPoolTex());
    _lastHpfTex = hasHpf ? _hpfTex : null;
    _chuSet1i(U, _cck, 'hpfPool', TU.hpf);
    gl.activeTexture(gl.TEXTURE0 + TU.hpf2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, (hasHpf && _hpfTex2) ? _hpfTex2 : ensureDummyHeightPoolTex());
    _lastHpfTex2 = (hasHpf && _hpfTex2) ? _hpfTex2 : null;
    _chuSet1i(U, _cck, 'hpfPool2', TU.hpf2);
    _chuSet1i(U, _cck, 'hasHpf', hasHpf ? 1 : 0);
    // uTransmittanceLUT (sampler2D, Bruneton-lite precomputed transmittance) pinned UNCONDITIONALLY
    // every frame -- same discipline as hpfPool/hpfPool2 above (a JS-side "already bound, skip
    // rebind" dirty-cache is unsound whenever THREE's own render pass rebinds the same unit between
    // mapspinner draws within one frame, AGENTS.md TEXTURE1/3/5 desync incident). Always available
    // (baked+uploaded once, lazily, on first use -- never gated on a window.__ toggle like THC).
    gl.activeTexture(gl.TEXTURE0 + TU.transmittanceLUT);
    gl.bindTexture(gl.TEXTURE_2D, ensureTransmittanceLUT());
    _chuSet1i(U, _cck, 'uTransmittanceLUT', TU.transmittanceLUT);
    // uScatteringLUT (sampler2DArray, Bruneton-lite precomputed single-scatter in-scattered
    // radiance) pinned UNCONDITIONALLY every frame -- same discipline/rationale as
    // uTransmittanceLUT immediately above (TEXTURE1/3/5 dirty-cache desync precedent).
    gl.activeTexture(gl.TEXTURE0 + TU.scatteringLUT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ensureScatteringLUT());
    _chuSet1i(U, _cck, 'uScatteringLUT', TU.scatteringLUT);
    // uUseScatteringLUT: explicit A/B lever (default 0 = runtime march, UNCHANGED behavior) so the
    // LUT fast path in atm_marchRadiance is opt-in via window.__useScatteringLUT=1, matching this
    // file's own house convention for analytic-vs-precomputed levers (aerialAmt, THC __thc, etc).
    // Read inline here (not via the _g() helper defined later in this function) to avoid a TDZ
    // reference-before-declaration -- _g is a `const` declared further down this same scope.
    {
      const _useScatLut = (typeof window !== 'undefined' && window.__useScatteringLUT != null) ? +window.__useScatteringLUT : 0;
      _chuSet1f(U, _cck, 'uUseScatteringLUT', _useScatLut);
    }
    // aerial-perspective haze strength -- live A/B lever (1=on default, 0=off) to isolate/kill the
    // 'haze that melts into the land' on descent. The glancing-only graze weight in the shader
    // confines haze to the limb; this lever lets the witness compare with/without.
    // (aerialAmt setter DELETED 2026-06-11 dead-code sweep: the uniform left the shader earlier.)
    // FS-derivative normal lever. Default OFF: pure cross(dFdx,dFdy) of vWorld removes the tile
    // seam but exposes the coarse GRID mesh as facets -> moire (measured worse than the seam).
    // Kept as a lever; the seamless fix is the HYBRID in the FS (atlas detail + continuous base).
    // W5: fsNormal + pvNormal uniforms removed -- the shader no longer has them (THC Sobel is the sole
    // lit normal). The old per-vertex/dFdx normal levers are deleted.
    // per-vertex micro-displacement (coplanar-quads fix): unique sub-mesh-cell height per vertex
    // from world-continuous face-local fBm, so the surface isn't capped at the 21-texel atlas. default 1.
    // vtxDetail DEFAULT 0: the LOD-RELATIVE per-vertex micro-displacement popped between 1500/1200km
    // (amplitude scaled with tile size + faded in by altitude). The continuous broadShape (12 octaves,
    // absolute world wavelengths) now carries fine relief LOD-invariantly. Live re-enable via __vtxDetail.
    // PARITY + LEVER ENABLE (2026-06-15): set ALL composeHeight shape uniforms on the RENDER program through
    // the SAME function the probe/bake use -> render/probe can never diverge AND the octave-count levers
    // (uOctMax/uInciseRidgeOcts/uBroadLowOcts/uPeakOcts/uVtxBaseOcts) now affect the render so each fractal's
    // visual contribution can be measured live. (Inline sets below are now redundant-but-harmless duplicates.)
    // cacheKey = the actual active program's uniform-location cache (U() is dynamic, resolving
    // against render-prog or debug-prog depending on displayMode) so the dirty-flag cache never
    // conflates two different real GL programs under one key.
    setComposeHeightUniforms(U, _activeUloc || _uloc);
    // (vtxDetail render setter removed 2026-06-18 -- vtxDisplace is a 0.0 stub, the uniform is gone.)
    // CLIFF / CANYON levers (live-tunable): canyon depth multiplier, cliff terrace strength (VS shape)
    // + strata band thickness and cliff-strata material strength (FS texturing). Defaults = the tuned
    // literals so the look is unchanged until the user dials a window global.
    const _g = (n,d)=> (typeof window!=='undefined' && window['__'+n]!=null) ? +window['__'+n] : d;
    // DESTRUCTIVE-OPT 2026-06-18 (workflow wohggez72, glr-dedup-setComposeHeight): the inline canyonDepthMul/
    // uVsCheap/uBeachShelfM/uLandBias/uHiFreqCut/cliffAmt/uHpfInset/uFloatLinearOK sets that used to live here
    // were exact redundant duplicates of setComposeHeightUniforms(U) -- called just above at line ~1068 with the
    // SAME locator U and SAME window-read values -- so they re-uploaded identical values every frame. Deleted:
    // byte-identical render, fewer uniform calls/frame. The NON-overlapping sets (uVertexAO/uAoAmt/uWireframe/
    // uFsCheap, none of which setComposeHeightUniforms touches) stay.
    // DIRTY-CACHE THE STATIC "LOOK" UNIFORM BLOCK (perf, 2026-07-06): every uniform below is a tuning
    // constant (TD default or a live window.__ tweak-panel override) that changes only when a user drags
    // a slider or a texture/biome async load lands -- NOT once per frame. The old code called gl.uniform*
    // unconditionally here (~55 calls/frame, every one a synchronous driver round-trip on this weak-iGPU/
    // ANGLE-D3D11 target), duplicating the exact "upload only on real change" problem setComposeHeightUniforms
    // already solved via _chuSet1f/1i above. Route through the SAME cache (keyed identically: cacheKey =
    // _activeUloc || _uloc, matching setComposeHeightUniforms's own cacheKey resolution just above) so a
    // static frame (the overwhelming common case) skips ~55 gl.uniform calls entirely; a changed value
    // uploads exactly like before. Byte-identical rendered output -- this only elides redundant re-uploads
    // of the SAME value, verified live (see fix-verify witness).
    // (_cck already declared above, at the hpfPool/hasHpf dirty-cache block -- same cacheKey resolution.)
    _chuSet1f(U, _cck, 'uVertexAO',      _g('vertexAO', TD.vertexAO));    // per-vertex shading/AO strength (DEFECT 2, 2026-06-06)
    _chuSet1f(U, _cck, 'uAoAmt',         _g('aoAmt', TD.aoAmt));
    _chuSet1f(U, _cck, 'uWireframe',     (typeof window!=='undefined' && window.__wireframe) ? 1.0 : 0.0);
    // WEATHER-DRIVEN WETNESS (wetness-material-modifier-weather-driven, 2026-07-21): plain live
    // tuning scalar, same window.__* + _g() precedent as every other lever in this block (e.g.
    // vertexAO/aoAmt above) -- client/core/Weather.js's rain state writes window.__wetness every
    // frame (see client/app.js's weather-update render-graph node), terrain.glsl consumes it
    // post-lighting (land-only, terrain-pass-only gate -- see that uniform's own declaration
    // comment). _g() already falls back to 0 (fully dry, byte-identical to pre-this-change output)
    // when unset, so a bare SDK consumer / this demo's own planet.html is unaffected.
    _chuSet1f(U, _cck, 'uWetness',        _g('wetness', 0));
    _chuSet1f(U, _cck, 'uFsCheap',        (typeof window!=='undefined' && window.__fsCheap) ? 1.0 : 0.0);  // GPU-timer VS-isolation frame (window.__gpuTimer)
    _chuSet1f(U, _cck, 'uWaterDbg',       (typeof window!=='undefined' && window.__waterDbg) ? window.__waterDbg : 0.0);  // water-FS intermediate readout (1=refrCol 2=refl 3=fogT 4=waterBody 5=spec)
    // (uBiomeBandBias render setter removed 2026-06-18 -- dead with the anchor-point biome system.)
    // REAL-WORLD LOOK overhaul (live-tunable via window globals / DEFAULTS.look). Beer-Lambert ocean
    // extinction, biome saturation pull, intra-biome mottle, sky-fill relief, terminator sunset glow,
    // night floor + earthshine, exposure + post-ACES Look (sat/contrast). Defaults = the tuned look.
    // (uBiomeSat + uBiomeClimate render setters removed 2026-06-18 -- dead with the anchor-point biome system removal.)
    _chuSet1f(U, _cck, 'uVariationAmt',   _g('variationAmt', TD.variationAmt));   // 0.08->0.04 (2026-06-10 'blotchy': mottle patches across the 4x massifs)
    // (uDetailOverlay inline set removed 2026-06-18 destructive-opt wohggez72 -- redundant duplicate of
    //  setComposeHeightUniforms(U) line ~454, same locator/value; one uniform call/frame saved, render identical.)
    _chuSet1f(U, _cck, 'uHazeMul',        _g('hazeMul', TD.hazeMul));        // aerial-perspective strength (2026-06-10 'pale hazy': 1.0 milked the midground)
    // SURFACE PHOTO-TEXTURES (TEXTURE6/7): triplanar grass/rock/sand/snow splat. hasSurfTex stays 0
    // until the async loader uploads (procedural-only fallback, no flash -- the splat fades in).
    const hasSurf = !!_surfAlb && !!_surfNrm;
    // uSurfAlb/uSurfNrm (TEXTURE6/7) pinned UNCONDITIONALLY every frame -- same discipline/rationale as
    // uShadowMap/hpfPool/hpfPool2/uHeightPool/uSceneTex above (TEXTURE1/3/5/8/9 dirty-cache desync
    // precedent, AGENTS.md): a JS-side "already bound, skip the rebind" cache is unsound whenever THREE's
    // own renderer.render() pass rebinds the SAME texture unit between mapspinner draws within one frame.
    // The prior last-bound-object skip (_lastSurfAlb !== _surfAlb) left units 6/7 vulnerable to exactly
    // that desync -- live-witnessed as a real GL_INVALID_OPERATION on drawElementsInstanced (726
    // occurrences in one ~12s cold-load session, AAA-push Sillos investigation 2026-08-09) whenever THREE
    // last touched unit 6 or 7 with an incompatible texture between two mapspinner terrain draws.
    const _surfTex = hasSurf ? _surfAlb : ensureDummySurfTex();
    const _surfTexN = hasSurf ? _surfNrm : _surfTex;
    gl.activeTexture(gl.TEXTURE0 + TU.surfAlb); gl.bindTexture(gl.TEXTURE_2D_ARRAY, _surfTex);
    _lastSurfAlb = _surfTex;
    _chuSet1i(U, _cck, 'uSurfAlb', TU.surfAlb);
    gl.activeTexture(gl.TEXTURE0 + TU.surfNrm); gl.bindTexture(gl.TEXTURE_2D_ARRAY, _surfTexN);
    _lastSurfNrm = _surfTexN;
    _chuSet1i(U, _cck, 'uSurfNrm', TU.surfNrm);
    _chuSet1f(U, _cck, 'uHasSurfTex', hasSurf ? 1.0 : 0.0);
    const _texTileM = _g('texTile', TD.texTile) * (R / 6360000.0);   // SCALE-INVARIANT (2026-06-17): the surface-texture repeat scales with the radius so the photo splat stays proportional to the terrain at ANY planet scale (the whole texture pyramid derives from this tile size). 1.0 at the 6360km design radius = no-op.
    _chuSet1f(U, _cck, 'uTexTileM',   _texTileM);  // metres per repeat (user: 24m read as noise/rock -- 100x bigger)
    // CAMERA-RELATIVE TEXTURE UV (2026-06-15 'UV jumps wildly up close'): reduce the camera world pos mod the
    // tile period in fp64 here on the CPU, pass the small remainder. The shader builds the UV from
    // (vTexRel + uTexCamFrac) so no 6.4e6m fp32 quantization reaches the texture coord. Dropping whole tiles is
    // REPEAT-wrap-invariant -> world-anchored, seam-free.
    // WRAP PERIOD = 8 tiles, NOT 1 (2026-06-15 'texture normals popping/jumping at intervals as we move'):
    // the texture NORMAL pyramid samples FRACTIONAL octaves of wt (wt4*0.5 = wt*1, wt4*0.25 = wt*0.5). A 1-tile
    // camera-frac wrap shifts wt by exactly 1 -> integer-safe for albedo (wt*2) but a HALF-tile shift for the
    // wt*0.5 octave = a different texel = the normal pops every time the camera crosses a tile boundary. Wrap on
    // 8*tileM so the dropped amount shifts wt by 8 -> every octave down to wt*0.125 stays integer-aligned (no pop).
    // NOT dirty-cached: derived from cam.eye, genuinely changes every moving frame (the common case anyway).
    const _wrapM = _texTileM * 8.0;
    gl.uniform3f(U('uTexCamFrac'),
      cam.eye[0] - Math.floor(cam.eye[0] / _wrapM) * _wrapM,
      cam.eye[1] - Math.floor(cam.eye[1] / _wrapM) * _wrapM,
      cam.eye[2] - Math.floor(cam.eye[2] / _wrapM) * _wrapM);
    _chuSet1f(U, _cck, 'uTexNrmK',    _g('texNrmK', TD.texNrmK));   // user-dialed 2026-06-15 2.0->1.0 (live window.__texNrmK). texture detail-normal strength
    _chuSet1f(U, _cck, 'uBiomeTint',  _g('biomeTint', TD.biomeTint)); // macro biome color mixed over the texture (2026-06-15 'doesnt look like the texture color' -- was hard 0.5)
    _chuSet1f(U, _cck, 'uTexBright',  _g('texBright', TD.texBright)); // overall ground brightness
    _chuSet1f(U, _cck, 'uTexSat',     _g('texSat', TD.texSat));     // texture chroma saturation (>1 = more vivid photo hue)
    _chuSet1f(U, _cck, 'uXSoft',      _g('xSoft', TD.xSoft));     // crossover fade HALF-WIDTH (window.__xSoft): the A/B crossover is now ONE constant-width directional fade; width is CONSTANT (warp shifts position only) -- user 2026-06-17 redesign
    _chuSet1f(U, _cck, 'uXFinger',    _g('xFinger', TD.xFinger));    // near-field displacement fingering amount (window.__xFinger); fades to 0 with distance so the mipped/far crossover is a SIMPLE over->under fade, no band (user 2026-06-17)
    _chuSet1f(U, _cck, 'uOrdPush',    _g('ordPush', TD.ordPush));    // overlay-priority POSITIONAL push (window.__ordPush): the covering material (sand<rock<grass<snow) expands over the band -> grass covers the grass<->sand band so it never reads green sand (user 2026-06-17)
    _chuSet1f(U, _cck, 'uBiomeWarp',  _g('biomeWarp', TD.biomeWarp));  // biome-distribution domain-warp amount (window.__biomeWarp). 1.0->1.6 (user 2026-06-16 'narrow the biome band, the elevation band is ok'): a stronger warp wiggles the biome boundaries enough to break the WIDE blobs into smaller fingered patches = narrower effective bands. 0 = raw anchor blobs; tune live in the Tweaks panel.
    _chuSet1f(U, _cck, 'uNrmLow',     _g('nrmLow', TD.nrmLow));     // low-octave rock normal strength (2026-06-15 'dont see lower-freq octave normals')
    _chuSet1f(U, _cck, 'uXFade0',     _g('xFade0', TD.xFade0));   // crossover-displacement fade start (m) (user 2026-06-15: gone by 10km, want it to hold further)
    _chuSet1f(U, _cck, 'uXFade1',     _g('xFade1', TD.xFade1));  // crossover-displacement fade end (m) -- 'fully faded by ~20km would be more appropriate'
    _chuSet1f(U, _cck, 'uTriSharp',   _g('triSharp', TD.triSharp));     // triplanar weight exponent (2026-06-15 ^8 'normals flipping between two states' -> 4 smooth)
    _chuSet1f(U, _cck, 'uNrmFade0',   _g('nrmFade0', TD.nrmFade0)); // normal-texture fade start (m) -- DOUBLED from 20km (2026-06-15)
    _chuSet1f(U, _cck, 'uNrmFade1',   _g('nrmFade1', TD.nrmFade1)); // normal-texture fade end (m) -- DOUBLED from 40km
    _chuSet1f(U, _cck, 'uOctFar0',    _g('octFar0',  TD.octFar0));  // coarse-albedo-octave blend start (pxWorld m) (__octFar0)
    _chuSet1f(U, _cck, 'uOctFar1',    _g('octFar1',  TD.octFar1));  // coarse-albedo-octave blend end (pxWorld m) (__octFar1)
    _chuSet1f(U, _cck, 'uBandWarp',   _g('bandWarp', TD.bandWarp));  // snow/rock/BEACH band warp amplitude (m), low-freq (2026-06-15 'use the snow warp on the beach too')
    _chuSet1f(U, _cck, 'uBeachWidth', _g('beachWidth', TD.beachWidth));   // grass<->beach crossover band width x beachTop (2026-06-15 'band super narrow, displacement does little') -- wide = displacement-fingered shoreline
    _chuSet1f(U, _cck, 'uTexFar0',    _g('texFar0', TD.texFar0));      // splat->biome far-fade start (pxWorld m). User baked 0 = the splat fades from the deck out.
    _chuSet1f(U, _cck, 'uTexFar1',    _g('texFar1', TD.texFar1));  // splat->biome far-fade end (pxWorld m). WIDENED to 12000 (user 2026-06-16 'widen the fade band'): the baked 2000 squeezed the splat->macro detail-normal+albedo handoff into a narrow band = a visible LIT RING; spreading the END to 12000 makes the handoff gradual so the ring disappears.
    _chuSet1f(U, _cck, 'uTexMix',     _g('texMix', TD.texMix));     // splat blend amount (0 = off)
    _chuSet1f(U, _cck, 'uTexWarp',    _g('texWarp', TD.texWarp));    // anti-repetition warp amplitude (-30% from 0.325, grass warp too intense)
    _chuSet1f(U, _cck, 'uTexPhoto',   _g('texPhoto', TD.texPhoto));    // raw photo-color fraction (0 = patch matches the macro shade exactly)
    _chuSet1f(U, _cck, 'uTexPhotoNear', _g('texPhotoNear', TD.texPhotoNear));  // near-field material identity (photo hue at macro luminance; user 2026-06-12 'must be either grass or sand')
    _chuSet4f(U, _cck, 'uSurfMeanL', _surfMeanL[0], _surfMeanL[1], _surfMeanL[2], _surfMeanL[3]);   // per-layer mean linear luminance (shade-match divisor)
    // LIVE A/B ISOLATION TOGGLES (window.__rockBump / __chroma / __strata, default 1 = no change). Flip one
    // to 0 in the console to disable that detail layer and see which produces the close-up uv scramble.
    _chuSet1f(U, _cck, 'uFlatNormal',      _g('flatNormal', TD.flatNormal));   // 1 = smooth analytic normal (isolate the geometric-normal scramble)
    _chuSet1f(U, _cck, 'uReliefShade',    _g('reliefShade', TD.reliefShade));   // user-dialed 2026-06-15 5.0->1.8 (live window.__reliefShade). landscape/macro-slope normal exaggeration
    _chuSet1f(U, _cck, 'uSkyFill',        _g('skyFill', TD.skyFill));
    _chuSet1f(U, _cck, 'uTerminatorGlow', _g('terminatorGlow', TD.terminatorGlow));
    _chuSet1f(U, _cck, 'uNightLights',    _g('nightLights', TD.nightLights));   // night/shadow FILL intensity (dim ambient lift so dark areas are not black); 0 = off
    _chuSet1f(U, _cck, 'uNightFloor',     _g('nightFloor', TD.nightFloor));   // night-longitude terminator floor RAISED 0.05->0.16 (no black night terrain)
    _chuSet1f(U, _cck, 'uTermWidth',      _g('termWidth', TD.termWidth));
    _chuSet1f(U, _cck, 'uExposure',       _g('exposure', TD.exposure));
    _chuSet1f(U, _cck, 'uLookSat',        _g('lookSat', TD.lookSat));
    _chuSet1f(U, _cck, 'uLookContrast',   _g('lookContrast', TD.lookContrast));
    { const o3=(n,d)=>{ const w=(typeof window!=='undefined'&&window['__'+n])||null; const v=(Array.isArray(w)&&w.length===3)?w:d; _chuSet3f(U, _cck, n, v[0],v[1],v[2]); };
      o3('uOceanDeep',TD.uOceanDeep); o3('uOceanShallow',TD.uOceanShallow); o3('uOceanK',TD.uOceanK); }   // K halved (user 2026-06-14 'see the land under the water properly') = clearer water, bed visible through shallow/medium depth; deep basins still opaque
    // (the continuous broad-shape field is now always on - the single terrain shape source -
    // so its old on/off lever uniform was removed from terrain.glsl; nothing to set here.)
    // LIVE biome ramp (window.__gen.state.biome, else tuned defaults) -- full-adjustability.
    { const bm = (typeof window!=='undefined' && window.__gen && window.__gen.state && window.__gen.state.biome) || null;
      const C = (k,d)=> (bm && bm[k]) ? bm[k] : d;
      const c3 = (n,d)=>{ const v=C(n,d); _chuSet3f(U, _cck, n, v[0],v[1],v[2]); };
      c3('bcDeepSea',TD.bcDeepSea); c3('bcSea',TD.bcSea); c3('bcShore',TD.bcShore);
      c3('bcLowland',TD.bcLowland); c3('bcGrass',TD.bcGrass);
      // bcRock follows the ROCK PHOTO mean once loaded (user 2026-06-10 'replace the original rock
      // completely'): the far-field macro rock shade matches the near-field photo so the 15-20km
      // fade has no color pop. Falls back to the tuned grey-tan until the loader lands.
      c3('bcRock', (typeof window!=='undefined' && window.__surfRockMean) || TD.bcRock);
      c3('bcSnow',TD.bcSnow);
      const e=C('bandEdgesLo',TD.bandEdgesLo); _chuSet2f(U, _cck, 'bandEdgesLo', e[0],e[1]);
      const eh=C('bandEdgesHi',TD.bandEdgesHi); _chuSet2f(U, _cck, 'bandEdgesHi', eh[0],eh[1]);   // [1600,3200]->[3500,6500] (2026-06-10 'rockface everywhere': tuned pre-4x; with 11.6km peaks everything above 3200m was height-rock -- rescale the treeline)
      const sn=C('snowEdges',TD.snowEdges); _chuSet2f(U, _cck, 'snowEdges', sn[0],sn[1]);   // 8000/10500->6000/8500 (user 2026-06-11 'all the snowy mountains have disappeared': only ~1% of land tops 8km (probe 3000-dir sweep, over7k 1.3%), so the whiteout-era snowline left virtually every massif bare; the whiteout's other sources (pre-rescale rock gates, alpine ice bias, tundra grey) are fixed independently, so 6km onset re-caps the real mountains without re-whitening the terrain)
      _chuSet1f(U, _cck, 'seaDepthM', C('seaDepthM',TD.seaDepthM));
      const sr=C('slopeRock',TD.slopeRock); _chuSet2f(U, _cck, 'slopeRock', sr[0],sr[1]); }   // [0.25,0.55] USER-SET 2026-06-12 (matches terrain-gen-controls persisted default)
    gl.uniform3f(U('sunDir'), sunDir[0],sunDir[1],sunDir[2]);
    gl.uniform1i(U('displayMode'), cam.displayMode||0);
    // HOST-ENGINE SHADOW BRIDGE (terrain-shadow-bridge-never-wired): cam.shadowInfo threads from
    // planet-orchestrator.js's frame() 9th arg (TerrainBackdrop.js's _buildShadowInfo). undefined/
    // hasShadow-false -> uHasShadow=0, terrain.glsl's sampleHostShadow fails open to fully-lit (no
    // regression to the pre-bridge look). TEXTURE1 (free: 0,3,4,5,6,7,8,9 already claimed by hpf/
    // surf/height-pool/scene-copy/vdrs-depth). The depth texture already carries THREE's own
    // COMPARE_REF_TO_TEXTURE mode (set once by WebGLShadowMap for PCFShadowMap) -- bind-only, no
    // texParameteri here, so this never fights THREE's own shadow-map texture state.
    const _si = cam.shadowInfo;
    // uShadowMap's sampler-unit uniform must be set EVERY frame regardless of shadow availability: a
    // sampler2DShadow uniform never explicitly assigned defaults to texture unit 0, and unit 0 is
    // where passUpscaleToCanvas/passPlanetDepthWriteback bind a plain TEXTURE_2D (_vdrsColor/
    // _vdrsDepth) -- a shadow-comparison sampler pointed at a unit holding a non-shadow TEXTURE_2D
    // produces "GL_INVALID_OPERATION: two textures of different types use the same sampler location"
    // on drawElementsInstanced, even on scenes with no shadow-casting light configured (uHasShadow=0
    // still reaches this code path every frame). Pin it to unit 1 unconditionally, same fix shape as
    // uHeightPool above.
    _chuSet1i(U, _cck, 'uShadowMap', TU.shadow);
    if (_si && _si.hasShadow && _si.texture) {
      // uShadowTexelSize/uShadowBias/uHasShadow are static light config (mapSize/bias set once,
      // hasShadow only flips on shadow becoming (un)available) -- route through the same dirty-cache
      // idiom as every other uniform in this function instead of re-uploading every frame.
      // The texture bind is UNCONDITIONAL every frame (dirty-cache skip REMOVED, 2026-07-10): THREE's
      // own renderer.render() call (the RenderGraph's later scene-color node) rebinds TEXTURE1 for its
      // OWN materials sometime between one mapspinner terrain draw and the next -- live-witnessed via
      // gl.getParameter(TEXTURE_BINDING_2D) at unit 1 showing a bound texture whose TEXTURE_COMPARE_MODE
      // was NONE (not COMPARE_REF_TO_TEXTURE) even though _lastShadowTex still equalled the dummy/real
      // shadow texture object -- the JS-side dirty-cache sentinel only tracks what MAPSPINNER itself
      // last bound, it has no visibility into THREE's own rebinds, so the skip left THREE's leftover
      // non-shadow-compare texture bound at unit 1 into the next terrain draw, producing "GL_INVALID_
      // OPERATION: mismatch between texture format and sampler type" on EVERY frame. A third party that
      // can invalidate a JS-side texture-bind cache between draws makes that cache unsound; correctness
      // requires an unconditional rebind here (this is a plain activeTexture+bindTexture call, not the
      // expensive uniform upload, so the perf cost of dropping the skip is negligible).
      gl.activeTexture(gl.TEXTURE0 + TU.shadow);
      gl.bindTexture(gl.TEXTURE_2D, _si.texture);
      _lastShadowTex = _si.texture;
      gl.uniformMatrix4fv(U('uShadowMatrix'), false, _si.matrix);   // genuinely per-frame (camera/sun-relative)
      _chuSet1f(U, _cck, 'uHasShadow', 1.0);
      _chuSet1f(U, _cck, 'uShadowTexelSize', 1.0 / (_si.mapSize || 1024));
      _chuSet1f(U, _cck, 'uShadowBias', _si.bias || 0.0);
    } else {
      // No real shadow map this frame: TEXTURE1 must still hold a shadow-comparison-configured
      // texture (see ensureDummyShadowTex) or the sampler2DShadow/non-shadow-texture format mismatch
      // fires on every draw. Unconditional rebind every frame (dirty-cache skip removed, same reasoning
      // as the real-shadow branch above -- THREE can clobber unit 1 between mapspinner draws).
      gl.activeTexture(gl.TEXTURE0 + TU.shadow);
      gl.bindTexture(gl.TEXTURE_2D, ensureDummyShadowTex());
      _lastShadowTex = 'dummy';
      _chuSet1f(U, _cck, 'uHasShadow', 0.0);
      if (typeof window !== 'undefined' && window.__wantShadowProbe) {
        gl.activeTexture(gl.TEXTURE0 + TU.shadow);
        window.__shadowProbeCompareMode = gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE);
        window.__shadowProbeBoundTex = !!gl.getParameter(gl.TEXTURE_BINDING_2D);
        window.__shadowProbeIsDummy = gl.getParameter(gl.TEXTURE_BINDING_2D) === _dummyShadowTex;
      }
    }
    // ---- animated ocean uniforms. time advances the Gerstner waves; amp/choppy read
    // from the HUD ocean sliders (window.__cam) with sane defaults for v1.
    const oc = (typeof window !== 'undefined' && window.__cam) || {};
    gl.uniform1f(U('oceanTime'), time || 0.0);
    gl.uniform1f(U('oceanAmp'), (oc.oceanAmplitude != null) ? oc.oceanAmplitude : 1.0);
    gl.uniform1f(U('oceanChoppy'), (oc.oceanChoppiness != null) ? oc.oceanChoppiness : 0.5);
    gl.uniform1f(U('oceanFoam'), (oc.oceanFoam != null) ? oc.oceanFoam : 0.5);
    gl.uniform1f(U('uBeachTopM'), _g('beachTop', TD.beachTop));    // beach ceiling: grass stops, sand to the waterline. 640->60 (user 2026-06-15 'distance from grass to water too high, huge beach' -- 640m put grass 640m up = a massive sand band; 60m = a normal coastal beach)

    // SINGLE INSTANCED DRAW: the deform params that were per-quad uniforms (ox,oy,l,level + face)
    // are now PER-INSTANCE attributes. Build one interleaved instance buffer [ox,oy,l,level,face]
    // (5 floats/instance) from the visible leaf set and issue ONE gl.drawElementsInstanced -- no
    // per-quad uniform churn, no N draw calls. defViewProjRel is one uniform shared by all instances.
    gl.uniformMatrix4fv(U('defViewProjRel'), false, viewProjRel);
    gl.uniform1f(U('defRadius'), R);
    // GEOMORPHING LOD (see terrain.glsl iMorph computation + quadtree.js _recurse's comment on why this
    // is quadtree-GLOBAL, never per-quad/per-instance): morphSplitDist/morphDistFactor/morphMaxLevel are
    // the SAME qt.splitDist/qt.distFactor/qt.maxLevel scalars for every instance in this draw call, so
    // they are plain per-frame uniforms, not instance-buffer fields -- the shader derives each vertex's
    // own morph ratio from its world distance to the camera, keyed only by (level, these 3 globals),
    // guaranteeing two adjacent same-level quads agree at a shared boundary vertex. cam.morph* default
    // to values that make the VS morph branch inert (0 splitDist -> gate off) so an older/foreign cam
    // object (no morph fields set) degrades to the pre-geomorph behavior, never NaN geometry.
    gl.uniform1f(U('uMorphSplitDist'), (cam && cam.morphSplitDist > 0) ? cam.morphSplitDist : 0.0);
    gl.uniform1f(U('uMorphDistFactor'), (cam && cam.morphDistFactor > 0) ? cam.morphDistFactor : 1.0);
    gl.uniform1f(U('uMorphMaxLevel'), (cam && cam.morphMaxLevel > 0) ? cam.morphMaxLevel : 0.0);
    const n = quads.length;
    // Instance buffer: [ox,oy,l,level,face, iLayer] (6 floats). iLayer = the THC pool layer for this
    // tile (when __thc on); the VS samples the baked height there instead of composeHeight.
    const FLOATS = 6;   // [ox,oy,l,level,face, iLayer]
    // ===== PASS BOUNDARY: terrain-tile-draw + half-res-water-color + water-depth-share +
    // half-res-water-composite (see _passManifest ids) =====
    // IN: quads, viewProjRel/composeHeight uniforms (set above). OUT: color, depth, _hrwColor.
    // These four manifest passes are named here as CONTIGUOUS SUB-REGIONS of one block, not split
    // into separate function bodies: the water sub-passes read 10+ single-computed local values from
    // the terrain-draw sub-region (_thc, _dirty, STRIDE, wn, _hrw, _waterHidden, _stampedThisFrame,
    // _sceneFbo) and the water-depth-share logic appears twice (inline in the visibility-probe at the
    // top of this block, and again as a fallback near the bottom when the probe is gated off) --
    // threading that much mutable state across a real function-call boundary is exactly the class of
    // edit this task's own "byte-for-byte" requirement warns against; a mis-threaded variable here
    // would silently change draw order or skip a stamp. Each sub-region below is marked with its own
    // "PASS:" comment naming its manifest id + the exact reads/writes, giving a host inspector the
    // SAME named-boundary information the manifest array already exports, with zero risk of a
    // GL-sequencing regression from moving tightly-coupled mutable state across function scopes.
    if (n > 0) {
      // ---- PASS: terrain-tile-draw -- reads: quads/composeHeight uniforms; writes: color, depth ----
      // THC: when active, ensure every visible tile has a baked pool layer (bake on first sight). The
      // bakes clobber the FBO/program/viewport -> restore the canvas render state afterward.
      const _thc = thcActive();
      let _layers = null;
      if (_thc) {
        _tcFrame++; _tcBakesThisFrame = 0;
        _layers = new Float32Array(n);
        for (let i = 0; i < n; i++) { const q = quads[i].quad; _layers[i] = ensureTileLayer(quads[i].face, q.ox, q.oy, q.l, q.level); }
        gl.bindVertexArray(null);   // bakeTileToLayer left bakeVao bound; the main path uses the default VAO
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.enable(gl.DEPTH_TEST);   // bakeTileToLayer disabled depth
        gl.useProgram(_activeProg);
        if (typeof window !== 'undefined') window.__thcBakes = _tcBakesThisFrame;
      }
      // STATIC-FRAME SKIP: rebuild only when the quad set changed OR the toggle flipped (iLayer needs writing).
      const _dirty = (quads !== _instQuadsRef) || (_thc !== _lastThc);
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      if (_dirty) {
        // FRONT-TO-BACK SORT (overdraw cut, 2026-06-15): emit instances near->far so hardware early-Z
        // rejects occluded far fragments BEFORE the expensive terrain FS runs (the terrain pass does not
        // discard, so early-Z is active). Pure draw-ORDER change -> the depth test owns correctness =
        // visual-neutral. CPU sort of n (~hundreds) on rebuild only (the static-frame cache skips it).
        // d2 = |cam.eye - quad sea-level world centre|^2; _faceFrames[face] = [u0..2,v0..2,c0..2] (col-major).
        // SCRATCH POOL (perf 2026-07-03): _d2/ord/inst reused across frames (grow-only), not reallocated
        // every _dirty frame -- see _ensureScratch. Same values, same layout, zero steady-state GC churn
        // while the camera moves (the common case: this branch fires whenever the sort order can change).
        _ensureScratch(n, FLOATS);
        const _d2 = _scrD2, ord = _scrOrd;
        const WK = Math.PI / 4.0;
        for (let i = 0; i < n; i++) {
          const q = quads[i].quad; const ff = _faceFrames[quads[i].face | 0];
          const cx = q.ox + q.l * 0.5, cy = q.oy + q.l * 0.5;
          const wx = R * Math.tan((cx / R) * WK), wy = R * Math.tan((cy / R) * WK);
          // OPTIMIZATION (ms-hypot-to-sqrt): wx,wy,R are world-meter magnitudes bounded by the planet
          // radius, far below float overflow range -- Math.hypot's overflow guard is unneeded overhead
          // in this per-visible-tile sort-key computation; sqrt-of-sum-of-squares is exact and cheaper.
          const il = 1.0 / (Math.sqrt(wx*wx + wy*wy + R*R) || 1);
          const dx = (wx*il)*ff[0] + (wy*il)*ff[3] + (R*il)*ff[6];
          const dy = (wx*il)*ff[1] + (wy*il)*ff[4] + (R*il)*ff[7];
          const dz = (wx*il)*ff[2] + (wy*il)*ff[5] + (R*il)*ff[8];
          const ex = dx*R - cam.eye[0], ey = dy*R - cam.eye[1], ez = dz*R - cam.eye[2];
          _d2[i] = ex*ex + ey*ey + ez*ez; ord[i] = i;
        }
        // subarray view over the live n (the backing store may be larger from a prior bigger frame);
        // Int32Array.prototype.sort is available and numeric-comparator-safe like Array.sort here.
        const ordN = (ord.length === n) ? ord : ord.subarray(0, n);
        ordN.sort((a, b) => _d2[a] - _d2[b]);
        const inst = (_scrInst.length === n * FLOATS) ? _scrInst : _scrInst.subarray(0, n * FLOATS);
        for (let k = 0; k < n; k++) {
          const i = ordN[k];
          const q = quads[i].quad;
          inst[k*FLOATS+0] = q.ox; inst[k*FLOATS+1] = q.oy; inst[k*FLOATS+2] = q.l; inst[k*FLOATS+3] = q.level;
          inst[k*FLOATS+4] = quads[i].face;
          inst[k*FLOATS+5] = _layers ? _layers[i] : 0.0;
        }
        gl.bufferData(gl.ARRAY_BUFFER, inst, gl.DYNAMIC_DRAW);
      }
      _lastThc = _thc;
      const STRIDE = FLOATS * 4;
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 0);          gl.vertexAttribDivisor(1, 1);  // iOffset
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 4 * 4);      gl.vertexAttribDivisor(2, 1);  // iFace
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 5 * 4);      gl.vertexAttribDivisor(3, 1);  // iLayer (THC pool layer)
      gl.uniform1f(U('uThc'), _thc ? 1.0 : 0.0);
      // uHeightPool's sampler-unit uniform must be set EVERY frame regardless of _thc: a sampler
      // uniform never explicitly assigned defaults to texture unit 0, and unit 0 is where
      // passUpscaleToCanvas/passPlanetDepthWriteback bind a plain TEXTURE_2D (_vdrsColor/_vdrsDepth)
      // on frames after the first -- a sampler2DArray uniform (uHeightPool) pointed at a unit
      // holding a TEXTURE_2D produces "GL_INVALID_OPERATION: two textures of different types use
      // the same sampler location" on drawElementsInstanced, even though the shader's _thc branch
      // never reads it. Pin it to unit 8 unconditionally so it never collides with unit 0.
      gl.uniform1i(U('uHeightPool'), TU.heightPool);
      if (_thc) {
        gl.activeTexture(gl.TEXTURE0 + TU.heightPool); gl.bindTexture(gl.TEXTURE_2D_ARRAY, heightPool);
        gl.uniform1f(U('uPoolRes'), THC_BAKE_RES); gl.uniform1f(U('uPoolLinear'), _halfFloatLinearOK ? 1.0 : 0.0);
      } else {
        // THC OFF (the default path): unit 8 must still hold SOME 2D_ARRAY texture object, or the
        // driver validates uHeightPool against an empty unit and throws GL_INVALID_OPERATION even
        // though the shader's _thc==0 branch never dynamically samples it -- witnessed live via
        // gl.getParameter(TEXTURE_BINDING_2D_ARRAY) at unit 8 returning null on this path while the
        // sampler uniform value was already 8. Bind the 1x1 dummy so unit 8 is never empty.
        gl.activeTexture(gl.TEXTURE0 + TU.heightPool); gl.bindTexture(gl.TEXTURE_2D_ARRAY, ensureDummyHeightPoolTex());
      }
      gl.uniform1f(U('uIsWater'), 0.0);
      gl.uniform1f(U('uOccludeDepth'), 0.0);   // terrain pass: no FS depth occlusion
      // UNDERWATER DETECTION: camera below sea level enables underwater shading + water surface
      // rendering from below. Set before the terrain draw so the FS can apply underwater fog.
      const _uw = camDist < R - 2.0;
      gl.uniform1f(U('uUnderwater'), _uw ? 1.0 : 0.0);
      // FIX (perf-regression-terrain-geomorph-default-off-plus-gl-errors-investigation): pin uSceneTex
      // (unit 9) to a valid dummy TEXTURE_2D before THIS terrain draw -- see ensureDummySceneTex's
      // comment above for the live-confirmed mechanism (unit 9/_sceneCopyTex is otherwise only ever
      // bound later, inside the water color-pass, which can be skipped or simply hasn't run yet on the
      // terrain draw). The water block's own real bind (line ~2176 below) always re-binds when it runs,
      // so this dummy is only ever actually sampled on a frame/branch that never reaches that code.
      gl.activeTexture(gl.TEXTURE0 + TU.sceneTex); gl.bindTexture(gl.TEXTURE_2D, ensureDummySceneTex());
      gl.uniform1i(U('uSceneTex'), TU.sceneTex);
      gl.drawElementsInstanced(gl.TRIANGLES, indices.length, gl.UNSIGNED_INT, 0, n);
      // (SCENE-COPY for water refraction moved INSIDE the water block below, 2026-07-05: it is
      // consumed only by the water FS, and the water-visibility gate must be able to skip it --
      // the full-res copyTexSubImage2D was a fixed per-frame cost even with zero water pixels.)
      // SEPARATE WATER SURFACE (user 2026-06-11): second instanced draw with uIsWater=1 -- the VS
      // pins the mesh to sea level, the FS shades animated water and alpha-blends it over the
      // just-rendered seabed. Depth test keeps it behind land; depthMask off so the transparent
      // surface never occludes later passes. One program, one uniform flip.
      // OWN GEOMETRY, NOT THE TERRAIN TILES (user 2026-06-11 'the terrain tiles should not be
      // used for water'): the water sphere needs no terrain LOD -- deep leaves are wasted vertices
      // (each runs composeHeight) and re-tessellate with terrain detail the flat surface never
      // shows. Cap every visible leaf at level WCAP and DEDUP to its ancestor tile: a coarse,
      // LOD-churn-free cover of the same footprint, typically ~10-50x fewer water vertices.
      // __waterSurface=0 disables live.
      // The water surface draws in BOTH cases now (user 2026-06-14 'no water surface visible from
      // underneath'): it's geometrically ABOVE the camera, so underwater it is the up-view CEILING
      // (Snell's window, shaded in the uUnderwater branch) and the seabed below stays visible (the
      // down-view ray never hits the surface). With the fog 10x lighter it no longer washes the floor.
      if (typeof window === 'undefined' || window.__waterSurface !== false) {
        // WCAP 7 -> 9 (coast witness caught it: a level-7 tile's 16-cell mesh chord sags
        // A_cell^2/(8R) ~ 0.8m below the true sphere mid-cell -- BELOW the metres-deep shelf
        // seabed, so the depth test culled the water across entire shorelines. Level-9 cells
        // (~1.6km) sag ~5cm, far under any visible bathymetry, still ~16-64x fewer water verts
        // than the deep terrain leaves.
        // WCAP 9 -> 11 (user 2026-06-14 'water lines still jagged and square, doesnt meet land properly'):
        // the water-pass `if(vH>1.0) discard` keys off the water mesh's COARSE interpolated seabed height,
        // so the discarded waterline stepped at ~1.6km (level-9) cells = square/jagged edges that didn't
        // follow the fine seabed coastline. Level-11 cells (~400m) -> ~4x finer waterline. Water-vertex
        // cost rises (watch FPS); still far fewer verts than the full-LOD terrain leaves.
        const WCAP = 11;
        // OWN persistent buffer (instBufWater) + static-frame skip: on an unchanged quad set, reuse the
        // cached water instances (skip the dedup Set-loop + Float32Array + bufferData). Separate buffer
        // means the terrain pass never clobbers it (the prior water-as-terrain regression root).
        gl.bindBuffer(gl.ARRAY_BUFFER, instBufWater);
        if (_dirty || quads !== _instWaterRef) {
          // SCRATCH POOL (perf 2026-07-03): wl was a plain push-based Array rebuilt (with a fresh Set)
          // every _dirty frame -- reallocates every camera-moved frame, the common case. The dedup Set
          // still allocates (its size is data-dependent, not a fixed capacity like the typed scratch
          // above) but the OUTPUT float buffer is now a grow-only typed-array write by index, matching
          // _ensureScratch's idiom -- output count is bounded by n so n*FLOATS is always sufficient.
          _ensureWaterScratch(n, FLOATS);
          const wl = _scrWl;
          const seen = _waterSeen; seen.clear(); let wc = 0;
          // Packed-integer dedup key (perf 2026-07-03): was a string concat (`face:ox:oy:l`) per
          // quad. Once snapped to the WCAP ancestor, ox/oy are exact multiples of the WCAP cell
          // size `l` (root spans [-size,size], each level exactly halves, so l evenly divides
          // 2*size) -- ox/l and oy/l are therefore exact integers in [-2^(WCAP-1), 2^(WCAP-1)-1]
          // (WCAP=11 -> [-1024,1023]). WKEY_BIG=4096 comfortably covers that range (offset by
          // WKEY_BIG>>1 to stay non-negative) with huge headroom (max packed value ~8.6e7, far
          // under 2^53) even if WCAP is raised later.
          const WKEY_BIG = 4096, WKEY_OFF = WKEY_BIG >> 1;
          for (let i = 0; i < n; i++) {
            const q = quads[i].quad; let ox = q.ox, oy = q.oy, l = q.l, lv = q.level;
            if (lv > WCAP) { const A = l * (1 << (lv - WCAP)); ox = Math.floor(ox / A) * A; oy = Math.floor(oy / A) * A; l = A; lv = WCAP; }
            const face = quads[i].face;
            const ix = Math.round(ox / l) + WKEY_OFF, iy = Math.round(oy / l) + WKEY_OFF;
            const key = (face * WKEY_BIG + iy) * WKEY_BIG + ix;
            if (seen.has(key)) continue; seen.add(key);
            wl[wc*FLOATS+0]=ox; wl[wc*FLOATS+1]=oy; wl[wc*FLOATS+2]=l; wl[wc*FLOATS+3]=lv;
            wl[wc*FLOATS+4]=face; wl[wc*FLOATS+5]=0;   // iLayer unused for water (VS pins sea level)
            wc++;
          }
          _instWaterN = wc;
          const wlView = (wl.length === wc * FLOATS) ? wl : wl.subarray(0, wc * FLOATS);
          gl.bufferData(gl.ARRAY_BUFFER, wlView, gl.DYNAMIC_DRAW);
          _instWaterRef = quads;
        }
        const wn = _instWaterN;
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 0);     gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 4 * 4); gl.vertexAttribDivisor(2, 1);
        // FIX (instanced-draw-sampler-type-collision-new-instance, non-deterministic
        // GL_INVALID_OPERATION on this drawElementsInstanced): the terrain draw immediately above
        // enables+points location 3 (iLayer, layout(location=3) in terrain.glsl, a REAL active
        // attribute in the shared terrain/water program) at instBuf (the terrain instance buffer,
        // sized for this frame's terrain quad count). This water draw only re-pointed locations 1
        // and 2 into instBufWater, leaving location 3 enabled but STILL bound to the stale terrain
        // buffer with the terrain's per-frame size/content -- live-confirmed via a buffer-identity
        // capture (bufId 27 = instBuf vs bufId 28 = instBufWater) that location 3 at this exact draw
        // pointed at instBuf while 1/2 correctly pointed at instBufWater, causing WebGL2 attribute-
        // buffer validation to fail (non-deterministically, since the divergence in size/content
        // between the two differently-sized dynamic buffers varies frame to frame). Re-point
        // location 3 into instBufWater (offset 20 = same iLayer field the water dedup loop already
        // writes as 0 at wl[...+5]) so every enabled attribute for this draw call is self-consistent
        // with instBufWater's own instance count, matching the terrain draw's own pattern.
        gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 5 * 4); gl.vertexAttribDivisor(3, 1);
        // HALF-RES WATER: redirect the water draw into a half-res FBO (gated, default on above water --
        // the underwater up-view is a thin ceiling, render it full-res to keep Snell's-window crisp).
        const _sceneFbo = (_vdrsRsThisFrame > 0) ? _vdrsFbo : null;   // scene target this frame (vdrs FBO when half-res water forced it on)
        // _hrw REQUIRES the scene to be in the vdrs FBO (_sceneFbo set): the half-res depth blit reads
        // _sceneFbo's depth, which fails from the default framebuffer. On any frame where the scene went
        // straight to canvas (e.g. a THC-bake frame where _vrs=0), fall back to FULL-RES water -- doing
        // half-res there left the water un-occluded for that frame = the intermittent terrain-over-water
        // FLASH (user 2026-06-24). Tying _hrw to _sceneFbo keeps the two in lockstep, no per-frame race.
        const _hrw = (typeof window==='undefined' || window.__halfResWater!==false) && !_uw && _sceneFbo === _vdrsFbo;
        // ---- WATER VISIBILITY PROBE (see _waterVisQ declaration for the design).
        // Draws the coarse water mesh color-masked-off, wrapped in a conservative occlusion query.
        // The previous frame's resolved query decides whether the expensive color pipeline below runs
        // at all this frame. Since 2026-08-23 the probe is a PURE COVERAGE query (depthFunc ALWAYS,
        // depthMask off, double-sided, uWaterVisProbe=1 skips the vH>1 discard) -- it can only
        // OVER-report visibility, which is the only safe direction for a gate (see the fix comment at
        // the draw below for the three independent ways the old depth-tested/stamping probe under-
        // reported and gated the ocean off entirely). It no longer stamps depth; the late stamp below
        // owns the water depth representation.
        let _waterHidden = false, _stampedThisFrame = false;
        // GRAZING-ANGLE PROBE UNRELIABILITY (fix: water streaks to a 1px line / flashes+re-appears near
        // the surface): the visibility probe draws the COARSE flat wvbo/wibo mesh (~400m WCAP=11 cells,
        // only the 0.8m swell displacement applied) -- at low camera altitude the probe is viewed almost
        // edge-on, so its screen footprint is a sub-pixel-thin silhouette that straddles the rasterizer's
        // sample-or-not boundary FRAME TO FRAME even with the camera perfectly still (witnessed live:
        // gl.getQueryParameter(QUERY_RESULT) toggling 0/1 on a static grazing pose over open water, no
        // camera motion). The actual COLOR pass is not this flat mesh -- it raymarches the animated wave
        // surface per-pixel (see the raymarch block above) and covers far more of the screen than the
        // flat probe at grazing incidence, so the probe's "conservative" guarantee (documented above as
        // "only ever over-reports visibility") does NOT hold here: it under-reports, and the 2-frame
        // hysteresis hides a color pass that would in fact have covered most of the view. Bypass the gate
        // (treat as always-visible) below a safe altitude margin -- comfortably above the deck (~1.5-2m
        // eye height) where this was witnessed collapsing the water to a streak / flashing it on and off.
        // ---- PASS: water-visibility-probe -- reads: nothing; writes: occlusion query ----
        const WATER_PROBE_GRAZING_UNRELIABLE_ABOVE_ALT_M = 2000.0;
        const _waterProbeReliable = alt >= 5.0 && alt < WATER_PROBE_GRAZING_UNRELIABLE_ABOVE_ALT_M;
        if (_hrw && _waterProbeReliable && typeof window !== 'undefined' && window.__planetDepthToCanvas === true
            && window.__waterDepthShareOff !== true && window.__waterVisGate !== false) {
          if (!_waterVisQ) _waterVisQ = gl.createQuery();
          if (_waterVisQPending && gl.getQueryParameter(_waterVisQ, gl.QUERY_RESULT_AVAILABLE)) {
            _waterVisZeroRuns = gl.getQueryParameter(_waterVisQ, gl.QUERY_RESULT) ? 0 : _waterVisZeroRuns + 1;
            _waterVisQPending = false;
          }
          _waterHidden = _waterVisZeroRuns >= 2;   // 2-frame hysteresis before gating off
          if (typeof window !== 'undefined') window.__waterVisDebug = { zeroRuns: _waterVisZeroRuns, pending: _waterVisQPending, hidden: _waterHidden };
          gl.colorMask(false, false, false, false);
          gl.disable(gl.BLEND);
          // PURE COVERAGE PROBE (fix 2026-08-23, supersedes the depth-stamped probe): the probe draw is
          // now a rasterization-coverage query ONLY -- depthFunc ALWAYS + depthMask(false) + double-sided
          // + uWaterVisProbe=1 (FS skips the vH>1 land discard). Live isolation at a shoreline pose
          // (scripts/depth-cut-probe.mjs, 4-config A/B): the depth test, the vH discard and the winding
          // EACH independently zeroed the coarse mesh's samples (coarse sphere chords sag under the shelf
          // seabed; coarse-interpolated vH>1 across the visible sliver; top-surface winding), so the
          // query returned 0 for ~90% of frames while water filled a third of the screen ->
          // _waterHidden -> the whole water color pipeline gated off = ocean rendered as bare sand with a
          // black band at the far waterline (the "ground depth swallows everything" report). A coverage
          // probe with no depth/discard/cull can only OVER-report visibility -- the safe direction for a
          // conservative gate (water behind a mountain keeps the color pass on: correct image, small perf
          // cost). The old draw's depth-stamp role is dropped entirely: readbacks proved it NEVER wrote
          // depth (identical _vdrsDepth with the probe on vs off), while claiming _stampedThisFrame
          // suppressed the LATE stamp that actually works -- so water had NO depth representation at all
          // in hrw mode. _stampedThisFrame now stays false here and the late stamp owns water depth.
          gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS); gl.depthMask(false);
          gl.disable(gl.CULL_FACE);
          gl.uniform1f(U('uIsWater'), 1.0);
          gl.uniform1f(U('uOccludeDepth'), 0.0);
          gl.uniform1f(U('uDepthOnly'), 1.0);      // cheap FS: no shading ALU
          gl.uniform1f(U('uWaterVisProbe'), 1.0);  // skip the vH>1 land discard (see comment above)
          gl.bindBuffer(gl.ARRAY_BUFFER, wvbo); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wibo);
          // FIX (perf-regression-terrain-geomorph-default-off-plus-gl-errors-investigation, live-confirmed
          // STILL-FIRING 864-byte-buffer GL_INVALID_OPERATION on THIS drawElementsInstanced, distinct call
          // site from the wave-8 color-pass fix above): re-assert locations 1/2/3 into instBufWater
          // (matching the color-pass draw's own pattern) immediately before this water-visibility-probe
          // draw. wvbo/wibo's bindBuffer(ARRAY_BUFFER,...) above only rebinds the CURRENT ARRAY_BUFFER
          // target for the *next* vertexAttribPointer call (attribute 0 here) -- it does not touch
          // locations 1/2/3's own buffer bindings, which are captured at their own vertexAttribPointer
          // call time. Explicitly re-pointing here removes any dependency on frame-to-frame ordering
          // between this probe and the color-pass setup (e.g. a skipped/reordered pass leaving 1/2/3
          // referencing a stale-sized buffer) -- self-contained per-draw correctness, same fix shape as
          // the already-shipped color-pass fix, applied to the 3 other wvbo/wibo water draws too.
          gl.bindBuffer(gl.ARRAY_BUFFER, instBufWater);
          gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 0);     gl.vertexAttribDivisor(1, 1);
          gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 4 * 4); gl.vertexAttribDivisor(2, 1);
          gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 5 * 4); gl.vertexAttribDivisor(3, 1);
          const _issueQ = !_waterVisQPending;
          if (_issueQ) gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, _waterVisQ);
          gl.drawElementsInstanced(gl.TRIANGLES, waterIndices.length, gl.UNSIGNED_INT, 0, wn);
          if (_issueQ) { gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE); _waterVisQPending = true; }
          if (typeof window !== 'undefined') window.__waterProbeGLErr = gl.getError();
          gl.depthFunc(gl.LESS); gl.depthMask(true);
          gl.enable(gl.CULL_FACE);
          gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
          gl.uniform1f(U('uIsWater'), 0.0);
          gl.uniform1f(U('uDepthOnly'), 0.0);
          gl.uniform1f(U('uWaterVisProbe'), 0.0);
          gl.colorMask(true, true, true, true);
          // NO _stampedThisFrame here: this draw writes no depth (depthMask off) -- the late stamp
          // (below, gated on !_stampedThisFrame) owns the water depth representation now.
          if (_waterHidden) window.__waterVisSkips = (window.__waterVisSkips|0) + 1;
        }
        // ---- PASS: half-res-water-color -- reads: color (scene copy), depth; writes: color/_hrwColor ----
        if (!_waterHidden) {
        // SCENE-COPY for water refraction: snapshot the rendered terrain into _sceneCopyTex so the
        // water FS can sample it with a wave-normal UV offset. copyTexSubImage2D is a GPU-side blit
        // (no CPU readback, no allocation). Reads the CURRENTLY BOUND framebuffer (_vdrsFbo on hrw
        // frames, canvas otherwise) -- skipped entirely when the visibility gate proved no water.
        ensureSceneCopy(_vW, _vH);
        gl.activeTexture(gl.TEXTURE0 + TU.sceneTex); gl.bindTexture(gl.TEXTURE_2D, _sceneCopyTex);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, _vW, _vH);
        gl.uniform1i(U('uSceneTex'), TU.sceneTex);
        gl.uniform2f(U('uResolution'), _vW, _vH);
        let _hrwVW=0, _hrwVH=0;
        if (_hrw) {
          _hrwVW = Math.max(1, _vW>>1); _hrwVH = Math.max(1, _vH>>1);
          ensureHrwTargets(_hrwVW, _hrwVH);
          // NO DEPTH OCCLUSION in the half-res pass: a cross-size depth blitFramebuffer (full->half) was
          // BROKEN on NVIDIA/ANGLE (rejected most water -- confirmed same-pose A/B on an RTX 3060), and a
          // depth-texture + FS-sample approach hit a sampler-unit collision that blacked out terrain. So
          // the half-res water draws with NO depth test; the vH>1 discard drops water directly under land.
          // Distant-mountain-occluding-water is rare at the deck and parked for a later portable fix.
          gl.bindFramebuffer(gl.FRAMEBUFFER, _hrwFbo);
          gl.viewport(0,0,_hrwVW,_hrwVH);
          gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
          gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
          // Occlude the half-res water against the full-res scene DEPTH TEXTURE in the FS (portable; the
          // cross-size depth blit was NVIDIA-broken). Bind on a FREE unit (4 -- terrain uses 0/3/5/6/7/8/9)
          // and UNBIND it before the composite (the composite rebinds _vdrsFbo as the target, and sampling
          // its depth attachment while attached = feedback loop = black on NVIDIA).
          gl.activeTexture(gl.TEXTURE0 + TU.sceneDepth); gl.bindTexture(gl.TEXTURE_2D, _vdrsDepth); gl.uniform1i(U('uSceneDepth'), TU.sceneDepth);
          gl.uniform1f(U('uOccludeDepth'), 1.0);
          gl.uniform2f(U('uResolution'), _hrwVW, _hrwVH);   // refraction screenUV = fragCoord/halfRes -> samples full-res uSceneTex
        }
        if (_uw) {
          gl.disable(gl.BLEND);
          gl.depthMask(true);
        } else {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
        }
        // TWO-SIDED ONLY UNDERWATER (user 2026-06-24): the underside is needed only for the up-view
        // from below sea level (uUnderwater). ABOVE water, drawing two-sided meant the FAR-SIDE water
        // sphere back-faces rendered too -- and in the half-res pass (no shared depth before this fix)
        // they composited OVER the scene ('backface water drawing over the scene'). Above water, keep
        // back-face culling so only the near surface draws; the depth blit above occludes the rest.
        // GRAZING-ALTITUDE WINDING-FLIP FIX (ground-depth-cut black-band ROOT CAUSE, witnessed live
        // 2026-08-22 at site (707,707), gy=-21.63, curved waterline -18.8, _uw=false, yaw pi/4):
        // with the eye within ~2 m of the effective water sphere (camAlt -0.9 -> hard black horizon
        // band; -1.85 -> flat slab), the camera-relative VS projection FLIPS the projected winding of
        // the distant water surface, so this hardcoded cullFace(FRONT) culled the ENTIRE visible
        // ocean -> zero water fragments (mode-10 constant-magenta FS probe: no magenta in the band;
        // mode-11 discard->magenta: not vH>1 fragments either) -> a coverage gap that drawSky's
        // sub-horizon radiance (black by design: atmosphere has no ground) showed through as the hard
        // band. A/B: __cullMode='none' fills the band with water (graze4_cullNone_dy2.jpg). The older
        // comment's "winding is altitude-invariant" only holds for |camAlt| > ~5 m. Disable culling
        // inside that thin-shell regime: correctness is already carried by the vH>1 discard + the
        // hardware depth test (the underside loses to the top surface), and an edge-on double-sided
        // shell costs nothing measurable. Outside the regime the FRONT cull is unchanged (no retune).
        const _waterCullFront = !_uw && !(Math.abs(camAlt) < 5.0);
        if (!_waterCullFront) gl.disable(gl.CULL_FACE); else { gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT); gl.frontFace(gl.CCW); }   // FRONT = match the terrain cull (shows the near/top water surface, drops the far-side back-faces)
        gl.uniform1f(U('uIsWater'), 1.0);
        // Bind the COARSE water mesh (wvbo/wibo) for attrib 0 -- far fewer verts than the terrain GRID
        // mesh, the measured ~12ms->lower deck win. Restore the terrain mesh (vbo/ibo) after the draw.
        gl.bindBuffer(gl.ARRAY_BUFFER, wvbo); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wibo);
        // FIX (perf-regression-terrain-geomorph-default-off-plus-gl-errors-investigation): re-assert
        // locations 1/2/3 into instBufWater before this draw and the depth-stamp draw immediately below
        // -- same fix shape as the color-pass fix above and the water-visibility-probe fix, self-contained
        // per-draw correctness independent of whatever ran (or was skipped) earlier this frame.
        gl.bindBuffer(gl.ARRAY_BUFFER, instBufWater);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 0);     gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 4 * 4); gl.vertexAttribDivisor(2, 1);
        gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 5 * 4); gl.vertexAttribDivisor(3, 1);
        gl.drawElementsInstanced(gl.TRIANGLES, waterIndices.length, gl.UNSIGNED_INT, 0, wn);
        // TEMP DIAGNOSTIC (window.__passProbe): frame right after the water COLOR draw -- did it
        // paint above the horizon (far-side backfaces)? Captures _hrwColor (half-res target).
        if (typeof window !== 'undefined' && window.__passProbe === true) {
          const _cc = gl.getParameter(gl.CULL_FACE), _cm2 = gl.getParameter(gl.CULL_FACE_MODE), _ff = gl.getParameter(gl.FRONT_FACE);
          (window.__passProbeLog = window.__passProbeLog || []).push('water-color draw: cullEnabled=' + _cc + ' cullFace=' + (_cm2 === gl.FRONT ? 'FRONT' : 'BACK') + ' frontFace=' + (_ff === gl.CCW ? 'CCW' : 'CW') + ' _hrw=' + _hrw + ' quads=' + wn + ' _uw=' + _uw + ' camAlt=' + camAlt.toFixed(2) + ' eyeY=' + eye[1].toFixed(2));
          if (_hrw && _hrwColor && _hrwW > 0) _passProbeSnap('water-color-hrw', _hrwColor, _hrwW, _hrwH);
          else if (!_hrw) _passProbeSnap('water-color-direct-canvas', null, 0, 0);
        }
        // DIRECT-PATH WATER DEPTH STAMP (2026-07-05, iGPU perf): with half-res water DISABLED
        // (__halfResWater=false) the scene renders straight into the canvas, so the canvas depth buffer
        // already carries terrain depth natively -- but the above-water color draw ran with
        // depthMask(false), so the WATER surface left no depth and a consumer object BELOW the surface
        // would draw OVER the water (the exact bug the _hrw path's _vdrsFbo depth-only redraw fixes).
        // Stamp the water depth here with the SAME depth-only trick (colorMask off, uDepthOnly=1 skips
        // the water shading ALU; the FS vH>1 discard keeps land-fronting terrain winning). Water mesh +
        // attribs are still bound from the color draw. Gated on the consumer's shared-depth opt-in.
        // ---- PASS: water-depth-share (direct-path variant) -- reads: water mesh; writes: depth ----
        if (!_hrw && !_uw && typeof window !== 'undefined' && window.__planetDepthToCanvas === true && window.__waterDepthShareOff !== true) {
          gl.colorMask(false, false, false, false);
          gl.depthMask(true); gl.disable(gl.BLEND);
          gl.uniform1f(U('uDepthOnly'), 1.0);
          gl.drawElementsInstanced(gl.TRIANGLES, waterIndices.length, gl.UNSIGNED_INT, 0, wn);
          gl.uniform1f(U('uDepthOnly'), 0.0);
          gl.colorMask(true, true, true, true);
          window.__waterDepthShared = (window.__waterDepthShared|0) + 1;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.uniform1f(U('uIsWater'), 0.0);
        gl.enable(gl.CULL_FACE);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        // HALF-RES WATER COMPOSITE: restore the scene FBO + full viewport, then alpha-blend the half-res
        // water color over the full-res terrain via the existing fullscreen-tri upscale program (LINEAR
        // upsample). The water's coverage alpha (1 where water, 0 on the cleared/discarded pixels) gates
        // the blend so land is untouched. Restore the main program after.
        // ---- PASS: half-res-water-composite -- reads: _hrwColor; writes: color (+ depth via the
        // shared-depth water stamp below, water-depth-share second variant, gated on !_stampedThisFrame) ----
        if (_hrw) {
          gl.uniform1f(U('uOccludeDepth'), 0.0);   // done with FS occlusion this frame
          gl.activeTexture(gl.TEXTURE0 + TU.sceneDepth); gl.bindTexture(gl.TEXTURE_2D, null);   // UNBIND _vdrsDepth before its FBO is rebound = no feedback loop
          gl.bindFramebuffer(gl.FRAMEBUFFER, _sceneFbo);
          gl.viewport(0,0, (_sceneFbo? Math.max(1,Math.round(_vW*_vrs)) : _vW), (_sceneFbo? Math.max(1,Math.round(_vH*_vrs)) : _vH));
          gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
          // PREMULTIPLIED blend (ONE, ONE_MINUS_SRC_ALPHA): water FS alpha=1 -> its colour is already
          // premultiplied; the LINEAR upsample mixes it with the premultiplied-zero cleared texels, so a
          // half-covered waterline texel is (water*0.5, 0.5) and adds exactly 0.5*water over land = no
          // black fringe (the SRC_ALPHA blend laid 0.5*black there = the black line user reported).
          gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
          gl.useProgram(upProg);
          gl.activeTexture(gl.TEXTURE0 + TU.sceneTex); gl.bindTexture(gl.TEXTURE_2D, _hrwColor); gl.uniform1i(cmpUTex, TU.sceneTex);
          gl.uniform2f(upUScale, 1.0, 1.0);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          // FIX (instanced-draw-sampler-type-collision-new-instance, non-deterministic
          // "GL_INVALID_OPERATION: glDrawElementsInstanced: Feedback loop formed between
          // Framebuffer and active Texture"): _hrwColor was left bound to TU.sceneTex (unit 9)
          // after this composite draw, with no unbind -- unlike TU.sceneDepth two lines above
          // (and again at the depth-share stamp below), which is explicitly unbound before every
          // FBO rebind specifically to avoid this exact class (see the "UNBIND ... = no feedback
          // loop" comments on TU.sceneDepth). On a LATER frame, ensureHrwTargets rebinds _hrwFbo
          // (whose own color attachment IS _hrwColor) as the render target for the half-res water
          // pass while unit 9 still holds _hrwColor from this stale binding -- live-confirmed via
          // a buffer/texture-identity capture: at the failing drawElementsInstanced, the bound
          // FBO's COLOR_ATTACHMENT0 texture and unit 9's bound texture were the SAME object,
          // created at ensureHrwTargets (gl-render.js:1123, i.e. _hrwColor). Unbind here so unit 9
          // is never left holding an FBO's own color attachment across frames, mirroring the
          // existing sceneDepth pattern exactly.
          gl.activeTexture(gl.TEXTURE0 + TU.sceneTex); gl.bindTexture(gl.TEXTURE_2D, null);
          gl.disable(gl.BLEND); gl.depthMask(true); gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
          gl.useProgram(prog);
          // SHARED-DEPTH FOR WATER (fix: 'objects draw over water even when under it'): the half-res water
          // pass composites COLOR-only, so the water surface has NO representation in _vdrsDepth (the depth
          // texture the __planetDepthToCanvas writeback stamps to the canvas). A consumer (three) scene then
          // tests only against TERRAIN depth and any object BELOW the water surface draws OVER the water.
          // Fix: re-draw the water mesh DEPTH-ONLY into _vdrsFbo (colorMask off, depthTest LESS, depthMask on)
          // so _vdrsDepth gains the sea-level water-surface depth wherever water is in front of terrain; the
          // existing writeback then carries water depth to the canvas and submerged consumer geometry is
          // occluded. VS pins the mesh to sea level (uIsWater=1); the FS's vH>1 discard drops water directly
          // under land so land-fronting terrain still wins. Gated on the consumer opting into shared depth.
          // (Depth-only, no color, no blend -> cheap; reuses the coarse water mesh already resident.)
          // _stampedThisFrame: the visibility probe above already IS this stamp (issued pre-color);
          // only run here when the probe/gate was disabled (__waterVisGate=false or no depth share).
          if (!_stampedThisFrame && typeof window !== 'undefined' && window.__planetDepthToCanvas === true && window.__waterDepthShareOff !== true && _vdrsDepth) {
            gl.activeTexture(gl.TEXTURE0 + TU.sceneDepth); gl.bindTexture(gl.TEXTURE_2D, null);   // UNBIND _vdrsDepth texture before rebinding its FBO as render target
            gl.bindFramebuffer(gl.FRAMEBUFFER, _vdrsFbo);
            gl.viewport(0, 0, Math.max(1, Math.round(_vW*_vrs)), Math.max(1, Math.round(_vH*_vrs)));
            gl.colorMask(false, false, false, false);
            gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); gl.disable(gl.BLEND);
            gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT); gl.frontFace(gl.CCW);
            gl.uniform1f(U('uIsWater'), 1.0);
            gl.uniform1f(U('uOccludeDepth'), 0.0);   // no FS scene-depth occlusion in this depth-only pass
            gl.uniform1f(U('uDepthOnly'), 1.0);      // skip the full water shading ALU -- colorMask is off, only depth matters
            gl.bindBuffer(gl.ARRAY_BUFFER, wvbo); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wibo);
            // FIX (perf-regression-terrain-geomorph-default-off-plus-gl-errors-investigation): re-assert
            // locations 1/2/3 into instBufWater before this draw too -- 4th and last of the wvbo/wibo
            // water draws needing the same self-contained per-draw attribute fix.
            gl.bindBuffer(gl.ARRAY_BUFFER, instBufWater);
            gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 0);     gl.vertexAttribDivisor(1, 1);
            gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 4 * 4); gl.vertexAttribDivisor(2, 1);
            gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 5 * 4); gl.vertexAttribDivisor(3, 1);
            gl.drawElementsInstanced(gl.TRIANGLES, waterIndices.length, gl.UNSIGNED_INT, 0, wn);
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
            gl.uniform1f(U('uIsWater'), 0.0);
            gl.uniform1f(U('uDepthOnly'), 0.0);
            gl.colorMask(true, true, true, true);
            if (typeof window !== 'undefined') window.__waterDepthShared = (window.__waterDepthShared|0) + 1;
          }
        }
        }   // end if (!_waterHidden) -- water color pipeline (scene copy / color pass / composite)
      // TEMP DIAGNOSTIC (window.__passProbe): after the water composite into the scene FBO.
      if (typeof window !== 'undefined' && window.__passProbe === true && _vdrsColor && _vdrsW > 0) _passProbeSnap('after-water-composite-vdrs', _vdrsColor, _vdrsW, _vdrsH);
        if (typeof window !== 'undefined') window.__lastWaterQuads = wn;
      }
      _instQuadsRef = quads;   // mark this quad set uploaded; next frame with the same array skips the rebuild
      if (typeof window !== 'undefined') window.__instUploads = (window.__instUploads | 0) + (_dirty ? 1 : 0);
    }
    if (typeof window !== 'undefined') window.__lastDrawCalls = (n > 0) ? 2 : 0;
    // Straight-to-canvas path (no VDRS/half-res-water upscale this frame): terrain+water already
    // drew directly into the canvas depth buffer, so it holds THIS frame's real depth -- draw sky
    // depth-tested now (see drawSky's depthTested contract above).
    if (_vdrsRsThisFrame === 0) { drawSky(true); if (typeof window !== 'undefined' && window.__passProbe === true) _passProbeSnap('after-drawSky-straight-canvas', null, 0, 0); }

    // ===== PASS: upscale-to-canvas (see _passManifest) =====
    // TEMP DIAGNOSTIC (window.__passProbe): capture a downscaled JPEG of the current framebuffer
    // (default canvas, or a given color texture via a scratch FBO) into window.__passProbeFrames.
    // Zero effect when window.__passProbe !== true. One-shot: disarms itself after one full sweep.
    function _passProbeSnap(label, srcTex, texW, texH) {
      if (!(typeof window !== 'undefined' && window.__passProbe === true)) return;
      try {
        const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        const prevViewport = gl.getParameter(gl.VIEWPORT);
        const W = srcTex ? texW : gl.drawingBufferWidth, H = srcTex ? texH : gl.drawingBufferHeight;
        if (srcTex) {
          const fbo = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, srcTex, 0);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.deleteFramebuffer(fbo); gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo); return;
          }
        } else {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
        const px = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        if (srcTex) { gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo); gl.deleteFramebuffer(fbo); }
        else gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
        gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
        // subsample JS-side to ~256 wide, flip Y (readPixels is bottom-up), JPEG-encode offscreen
        const pw = 256, ph = Math.max(1, Math.round(256 * H / W));
        const cv = document.createElement('canvas'); cv.width = pw; cv.height = ph;
        const cx = cv.getContext('2d');
        const img = cx.createImageData(pw, ph);
        for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
          const sx = Math.min(W - 1, Math.round(x * W / pw)), sy = H - 1 - Math.min(H - 1, Math.round(y * H / ph));
          const si = (sy * W + sx) * 4, di = (y * pw + x) * 4;
          img.data[di] = px[si]; img.data[di+1] = px[si+1]; img.data[di+2] = px[si+2]; img.data[di+3] = 255;
        }
        cx.putImageData(img, 0, 0);
        (window.__passProbeFrames = window.__passProbeFrames || []).push({ label, dataURL: cv.toDataURL('image/jpeg', 0.7) });
      } catch (e) {
        (window.__passProbeLog = window.__passProbeLog || []).push('_passProbeSnap ERR ' + label + ': ' + e);
      }
    }
    // IN: _vdrsColor, _vdrsRsThisFrame. OUT: canvas color.
    // VIEWPORT-DRS UPSCALE: blit the flexed-viewport FBO to the canvas via a fullscreen-quad sample
    // of the rendered [0,rs] sub-rect. No canvas realloc occurred this frame -> the resolution change is
    // hitch-free. preserveDrawingBuffer witness reads + page screenshots capture this final canvas image.
    // Extracted as a real function: reads only render()-closure state already in scope (_vdrsColor,
    // _vdrsRsThisFrame, upProg/upUTex/upUScale/upVao), no water-block-local coupling -- safe to hoist.
    // FSR1-QUALITY BRANCH (window.__vdrsUpscaleFsr1===true): EASU edge-adaptive resample into the
    // intermediate _fsr1UpTex, then RCAS contrast-adaptive sharpen straight to the canvas -- same
    // two-pass shape as client/core/FSR1.js's compute()/composite() split. Falls back to the plain
    // LINEAR upFsSrc tap (byte-identical to pre-existing behavior) when the knob is off, so this is
    // purely additive.
    function passUpscaleToCanvas() {
      const _fsr1 = (typeof window !== 'undefined' && window.__vdrsUpscaleFsr1 === true);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND); gl.depthMask(true);
      if (_fsr1) {
        const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
        ensureFsr1UpTarget(W, H);
        // EASU pass: flexed [0,rs] sub-rect of _vdrsColor (size _vdrsW x _vdrsH) -> full-res _fsr1UpTex.
        gl.bindFramebuffer(gl.FRAMEBUFFER, _fsr1UpFbo);
        gl.viewport(0, 0, W, H);
        gl.useProgram(easuProg);
        gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, _vdrsColor);
        gl.uniform1i(easuUTex, TU.upscale);
        gl.uniform2f(easuUScale, _vdrsRsThisFrame, _vdrsRsThisFrame);
        gl.uniform2f(easuUSrcTexel, _vdrsW > 0 ? 1 / _vdrsW : 0, _vdrsH > 0 ? 1 / _vdrsH : 0);
        gl.bindVertexArray(upVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, null);   // avoid the same feedback-loop hazard the LINEAR path guards below
        // RCAS pass: sharpen the EASU output straight onto the canvas.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, W, H);
        gl.useProgram(rcasProg);
        gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, _fsr1UpTex);
        gl.uniform1i(rcasUTex, TU.upscale);
        gl.uniform2f(rcasUTexel, 1 / W, 1 / H);
        gl.uniform1f(rcasUSharpness, (typeof window.__vdrsUpscaleFsr1Sharpness === 'number') ? window.__vdrsUpscaleFsr1Sharpness : 0.5);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
        gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, null);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.useProgram(upProg);
        gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, _vdrsColor);
        gl.uniform1i(upUTex, TU.upscale);
        gl.uniform2f(upUScale, _vdrsRsThisFrame, _vdrsRsThisFrame);
        gl.bindVertexArray(upVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
        // UNBIND _vdrsColor from TEXTURE0: same feedback-loop hazard as _vdrsDepth (see
        // passPlanetDepthWriteback's matching fix below) -- _vdrsColor is _vdrsFbo's own
        // COLOR_ATTACHMENT0, and this bind was never cleared, persisting into the next frame's
        // _vdrsFbo rebind as the draw target.
        gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, null);
      }
      gl.enable(gl.DEPTH_TEST);
    }

    // ===== PASS: planet-depth-writeback (see _passManifest) =====
    // IN: _vdrsDepth, near, far. OUT: canvas depth.
    // SHARED-DEPTH (window.__planetDepthToCanvas===true, opt-in): the half-res-water / VDRS path renders
    // the planet into _vdrsFbo (full-res, _vdrsDepth DEPTH texture) and upscales COLOR-only to the canvas
    // -- so a consumer scene drawn on top has NO planet depth to test against and draws OVER the terrain
    // instead of being occluded by it. Write the planet depth into the canvas depth buffer via a SHADER
    // PASS (gl_FragDepth from _vdrsDepth), color-masked off, depthFunc ALWAYS to stamp every planet texel.
    // (A single-sample->MSAA blitFramebuffer of DEPTH is GL_INVALID_OPERATION -- the canvas is commonly
    // MSAA -- so the prior blit silently failed and nothing was occluded. This shader pass is MSAA-safe.)
    // Returns true if the writeback ran (caller uses this to pick drawSky's depthTested arg, matching
    // the exact pre-decomposition if/else branch this replaces).
    function passPlanetDepthWriteback() {
      if (!(typeof window !== 'undefined' && window.__planetDepthToCanvas === true && _vdrsDepth)) return false;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.colorMask(false, false, false, false);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.ALWAYS);
      gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
      gl.useProgram(dwProg);
      gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, _vdrsDepth); gl.uniform1i(dwUDepth, TU.upscale);
      gl.uniform1f(dwUBias, (typeof window.__planetDepthBias === 'number') ? window.__planetDepthBias : 2e-6);
      gl.uniform2f(dwUScale, _vdrsRsThisFrame, _vdrsRsThisFrame);   // same subregion mapping as the color upscale
      // Consumer (THREE) near/far may legitimately differ from this frame's own near/far (window.__hostNearFar,
      // set by the host once per frame if it decouples its projection from ours) -- fall back to this frame's
      // own near/far (a no-op re-encode) when the host hasn't published one, preserving existing behavior.
      const _hostNF = (typeof window !== 'undefined') ? window.__hostNearFar : null
      const _dstNear = (_hostNF && Number.isFinite(_hostNF.near)) ? _hostNF.near : near
      const _dstFar = (_hostNF && Number.isFinite(_hostNF.far)) ? _hostNF.far : far
      gl.uniform1f(dwUSrcNear, near); gl.uniform1f(dwUSrcFar, far)
      gl.uniform1f(dwUDstNear, _dstNear); gl.uniform1f(dwUDstFar, _dstFar)
      gl.bindVertexArray(upVao); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
      gl.colorMask(true, true, true, true); gl.depthFunc(gl.LESS);
      // UNBIND _vdrsDepth from TEXTURE0 before returning: this function's TEXTURE0 bind was left live
      // into the NEXT frame (no unbind anywhere in this pass), so when _vdrsFbo is rebound as the draw
      // target for the next frame's terrain pass (_vdrsDepth is its own DEPTH_ATTACHMENT), that texture
      // is simultaneously an active sampler binding on TEXTURE0 -- a feedback loop that made every
      // subsequent terrain draw into _vdrsFbo fail with GL_INVALID_FRAMEBUFFER_OPERATION despite
      // checkFramebufferStatus reporting COMPLETE (completeness and the feedback-loop check are
      // separate GL validations). Mirrors the existing TEXTURE4 unbind pattern elsewhere in this file.
      gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, null);
      return true;
    }

    if (_vdrsRsThisFrame > 0) {
      // DEBUG DEPTH READBACK (window.__depthProbeOn): encode _vdrsDepth's depth01 into an RGBA8
      // target as (hi,lo) byte-split and readPixels it back so a host can compare the stamped
      // planet depth against expected per-pixel distances. Diagnostic-only; zero cost when off.
      if (typeof window !== 'undefined' && window.__depthProbeOn && _vdrsDepth) {
        const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
        if (!_dpFbo || _dpW !== W || _dpH !== H) {
          if (_dpTex) gl.deleteTexture(_dpTex);
          if (_dpFbo) gl.deleteFramebuffer(_dpFbo);
          _dpTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, _dpTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          _dpFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, _dpFbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, _dpTex, 0);
          gl.bindTexture(gl.TEXTURE_2D, null);
          _dpW = W; _dpH = H;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, _dpFbo);
        gl.viewport(0, 0, W, H);
        gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
        gl.useProgram(dpProg);
        gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, _vdrsDepth);
        gl.uniform1i(dpUTex, TU.upscale);
        gl.uniform2f(dpUScale, _vdrsRsThisFrame, _vdrsRsThisFrame);
        gl.bindVertexArray(upVao); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
        gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, null);
        try {
          const px = new Uint8Array(W * H * 4);
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
          window.__depthProbe = { w: W, h: H, px };
        } catch (_) {}
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(_activeProg);
      }
      if (typeof window !== 'undefined' && window.__wantVdrsColorProbe) {
        try {
          const probeFbo = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, probeFbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, _vdrsColor, 0);
          const px = new Uint8Array(4);
          gl.readPixels(Math.floor(_vW*_vrs/2), Math.floor(_vH*_vrs/2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          window.__vdrsColorProbe = { px: Array.from(px) };
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.deleteFramebuffer(probeFbo);
        } catch (e) { window.__vdrsColorProbe = { error: String(e) }; }
      }
      passUpscaleToCanvas();
      // TEMP DIAGNOSTIC (window.__passProbe): canvas right after the upscale.
      if (typeof window !== 'undefined' && window.__passProbe === true) _passProbeSnap('after-upscale-canvas', null, 0, 0);
      // ===== PASS: atmosphere-aerial-composite (see _passManifest), THC gate implicit in _vdrsRsThisFrame>0 =====
      // drawSky's depthTested arg follows EXACTLY the same condition as the pre-decomposition inline
      // if/else: true only when passPlanetDepthWriteback() actually stamped canvas depth this frame.
      const _wroteDepth = passPlanetDepthWriteback();
      // TEMP DIAGNOSTIC (window.__passProbe): canvas after writeback (color should be identical to post-upscale).
      if (typeof window !== 'undefined' && window.__passProbe === true) { (window.__passProbeLog = window.__passProbeLog || []).push('writeback ran=' + _wroteDepth); _passProbeSnap('after-writeback-canvas', null, 0, 0); }
      drawSky(_wroteDepth);    // true: canvas depth was just stamped with this frame's real terrain depth
      // false (writeback gated off): canvas depth is not this frame's; fail open (depth-test off, matches pre-existing behavior)
      // TEMP DIAGNOSTIC (window.__passProbe): final canvas after drawSky + disarm after a full sweep.
      if (typeof window !== 'undefined' && window.__passProbe === true) {
        _passProbeSnap('after-drawSky-canvas', null, 0, 0);
        if ((window.__passProbeFrames || []).length >= 4 && window.__passProbeOneShot !== false) window.__passProbe = false;
      }
      gl.useProgram(_activeProg);   // restore the terrain program for the next frame's uniform sets
    }
    return 0;   // glError is checked via checkGlError() once per frame after quadtree (CPU/GPU pipelining)
  }

  function checkGlError() { return gl.getError(); }

  // ---- DEBUG PROBE: replicate the VS clip-space transform on the CPU for a quad's 4
  // corners (vertex.xy in {0,1}^2) so we can see which quads project off-screen.
  function probe(quads, cam) {
    const aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    const near = (cam.near!=null)?cam.near:1.0, far=(cam.far!=null)?cam.far:R*8;
    const proj = M4.perspective(cam.fovy||0.785, aspect, near, far);
    const eye = cam.eye;
    const viewRel = M4.lookAt([0,0,0], [cam.center[0]-eye[0], cam.center[1]-eye[1], cam.center[2]-eye[2]], cam.up||[0,1,0]);
    const viewProjRel = M4.mul(M4.mul(proj, viewRel), M4.translate([-eye[0],-eye[1],-eye[2]]));
    const out = [];
    for (const q of quads) {
      const w3 = localToWorld3(q.face);
      const w4 = new Float32Array([ w3[0],w3[1],w3[2],0, w3[3],w3[4],w3[5],0, w3[6],w3[7],w3[8],0, 0,0,0,1 ]);
      const localToScreen = M4.mul(viewProjRel, w4);
      const {ox,oy,l} = q.quad;
      const cs = [[ox,oy],[ox+l,oy],[ox,oy+l],[ox+l,oy+l]];
      const v=[],L=[];
      for (let i=0;i<4;i++){ const px=cs[i][0],py=cs[i][1]; const len=Math.hypot(px,py,R); L.push(len); v.push([px/len,py/len,R/len]); }
      // C and N matrices (4x4) as in setQuadUniforms
      const dCorners = new Float32Array([ v[0][0]*R,v[0][1]*R,v[0][2]*R,1, v[1][0]*R,v[1][1]*R,v[1][2]*R,1, v[2][0]*R,v[2][1]*R,v[2][2]*R,1, v[3][0]*R,v[3][1]*R,v[3][2]*R,1 ]);
      const C = M4.mul(localToScreen, dCorners);
      // For each of the 4 mesh corners, alphaPrime picks out one column => clip = column i (h=0 baseline)
      const ndc = [];
      for (let i=0;i<4;i++){ const x=C[i*4],y=C[i*4+1],z=C[i*4+2],w=C[i*4+3];
        ndc.push({x:+(x/w).toFixed(3),y:+(y/w).toFixed(3),z:+(z/w).toFixed(3),w:+w.toFixed(1),
          off: (w<=0)||Math.abs(x/w)>1||Math.abs(y/w)>1||(z/w)<-1||(z/w)>1}); }
      out.push({face:q.face, level:q.quad.level, ox:+ox.toFixed(0), oy:+oy.toFixed(0), l:+l.toFixed(0), ndc});
    }
    return out;
  }
  function setHpf(tex, res, tex2) { _hpfTex = tex; _hpfRes = res|0; _hpfTex2 = tex2 || null; invalidatePool(); }   // tex2 = RG8(temp,humid) pack (W12); HPF change -> re-bake THC tiles

  // CONTEXT LOSS (consumer-facing diagnostic hook): a GPU driver reset / OOM / tab-background
  // eviction fires 'webglcontextlost' on the canvas, after which EVERY gl.* call becomes a
  // spec-defined silent no-op -- render() keeps "succeeding" with no error, producing a frozen/
  // black frame with zero diagnostic signal. Without a hook, a host app (e.g. spoint) has no way
  // to know it needs to recreate the renderer; it just silently stops updating. isContextLost()
  // lets a host poll cheaply (gl.isContextLost() is a fast native call); onContextLost(cb)
  // subscribes to the event directly. Detection-only -- state RECOVERY (recreating buffers/
  // textures/programs after 'webglcontextrestored') is intentionally left to the consumer, since
  // the right recovery strategy (full renderer recreation vs in-place restore) is host-specific.
  const _contextLostCbs = [];
  let _canvasEl = null;
  try { _canvasEl = (gl && typeof gl.canvas !== 'undefined') ? gl.canvas : null; } catch (_) {}
  if (_canvasEl && typeof _canvasEl.addEventListener === 'function') {
    _canvasEl.addEventListener('webglcontextlost', (e) => {
      for (const cb of _contextLostCbs) { try { cb(e); } catch (_) {} }
    });
  }
  function isContextLost() { try { return !!(gl && gl.isContextLost && gl.isContextLost()); } catch (_) { return false; } }
  function onContextLost(cb) {
    if (typeof cb !== 'function') return () => {};
    _contextLostCbs.push(cb);
    return () => { const i = _contextLostCbs.indexOf(cb); if (i >= 0) _contextLostCbs.splice(i, 1); };
  }

  return { get prog(){ return prog; }, render, checkGlError, probe, sampleGroundM, sampleGroundMSync, cullMatrix, recompile, setHpf, isContextLost, onContextLost, GRID, indexCount: indices.length, M4, setSculptOverride, clearSculptOverride, SCULPT_RES };
}
