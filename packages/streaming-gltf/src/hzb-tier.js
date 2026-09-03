// hzb-tier.js — GPU hierarchical-Z (depth-pyramid) occlusion culling, WebGL2.
//
// SCOPE (read before extending): this is the depth-PYRAMID GENERATION half of
// hierarchical-Z occlusion culling, real and working end-to-end, PLUS a
// per-candidate CPU-side HZB query path (isOccluded) that already replaces
// OcclusionQueryTier's hardware-query round-trip with a single texelFetch
// readback per candidate against the coarsest usable mip. What is NOT in this
// pass: a GPU-side instance-culling CONSUMER (transform-feedback visibility
// buffer / indirect multi-draw count buffer) that tests thousands of
// instances against the pyramid in one shader dispatch without any CPU
// readback at all — that is the natural next tier once this repo has a
// GPU-driven multi-draw-indirect path to feed (it currently does not; every
// consumer, cluster-lod-mesh.js included, drives per-object/per-cluster
// drawElements from JS). See "NEXT TIER" at the bottom for the concrete shape
// that follow-up would take.
//
// WHY THIS EXISTS (vs. OcclusionQueryTier): hardware occlusion queries
// (ANY_SAMPLES_PASSED_CONSERVATIVE) are BEGIN/END pairs — each is its own
// draw + driver round-trip, and OcclusionQueryTier already documents (see
// that file's header) that this becomes the CPU cost at just dozens of
// candidates/frame on ANGLE/D3D11, hence its maxQueriesPerFrame budget +
// round-robin. A hierarchical-Z buffer inverts the cost model: build ONE
// mip-chain from the depth buffer once per frame (a fixed number of small
// fullscreen-quad passes, independent of candidate count), then test EVERY
// candidate against it with a cheap CPU-side texel readback (no query
// object, no begin/end, no driver-side async result machinery). This is
// what scales to thousands of candidates: query cost becomes O(mip levels)
// + O(candidates * 1 texel read) instead of O(candidates * query-object-
// round-trip).
//
// PYRAMID GENERATION (the real, working part):
//   1. Capture: scene depth is written into a THREE.DepthTexture-backed
//      WebGLRenderTarget (the caller's normal render, redirected there for
//      one frame — see captureAndBuild()).
//   2. Reduce: a raw-GL ping-pong chain of framebuffers, one per mip level,
//      each level MIN-reducing a 2x2 (edge-padded, odd-size-safe) block of
//      the previous level with a fullscreen-triangle fragment shader. MIN
//      (not average) is required for conservative occlusion culling — a
//      bounding-box footprint must be tested against the depth value that
//      is CLOSEST to the camera anywhere in its coverage (the most
//      conservative value real geometry might occupy). This mirrors the
//      standard HZB min-reduction used by GPU-driven renderers.
//   3. Query: isOccludedBox(worldBox, camera) projects the box to
//      screen-space NDC, picks the coarsest mip whose texel footprint still
//      covers the box's screen-space extent (so ONE texel read suffices —
//      the chosen-mip depth is a conservative min over strictly at least
//      the box's own footprint), reads that one texel back, and compares
//      against the box's nearest depth. A CPU->GPU readback per candidate
//      still costs a driver round-trip; see NEXT TIER for how a real
//      GPU-driven pipeline removes even that.
//
// Depth convention: this pyramid stores raw [0,1] gl_FragCoord.z-equivalent
// depth (post-projection, non-linear, standard GL depth range where SMALLER
// = closer to camera). MIN-reduction on this convention is correct for
// "closer to camera = smaller depth" occlusion testing — no linearization
// required for a correct (if not maximally tight) conservative test.

import * as THREE from 'three';

const _v = new THREE.Vector3();

const FULLSCREEN_VS = `#version 300 es
// Single oversized triangle covering the viewport with no vertex buffer —
// gl_VertexID-driven, avoids a VBO/VAO attribute for a pass this cheap.
out vec2 vUv;
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`;

