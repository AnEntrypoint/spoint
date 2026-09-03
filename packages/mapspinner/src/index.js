// mapspinner SDK entry point
// Primary exports for external consumers (e.g., spoint integration)

export { initMapspinnerPlanet } from './planet-orchestrator.js';
export { initMapspinnerRender } from './gl-render.js';
export { Quadtree } from './quadtree.js';
export { createAnchorField } from './anchor-field.js';
// Headless CPU terrain-height sampler (transpiled from terrain.glsl, single source
// of truth) for physics/sampling on a server with no GPU. See height-cpu.js.
export { createHeightSampler, HEIGHT_UNIFORM_DEFAULTS } from './height-cpu.js';
// Canonical SDK-side defaults: every terrain look/shape/lod lever's blessed value. The render
// layers read these as their fallbacks so a bare consumer (no demo panels) renders the calibrated
// look. See src/terrain-defaults.js.
export { TERRAIN_DEFAULTS, SHAPE_UNIFORM_DEFAULTS } from './terrain-defaults.js';

// SDK API version. Deliberately independent of package.json's npm publish version
// (which bumps on every internal perf/cleanup commit) -- this only changes when the
// PUBLIC export surface (functions/shapes below) actually changes, so a consumer can
// gate feature-detection on it without churn. Bump alongside any breaking export change.
export const VERSION = '0.1.0';

/**
 * Initialize mapspinner's low-level WebGL2 render layer directly (no LOD/camera/quadtree
 * driver -- see createPlanet for the full system). Use this if you already own quadtree/LOD
 * selection and just need the GPU terrain+water+sky draw calls.
 *
 * @param {WebGL2RenderingContext} gl - WebGL2 context (must support EXT_color_buffer_float;
 *   throws if absent). OES_texture_float_linear and KHR_parallel_shader_compile are optional
 *   (degrade gracefully: nearest-filtered HPF field / blocking shader compile).
 * @param {Object} [config]
 * @param {number} [config.radius=6360] - Planet radius in the SDK's internal km-like unit
 *   (matches Quadtree/anchor-field scale; NOT meters -- see TERRAIN_DEFAULTS/reliefScale for
 *   the meters<->internal-unit relationship used elsewhere in the SDK).
 * @param {number} [config.gridMeshSize=9] - Mesh quads per patch edge (perf/quality lever).
 * @param {number} [config.reliefScale] - Vertical relief scale; defaults to a value derived
 *   from radius so terrain looks proportionally consistent at any configured radius.
 * @returns {Promise<Object>} Renderer instance. REAL returned shape (gl-render.js
 *   initMapspinnerRender): { prog (getter), render(cam), checkGlError(), probe(...),
 *   sampleGroundM(dir), sampleGroundMSync(dir), cullMatrix(...), recompile(), setHpf(tex,res,tex2),
 *   isContextLost(), onContextLost(cb)=>unsubscribe, GRID, indexCount, M4 }.
 *   sampleGroundM(dir) is FIRE-AND-FORGET ASYNC (~1-frame-stale by design, cheap, safe to call every
 *   rAF frame from a render loop paced consumer like the real-time collision floor). It returns a
 *   PREVIOUS call's harvested value, not this call's -- correct only when called once per rendered
 *   frame with a slowly-changing dir. A one-off probe/diagnostic/parity caller NOT paced by rAF (a
 *   Node/CDP witness script, a lab.mjs sweep) MUST use sampleGroundMSync(dir) instead, which blocks
 *   (bounded spin, same discipline as the THC bake readback) until it can return THIS call's own
 *   result -- see the mapspinner-sampleGroundM-probe-drift-preexisting-bug fix in gl-render.js for
 *   the live-reproduced failure mode (alternating directions via separate async calls read each
 *   other's settled value forever, in lockstep -- looks like a fixed additive drift, is really a
 *   one-call-stale read).
 *   isContextLost()/onContextLost() are a DETECTION-only hook for a lost WebGL context (driver
 *   reset/OOM/tab-eviction) -- after context loss every gl.* call is a silent spec-defined no-op,
 *   so render() keeps "succeeding" with a frozen/black frame and no error; subscribe via
 *   onContextLost to know when to recreate the renderer. Recovery is consumer-owned.
 *   NOTE: there is currently no dispose()/teardown method -- GL resources (programs, buffers,
 *   textures) live for the lifetime of the gl context. A consumer that recreates the renderer
 *   repeatedly (e.g. hot-reload) should reuse one instance rather than discarding+recreating,
 *   or accept the accumulated GPU resource growth.
 *
 * Example:
 *   const renderer = await mapspinner.createRenderer(gl, { radius: 6360 });
 *   // In animation loop:
 *   renderer.render(camera);
 */
export async function createRenderer(gl, config = {}) {
  const { initMapspinnerRender } = await import('./gl-render.js');
  return initMapspinnerRender(gl, config);
}

/**
 * Initialize a full planet: render layer + cube-sphere quadtree LOD + per-frame drive, the
 * batteries-included entry point most consumers (e.g. spoint) want.
 *
 * @param {WebGL2RenderingContext} gl - WebGL2 context; see createRenderer for extension notes.
 * @param {Object} [config] - Same shape as createRenderer's config, plus quadtree/LOD options
 *   (maxLevel, splitFactor, hpfSeed, hpfTexRes -- see planet-orchestrator.js for the full list).
 * @returns {Promise<Object>} REAL returned shape (planet-orchestrator.js initMapspinnerPlanet):
 *   { frame(cam), render(gl), clearCache() }. Call frame(cam) once per animation frame with the
 *   current camera (drives the quadtree LOD selection + issues the draw calls); render/clearCache
 *   are lower-level escapes for a consumer driving its own loop.
 */
export async function createPlanet(gl, config = {}) {
  const { initMapspinnerPlanet } = await import('./planet-orchestrator.js');
  return initMapspinnerPlanet(gl, config);
}
