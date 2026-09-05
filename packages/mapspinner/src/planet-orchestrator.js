// planet-orchestrator.js -- drives the GPU one-fractal planet render. Per frame it runs the
// 6-face cube-sphere quadtree (quadtree.js) with the camera in each face's local frame, collects
// the visible leaf quads, and hands them to gl-render to draw. Terrain shape is the per-vertex
// GPU fractal in terrain.glsl -- there is no tile producer, no atlas, no per-tile content gen.
//
// Coordinate facts:
//   - quad coords are METERS. root l = 2*R, R = 6360000.
//   - the quadtree returns leaf quads as (level,tx,ty,ox,oy,l) in METER coords; ox,oy,l pass
//     straight to gl-render (which projects each vertex P=(ox+..,oy+..,R) to the sphere).
//   - FACE_FRAME below is the SINGLE source of truth for the cube-face local frame (col0=U,
//     col1=V, col2=center); worldToFaceLocal inverts it to put the world camera into face coords.

import { Quadtree } from './quadtree.js';
import { initMapspinnerRender } from './gl-render.js';
import { createAnchorField } from './anchor-field.js';
import { TERRAIN_DEFAULTS as TD } from './terrain-defaults.js';

// MUST match the render's localToWorld3 transformation exactly (col0=U, col1=V,
// col2=center). This is the face's local orthonormal frame: a face-local point
// (x,y,z) maps to world = x*U + y*V + z*center. The frame is orthonormal, so the
// inverse (world->local) is just the dot products onto U, V, center.
import { FACE_FRAME, dot, worldToFaceLocal, quadOutsideFrustum, extractFrustumPlanes, pickFace, CULL_ELEV_FRAC } from './planet-orchestrator-cull.js';
export { FACE_FRAME, dot, worldToFaceLocal, quadOutsideFrustum, extractFrustumPlanes, pickFace } from './planet-orchestrator-cull.js';