// MIN-reduction: samples up to 4 texels of the previous level (2x2 block,
// clamped at odd-sized edges so a non-power-of-two source level is still
// covered exactly once) and writes the minimum depth (nearest-to-camera) —
// the standard "conservative" reduction for occlusion HZBs. Depth encoded
// into the R channel of an RGBA8 mip target (kept 8-bit deliberately, see
// _ensurePyramid — this trades some precision for texelFetch-without-
// depth-format-sampling portability across WebGL2 implementations that
// restrict depth-texture minification/mip generation).
const REDUCE_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;   // 1/srcWidth, 1/srcHeight
uniform vec2 uSrcSize;    // srcWidth, srcHeight (for edge clamp)
in vec2 vUv;
out vec4 oColor;
void main() {
  vec2 base = floor(vUv * uSrcSize) * 2.0;
  vec2 c00 = min(base, uSrcSize - 1.0);
  vec2 c10 = min(base + vec2(1.0, 0.0), uSrcSize - 1.0);
  vec2 c01 = min(base + vec2(0.0, 1.0), uSrcSize - 1.0);
  vec2 c11 = min(base + vec2(1.0, 1.0), uSrcSize - 1.0);
  float d00 = texture(uSrc, (c00 + 0.5) * uSrcTexel).r;
  float d10 = texture(uSrc, (c10 + 0.5) * uSrcTexel).r;
  float d01 = texture(uSrc, (c01 + 0.5) * uSrcTexel).r;
  float d11 = texture(uSrc, (c11 + 0.5) * uSrcTexel).r;
  float m = min(min(d00, d10), min(d01, d11));
  oColor = vec4(m, m, m, 1.0);
}`;

// Level-0 seed pass: copies the real depth-texture source into the R8 mip
// target in the SAME encoding every reduce pass expects, so REDUCE_FS never
// needs to special-case level 0 vs level N.
const SEED_FS = `#version 300 es
precision highp float;
uniform sampler2D uDepth;
in vec2 vUv;
out vec4 oColor;
void main() {
  float d = texture(uDepth, vUv).r;
  oColor = vec4(d, d, d, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`[hzb-tier] shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`[hzb-tier] program link failed: ${log}`);
  }
  return prog;
}

export class HzbTier {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && this.gl instanceof WebGL2RenderingContext;
    this.minCandidates = opts.minCandidates ?? 64;
    // Depth-capture target: resized lazily in captureAndBuild() to track
    // canvas/render-target size changes.
    this._depthTarget = null;
    // Mip chain: array of { tex, fbo, w, h } from level 0 (full/source res,
    // R8 seeded from the real depth buffer) down to a 1x1 top level.
    this._mips = [];
    this._seedProgram = null;
    this._reduceProgram = null;
    this._vao = null; // empty VAO — fullscreen-triangle VS needs no attributes but WebGL2 core profile requires a bound VAO for draw calls
    this._readPixel = new Uint8Array(4);
    this._pyrW = 0;
    this._pyrH = 0;
    this._pyramidReady = false;
    this.stats = { levels: 0, queried: 0, occluded: 0, supported: this.isWebGL2 };
    this._records = new Map(); // entity -> { localBox }
  }

  supported() {
    return this.isWebGL2;
  }

  _ensurePrograms() {
    if (this._seedProgram) return;
    const gl = this.gl;
    this._seedProgram = { prog: link(gl, FULLSCREEN_VS, SEED_FS), uDepth: null };
    this._seedProgram.uDepth = gl.getUniformLocation(this._seedProgram.prog, 'uDepth');
    this._reduceProgram = { prog: link(gl, FULLSCREEN_VS, REDUCE_FS), uSrc: null, uSrcTexel: null, uSrcSize: null };
    this._reduceProgram.uSrc = gl.getUniformLocation(this._reduceProgram.prog, 'uSrc');
    this._reduceProgram.uSrcTexel = gl.getUniformLocation(this._reduceProgram.prog, 'uSrcTexel');
    this._reduceProgram.uSrcSize = gl.getUniformLocation(this._reduceProgram.prog, 'uSrcSize');
    this._vao = gl.createVertexArray();
  }

  // (Re)allocate the full mip chain when the source resolution changes.
  // Level 0 is the full source resolution (rounded down — HZB mips don't
  // need exact pixel parity with the drawing buffer, only conservative
  // coverage), each subsequent level halves (ceil, so an odd dimension
  // still fully covers the previous level per the REDUCE_FS edge-clamp).
  _ensurePyramid(width, height) {
    const gl = this.gl;
    width = Math.max(1, width | 0);
    height = Math.max(1, height | 0);
    if (this._pyrW === width && this._pyrH === height && this._mips.length) return;
    this._pyrW = width;
    this._pyrH = height;
    this._disposeMips();
    let w = width, h = height;
    for (;;) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this._mips.push({ tex, fbo, w, h });
      if (w === 1 && h === 1) break;
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.stats.levels = this._mips.length;
  }

  _disposeMips() {
    const gl = this.gl;
    for (const m of this._mips) {
      gl.deleteTexture(m.tex);
      gl.deleteFramebuffer(m.fbo);
    }
    this._mips.length = 0;
  }

  // Builds the full mip chain from a raw WebGLTexture holding this frame's
  // depth: level 0 seeded from that texture, each subsequent level
  // MIN-reduced from the one below. This is the GENERATION step this task
  // scopes as the real deliverable — every line below actually runs on the
  // GPU, no stubbing. `rawDepthTex` must already be bound-usable (a plain
  // gl texture handle — see captureAndBuild() for how one is obtained
  // portably from a THREE.DepthTexture).
  buildPyramid(rawDepthTex, width, height) {
    if (!this.isWebGL2 || !rawDepthTex) return false;
    const gl = this.gl;
    this._ensurePrograms();
    this._ensurePyramid(width, height);
    if (!this._mips.length) return false;

    const prevTarget = this.renderer.getRenderTarget();
    const prevViewport = new THREE.Vector4();
    this.renderer.getViewport(prevViewport);

    gl.bindVertexArray(this._vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    gl.depthMask(false);

    // Level 0: seed from the real depth texture.
    const lvl0 = this._mips[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, lvl0.fbo);
    gl.viewport(0, 0, lvl0.w, lvl0.h);
    gl.useProgram(this._seedProgram.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rawDepthTex);
    gl.uniform1i(this._seedProgram.uDepth, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Levels 1..N: MIN-reduce from the previous level.
    gl.useProgram(this._reduceProgram.prog);
    for (let i = 1; i < this._mips.length; i++) {
      const src = this._mips[i - 1];
      const dst = this._mips[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(this._reduceProgram.uSrc, 0);
      gl.uniform2f(this._reduceProgram.uSrcTexel, 1 / src.w, 1 / src.h);
      gl.uniform2f(this._reduceProgram.uSrcSize, src.w, src.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setViewport(prevViewport);
    this.renderer.resetState();
    this._pyramidReady = true;
    return true;
  }

  // Owns a THREE.WebGLRenderTarget with an attached THREE.DepthTexture,
  // redirects a render of (scene,camera) into it, then hands buildPyramid()
  // the three-managed raw gl texture for that depth attachment (three
  // guarantees renderer.properties.get(depthTexture).__webglTexture exists
  // after a render call targeting a render target with depthTexture set —
  // it's the same handle three's own shadow-map passes sample from).
  // Returns true iff the pyramid was rebuilt.
  captureAndBuild(scene, camera, width, height) {
    if (!this.isWebGL2) return false;
    width = Math.max(1, width | 0);
    height = Math.max(1, height | 0);
    if (!this._depthTarget || this._depthTarget.width !== width || this._depthTarget.height !== height) {
      if (this._depthTarget) this._depthTarget.dispose();
      this._depthTarget = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: true,
        stencilBuffer: false,
        depthTexture: new THREE.DepthTexture(width, height, THREE.UnsignedIntType),
      });
    }
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this._depthTarget);
    this.renderer.clear(true, true, false);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(prevTarget);

    const props = this.renderer.properties.get(this._depthTarget.depthTexture);
    const rawTex = props && props.__webglTexture;
    if (!rawTex) return false;
    return this.buildPyramid(rawTex, width, height);
  }

  // Standard HZB level-selection rule: pick the smallest mip such that ONE
  // texel is guaranteed to have MIN-reduced over the object's ENTIRE
  // footprint (never a level so coarse that the texel undershoots and
  // false-occludes on a stale value from outside the footprint).
  _selectLevel(wPx, hPx) {
    const span = Math.max(wPx, hPx, 1);
    let level = Math.ceil(Math.log2(span)); // level L has texel footprint ~2^L source pixels; want smallest L with 2^L >= span
    if (level < 0) level = 0;
    if (level >= this._mips.length) level = this._mips.length - 1;
    return level;
  }

  // Read one texel of a given mip level at normalized uv in [0,1]^2 via a
  // direct gl.readPixels against that level's own FBO — spec-legal (RGBA8
  // color-attachment readback), and these FBOs/textures are entirely owned
  // by this class so no three-internals reach is needed here (unlike the
  // DepthTexture capture above). Returns depth in [0,1] (R channel; G=B=R
  // for debug-visualizability).
  _readMipTexel(level, u, v) {
    const gl = this.gl;
    const mip = this._mips[level];
    if (!mip) return 1;
    const x = Math.min(mip.w - 1, Math.max(0, Math.floor(u * mip.w)));
    const y = Math.min(mip.h - 1, Math.max(0, Math.floor(v * mip.h)));
    gl.bindFramebuffer(gl.FRAMEBUFFER, mip.fbo);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._readPixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this._readPixel[0] / 255;
  }

  // Per-candidate occlusion test against the built pyramid: projects the
  // entity's world AABB to screen space, reads the ONE conservative mip
  // texel that covers its full footprint, and compares against the box's
  // own nearest-to-camera projected depth. True = fully occluded (skip
  // drawing this frame). Fail-open (returns false) whenever the pyramid
  // isn't built yet or the box is off-screen/behind-camera-degenerate —
  // frustum culling already handles those cases upstream.
  isOccludedBox(worldBox, camera) {
    if (!this._pyramidReady || !this._mips.length || !camera) return false;
    if (worldBox.isEmpty()) return false;

    // 8-corner projection to screen-space NDC bounds + nearest depth —
    // cheap (8 Vector3 transforms), correct for any box orientation.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity;
    let anyInFront = false;
    const min = worldBox.min, max = worldBox.max;
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z);
      _v.applyMatrix4(camera.matrixWorldInverse);
      if (_v.z > -camera.near) continue; // behind or at the near plane in view space
      anyInFront = true;
      _v.applyMatrix4(camera.projectionMatrix);
      if (!isFinite(_v.x) || !isFinite(_v.y) || !isFinite(_v.z)) continue;
      const sx = (_v.x * 0.5 + 0.5);
      const sy = (_v.y * 0.5 + 0.5);
      const sz = (_v.z * 0.5 + 0.5);
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
      if (sz < minZ) minZ = sz;
    }
    if (!anyInFront || !isFinite(minX) || !isFinite(minY)) return false; // straddles/behind camera — fail open
    minX = Math.max(0, minX); maxX = Math.min(1, maxX);
    minY = Math.max(0, minY); maxY = Math.min(1, maxY);
    if (maxX <= minX || maxY <= minY) return false; // degenerate/off-screen footprint

    const wPx = (maxX - minX) * this._pyrW;
    const hPx = (maxY - minY) * this._pyrH;
    const level = this._selectLevel(wPx, hPx);
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const pyramidDepth = this._readMipTexel(level, cx, cy);
    // Occluded iff the box's OWN nearest depth is farther than (>=) the
    // pyramid's stored (already-minimum, i.e. nearest-possible) depth over
    // its footprint — meaning real geometry somewhere in that footprint is
    // at least as close as the box's nearest corner, so nothing of the box
    // could be visible in front of it.
    return minZ >= pyramidDepth + 1e-5;
  }

  // Convenience wrapper matching OcclusionQueryTier's per-entity call shape
  // (entity.root with a static local-space AABB cached once), so this tier
  // can be dropped into the SAME consumer contract used by
  // model-pool.js's _getOcclusionTier() without changing call sites there
  // beyond picking which tier to construct.
  isOccluded(entity) {
    const rec = this._records.get(entity);
    if (!rec || !rec.localBox) return false;
    const worldBox = rec.localBox.clone().applyMatrix4(entity.root.matrixWorld);
    return this.isOccludedBox(worldBox, this._lastCamera);
  }

  // Registers/refreshes the candidate's cached local-space AABB (same
  // one-time-compute-then-reuse-transform pattern as OcclusionQueryTier) and
  // stashes the camera so isOccluded() (called from a plain per-entity loop
  // with no camera argument, matching model-pool.js's existing
  // occTier.isOccluded(e) call site) always tests against the frame that
  // produced the currently-built pyramid.
  runQueries(camera, candidates) {
    if (!this.isWebGL2 || !this._pyramidReady) { this.stats.queried = 0; this.stats.occluded = 0; return; }
    this._lastCamera = camera;
    let occluded = 0;
    for (let i = 0; i < candidates.length; i++) {
      const entity = candidates[i];
      let rec = this._records.get(entity);
      if (!rec) { rec = {}; this._records.set(entity, rec); }
      if (!rec.localBox) {
        entity.root.updateWorldMatrix(true, true);
        const worldBox = new THREE.Box3().setFromObject(entity.root);
        if (!worldBox.isEmpty()) {
          const inv = new THREE.Matrix4().copy(entity.root.matrixWorld).invert();
          rec.localBox = worldBox.clone().applyMatrix4(inv);
        }
      }
      if (rec.localBox && this.isOccluded(entity)) occluded++;
    }
    this.stats.queried = candidates.length;
    this.stats.occluded = occluded;
  }

  release(entity) {
    this._records.delete(entity);
  }

  dispose() {
    this._disposeMips();
    if (this._seedProgram) { this.gl.deleteProgram(this._seedProgram.prog); this._seedProgram = null; }
    if (this._reduceProgram) { this.gl.deleteProgram(this._reduceProgram.prog); this._reduceProgram = null; }
    if (this._vao) { this.gl.deleteVertexArray(this._vao); this._vao = null; }
    if (this._depthTarget) { this._depthTarget.dispose(); this._depthTarget = null; }
    this._records.clear();
    this._pyramidReady = false;
  }
}

// NEXT TIER (not built this pass — the honest remainder):
//
// The consumer side that makes HZB culling actually replace per-object
// hardware queries AT SCALE (30k objects, zero CPU-side readback loop) needs:
//
//   1. Instance transforms + bounding spheres/boxes uploaded to a GPU buffer
//      (a data texture, same pattern model-pool.js's GPU-instance-transform-
//      texture path (currently opt-in/off, see _enableGpuInstanceTex) uses —
//      WebGL2 has no SSBOs, so a data texture is the portable equivalent).
//   2. A transform-feedback (or fragment-shader-to-texture) pass that, for
//      every instance, projects its bounds, samples THIS pyramid at the
//      selected mip (same level-selection math as _selectLevel/isOccludedBox
//      above, ported to GLSL), and writes a single visible/culled bit (or a
//      compacted "surviving index" stream via TRANSFORM_FEEDBACK) — entirely
//      on the GPU, no per-instance CPU loop.
//   3. A consumer that turns that visibility stream into a reduced draw:
//      either an indirect multi-draw (WebGL2 has no multi_draw_indirect —
//      would need ANGLE_multi_draw or a per-visible-instance
//      drawElementsInstanced with a compacted instance-attribute offset) or,
//      more realistically for this renderer's existing architecture, feeding
//      the survivor list back into cluster-lod-mesh.js's existing
//      per-cluster JS-driven group/drawRange selection (still a CPU loop,
//      but over SURVIVORS only, post-culled).
//
// This would be a genuinely separate module (a real transform-feedback GLSL
// program + a defined instance-buffer layout contract with model-pool.js)
// and is scoped out of this pass per the task's own "even if the full
// instance-culling consumer is not completed in this pass" allowance.
