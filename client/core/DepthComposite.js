// DepthComposite -- THE documented contract for how mapspinner's raw-GL terrain/water/sky and the THREE
// scene share ONE depth buffer so they composite correctly. This module is DOCUMENTATION + a small live
// self-check; it holds no per-frame state (the actual passes are RenderGraph nodes + gl-render.js). It
// exists because the depth handoff was previously understandable only by reverse-engineering two repos,
// and that opacity is the source of the z-fight / "objects draw over/under terrain/water" bug class.
//
// ============================================================================================
// THE CONTRACT (read this before touching anything depth-related)
// ============================================================================================
//
// Per frame, the render graph (client/core/RenderGraph.nodes.js) runs these passes IN ORDER:
//
//   host-near-far           -> publishes ctx.res.hostNearFar {near, far} and window.__hostNearFar.
//                              near = 0.5; far = clamp(vegetationRenderDistance, 100, distToPlanetCenter).
//                              Computed from LAST frame's state (a deliberate, harmless one-frame lag) so
//                              it is available to renderPlanet, which reads it SYNCHRONOUSLY.
//
//   terrain-depth-color     -> mapspinner draws terrain + water + sky straight to the canvas (raw WebGL2),
//                              then WRITES ITS DEPTH into the canvas depth buffer. The writeback is NOT a
//                              raw copy: mapspinner's terrain is rendered under its OWN near/far, so the
//                              depth is re-encoded from (uSrcNear,uSrcFar) to the consumer's
//                              (uDstNear,uDstFar) = window.__hostNearFar, via a full-screen gl_FragDepth
//                              shader pass (gl-render.js passPlanetDepthWriteback / dwProg). It also adds
//                              window.__planetDepthBias (default 3e-5) to push terrain depth slightly back
//                              so grounded geometry (trees/rocks sitting ON the surface) wins the depth
//                              test instead of z-fighting. Gated on window.__planetDepthToCanvas === true
//                              (RenderControls knob 'planetDepthToCanvas').
//                              Water surface depth is ALSO stamped (so submerged objects are occluded by
//                              water) unless window.__waterDepthShareOff.
//
//   camera-projection-apply -> sets THREE camera.near/far = hostNearFar AFTER renderPlanet, so THREE's
//                              projection encodes depth on the SAME curve the writeback just used. (near/far
//                              must match or the two depth buffers are on different non-linear curves and
//                              the comparison is meaningless -- this is the exact bug the re-encode fixes.)
//
//   scene-color             -> renderer.render(scene, camera) with autoClear=false, so THREE draws ON TOP
//                              of the terrain colour and DEPTH-TESTS against the terrain depth written above.
//                              A tree fragment nearer than the terrain behind it wins; one behind loses.
//
//   visibility-commit       -> issues occlusion queries against the now-final depth (results next frame).
//
// INVARIANTS (violating any of these is the bug):
//   * planetDepthToCanvas ON  => terrain depth is in the canvas; THREE geometry is correctly occluded by
//                                terrain/water. OFF => THREE draws over terrain (debug only).
//   * hostNearFar is the SINGLE near/far both the writeback re-encode AND THREE's projection use. Never let
//     them diverge (host-near-far writes it; camera-projection-apply applies the same value).
//   * The writeback is single-sourced: RenderGraph enforces exactly one writer for the 'terrainDepth'
//     resource (a 4th ad-hoc depth path is a construction-time throw).
//   * VDRS/half-res-water path renders the scene single-sample into _vdrsFbo then upscales; the writeback
//     re-samples _vdrsDepth's active sub-region (uUvScale) so it stamps the right texels.
//
// If a "z-fight / object drawing through terrain/water" bug appears, check IN THIS ORDER:
//   1. planetDepthToCanvas true?  2. hostNearFar sane (near<far, far not collapsed)?
//   3. THREE camera.near/far == hostNearFar after camera-projection-apply?  4. planetDepthBias not zeroed?
//   5. waterDepthShareOff not accidentally set?  All are RenderControls knobs (__renderControls.list()).

import { RenderControls } from './RenderControls.js'

// Live self-check: read the current depth-composite state and report whether the contract holds. Returns
// { ok, issues[], state } -- one call answers "is the depth seam healthy right now".
export function checkDepthComposite(camera) {
  const issues = []
  const depthToCanvas = RenderControls.get('planetDepthToCanvas')
  const bias = RenderControls.get('planetDepthBias')
  const hostNearFar = (typeof window !== 'undefined') ? window.__hostNearFar : null
  if (depthToCanvas !== true) issues.push('planetDepthToCanvas is not true -- THREE geometry will draw over terrain instead of being occluded by it')
  if (!hostNearFar) issues.push('window.__hostNearFar not published yet (terrain not initialised?)')
  else {
    if (!(hostNearFar.near < hostNearFar.far)) issues.push(`hostNearFar near(${hostNearFar.near}) >= far(${hostNearFar.far}) -- depth encoding is degenerate`)
    if (camera && (Math.abs(camera.near - hostNearFar.near) > 1e-6 || Math.abs(camera.far - hostNearFar.far) > 1e-3)) {
      issues.push(`THREE camera near/far (${camera.near},${camera.far}) != hostNearFar (${hostNearFar.near},${hostNearFar.far}) -- the two depth buffers are on different curves`)
    }
  }
  if (typeof bias !== 'number' || bias < 0) issues.push(`planetDepthBias (${bias}) invalid -- grounded geometry may z-fight the terrain`)
  const state = { planetDepthToCanvas: depthToCanvas, planetDepthBias: bias, hostNearFar, cameraNearFar: camera ? [camera.near, camera.far] : null }
  return { ok: issues.length === 0, issues, state }
}

// Expose a one-call health check on the debug surface.
export function installDepthCompositeCheck(camera) {
  if (typeof window !== 'undefined') window.__depthComposite = { check: () => checkDepthComposite(camera) }
}