export async function initMapspinnerPlanet(gl, opts = {}) {
  // GUARD (consumer-facing input validation): a degenerate radius/gridMeshSize propagates
  // silently into Quadtree (which divides by `size` in _cameraDist/_recurse) and the terrain
  // shader uniforms, producing NaN geometry or a divide-by-zero hang with no actionable error --
  // e.g. a consumer accidentally passing an uninitialized variable as radius. Fail loud instead.
  if (opts.radius != null && (!Number.isFinite(opts.radius) || opts.radius <= 0)) {
    throw new TypeError(`mapspinner: opts.radius must be a positive finite number, got ${opts.radius}`);
  }
  if (opts.gridMeshSize != null && (!Number.isInteger(opts.gridMeshSize) || opts.gridMeshSize < 2)) {
    throw new TypeError(`mapspinner: opts.gridMeshSize must be an integer >= 2, got ${opts.gridMeshSize}`);
  }
  const R = opts.radius || 6360.0;  // default matches _planetScale=0.001 (WEBGL2_TERRAIN_R_M)
  // maxLevel default raised 12 -> 16: at 12 the quadtree hit its cap around ~300km altitude so
  // terrain detail froze on descent. 16 lets it keep refining toward first-person (texel ~7m at
  // L16 vs ~116m at L12); fps sweep (browser-1835) showed deeper levels are cheap here. Live
  // override window.__maxLevel (read per-frame in the update loop below).
  // maxLevel 16 = the DETAIL FLOOR: vtxDisplace now resolves to ~31m (7 octaves), and L16 cells are
  // ~7m, so L16 fully samples the finest fractal octave -- subdividing past it would multiply quads
  // with no new detail (user: 'below ~500m quads increase but nothing happens'). Capped here so the
  // deepest LOD lands where the fractal detail ends. Live override window.__maxLevel.
  // maxLevel 16 -> 14 (user 2026-06-01j: 'really slow when you get close'). vtxDisplace's finest
  // octave is ~31m (wl0 2000m / 2^6); an L14 cell is ~28m, which ALREADY fully samples that floor.
  // L15/L16 (cells ~14m/~7m) multiply the quad count 2-4x with NO new resolvable detail (the fractal
  // has nothing below ~31m) -- pure close-approach overdraw. Cap at 14 = the real detail floor.
  // maxLevel 14 -> 16 (user 2026-06-02: 'at 2m we feel bigger than the features'). vtxDisplace now
  // adds octaves down to ~8m, but an L14 cell is ~28m -> those octaves undersample. L16 cells are
  // ~7m, resolving the ~8m floor so the ground shows human/decametre-scale relief on close approach.
  // Trade: ~2-4x more quads at the deck (the deep LOD only triggers within ~hundreds of m of ground).
  // maxLevel 16 -> 13 (user 2026-06-09: 'get rid of the highest 3 stages'). Drops the three deepest
  // quadtree levels (L14/L15/L16, ~28m/~14m/~7m cells) -- the close-approach overdraw tail -- so the deepest
  // LOD is now L13 (~56m cell). Pairs with the LOD_STEP push (each region still resolves levels-finer-per-
  // distance, just capped three steps shallower). Live override window.__maxLevel.
  const maxLevel = opts.maxLevel ?? 11;
  // splitFactor 2.0 over-subdivided ~5-20x: the baseline measured px/poly edge median
  // 0.73 (orbit) / 1.56 (lowalt), far below the user's 4-50 px target, which also
  // saturated the atlas (1920/1920) and drove tileGenMs to ~950ms. The live sweep
  // (__diag.sweepSplit, browser-3) found splitFactor 1.0 puts px/poly median at 9.7
  // (orbit) / 26.8 (lowalt) -- 100%/98% inside the 4-50 band -- while collapsing the quad
  // count (orbit 860->20, lowalt 1272->328). The SDK default is the BLESSED flat mesh density
  // (TERRAIN_DEFAULTS.splitFactor = 0.30) -- the demo used to PIN this via window.__splitFactor and
  // never ran the altitude ramp below, so a flat 0.30 IS the calibrated look. A bare SDK consumer
  // gets it with no setup. Override live via window.__splitFactor or per-instance via opts.splitFactor.
  const splitFactor = opts.splitFactor ?? TD.splitFactor;
  const gridMeshSize = opts.gridMeshSize || 11;   // 16->11 FPS lever (triangle-throughput bound, not ALU; GRID 8 jagged biome crossovers, see gl-render.js GRID)
  // GEOMORPHING LOD (see terrain.glsl's iMorph computation): default OFF. This VS is already
  // measured 96% of frame cost (see AGENTS.md "RUNTIME FPS is VERTEX-SHADER-bound") -- the morph
  // branch adds a normalize()+distance()+mix() to EVERY vertex of EVERY visible terrain quad, every
  // frame, unconditionally, when enabled. Live-witnessed real regression this session: a consuming
  // app's measured FPS collapsed from ~50 to 2-3 the moment this became always-on (qt.splitDist is
  // always a real positive value, so the "cam.morph* default to inert" comment at the gl-render.js
  // call site was never actually reachable -- there was no opt-out). opts.geomorphLod:true is the
  // real opt-in; the feature's own crack-free/monotonic-morph correctness (verified via a live node
  // script mirroring the exact GLSL algorithm) is unaffected by this default -- only its cost is now
  // gated behind an explicit choice, matching this file's own "measure, do not eyeball" perf rule.
  const _geomorphLod = !!opts.geomorphLod

  // EXT_color_buffer_float is REQUIRED: the HPF field + elevation render targets use RG16F/RGBA32F
  // float color attachments (gl.RG16F texStorage below, plus gl-render's float FBOs). On a WebGL2
  // device that lacks this extension (some low-end Android / older Intel), the float texture alloc
  // silently fails -> blank terrain. Detect it up front and throw a clear typed Error BEFORE the
  // first RG16F alloc so a consumer's try/catch (e.g. spoint TerrainBackdrop) degrades to flat
  // terrain instead of rendering nothing.
  const _colorBufferFloatExt = gl.getExtension('EXT_color_buffer_float');
  if (!_colorBufferFloatExt) {
    throw new Error('mapspinner: EXT_color_buffer_float required for terrain rendering');
  }
  // OES_texture_float_linear lets the driver LINEAR-filter the RGBA32F HPF/elevation textures. When
  // ABSENT, a LINEAR-flagged float texture SILENTLY falls back to NEAREST -> per-texel square steps
  // ("elevations look square"). The terrain shader does MANUAL bilinear in hpfSample so the field is
  // smooth regardless (NOT a hard requirement, unlike EXT_color_buffer_float above), but expose
  // whether hardware float-linear was granted via window.__floatLinearOK so the live page can witness
  // the original root (false = the single-tap path was silently NEAREST, manual bilinear in effect).
  const _floatLinearExt = gl.getExtension('OES_texture_float_linear');
  if (typeof window !== 'undefined') window.__floatLinearOK = !!_floatLinearExt;

  // INIT TIMINGS (user 2026-06-02: profile the start load time). Stamp each init stage; exposed as
  // window.__initTimings so the bottleneck is visible (the HPF bake = 256*256*6 sampleUV is the
  // suspect). Uses performance.now() where available, Date.now() otherwise.
  const _now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const _t = { start: _now() };
  // No producer: terrain shape is the per-vertex GPU fractal (fractalTerrainH in terrain.glsl).
  const render = await initMapspinnerRender(gl, { radius: R, gridMeshSize, reliefScale: opts.reliefScale });
  _t.shaderCompileMs = +(_now() - _t.start).toFixed(0);
  // Pure-JS quadtree: geometry LOD selection only; terrain shape is the GPU fractal, so the mesh
  // needs no external height producer.
  const qt = new Quadtree(R);   // SCALE-INVARIANT: LOD quadtree root half-extent = configured radius (was hardcoded 6360000)

  // ---- HIERARCHICAL PARAMETER FIELD (HPF) ----------------------------------------
  // The anchor field drives generation as a CONTINUOUS function of world direction. To keep
  // For seamlessness we feed it to the terrain VS as a TEXTURE (a
  // continuous C0 field via LINEAR filtering) rather than a per-tile constant (a per-tile
  // step would reintroduce seams -- see the CLOD mean-drift / edge-equality lessons). We bake
  // the field's continental band into a per-face HPF_RES^2 RGBA32F 2D-array (seaBias, elevAmp,
  // temp, humidity) once at init; the VS samples it by world dir and uses seaBias as the
  // continental elevation bias (replacing the old hardcoded lobe). Live edits re-bake (cheap:
  // HPF_RES^2*6 samples) so the terraform loop stays one-dispatch.
  const _tHpf0 = _now();
  const hpf = createAnchorField({ seed: opts.hpfSeed || 1337 });
  _t.anchorFieldMs = +(_now() - _tHpf0).toFixed(0);
  // ANCHOR DENSITY: 64/face was too blocky; 256/face was sharp but its bake = 256*256*6 = 393k
  // hpf.sampleUV calls cost ~4s of MAIN-THREAD block at init (THE start-load-time bottleneck, profiled
  // headless 2026-06-02: 4027ms@256 vs 1137ms@128). 128/face (98k samples ~1.1s) is the calibrated
  // load-time fix: the field is LINEAR-filtered so continental/biome regions stay smooth (128 is still
  // 4x finer than the old blocky 64), and the regional biome PATCHES are 100s of km = far above one
  // 128-texel cell (~50km/cell on a 6371km face). opts.hpfTexRes overrides (256 for a sharpness A/B).
  const HPF_RES = opts.hpfTexRes || 128;    // per-face texels of the baked continental/biome field
  // W12 PACK (mob-w12): the continental field is split from one RGBA32F (16B/texel) into TWO
  // smaller textures -- hpfTex RG16F (seaBias, elevAmp; precision-sensitive geometry floats) +
  // hpfTex2 RG8 (temp, humid; [0,1] climate, 8-bit ample). 62% less HPF VRAM/bandwidth, silhouettes
  // intact. UNCONDITIONAL format (single version). The shader hpfSample decodes both back to the
  // legacy (seaBias, elevAmp, temp, humid) vec4. Both flagged LINEAR; the shader's manual bilinear
  // keeps the field smooth even where OES_texture_float_linear is absent (no quality tier).
  function _mkHpfTex(internalFmt) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, internalFmt, HPF_RES, HPF_RES, 6);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  const hpfTex  = _mkHpfTex(gl.RG16F);   // r=seaBias[m], g=elevAmp
  const hpfTex2 = _mkHpfTex(gl.RG8);     // r=temp[0,1], g=humid[0,1]
  // bands FINER than the bake texture resolution are sub-texel (alias to noise) -> skip them in the
  // bake to cut the ~1.5M-anchor local band that dominates init cost (hpf-bake-init-latency). The
  // baked channels (seaBias/elevAmp/temp/humidity) change negligibly (local band touches only elevAmp
  // by <=1.1x). The full field (all bands incl. local roughness) is still used live in the shader/CLI.
  const BAKE_MAX_LEVEL = Math.round(Math.log2(HPF_RES));   // e.g. 256 -> 8; skips bands with level>8
  const _bakeBuf  = new Float32Array(HPF_RES * HPF_RES * 2);   // RG16F: seaBias, elevAmp
  const _bakeBuf2 = new Uint8Array(HPF_RES * HPF_RES * 2);     // RG8: temp, humid (x255)
  // bake ONE face into the HPF texture array (HPF_RES^2 sampleUV calls). Factored from bakeHpf so the
  // init can bake the start face synchronously and BACKGROUND the rest (the cut to bakeHpfMs: the full
  // 6-face bake was 1519ms = 96% of warm totalInitMs, browser-1585). texStorage3D zero-inits unbaked
  // faces (0 bias = flat sea) -> we redraw as each background face lands so no face stays blank.
  function bakeFace(face) {
    const buf = _bakeBuf;
    // HPF SEAM INSET (hpf-seam-inset-bake): the centred bake fu=(x+0.5)/HPF_RES puts face-edge texels 0.5
    // texel INSIDE the face, so adjacent faces' edge texels do not land on the shared-edge world dir ->
    // LINEAR+CLAMP across a shared edge interpolates two inset grids = up to 985m seam (seam-diagnostic
    // gpuBilinearSeam f1|f4). The inset map fu=x/(RES-1) lands edge texels exactly on fu=0/1 = the shared
    // edge -> seam collapses to 0m. MATCHED PAIR: the shader hpfSample bilinear must ALSO map uv->texel as
    // uv*(sz-1) (terrain.glsl, same __hpfInset gate) or the whole field shifts 0.5 texel. Gated OFF by
    // default (window.__hpfInset) until live-A/B confirms no global misplacement; flip both together.
    // SEAM FIX (2026-06-09, workflow wmk2ieggi): edge-aligned inset bake is now the PERMANENT default
    // (was gated OFF behind window.__hpfInset). ROOT: the centred bake fu=(x+0.5)/RES put each face's
    // edge texel 0.5 texel INSIDE the face, so adjacent faces (e.g. y-/z+) sampled DIFFERENT world dirs
    // at the shared edge -> LINEAR+CLAMP across the edge interpolated two offset grids = a 3770m height
    // jump (code-exec browser-9317). baseParamsAt is pure world-dir (seamless by construction), so the
    // inset map fu=x/(RES-1) lands edge texels EXACTLY on the shared-edge world dir -> both faces bake the
    // IDENTICAL edge value -> cube-edge jump ~0. MATCHED PAIR with gl-render uHpfInset=1 + terrain.glsl
    // hpfSample inset branch; all three flip together. window.__hpfInset===false still forces OFF (rollback).
    const _hpfInset = (typeof window !== 'undefined' && window.__hpfInset === false) ? false : true;
    const buf2 = _bakeBuf2;
    bakeFaceRows(face, 0, HPF_RES, buf, buf2, _hpfInset);
    uploadFace(face, buf, buf2);
  }
  // Row-range slice of the bake loop (perf sweep 2026-06-11): the background path chunks a face into
  // row bands honoring the idle-callback deadline instead of one ~190ms synchronous block per face.
  function bakeFaceRows(face, yStart, yEnd, buf, buf2, _hpfInset) {
    for (let y = yStart; y < yEnd; y++) for (let x = 0; x < HPF_RES; x++) {
      const fu = _hpfInset ? x / (HPF_RES - 1) : (x + 0.5) / HPF_RES;
      const fv = _hpfInset ? y / (HPF_RES - 1) : (y + 0.5) / HPF_RES;
      const s = hpf.sampleUV(face, fu, fv, BAKE_MAX_LEVEL);
      const o = (y * HPF_RES + x) * 2;
      buf[o] = s.seaBias; buf[o+1] = s.elevAmp;                                  // RG16F float pair
      buf2[o]   = Math.max(0, Math.min(255, Math.round(s.temp     * 255)));      // RG8 quantize [0,1]
      buf2[o+1] = Math.max(0, Math.min(255, Math.round(s.humidity * 255)));
    }
  }
  function uploadFace(face, buf, buf2) {
    // WebGL2 spec forbids UNPACK_FLIP_Y_WEBGL/UNPACK_PREMULTIPLY_ALPHA_WEBGL (INVALID_OPERATION) on
    // any TEXTURE_3D/TEXTURE_2D_ARRAY upload. gl is a context shared with the host page's own
    // renderer, which can leave either flag set true from an unrelated 2D image upload earlier in
    // the frame -- reset both unconditionally before this raw typed-array upload.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, hpfTex);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, face, HPF_RES, HPF_RES, 1, gl.RG, gl.FLOAT, buf);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, hpfTex2);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, face, HPF_RES, HPF_RES, 1, gl.RG, gl.UNSIGNED_BYTE, buf2);
  }
  function bakeHpf() { for (let face = 0; face < 6; face++) bakeFace(face); }   // full synchronous (used by rebake)
  // pick the face under the start camera so the first visible face is baked synchronously; the rest
  // background. camWorldPos may not be known yet at init -> default face 0 (the bake order is otherwise
  // arbitrary, and the background pass fills all 6 within a few frames anyway).
  const _startFace = (typeof opts.startFace === 'number') ? (opts.startFace|0) : 0;
  const _tBake0 = _now();
  bakeFace(_startFace);                       // synchronous: the start face is ready for frame 1
  _t.bakeHpfMs = +(_now() - _tBake0).toFixed(0);   // now ~1/6 of the old full-bake cost on the init path
  _t.bakeFacesPending = 5;
  _t.totalInitMs = +(_now() - _t.start).toFixed(0);
  if (render.setHpf) render.setHpf(hpfTex, HPF_RES, hpfTex2);

  // (height atlas removed 2026-06-10: rejected for fidelity -- bilinear texels facet the 4x peaks at any
  // sane RES -- and the cold-compile motivation died with the ANGLE-backend fix (d3d11/FXC 152s -> vulkan
  // 140ms, scripts/dev-chrome.cmd). Procedural broadShapeM is the ONLY height path. Cast-shadow atlas
  // removed same day for bake stutters.)


  // BACKGROUND-bake the remaining 5 faces one per macrotask so init returns fast and the page can paint.
  // Each completed face triggers a redraw (clearCache -> the next frame re-renders with the new field).
  if (typeof window !== 'undefined') {
    // CHUNKED BY ROW BAND (perf sweep 2026-06-11): one whole face per idle callback was a ~190ms
    // synchronous block x5 (requestIdleCallback grants ~50ms; the callback ignored it) = 5 dropped-frame
    // hitches right after first paint. Now each callback bakes row bands while deadline.timeRemaining()
    // holds (fallback fixed band without a deadline), uploading once per completed face as before.
    // (Shared _bakeBuf: a sync __hpfRebake() mid-background-bake clobbers the partial face -- it always
    // did own the buffers; the background pass re-bakes that face's remaining rows from its own state.)
    const _rest = [0,1,2,3,4,5].filter(f => f !== _startFace);
    // timeout 200->32 + slice 16->32 rows (2026-06-11 'rocky patches/flat again' follow-up): the first
    // chunked version let the unbaked-face window stretch to ~8s on a GPU-bound tab -- an unbaked face
    // renders ZERO HPF (flat land, cold-dry grey biome, height-only shading), symptom-identical to the
    // old atlas-era flat/rocky class. 4 slices/face firing every <=32ms = whole planet baked in well
    // under 1s worst case (the old single-block path's wall-clock) with ~50ms slices, no 190ms frame hit.
    const _bgYield = (cb) => (typeof requestIdleCallback !== 'undefined') ? requestIdleCallback(cb, {timeout: 32}) : setTimeout(cb, 0);
    const ROWS_PER_SLICE = 32;
    let _bgFace = -1, _bgRow = 0;
    const _bgInset = (typeof window !== 'undefined' && window.__hpfInset === false) ? false : true;
    function _bgBakeNext(deadline) {
      if (_bgFace < 0) {
        if (!_rest.length) { _t.bakeFacesPending = 0; clearCache(); return; }
        _bgFace = _rest.shift(); _bgRow = 0;
      }
      do {
        const yEnd = Math.min(HPF_RES, _bgRow + ROWS_PER_SLICE);
        bakeFaceRows(_bgFace, _bgRow, yEnd, _bakeBuf, _bakeBuf2, _bgInset);
        _bgRow = yEnd;
      } while (_bgRow < HPF_RES && deadline && deadline.timeRemaining && deadline.timeRemaining() > 8);
      if (_bgRow >= HPF_RES) {
        uploadFace(_bgFace, _bakeBuf, _bakeBuf2);
        _bgFace = -1;
        _t.bakeFacesPending = _rest.length;
        clearCache();   // invalidate the static-camera cache so the next frame re-renders with the new face
      }
      _bgYield(_bgBakeNext);
    }
    _bgYield(_bgBakeNext);
  } else { bakeHpf(); _t.bakeFacesPending = 0; }   // headless/node: no event loop wait, bake all synchronously
  if (typeof window !== 'undefined') {
    window.__initTimings = _t;   // {shaderCompileMs, anchorFieldMs, bakeHpfMs, totalInitMs}
    window.__hpf = hpf;
    window.__hpfRebake = () => { bakeHpf(); };   // call after edits (does NOT clearCache: the
    // continental field is shader-side so a re-bake + redraw is enough; no tile regen needed).
  }
  // Vegetation is disabled in the GPU-only rewrite (it depended on the deleted producer; gated
  // by window.__veg default-off anyway). Re-add later as a pure-GPU instanced pass if wanted.
  let vegetation = null;

  // ATLAS LRU / tile-gen / ancestor-fallback REMOVED: terrain is the per-vertex GPU fractal,
  // there are no tiles to make resident, generate, or evict. _frameCache stays for the
  // static-camera re-render PERF path. frameStart kept (the render loop still references it).
  let _frameCache = null;
  let _pipelineQuads = null;   // pre-computed quads from last frame for draw-before-compute pipelining
  // DOUBLE-BUFFERED visible-quad POOLS (opt-cpu-quadtree-alloc): the per-frame quad set was a fresh
  // [] of {quad:{...},face,localCam,splitDist} (2 objects/leaf/frame). _pipelineQuads, _frameCache.quads
  // and __lastGLQuads are all set to the SAME array each rebuild (see ~865/884/889), so refilling the
  // pool NOT held by _pipelineQuads overwrites nothing live (the pipeline is mid-draw on it, the static
  // cache holds it). Ping-pong -> zero steady-state allocation for the quad set.
  const _quadsPoolA = [], _quadsPoolB = [];
  // HOISTED frustum-cull context (opt-remaining-cut-queue D2): the per-rebuild new Float64Array(24) +
  // cullCtx object literal is now one persistent scratch, refilled in place. R/maxElev are fixed per
  // planet; ex/ey/ez + planes are set per rebuild, ux..cz per face. cullCtx is consumed synchronously
  // inside updateQuadtree/_recurse and never retained past the frame, so reuse across rebuilds is safe.
  const _cullCtxScratch = { planes: new Float64Array(24), ex: 0, ey: 0, ez: 0,
                            ux: 0, uy: 0, uz: 0, vx: 0, vy: 0, vz: 0, cx: 0, cy: 0, cz: 0,
                            R, maxElev: R * CULL_ELEV_FRAC };
  let frameStart = 0;

  // ---- per-frame quadtree drive --------------------------------------------------
  // camWorldPos: [x,y,z] world meters (sphere centered at origin).
  // camTarget:   [x,y,z] world look-at point. fovy in radians. displayMode int.
  // shadowInfo (9th arg, optional): host-supplied {hasShadow,texture,matrix,bias,normalBias,...} --
  // see TerrainBackdrop.js's _buildShadowInfo. Threaded onto `cam` (below) so render.render's single
  // cam-bag parameter carries it straight to gl-render.js's per-frame uniform upload, matching how
  // eye/center/up/fovy/displayMode/surfElev already travel -- no new render() parameter needed.
  // Returns { quadCount, glError, face }.
  function frame(camWorldPos, camTarget, fovy = 0.7, displayMode = 0, sunDir, time = 0, up, surfElev = 0, shadowInfo) {
    const sun = sunDir || (() => { const s = [0.4, 0.5, 0.75]; const sl = Math.hypot(...s); return [s[0]/sl, s[1]/sl, s[2]/sl]; })();
    // Use the caller's up if given (planet.html keeps an orthonormal free-fly up); only
    // fall back to [0,1,0] when none supplied. Hardcoding [0,1,0] broke the +Y pole view
    // (up parallel to the view dir -> degenerate lookAt -> nothing rendered).
    const camUp = up || opts.up || [0, 1, 0];

    // PERF: rebuilding the 6-face quadtree + regenerating tiles (ensureResident: upsample/
    // normal/ortho FBO passes) every frame is the dominant cost. When the camera hasn't
    // moved/turned meaningfully since the last rebuild, REUSE the cached visible-quad set
    // and just re-render (cheap) -- re-render still animates the ocean (time) + tracks the
    // sun. Rebuild only when the camera moves > ~0.1% of altitude or turns, or display mode
    // changes. This keeps a static/orbiting view at full fps and only pays tile-gen on move.
    const camDist = Math.hypot(camWorldPos[0],camWorldPos[1],camWorldPos[2]);
    // LOD-LAG FIX (user 2026-06-02): the OLD moveTol = 0.1% of altitude let the LOD reference
    // snap only in coarse jumps while the camera glided smoothly between them, so the dense LOD
    // TRAILED the camera ("the camera moves faster than the LOD center"). The rebuild must track
    // the camera's per-move displacement, not 0.1% of altitude. Drop the coefficient 20x (0.001
    // -> 0.00005 = 0.005% of altitude) AND cap it at 250m absolute, so even at orbit the LOD
    // recomputes essentially every move-step. A perfectly STILL camera moves 0 m < moveTol and
    // still hits the cached branch (fps hold preserved); only a MOVING camera rebuilds.
    const moveTol = Math.min(250.0, Math.max(1.0, (camDist - R) * 0.00005));
    const fwd = [camTarget[0]-camWorldPos[0], camTarget[1]-camWorldPos[1], camTarget[2]-camWorldPos[2]];
    const c = _frameCache;
    // Rebuild the 6-face quadtree only when the camera moves > ~0.1% of altitude, turns, or
    // changes display mode; otherwise reuse the cached visible-quad set and just re-render
    // (cheap -- still animates ocean + tracks sun). The per-vertex GPU fractal means there is
    // no tile streaming to drain, so a static camera holds the cache indefinitely.
    const moved = !c || !c.pos
      || Math.hypot(camWorldPos[0]-c.pos[0], camWorldPos[1]-c.pos[1], camWorldPos[2]-c.pos[2]) > moveTol
      || (fwd[0]*c.fwd[0]+fwd[1]*c.fwd[1]+fwd[2]*c.fwd[2]) < c.fwdLen2*0.99999
      || displayMode !== c.displayMode;
    if (!moved) {
      // morphSplitDist/morphDistFactor: GEOMORPHING LOD level-detail-range inputs (see gl-render.js /
      // terrain.glsl iMorph). Deliberately the QUADTREE-GLOBAL qt.splitDist/qt.distFactor (identical
      // for every quad this frame), never a per-quad-adjusted value -- the shader derives a per-vertex,
      // level-keyed morph range from these two scalars alone, so two adjacent same-level leaves always
      // agree at a shared boundary vertex (see quadtree.js _recurse's geomorph comment for why a
      // per-quad-adjusted range is neighbor-inconsistent and was reverted).
      const cam2 = { eye: camWorldPos, center: camTarget, up: camUp, fovy, displayMode, surfElev, shadowInfo, morphSplitDist: _geomorphLod ? qt.splitDist : 0, morphDistFactor: qt.distFactor, morphMaxLevel: qt.maxLevel };
      render.render(c.quads, cam2, sun, time);
      // gl.getError() forces a full GPU pipeline flush/sync; this STATIC-frame branch runs every frame
      // the camera holds still (the planet caches its quad set), so an unconditional check stalled ~5.5%
      // of frame time in a settled profile. Gate it behind window.__glCheck exactly like the moved-frame
      // path below (line ~912) -- diagnostics opt in, production pays nothing.
      const glError = (typeof window !== 'undefined' && window.__glCheck) ? render.checkGlError() : 0;
      // Phase 2 fix: also re-draw vegetation on STATIC frames (the GPU instance buffer is
      // still valid from the last rebuild). Without this, trees vanished whenever the
      // camera held still (the static branch returned before the veg draw).
      try {
        if (vegetation && typeof window !== 'undefined' && window.__veg) {
          vegetation.draw(cam2, sun, render.cullMatrix(cam2).viewProjRel);
        }
      } catch(e){}
      try { if (typeof window !== 'undefined') window.__cullStats = { kept: c.quads.length, culled: -1, culledOnScreen: -1, cullActive: false, frame: 'cached', altM: Math.round(camDist - R) }; } catch(_){}
      return { quadCount: c.quads.length, glError, face: c.frontFace, residentCount: 0,
               fallbackCount: c.fallbackCount, maxFallbackLevel: c.maxFallbackLevel, frontFallback: c.frontFallback, cached: true };
    }

    // configure the quadtree once (meter units; root l=2R).
    // splitFactor is LIVE-TUNABLE via window.__splitFactor so the px/poly target
    // (4-50 px per triangle edge) can be calibrated in-browser with one dispatch
    // (no rebuild / reload) -- the efficiency analog of __diag.setGen. A SMALLER
    // splitFactor => smaller splitDist => quads split only when much closer => COARSER
    // mesh => MORE px per poly (the baseline measured px/poly median 0.73-1.56, far
    // below the 4-50 band: the terrain was over-subdivided ~5-20x, which also saturated
    // the atlas and drove tileGenMs to ~950ms). Clamp to a sane positive range.
    let sf = (typeof window !== 'undefined' && window.__splitFactor != null)
      ? Math.max(0.05, +window.__splitFactor) : splitFactor;
    // ONE altitude->splitFactor relationship (skipped when window.__splitFactor pins it, so the
    // live px/poly sweep stays authoritative). Two regimes, exactly ONE applies at any altitude:
    // The multiplier is MONOTONE-NONDECREASING as altitude drops (detail must never decrease on
    // approach -- user: 'detail decreased going under 200km'. The old bell decayed from its ~200km
    // peak back to 1.0 by 50km, so subdivision fell 200->50km). Shape, high alt -> surface:
    //   >=800km : 1.0x   (planet small in frame, base splitFactor suffices)
    //   800->150km : ramp UP 1.0 -> PEAK (2.6x) -- the near surface grows in frame, fill it / no
    //               black corner wedges (the 'fov above 100km' problem)
    //   150->50km : HOLD the peak (plateau, no decay) -- detail stays high through the descent
    //   <=50km   : keep rising peak -> 3.1x at the surface (closeup polys grow as the eye nears the
    //               deck; px/poly was ~67 just past target at 5km)
    // altitude above the sea-level sphere (km). Hoisted to the outer scope so the deck-cap
    // gate (below, ~line 465) can read it -- it was previously block-scoped inside the
    // splitFactor branch, so the deck-cap reference threw ReferenceError: altKm is not defined
    // and killed the whole render loop (frozen __altM, zero quads, overlay never torn down).
    const altKm = Math.max(0, (camDist - R) / 1000);
    // ALTITUDE->splitFactor RAMP is OPT-IN (opts.altSplitRamp). The demo always pinned
    // window.__splitFactor so this ramp never ran -- the blessed look is the FLAT splitFactor at all
    // altitudes. Default-off so a bare SDK consumer renders that same flat look without the demo's
    // pin. A consumer wanting altitude-adaptive density passes opts.altSplitRamp:true and leaves
    // window.__splitFactor unset.
    // DENSITY TARGET (ff-planet-density-target, 2026-06-19): the tessellation acceptance metric is
    // ~20-40 px per TRIANGLE (a denser-only-where-it-shows band that sits inside the historical 4-50
    // px-per-poly-EDGE diagnostic, window.__diag.pxPerPoly / window.__glGrid). The measured deck plateau
    // PEAK 1.4 below already lands the median at ~22px (browser-18: sf1.4 median 22px, deeper INTO the
    // band than sf2.0's 11px sub-pixel tail), and the altitude knots (KN[]) coarsen toward distance. These
    // are MEASURED values (octave/split A/Bs cited inline); the 20-40 target is the acceptance gate they
    // were tuned against, NOT a fresh blind re-tune -- pushing splitFactor without a live px/poly sweep
    // regresses (sf2.0 over-tessellated to sub-pixel; sf1.0 under-tessellated past the band). The new
    // altitude octave clamp (gl-render _clampOcts) cuts per-vertex ALU at distance WITHOUT changing this
    // vertex density, so it is orthogonal to the px/triangle target.
    if (opts.altSplitRamp && (typeof window === 'undefined' || window.__splitFactor == null)) {
      const PEAK = 1.4;   // 2.0 -> 1.4 (user 2026-06-04 destructive FPS run, browser-18 measured): at the
      // 6km closeup the frame is 96.6% VS+raster-bound (fullMs 36.3, vsRaster 35.1, fs 1.2 = dead lever).
      // A LIVE __splitFactor sweep at 6km showed PEAK 2.0 over-subdivides the low-alt footprint into a
      // SUB-PIXEL tail (pxPerPoly p10 0.01, median 11px, only 37% in the 4-50 band): sf2.0=2635q/34.3ms,
      // sf1.4=1480q/21.0ms (1.6x faster) and median climbs 11->22px = DEEPER into the 4-50 target band
      // (fracInBand 0.37->0.41, BETTER not worse). So 1.4 removes invisible over-tessellation, not detail:
      // the polys move toward the target screen size. Below 1.4 (sf1.0 median 44px) starts under-
      // tessellating the band, so 1.4 is the calibrated low-alt plateau. broadShapeM octave cuts were
      // rejected (change the shape/seams, refuted historically); the FS is a dead lever at 3.4%.
      let mul;
      if (altKm >= 700) {
        // HIGH-ALT LOD SWAP CURVE -- SPREAD 700km-3Mm (user 2026-06-11: 'the lods at around 700km to
        // 1Mm must be spread out from 700km to 3Mm'). The old knots stacked L6/L7/L8 onsets at
        // 931/895/860km (measured node 7111); re-solved (node solver 7113, bisection onsets + random
        // + coordinate search against this exact quadtree pipeline incl LOD_STEP 4.0 and the 0.35
        // lean) so the swaps log-spread: L6 onset 2955km, L7 1438km, L8 686km, L5 4872km preserved,
        // full descent monotone, L9-L12 close-approach unchanged. Regime boundary moved 800 -> 700km
        // so the L8 swap can land at 700km (the <boundary ramp begins below the lowest knot).
        // (the src/lab altSplitMul mirror was deleted 2026-06-12; this is the only copy now.)
        // knots [altKm, sf]; sf log-interpolated. Outside the range clamps to the end knot.
        const KN = [[700,0.865],[900,1.009],[1200,0.966],[1700,0.898],[2400,1.19],[3200,0.865],[5000,0.86],[12000,0.72],[20000,0.60],[40000,0.45]];
        if (altKm <= KN[0][0]) { mul = KN[0][1]; }
        else if (altKm >= KN[KN.length-1][0]) { mul = KN[KN.length-1][1]; }
        else { for (let i = 1; i < KN.length; i++) { if (altKm <= KN[i][0]) {
          const a0 = KN[i-1][0], v0 = KN[i-1][1], a1 = KN[i][0], v1 = KN[i][1];
          const t = (Math.log(altKm) - Math.log(a0)) / (Math.log(a1) - Math.log(a0));
          mul = v0 + (v1 - v0) * t; break;
        } } }
      } else if (altKm >= 150) {
        const x = (700 - altKm) / (700 - 150);      // 0 at 700km -> 1 at 150km (boundary synced to the 700km knot floor)
        mul = 1.0 + (PEAK - 1.0) * (x*x*(3 - 2*x)); // smoothstep up to the peak
      } else if (altKm >= 50) {
        mul = PEAK;                                  // plateau (no decay on the way down)
      } else {
        // <=50km: HOLD the peak, do NOT keep climbing. The old "2.6->3.1x at the deck" climb
        // (user 2026-06-01j: '17k quads at 24km, really slow') compounded with distFactor=sf*3 to
        // over-subdivide (browser-4582 pxPerPoly median 1.62, only 29% in the 4-50 band = ~6-10x too
        // fine). Maturing detail past 50km is the mesh subdividing into a denser sample of the same
        // fractal; pushing splitFactor higher just makes sub-pixel polys. Flat plateau here.
        mul = PEAK;
      }
      // W2 SINGLE-VERSION LOD LEAN (mob-w2, unconditional -- not a device tier): scale the
      // computed splitFactor (both regimes: the high-alt hold-off and the 150km ramp/plateau)
      // by 0.35. This is the biggest ALU win toward the 512 layer cap: it drops peak visible
      // leaves from ~1200-1950 toward ~600-900 by coarsening the mesh ~3x (fewer triangles, the
      // frame is 96%+ VS+raster-bound at the deck). 0.35 is THE value, hardcoded -- there is no
      // mobile-vs-desktop branch. (Pairs with the near-radius tighten in quadtree.js.)
      sf = sf * mul * 0.35;
    }
    // LOD-STEP PUSH (user 2026-06-09: 'push back the lod area one step so everything is 1 step higher
    // detail, don't add an lod'). One LOD step = a factor 2 in the screen-space split threshold (a quad
    // of length l vs l/2): doubling splitDist makes every quad split at 2x its current distance, so each
    // region resolves exactly one level finer and every LOD ring pushes outward by one step. Applied
    // ONLY to splitDist (NOT distF below): distF = sf*8.0 is the altitude-weighting term, and scaling sf
    // into BOTH compounds into ~2 levels at altitude (witnessed: base sf*2 gave mx 5->7 at 8000km). Keep
    // distF on the original sf so the push is a clean ONE step. maxLevel (16) is untouched -- no new LOD.
    const LOD_STEP = 3.6;   // 2.3->3.6; tightens the far-ring by reducing LOD near the horizon. NOTE: splitDist floors at 1.1 so deck quad count is set by splitFactor (0.28 ~= 500 quads), not this.
    qt.computeSplitDist(sf * LOD_STEP, gl.drawingBufferHeight || 480, fovy);
    // DETAIL-FARTHER (user 2026-06-01h: each LOD pop should happen ~3x farther out -- 6km detail at
    // 24km, etc.). A quad subdivides when camAlt < l * splitDist * distFactor, so tripling distFactor
    // shifts every LOD pop ~3x higher in altitude WITHOUT densifying (leaf count stays ~same, unlike
    // raising splitDist which also squares the count). distFactor was = sf (~1-3); decouple it to
    // ~3x sf so the curve shifts up in altitude. Lab-tuned (terrain-lab.mjs lodReport): distFactor 6
    // puts the L15 detail at 24km that distFactor 2 reached only at 6-9km. window.__distFactor overrides.
    // distFactor shifts WHERE LOD pops happen in altitude (each pop ~Nx farther) WITHOUT densifying.
    // sf*3 (session-h 'detail 3x farther') compounded with the low-alt sf ramp to over-subdivide at
    // 24km (browser-4582). Pull it back to sf*1.8 -- LOD still pops well ahead of the old sf*1, but
    // the 24km-horizon swath is no longer blanket-refined to L15. window.__distFactor overrides for
    // the live px/poly sweep.
    // distFactor sf*1.8 -> sf*3.6 (user 2026-06-01j: 'the LOD change at 1k should happen at 2k, 2k->4k,
    // 3k->6k, 6k->12k' = pops ~2x FARTHER in altitude). distFactor scales the altitude at which each
    // LOD pop fires WITHOUT densifying the leaf count; doubling it doubles the pop altitude. The
    // distance-falloff (quadtree.js) handles the horizon overdraw separately, so raising this is safe.
    // sf*3.6 -> sf*8.0 (lod-mip-range-altitude-2x, user 2026-06-06: 'we want the detail we see at 5.5km
    // to display at 12km' = each LOD pop ~2.2x FARTHER again). Measured (quadtree, sf=1): at 3.6 the
    // L15 detail pops at 6km; at 8.0 it pops at ~13km -- so 5.5km-detail now displays at ~12km, 3.5km
    // at ~9km, 2.5km at ~6km, 1.5km at ~3km, matching the user's table. Leaf count is unchanged (distF
    // shifts WHERE pops fire in altitude, it does not densify), so this is a pure detail-farther push.
    const distF = (typeof window !== 'undefined' && window.__distFactor != null) ? +window.__distFactor : sf * 8.0;
    // maxLevel LIVE-TUNABLE via window.__maxLevel. Raised default cap so the deeper (now-farther) LODs
    // are not clipped before the fractal detail runs out. Clamp to a sane range.
    let mxl = (typeof window !== 'undefined' && window.__maxLevel != null)
      ? Math.max(2, Math.min(22, window.__maxLevel|0)) : maxLevel;
    // ALTITUDE-GATED DECK CAP (user 2026-06-04, measured deck VS-bound ~27fps): on very-low
    // approach the deepest levels L15/L16 (cells ~14m/~7m) are ~10-21% of the frame's quads and
    // the frame is 98% vertex-shader, so capping them claws back deck FPS. The user chose to trade
    // that sub-30m close-approach relief for frame rate (cap to 14 = ~28m cells, the vtxDisplace
    // ~31m floor). Only fires under DECK_CAP_ALT_KM (where L15+ actually trigger, per the
    // distance-falloff); above it the full cap stands so descent detail is unaffected. An explicit
    // window.__maxLevel override still wins (manual tuning escape hatch). Live-tunable threshold via
    // window.__deckCapAltKm (default 1km).
    const DECK_CAP_ALT_KM = (typeof window !== 'undefined' && window.__deckCapAltKm != null) ? +window.__deckCapAltKm : 1.0;
    // RELIEF-KEYED ADAPTIVE DECK CAP (DEFECT 1b, user 2026-06-06: 'scale to bounding areas within
    // spatial indexes or otherwise increase the fidelity'). The flat L14 deck cap (FPS lever) wastes
    // the deeper LODs on flat ground but ALSO starves rugged ground of the fidelity it needs. Sample
    // the anchor relief UNDER the nadir (ONE hpf.sampleDir per frame, negligible) and raise the cap on
    // mountainous ground (mirror the shader mtn gate smoothstep(16.8,18.6, elevAmp)) so rugged tiles
    // subdivide to L16 (~7m cells, the vtxDisplace floor) while flat tiles stay capped at L14 -> the
    // polygon budget follows the relief, within the existing quadtree spatial index. nadir-only sample
    // so the foreground the user is descending toward drives it.
    let DECK_CAP_LEVEL = 12;
    if (hpf && hpf.sampleDir) {
      const nA = hpf.sampleDir([camWorldPos[0]/camDist, camWorldPos[1]/camDist, camWorldPos[2]/camDist]);
      const mtn = Math.max(0, Math.min(1, (nA.elevAmp - 16.8) / (18.6 - 16.8)));   // mountain-belt weight 0..1
      DECK_CAP_LEVEL = 12 + Math.round(2 * mtn);   // flat L12 -> rugged L14, adaptive
    }
    const _maxLevelOverridden = (typeof window !== 'undefined' && window.__maxLevel != null);
    if (!_maxLevelOverridden && altKm < DECK_CAP_ALT_KM && mxl > DECK_CAP_LEVEL) mxl = DECK_CAP_LEVEL;
    // HIGH-ALT LOD DROP (user 2026-06-13): at 30km+ the finest LOD is sub-pixel.
    // Drop 1 level at 30km, 2 levels at 700km+ so the next-coarser LOD naturally expands
    // (cells 2x larger). Skipped when window.__maxLevel is set.
    if (!_maxLevelOverridden && altKm >= 30 && mxl > 4) {
      mxl -= (altKm >= 700) ? 2 : 1;
    }
    qt.setConfig(R, mxl, distF);
    const splitDist = sf + 1.0;

    // Render ALL 6 cube faces. For each face, run the quadtree with the camera in THAT
    // face's local frame, then accumulate its visible leaf quads (tagged with the face).
    // Back-facing faces still subdivide coarsely (camera far on their local z) and are
    // depth-culled / off-screen, so the cost is bounded; the camera-facing face gets the
    // deep LOD. This makes the whole globe (silhouette + far side curving away) render,
    // not just the one face. The atlas LRU keys include the face, so tiles don't collide.
    // pick the pool NOT referenced by _pipelineQuads (first frame: null -> A). _quadN = fill counter.
    const quads = (_pipelineQuads === _quadsPoolA) ? _quadsPoolB : _quadsPoolA;
    let _quadN = 0;
    let fallbackCount = 0, maxFallbackLevel = -1, frontFallback = 0, culledCount = 0;
    let frontFace = pickFace(camWorldPos);
    // LOD-CENTER: the deepest LOD must land where the user is LOOKING, not at nadir.
    // getCameraDist measures lateral distance from g_localCam.x/y = the camera's
    // PROJECTED (nadir) position, so the finest quads cluster directly under the camera. When
    // the camera looks forward/oblique, the screen-centre ground point is FORWARD of nadir, so
    // the user "sees detail increasing in front of us" (the high-LOD patch is below the view).
    // FIX (JS-only): feed the quadtree a LOD-REFERENCE position whose
    // DIRECTION is shifted toward the aim ground point but whose MAGNITUDE stays == camDist, so
    // the altitude term (g_camAlt = |localCam| - R) is unchanged while the lateral term now
    // measures distance from the AIM point. At nadir-look this is identity (aimDir == camDir).
    // LOD reference: a MILD aim-bias (0.3) extends the quadtree's coverage toward the look direction
    // so the FORWARD ground fills the frame (fixes the forward-edge black band) WITHOUT moving the
    // density peak off the standing point -- the reference stays 0.7*camera + 0.3*aim, so the deepest
    // LOD is still under the camera (honors 'LOD local to standing') while the looked-toward arc gets
    // enough subdivision to tile the screen with no gap. window.__lodAimBias overrides (0 = pure nadir).
    let lodRefPos = camWorldPos;
    // AIM GROUND POINT (the look ray's surface hit) -- captured for BOTH the LOD-ref aim-bias AND
    // the far-LOD foreground protection. When the camera is pitched down, the bottom-of-screen band
    // sits at the aim point, OFF the nadir; protecting only the nadir box left that band slightly
    // under-covered in off-axis look azimuths (witnessed: bottom-strip coverage az90 0.964 vs az180
    // 1.0). Passing the aim point as a SECOND falloff-protect center keeps the bottom band full-LOD
    // in every azimuth without moving the density peak off the standing point.
    let aimGroundPt = null;
    {
      // aimBias DEFAULT 0 (user 2026-06-02: 'the LOD center still doesnt match the position center').
      // ANY aim-bias blends camDir with the look-ground-point dir, which moves the DENSITY PEAK off the
      // camera nadir toward where you look (at oblique angles the aim point is far toward the horizon ->
      // big shift). The peak must sit EXACTLY under the camera = the position center. So lodRefPos stays
      // the pure camera (aimBias 0); the FORWARD frame is still filled by the SEPARATE aimLocal
      // foreground-PROTECT passed to the quadtree (it keeps the looked-toward band full-LOD WITHOUT
      // moving the peak). window.__lodAimBias>0 re-enables the shift if a forward-bias is ever wanted.
      const aimBias = (typeof window !== 'undefined' && window.__lodAimBias != null) ? Math.max(0, Math.min(1, +window.__lodAimBias)) : 0.0;
      const fwdLen = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
      const fx = fwd[0]/fwdLen, fy = fwd[1]/fwdLen, fz = fwd[2]/fwdLen;
      // ray-sphere: nearest hit of (cam + t*fwd) with sphere radius R. b = cam.fwd, c = |cam|^2-R^2.
      const b = camWorldPos[0]*fx + camWorldPos[1]*fy + camWorldPos[2]*fz;
      const cc = camDist*camDist - R*R;
      const disc = b*b - cc;
      if (disc > 0) {
        const tHit = -b - Math.sqrt(disc);
        if (tHit > 0) aimGroundPt = [camWorldPos[0] + tHit*fx, camWorldPos[1] + tHit*fy, camWorldPos[2] + tHit*fz];
      }
      if (aimBias > 0 && disc > 0) {
        const t = -b - Math.sqrt(disc);      // nearest forward intersection
        if (t > 0) {
          // aim ground point, then its DIRECTION scaled to camDist (preserve altitude term).
          const gx = camWorldPos[0] + t*fx, gy = camWorldPos[1] + t*fy, gz = camWorldPos[2] + t*fz;
          const gl = Math.hypot(gx, gy, gz) || 1;
          // blend camera-dir and aim-ground-dir, renormalize to camDist.
          const cnx = camWorldPos[0]/camDist, cny = camWorldPos[1]/camDist, cnz = camWorldPos[2]/camDist;
          let rx = cnx*(1-aimBias) + (gx/gl)*aimBias;
          let ry = cny*(1-aimBias) + (gy/gl)*aimBias;
          let rz = cnz*(1-aimBias) + (gz/gl)*aimBias;
          const rl = Math.hypot(rx, ry, rz) || 1;
          lodRefPos = [rx/rl*camDist, ry/rl*camDist, rz/rl*camDist];
        }
      }
    }
    // diag: expose the LOD reference shift (angular separation from nadir) for live tuning.
    // Diagnostic-only, zero consumers found in planet.html/src -- gated behind window.__glCheck
    // (the established dev-diagnostic flag, see the render.checkGlError() gate below) so the
    // Math.acos + trig doesn't run unconditionally every rebuild.
    try {
      if (typeof window !== 'undefined' && window.__glCheck) {
        const sepDot = (lodRefPos[0]*camWorldPos[0] + lodRefPos[1]*camWorldPos[1] + lodRefPos[2]*camWorldPos[2]) / (camDist*camDist);
        window.__lodRefSepDeg = Math.acos(Math.max(-1, Math.min(1, sepDot))) * 57.29578;
      }
    } catch (e) {}
    // (No tile residency to pre-seed -- terrain is the per-vertex GPU fractal, every leaf draws.)
    // FRUSTUM CULL (budget optimization): skip quads fully outside the view frustum so they
    // don't consume atlas layers -- freeing budget for in-frame deep LOD (fewer fallbacks /
    // FRUSTUM CULL OFF BY DEFAULT (user: 'the FOV cull still omits on-screen elements at the edge').
    // The conservative 4-corner shell test mis-culls large near/edge quads whose sphere-bulged
    // interior is actually on-screen, so we don't run it: the GPU clips genuinely off-screen patches
    // for free, and the behind-limb cull below removes the ~80% backside quads cheaply. It is purely
    // a perf optimization; re-enable for diagnostics via window.__frustumCull (or opts.frustumCull).
    // FRUSTUM CULL DEFAULT-ON (2026-06-15): the historical over-cull (bulged oblique-low-alt quads
    // popping out) was fixed in quadOutsideFrustum (near-straddle KEEP + 3x3 sample grid + CULL_MAX_ELEV
    // 12km margin + 0.06 NDC slack). Live-measured SAFE+HUGE: at the deck quads 750->179 (-76%), full
    // 25.7->16.3ms (~1.58x), screen coverage stays 1.0 through yaw + at oblique 2km (no holes). The GPU
    // clips off-screen patches but still pays their VS + per-vertex fragment-gen, so culling them on the
    // CPU is a real win. Default ON; window.__frustumCull=false or opts.frustumCull===false disables.
    const cullOn = (typeof window !== 'undefined' && window.__frustumCull != null) ? !!window.__frustumCull : (opts.frustumCull !== false);
    const cullActive = cullOn && render.cullMatrix;
    // cull-debug: count frustum-culled-but-on-screen quads (false-cull signature) when enabled.
    const _cullDbgOn = (typeof window !== 'undefined' && !!window.__cullDebug);
    let _cullDbgOnScreen = 0;
    // Use viewProjNoEye (proj*viewRel, NO translate) + pass the eye so quadOutsideFrustum can make
    // each corner camera-relative in JS doubles (fp32-precision fix for the ground-nadir blank).
    const _cm = cullActive ? render.cullMatrix({ eye: camWorldPos, center: camTarget, up: camUp, fovy, surfElev }) : null;
    const vpr = _cm ? _cm.viewProjNoEye : null;
    // HIERARCHICAL FRUSTUM CULL context (batched-mesh-extensions-derived BVH-style subtree prune; see
    // quadtree.nodeOutsideFrustum). Extract the 6 camera-relative frustum planes from the SAME vpr the
    // per-leaf quadOutsideFrustum uses, ONCE per frame; the quadtree then rejects whole off-screen
    // SUBTREES before they reach the ~700-leaf per-leaf cull loop below (measured ~0.4-0.8ms of
    // GPU-independent CPU at the deck, ~61% of leaves off-screen). null when the frustum cull is off
    // (vpr null) -> the quadtree prunes nothing (conservative; mirrors the vpr-null leaf guard below).
    // The drawn leaf set is UNCHANGED -- the node sphere is conservative, so any pruned subtree's leaves
    // would all have been frustum-culled at the leaf level anyway.
    let cullCtx = null;
    if (cullActive && vpr) {
      // GATE: the subtree prune is a CPU-rebuild WIN at every view EXCEPT looking near-straight-DOWN,
      // where the visible cone fills the frustum (nothing off-screen to prune) so the per-node test is
      // pure overhead (node A/B sweep: ~0.8x at exact nadir; 1.0-1.85x everywhere else). Disable it
      // within ~18deg of straight down. lookDot = fwd . up: -1 straight down, 0 horizon, +1 up. The
      // pruned leaf set is IDENTICAL either way, so toggling is visually seamless + frame-time-safe
      // (the rebuild is pipelined behind the GPU frame regardless). window.__hcull forces on/off.
      const fl = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
      const lookDot = (fwd[0] * camWorldPos[0] + fwd[1] * camWorldPos[1] + fwd[2] * camWorldPos[2]) / (fl * camDist);
      const hcOn = (typeof window !== 'undefined' && window.__hcull != null) ? !!window.__hcull : (lookDot > -0.95);
      if (hcOn) {
        extractFrustumPlanes(vpr, _cullCtxScratch.planes);   // refill the hoisted scratch in place
        _cullCtxScratch.ex = camWorldPos[0]; _cullCtxScratch.ey = camWorldPos[1]; _cullCtxScratch.ez = camWorldPos[2];
        cullCtx = _cullCtxScratch;   // R/maxElev fixed at init; ux..cz set per-face below (SCALE-INVARIANT margin)
      }
    }
    // BEHIND-LIMB CULL (the dominant bottleneck fix). The baseline measured ~80% of all
    // generated quads sitting BEHIND the planet's horizon -- they are geometrically
    // occluded by the globe (depth-culled to nothing) yet each still costs 3 FBO tile-gen
    // passes (elev+normal+ortho) + a draw, saturating the atlas (1920/1920) and driving
    // tileGenMs to ~950ms. A quad whose deformed surface point lies beyond the horizon
    // tangent can NEVER be visible (the near hemisphere always occludes it), so skip it
    // before tile-gen. Horizon test: the tangent ray from the camera touches the sphere
    // where the surface-point direction wp satisfies dot(wp, camDir) == R/camDist; points
    // with dot < that cosine are over the horizon. A generous margin (subtract a few quad
    // half-angles via the elevation+arc slack) keeps limb quads that straddle the horizon.
    // Disabled for coarse quads (level<2: a single coarse quad can span the whole limb) and
    // when very close to the surface (camDist<R*1.001: the horizon is degenerate/at-foot).
    const camDirX = camWorldPos[0]/camDist, camDirY = camWorldPos[1]/camDist, camDirZ = camWorldPos[2]/camDist;
    // (the forward-cone limb rescue was replaced by quadOutsideFrustum; its normalized look-dir
    // lookX/Y/Z + _fl hypot were dead with zero readers -- removed 2026-06-10 ESE cleanup.)
    const cosHorizon = Math.min(1.0, R / camDist);
    // angular slack so a quad straddling the horizon (peak elevation + its own arc) is kept:
    // CULL_MAX_ELEV lifts the visible point, and the quad subtends ~l/R radians of arc.
    // The horizon exists at ANY altitude above the surface, so the limb cull is valid all
    // the way down -- the earlier R*1.001 guard (~6.4km) wrongly DISABLED it at closeup
    // (5km), leaving 1968 quads with wastedFrac 0.87 (browser-5). Lower the guard to a tiny
    // epsilon above the surface; the slack term already keeps any limb-straddling quad.
    // (Eye exactly at/under the surface is degenerate -- cosHorizon would be >=1 -- so skip.)
    // SCALED SLACK (2026-06-13): at low altitude the fixed CULL_MAX_ELEV=12km slack let all
    // back-face quads through when the limb cull was disabled by the 127m guard; scale the
    // elevation slack by altitude so the cull tightens naturally near the ground.
    const altM = Math.max(0.0, camDist - R);
    const elSlack = Math.min(R * CULL_ELEV_FRAC, 200.0 * (R / 6360000.0) + altM * 0.5);   // SCALE-INVARIANT: the 12km cap + the 200m min slack both scale with R
    const limbCullActive = (typeof window !== 'undefined' && window.__limbCull != null ? !!window.__limbCull : true)
      && altM > 0.5;
    // CPU/GPU PIPELINING (real overlap, 2026-06-14): issue LAST frame's cached quads to the GPU
    // NOW, BEFORE the 6-face quadtree build below runs, so the GPU draw and this frame's CPU
    // build actually overlap. Previously this draw sat AFTER the build loop (no overlap -- the
    // CPU work had already finished before the draw was issued). cam carries THIS frame's view
    // (1-frame geometry latency, standard pipelining). First frame (no cache) draws after build.
    // morphSplitDist/morphDistFactor/morphMaxLevel: see the cam2 comment above (static-frame branch) --
    // same quadtree-global (not per-quad) geomorph inputs, threaded here for the moved-camera path.
    const cam = { eye: camWorldPos, center: camTarget, up: camUp, fovy, displayMode, surfElev, shadowInfo, morphSplitDist: _geomorphLod ? qt.splitDist : 0, morphDistFactor: qt.distFactor, morphMaxLevel: qt.maxLevel };
    if (_pipelineQuads) {
      render.render(_pipelineQuads, cam, sun, time);
    }
    for (let face = 0; face < 6; face++) {
      // LOD drive uses lodRefPos (aim-shifted, altitude preserved) so deepest LOD follows the
      // look point; the quad record keeps the TRUE-camera localCam (for the VS geomorph
      // defCamera uniform), and the cull below uses the TRUE camera (camDirX/Y/Z, camWorldPos).
      // OPTIMIZATION (ms-worldtofacelocal-alias): worldToFaceLocal(face, camWorld, R) is a pure
      // function of its 3 args. When aimBias===0 (the default/common case, see the block above
      // building lodRefPos), lodRefPos IS camWorldPos (same reference, never reassigned in that
      // branch) -- so calling worldToFaceLocal twice for this face recomputes the identical
      // atan/dot chain. Alias instead of recomputing; only diverges when aimBias>0 reassigns
      // lodRefPos to a distinct aim-shifted vector.
      const localCam = worldToFaceLocal(face, camWorldPos, R);
      const lodLocalCam = (lodRefPos === camWorldPos) ? localCam : worldToFaceLocal(face, lodRefPos, R);
      // pass the TRUE camera nadir (localCam x,y) so the far-LOD falloff protects the real foreground
      // (decoupled from the aim-shifted lodLocalCam) -- nearby stays fine while the far horizon trims.
      // ALSO pass the AIM ground point (face-local x,y) as a SECOND foreground-protect center so the
      // pitched-down bottom-of-screen band stays full-LOD in every look azimuth (fixes the small
      // azimuth-asymmetric bottom-edge missing quads). null aim (look misses the sphere) -> nadir only.
      const aimLocal = aimGroundPt ? worldToFaceLocal(face, aimGroundPt, R) : null;
      // pass the TRUE altitude (|camWorldPos|-R) so the quadtree does not derive it from the WARPED
      // face-local hypot (which overestimates off the face centre -> LOD stalled everywhere but the
      // start point; user 2026-06-03). camDist = |camWorldPos|, R = planet radius.
      // point the reused cull context at THIS face's local frame (the quadtree maps node corners to
      // world dirs with these axes); the planes + eye are already set for the whole frame.
      if (cullCtx) {
        const Fc = FACE_FRAME[face];
        cullCtx.ux = Fc.u[0]; cullCtx.uy = Fc.u[1]; cullCtx.uz = Fc.u[2];
        cullCtx.vx = Fc.v[0]; cullCtx.vy = Fc.v[1]; cullCtx.vz = Fc.v[2];
        cullCtx.cx = Fc.c[0]; cullCtx.cy = Fc.c[1]; cullCtx.cz = Fc.c[2];
      }
      const leaves = qt.updateQuadtree(lodLocalCam[0], lodLocalCam[1], lodLocalCam[2], localCam[0], localCam[1],
                                       aimLocal ? aimLocal[0] : undefined, aimLocal ? aimLocal[1] : undefined,
                                       camDist - R, cullCtx);
      const n = leaves.length;
      if (n <= 0) continue;
      const F = FACE_FRAME[face];
      for (let i = 0; i < n; i++) {
        const q = leaves[i];
        const level = q.level, tx = q.tx, ty = q.ty;
        const ox = q.ox, oy = q.oy, l = q.l;
        // behind-limb cull (cheap; before the expensive frustum cull + tile-gen).
        // _qofInside: the limb RESCUE below and the main cull further down called quadOutsideFrustum
        // with byte-identical args (vpr is fixed for the frame), so a rescue that returned false made
        // the main test re-derive that same false at full price -- 18 projections. Measured on this
        // world's config (R=63600, maxLevel 13): 20-23% of all such calls at 2-50 m eye height.
        let _qofInside = false;
        if (limbCullActive && (level|0) >= 2) {
          const cx = ox + l*0.5, cy = oy + l*0.5;
          const len = Math.hypot(cx, cy, R) || 1;
          const wx = (cx/len)*F.u[0]+(cy/len)*F.v[0]+(R/len)*F.c[0];
          const wy = (cx/len)*F.u[1]+(cy/len)*F.v[1]+(R/len)*F.c[1];
          const wz = (cx/len)*F.u[2]+(cy/len)*F.v[2]+(R/len)*F.c[2];
          const dotOut = wx*camDirX + wy*camDirY + wz*camDirZ;
          // TIGHT slack = elevation lift + the quad's own arc, NO fixed 0.04 floor. The old floor kept
          // a ~17deg-wide RING at ALL azimuths at low alt (cosHorizon->1) -> 55% backside quads DRAWN
          // (browser-4726 wastedFrac 0.55) = the close-approach FPS sink. A quad above this tight
          // horizon is genuinely visible (kept); a quad below it is kept ONLY by the forward-cone
          // rescue, so sideways/backside near-horizon rings are culled.
          const slack = elSlack / R + (l / R);
          if (dotOut < cosHorizon - slack) {
            // FRUSTUM RESCUE (user 2026-06-05: 'culling nearby quads unnecessarily making land
            // disappear'). The old forward-CONE rescue used a fixed ~53deg half-angle cone
            // (cos(fovy*0.9+0.30)), but the real view FRUSTUM is WIDER than that cone -- especially
            // horizontally with the screen aspect ratio. So an on-screen quad past the geometric
            // horizon but outside the narrow cone (e.g. near-ground land off to the side of the look
            // direction) got LIMB-CULLED while still visible -> land popped out of the frame. The
            // authoritative on-screen test is quadOutsideFrustum (NDC AABB vs viewport, the same test
            // applied below); defer to it: a past-horizon quad is culled ONLY if it is also outside the
            // real frustum. The backside (genuinely off-screen) still fails the frustum test and is
            // culled, so the perf intent (no backside draw) is preserved without trimming visible land.
            // GUARD: vpr is null when the frustum cull is OFF (cullActive false -> line ~570). Without
            // this guard quadOutsideFrustum dereferences vpr[0] = null and throws 'Cannot read
            // properties of null (reading 0)' the moment the camera moves (user 2026-06-06). When there
            // is no frustum matrix we cannot prove the past-horizon quad is off-screen, so KEEP it
            // (conservative: a few extra backside quads when cull is off, never a crash, never lost land).
            if (vpr) {
              if (quadOutsideFrustum(face, ox, oy, l, R, vpr, camWorldPos)) { culledCount++; continue; }
              _qofInside = true;   // same args, same vpr -> the main test below can only re-derive false
            }
          }
        }
        if (cullActive && (level|0) >= 2 && !_qofInside && quadOutsideFrustum(face, ox, oy, l, R, vpr, camWorldPos)) {
          culledCount++;
          // CULL DEBUG: count quads the frustum cull dropped that ACTUALLY project on-screen (the
          // false-cull bug signature). Project the quad center via the cull's own camera-relative
          // matrix; on-screen = in front (cw>0) and |ndc|<1. window.__cullDebug toggles this.
          if (_cullDbgOn) {
            // match the tangent warp (same as quadOutsideFrustum + the VS) so the on-screen test
            // agrees with the rendered geometry (an un-warped center mis-counts toward face edges).
            const _wk = Math.PI/4.0;
            const ccx = R*Math.tan(((ox + l*0.5)/R)*_wk), ccy = R*Math.tan(((oy + l*0.5)/R)*_wk);
            const cl = Math.hypot(ccx, ccy, R) || 1;
            const cwx = (ccx/cl)*F.u[0]+(ccy/cl)*F.v[0]+(R/cl)*F.c[0];
            const cwy = (ccx/cl)*F.u[1]+(ccy/cl)*F.v[1]+(R/cl)*F.c[1];
            const cwz = (ccx/cl)*F.u[2]+(ccy/cl)*F.v[2]+(R/cl)*F.c[2];
            const dX = cwx*R - camWorldPos[0], dY = cwy*R - camWorldPos[1], dZ = cwz*R - camWorldPos[2];
            const px = vpr[0]*dX+vpr[4]*dY+vpr[8]*dZ+vpr[12];
            const py = vpr[1]*dX+vpr[5]*dY+vpr[9]*dZ+vpr[13];
            const pw = vpr[3]*dX+vpr[7]*dY+vpr[11]*dZ+vpr[15];
            const pz = vpr[2]*dX+vpr[6]*dY+vpr[10]*dZ+vpr[14];
            // pz<=pw (in front of the far plane) added to the on-screen test: perspective division
            // does not clip X/Y by depth, so a quad genuinely beyond the far plane can still project
            // to an in-range NDC x/y at its center -- without this the false-cull counter over-counts
            // correctly-culled distant geometry as a false-cull (confirmed via a live investigation:
            // every prior "false cull" candidate turned out to project on-screen X/Y while its actual
            // nearest world-space point was 10-15km away, past a ~5.7km far plane).
            if (pw > 1e-3 && Math.abs(px/pw) < 1 && Math.abs(py/pw) < 1 && pz <= pw) _cullDbgOnScreen++;
          }
          continue;
        }
        // HOST OCCLUSION HOOK (opt-in, default off): mapspinner has no THREE.js/depth-buffer-query
        // machinery of its own, but a host embedding the planet (e.g. spoint, via TerrainBackdrop.js's
        // shared-depth design) DOES own the real depth buffer + any occlusion-query state (walls/
        // models drawn after terrain each frame -- see that host's own render-order comments). Rather
        // than mapspinner owning GL query objects (which would require a THREE dependency this SDK
        // deliberately has none of), the host supplies a predicate keyed by chunk id, populated from
        // ITS previous frame's resolved occlusion verdicts (one-frame latency, same discipline as
        // streaming-gltf's OcclusionQueryTier). Conservative fail-open: predicate absent or throwing
        // keeps the quad. worldCenter/worldSize let the host build its own query box WITHOUT
        // duplicating this file's tangent-warp face-local-to-world math (the same computation the
        // _cullDbgOn on-screen check above already performs, factored out here since the predicate
        // needs it unconditionally, not just under the debug flag).
        if (opts.occlusionPredicate) {
          try {
            const _wk = Math.PI / 4.0;
            const _ccx = R * Math.tan(((ox + l * 0.5) / R) * _wk), _ccy = R * Math.tan(((oy + l * 0.5) / R) * _wk);
            const _cl = Math.hypot(_ccx, _ccy, R) || 1;
            const wx = (_ccx / _cl) * F.u[0] + (_ccy / _cl) * F.v[0] + (R / _cl) * F.c[0];
            const wy = (_ccx / _cl) * F.u[1] + (_ccy / _cl) * F.v[1] + (R / _cl) * F.c[1];
            const wz = (_ccx / _cl) * F.u[2] + (_ccy / _cl) * F.v[2] + (R / _cl) * F.c[2];
            const worldCenter = [wx * R, wy * R, wz * R];
            const worldSize = l * 1.2;   // generous margin over the flat face-local span (deformed/elevated surface can exceed it slightly)
            if (opts.occlusionPredicate(face, level, tx, ty, worldCenter, worldSize)) { culledCount++; continue; }
          } catch (_) { /* fail-open: a throwing predicate never hides real terrain */ }
        }
        // No atlas/tile generation: terrain shape is the GPU fractal evaluated per-vertex, so every
        // visible leaf just draws (no resident-tile allocation, no ancestor fallback, no gen budget).
        // POOLED quad emit (reuse the slot's compound object across frames; allocate only past the
        // high-water mark). localCam is stored by reference exactly as before -- no behaviour change.
        let _qo = quads[_quadN];
        if (_qo === undefined) _qo = quads[_quadN] = { quad: { level: 0, tx: 0, ty: 0, ox: 0, oy: 0, l: 0 }, face: 0, localCam: null, splitDist: 0 };
        const _qd = _qo.quad; _qd.level = level; _qd.tx = tx; _qd.ty = ty; _qd.ox = ox; _qd.oy = oy; _qd.l = l;
        _qo.face = face; _qo.localCam = localCam; _qo.splitDist = splitDist;
        _quadN++;
      }
    }
    quads.length = _quadN;   // expose exactly the filled prefix (truncate any prior-frame tail)

    // ===== CPU/GPU PIPELINING: draw-before-compute =====
    // Phase 1 (GPU): draw cached quads from LAST frame's camera IMMEDIATELY so the GPU
    // starts processing while the CPU computes THIS frame's quadtree. render.render()
    // issues draw commands without gl.getError() so the GPU pipeline is not stalled.
    // Phase 2 (CPU): the 6-face loop above already populated `quads` — this overlaps
    // with GPU rendering of Phase 1. Phase 3: first frame (no cache) draws after compute.
    // glError is checked via render.checkGlError() after Phase 2 for diagnostics.
    // cam + the _pipelineQuads draw were HOISTED above the 6-face loop (real CPU/GPU overlap).
    // First frame (no cache) has nothing to pre-draw, so it draws THIS frame's quads here.
    if (!_pipelineQuads) {
      render.render(quads, cam, sun, time);
    }
    // glError = a hard client/server SYNC that drains the GL pipeline (the exact stall the draw-before-
    // compute pattern exists to avoid). The 1-in-30 periodic probe is REMOVED (2026-06-16, 144fps
    // smoothness / user 'no transfer spikes'): on a slow GPU that periodic sync was a ~one-frame hitch
    // every ~0.5-1.3s = visible jitter in steady state. Now gated FULLY behind window.__glCheck (dev
    // only); production assumes 0 and relies on the separate webglcontextlost listener for the
    // catastrophic case. Re-arm error probing live with window.__glCheck=1.
    const glError = (typeof window !== 'undefined' && window.__glCheck) ? render.checkGlError() : 0;
    _pipelineQuads = quads;
    // CULL DEBUG stats for the live HUD: kept/culled counts + the false-cull signature
    // (culledOnScreen = frustum-culled quads that actually project inside the screen) + whether
    // this was a REBUILD frame (cull ran) vs a cached re-render. Read by planet.html's __cullHud.
    try {
      if (typeof window !== 'undefined') {
        window.__cullStats = { kept: quads.length, culled: culledCount, culledOnScreen: _cullDbgOnScreen,
          cullActive, frame: 'rebuild', altM: Math.round((camDist - R) ) };
      }
    } catch(_){}
    // VEGETATION (Phase 1 billboards): build instances from the visible quads + draw after
    // terrain. Gated by window.__veg (default off). Reuses render.cullMatrix's viewProjRel.
    try {
      if (vegetation && typeof window !== 'undefined' && window.__veg) {
        const vn = vegetation.buildInstances(quads, cam);
        vegetation.draw(cam, sun, render.cullMatrix(cam).viewProjRel);
        try { window.__vegCount = vn; window.__grassCount = vegetation.grass; } catch(_){}
      }
    } catch(e){ try { window.__vegErr = String(e.message||e); } catch(_){} }
    try { window.__lastGLQuads = quads; window.__lastGLCam = cam; window.__lastGLRender = render; } catch(e){}
    // cache the rebuilt set for static-camera re-render (PERF). fwdLen2 = |fwd|^2 is the
    // dot-product threshold reference for the "turned" check above. The per-vertex fractal has
    // no tiles to stream, so the cache is always complete in one frame.
    // IN-PLACE REUSE (safe: `c` above is only read in the `!moved` early-return branch, which we did
    // not take -- by the time we reach here `c`/_frameCache's old pos/fwd arrays are dead, so
    // overwriting them avoids a fresh object + 2 fresh arrays every rebuild).
    if (_frameCache && _frameCache.pos) {
      _frameCache.pos[0]=camWorldPos[0]; _frameCache.pos[1]=camWorldPos[1]; _frameCache.pos[2]=camWorldPos[2];
      _frameCache.fwd = fwd; _frameCache.fwdLen2 = fwd[0]*fwd[0]+fwd[1]*fwd[1]+fwd[2]*fwd[2];
      _frameCache.displayMode = displayMode; _frameCache.quads = quads; _frameCache.frontFace = frontFace;
      _frameCache.fallbackCount = fallbackCount; _frameCache.maxFallbackLevel = maxFallbackLevel; _frameCache.frontFallback = frontFallback;
    } else {
      _frameCache = { pos: [camWorldPos[0],camWorldPos[1],camWorldPos[2]], fwd, fwdLen2: fwd[0]*fwd[0]+fwd[1]*fwd[1]+fwd[2]*fwd[2],
                      displayMode, quads, frontFace, fallbackCount, maxFallbackLevel, frontFallback };
    }
    return { quadCount: quads.length, glError, face: frontFace, residentCount: 0, fallbackCount, maxFallbackLevel, frontFallback, culledCount, cached: false };
  }

  // No tile atlas to drop; clearCache just invalidates the static-camera re-render cache so a
  // live param change (e.g. anchor re-bake) redraws. Kept for the __diag/gen-control call sites.
  function clearCache() { _frameCache = null; }
  return { frame, render, clearCache };
}
